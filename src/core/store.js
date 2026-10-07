// IndexedDB persistence for sessions, rrweb event chunks, the interaction log
// and audio chunks. See docs/CONTRACTS.md.
//
// rrweb events and log entries are buffered in memory and written in small
// batches: every FLUSH_MS, right after a full snapshot (losing a page's first
// snapshot makes its whole segment unreplayable), and on pagehide /
// visibilitychange→hidden. Browsers let a transaction opened inside pagehide
// finish in practice, which is the best a page can do with no network egress.

const DB_NAME = 'testkit';
const DB_VERSION = 1;
// Pointers are scoped per study (and mirrors per session): one origin can
// host several prototypes, and a session must never leak into another study.
const ACTIVE_KEY = 'testkit:active:';
const LAST_KEY = 'testkit:last:';
const MIRROR_KEY = 'testkit:mirror:';
const FLUSH_MS = 2000;
const MAX_PENDING_EVENTS = 500;
const MAX_ATTEMPTS = 3;
const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot

let db = null;
let dbPromise = null;
let lifecycleInstalled = false;

let pendingEvents = []; // [{ sessionId, segmentId, event }]
let pendingLog = []; // [LogEntry & { sessionId }]
let pendingWaiter = null; // { promise, resolve } shared by every append in the batch
let flushTimer = null;
const inflight = new Set(); // settle promises of batches still writing or awaiting a retry
const tombstones = new Set(); // deleted session ids: their retries must not resurrect rows
const errorListeners = new Set();

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Groups buffered events into one chunk per consecutive (sessionId, segmentId) run. */
export function chunkEvents(pending) {
  const chunks = [];
  let current = null;
  for (const { sessionId, segmentId, event } of pending) {
    if (!current || current.sessionId !== sessionId || current.segmentId !== segmentId) {
      current = { sessionId, segmentId, ts: event?.timestamp ?? Date.now(), events: [] };
      chunks.push(current);
    }
    current.events.push(event);
  }
  return chunks;
}

/** Flattens stored chunks into one event array ordered by rrweb timestamp. */
export function flattenEventChunks(chunks) {
  const events = [];
  for (const chunk of chunks) for (const e of chunk.events || []) events.push(e);
  // Array#sort is stable, so same-timestamp events keep their emit order
  // (rrweb's Meta and FullSnapshot often share a millisecond).
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

export function sortLog(entries) {
  return entries
    .map(({ id, sessionId, ...entry }) => entry)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Stitches audio chunks into one Blob per audio segment. A segment's startTs
 * is the MediaRecorder 'start' time; endTs is when its last chunk arrived.
 */
export function groupAudioChunks(chunks) {
  const bySegment = new Map();
  for (const c of chunks) {
    if (!bySegment.has(c.audioSegmentId)) bySegment.set(c.audioSegmentId, []);
    bySegment.get(c.audioSegmentId).push(c);
  }
  const segments = [];
  for (const [audioSegmentId, list] of bySegment) {
    list.sort((a, b) => a.seq - b.seq);
    const mime = list[0].mime || 'audio/webm';
    segments.push({
      audioSegmentId,
      startTs: list[0].startTs ?? list[0].ts,
      endTs: Math.max(...list.map((c) => c.ts)),
      mime,
      blob: new Blob(list.map((c) => c.blob), { type: mime }),
    });
  }
  return segments.sort((a, b) => a.startTs - b.startTs);
}

/** Recording time excluding paused time, derived from a SessionRecord. */
export function elapsedMsFor(rec, now = Date.now()) {
  if (!rec?.startedAt) return 0;
  const end = rec.endedAt ?? now;
  const paused = (rec.pausedMs || 0) + (rec.pausedAt ? Math.max(0, end - rec.pausedAt) : 0);
  return Math.max(0, end - rec.startedAt - paused);
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function notifyError(err) {
  for (const fn of errorListeners) {
    try {
      fn(err);
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

function installLifecycle() {
  if (lifecycleInstalled || typeof window === 'undefined') return;
  lifecycleInstalled = true;
  window.addEventListener('pagehide', () => flush(), { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

export function openStore() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      for (const name of ['events', 'log', 'audio']) {
        if (!d.objectStoreNames.contains(name)) {
          d.createObjectStore(name, { keyPath: 'id', autoIncrement: true }).createIndex('sessionId', 'sessionId');
        }
      }
    };
    req.onsuccess = () => {
      db = req.result;
      // Another tab upgrading the schema: step aside so it isn't blocked.
      db.onversionchange = () => {
        db.close();
        db = null;
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  installLifecycle();
  return dbPromise;
}

async function ready() {
  return db || openStore();
}

// ---------------------------------------------------------------------------
// Buffered writes

function waiter() {
  if (!pendingWaiter) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    pendingWaiter = { promise, resolve };
  }
  return pendingWaiter.promise;
}

function scheduleFlush(immediate) {
  if (immediate) {
    Promise.resolve().then(flush);
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/**
 * Writes everything buffered and resolves once every batch — including ones
 * from earlier flushes still waiting on a retry — has landed or been given up
 * on. The transaction is opened synchronously when the DB is open, so this is
 * safe to call from pagehide, and any read transaction opened after the
 * returned promise resolves observes these writes.
 * Never rejects: failures are retried, then reported via onError().
 */
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (pendingEvents.length || pendingLog.length) {
    if (!db) return ready().then(flush, (err) => notifyError(err));
    let settle;
    const batch = { events: pendingEvents, log: pendingLog, waiter: pendingWaiter, attempts: 0 };
    batch.settled = new Promise((r) => (settle = r));
    batch.settle = settle;
    pendingEvents = [];
    pendingLog = [];
    pendingWaiter = null;
    inflight.add(batch.settled);
    writeBatch(batch);
  }
  return Promise.all(inflight).then(() => {});
}

function writeBatch(batch) {
  const done = () => {
    batch.waiter?.resolve();
    inflight.delete(batch.settled);
    batch.settle();
  };
  batch.events = batch.events.filter((p) => !tombstones.has(p.sessionId));
  batch.log = batch.log.filter((e) => !tombstones.has(e.sessionId));
  if (!batch.events.length && !batch.log.length) {
    done();
    return;
  }
  const retry = (err) => {
    batch.attempts += 1;
    if (batch.attempts >= MAX_ATTEMPTS || !db) {
      notifyError(err);
      done();
      return;
    }
    // A non-cloneable value would fail forever; JSON-normalize it once.
    if (err?.name === 'DataCloneError') {
      batch.events = batch.events.map((p) => ({ ...p, event: JSON.parse(JSON.stringify(p.event)) }));
      batch.log = batch.log.map((e) => JSON.parse(JSON.stringify(e)));
    }
    setTimeout(() => writeBatch(batch), 250 * batch.attempts);
  };
  let tx;
  try {
    tx = db.transaction(['events', 'log'], 'readwrite');
    const events = tx.objectStore('events');
    for (const chunk of chunkEvents(batch.events)) events.add(chunk);
    const log = tx.objectStore('log');
    for (const entry of batch.log) log.add(entry);
  } catch (err) {
    try {
      tx?.abort();
    } catch {
      // Already inactive.
    }
    retry(err);
    return;
  }
  tx.oncomplete = done;
  tx.onabort = () => retry(tx.error || new Error('IndexedDB transaction aborted'));
  // Ask the engine to commit now rather than when the task ends — helps on unload.
  tx.commit?.();
}

/** Buffers rrweb events. Resolves once they're written; never rejects. */
export function appendEvents(sessionId, segmentId, events) {
  let snapshot = false;
  for (const event of events) {
    pendingEvents.push({ sessionId, segmentId, event });
    if (event?.type === FULL_SNAPSHOT) snapshot = true;
  }
  const p = waiter();
  scheduleFlush(snapshot || pendingEvents.length >= MAX_PENDING_EVENTS);
  return p;
}

/** Buffers a log entry. Resolves once written; never rejects. */
export function appendLog(sessionId, entry) {
  pendingLog.push({ ...entry, sessionId });
  const p = waiter();
  scheduleFlush(false);
  return p;
}

/** Writes an audio chunk immediately (blobs aren't worth holding in memory). */
export async function appendAudio(sessionId, chunk) {
  await ready();
  const tx = db.transaction('audio', 'readwrite');
  tx.objectStore('audio').add({ ...chunk, sessionId });
  tx.commit?.();
  return txDone(tx);
}

/** Registers a listener for write failures that were given up on. */
export function onError(fn) {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Sessions

export async function createSession(rec) {
  await ready();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').add(rec);
  return txDone(tx);
}

export async function getSession(id) {
  await ready();
  return (await requestToPromise(db.transaction('sessions').objectStore('sessions').get(id))) ?? null;
}

/** Shallow-merges `patch` into the stored record (read + write in one transaction). */
export async function updateSession(id, patch) {
  await ready();
  const tx = db.transaction('sessions', 'readwrite');
  const sessions = tx.objectStore('sessions');
  let updated = null;
  sessions.get(id).onsuccess = (e) => {
    const current = e.target.result;
    if (!current) return;
    updated = { ...current, ...patch, id };
    sessions.put(updated);
  };
  await txDone(tx);
  if (!updated) throw new Error(`Unknown session ${id}`);
  return updated;
}

/** Most recently stored audio chunk for a session (null if none). */
export async function lastAudioChunk(sessionId) {
  await ready();
  const index = db.transaction('audio').objectStore('audio').index('sessionId');
  // Equal index keys iterate in primary-key order, so 'prev' yields the newest.
  const cursor = await requestToPromise(index.openCursor(IDBKeyRange.only(sessionId), 'prev'));
  return cursor ? cursor.value : null;
}

export async function loadSessionData(id) {
  await flush();
  await ready();
  const tx = db.transaction(['sessions', 'events', 'log', 'audio']);
  const byIndex = (name) => requestToPromise(tx.objectStore(name).index('sessionId').getAll(IDBKeyRange.only(id)));
  const [session, eventChunks, log, audio] = await Promise.all([
    requestToPromise(tx.objectStore('sessions').get(id)),
    byIndex('events'),
    byIndex('log'),
    byIndex('audio'),
  ]);
  if (!session) throw new Error(`Unknown session ${id}`);
  return {
    session,
    events: flattenEventChunks(eventChunks),
    log: sortLog(log),
    audio: groupAudioChunks(audio),
  };
}

export async function deleteSession(id) {
  tombstones.add(id);
  pendingEvents = pendingEvents.filter((p) => p.sessionId !== id);
  pendingLog = pendingLog.filter((e) => e.sessionId !== id);
  // Drain in-flight batches (their retries now skip this session) so the
  // delete below runs after every write that could still add rows.
  await flush();
  await ready();
  const tx = db.transaction(['sessions', 'events', 'log', 'audio'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  for (const name of ['events', 'log', 'audio']) {
    const store = tx.objectStore(name);
    store.index('sessionId').getAllKeys(IDBKeyRange.only(id)).onsuccess = (e) => {
      for (const key of e.target.result) store.delete(key);
    };
  }
  return txDone(tx);
}

// ---------------------------------------------------------------------------
// localStorage pointers, keyed by study. `testkit:active:<study>` is read
// synchronously by the loader; `testkit:last:<study>` remembers a stopped
// session so a reload can still export it.

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage disabled: the session still works within this page.
  }
}

// Synchronous copy of a session's critical fields (see persist() in session.js).
export function getSessionMirror(id) {
  try {
    return JSON.parse(lsGet(MIRROR_KEY + id) || 'null');
  } catch {
    return null;
  }
}
export const setSessionMirror = (mirror) => lsSet(MIRROR_KEY + mirror.id, JSON.stringify(mirror));
export const clearSessionMirror = (id) => lsSet(MIRROR_KEY + id, null);

export const getActiveSessionId = (study) => lsGet(ACTIVE_KEY + study);
export const setActiveSessionId = (study, id) => lsSet(ACTIVE_KEY + study, id);
export const clearActiveSessionId = (study) => lsSet(ACTIVE_KEY + study, null);
export const getLastSessionId = (study) => lsGet(LAST_KEY + study);
export const setLastSessionId = (study, id) => lsSet(LAST_KEY + study, id);
export const clearLastSessionId = (study) => lsSet(LAST_KEY + study, null);
