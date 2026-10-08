// Controller lifecycle against an in-memory store and fake capture modules
// injected through createController({ deps }). rrweb and the esbuild-only
// player bundle are stubbed by a resolve hook because session.js imports
// them statically.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'virtual:player-bundle') return { url: 'data:text/javascript,globalThis.__playerLoads = (globalThis.__playerLoads || 0); export const loadPlayerJs = async () => { globalThis.__playerLoads++; return ""; }', shortCircuit: true };
      if (specifier === 'rrweb') return { url: 'data:text/javascript,export function record() {}', shortCircuit: true };
      return next(specifier, context);
    }`)}`,
);

const noop = () => {};
const windowListeners = {};
globalThis.window = {
  addEventListener: (name, fn) => (windowListeners[name] ||= []).push(fn),
  removeEventListener: noop,
  innerWidth: 800,
  innerHeight: 600,
};
globalThis.document = { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', querySelector: () => null };
globalThis.location = { href: 'https://example.test/p' };
delete globalThis.BroadcastChannel; // no other tabs; an open channel would keep the process alive
const permissions = { state: 'prompt' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node-test', permissions: { query: async () => ({ state: permissions.state }) } },
});

const session = await import('../src/core/session.js');
const { STALE_MS } = session;

// Every controller made by a test is stopped afterwards, so a test that fails
// before its own stop() can't leave a ticker/heartbeat holding the process open.
const controllers = new Set();
async function createController(opts) {
  const c = await session.createController(opts);
  controllers.add(c);
  return c;
}
afterEach(async () => {
  for (const c of controllers) await c.stop().catch(() => {});
  controllers.clear();
});
const { normalizeConfig } = await import('../src/core/config.js');
const { groupAudioChunks } = await import('../src/core/store.js');

const settle = () => new Promise((r) => setTimeout(r, 10));

function memoryStore() {
  const sessions = new Map();
  const log = [];
  const audio = [];
  const ls = new Map();
  const calls = [];
  let lastChunk = Promise.resolve(null);
  const store = {
    sessions, log, audio, ls, calls,
    failAudio: null, // an Error makes appendAudio reject
    setLastChunk: (p) => (lastChunk = p),
    importSpill: async () => calls.push('importSpill'),
    getSession: async (id) => {
      calls.push('getSession');
      return sessions.has(id) ? structuredClone(sessions.get(id)) : null;
    },
    createSession: async (rec) => sessions.set(rec.id, structuredClone(rec)),
    updateSession: async (id, patch) => Object.assign(sessions.get(id), structuredClone(patch)),
    appendEvents: async () => {},
    appendLog: async (id, entry) => log.push({ ...entry, sessionId: id }),
    appendAudio: async (id, chunk) => {
      if (store.failAudio) throw store.failAudio;
      audio.push({ ...chunk, sessionId: id });
    },
    loadAudioReport: async (id) => ({
      session: structuredClone(sessions.get(id)),
      log: log.filter((e) => e.sessionId === id).map(({ sessionId, ...e }) => e),
      audio: groupAudioChunks(audio.filter((c) => c.sessionId === id).map((c) => ({ ...c, blob: new Blob([]) }))),
      audioDropped: [],
    }),
    lastAudioChunk: () => lastChunk,
    flush: async () => {},
    spill: noop,
    deleteSession: async (id) => sessions.delete(id),
    onError: noop,
    getActivePointer: (study) => JSON.parse(ls.get(`active:${study}`) || 'null'),
    getActiveSessionId: (study) => store.getActivePointer(study)?.id ?? null,
    setActiveSessionId: (study, id, lastActivityAt = Date.now()) => ls.set(`active:${study}`, JSON.stringify({ id, study, lastActivityAt })),
    clearActiveSessionId: (study) => ls.delete(`active:${study}`),
    getLastSessionId: (study) => ls.get(`last:${study}`) ?? null,
    setLastSessionId: (study, id) => ls.set(`last:${study}`, id),
    clearLastSessionId: (study) => ls.delete(`last:${study}`),
    getSessionMirror: () => null,
    setSessionMirror: noop,
    clearSessionMirror: noop,
  };
  return store;
}

function fakeDeps({ micError } = {}) {
  const seen = { recorderConfigs: [], marks: [], acquires: 0, releases: 0, problem: null, micError, segments: [], capture: null };
  const deps = {
    createRecorder: ({ config }) => {
      seen.recorderConfigs.push(config);
      let on = false;
      return {
        start: () => (on = true),
        stop: () => (on = false),
        addCustomEvent: (tag, payload) => on && seen.marks.push({ tag, payload }),
        takeFullSnapshot: noop,
        isRecording: () => on,
      };
    },
    createInteractionLog: ({ getTaskId, onEntry, mask }) => {
      seen.mask = mask;
      return {
        start: noop,
        stop: noop,
        flushPending: noop,
        log: (type, fields = {}) => onEntry({ ts: Date.now(), type, url: location.href, taskId: getTaskId(), ...fields }),
      };
    },
    // Chunks are emitted by hand (seen.capture.emit()) so tests control when
    // the first one is persisted.
    createAudioCapture: ({ onProblem, onChunk, onObserve }) => {
      seen.problem = onProblem;
      seen.observe = onObserve;
      let live = false;
      let seg = null;
      let n = 0;
      let muted = false;
      const capture = {
        acquire: async () => {
          seen.acquires++;
          if (seen.gate) await seen.gate;
          if (seen.micError) throw seen.micError;
          live = true;
        },
        startSegment: () => {
          seg = { id: `aseg${++n}`, seq: 0, startTs: Date.now() };
          seen.segments.push({ id: seg.id, mutedAtStart: muted });
          return seg.id;
        },
        stopSegment: async () => {
          seg = null;
        },
        emit: () => seg && onChunk({ audioSegmentId: seg.id, seq: seg.seq++, ts: Date.now(), startTs: seg.startTs, mime: 'audio/webm', blob: null }),
        requestData: noop,
        setMuted: (m) => {
          muted = m;
        },
        getLevel: () => 0,
        release: async () => {
          seen.releases++;
          live = false;
          seg = null;
        },
        kill: () => {
          live = false;
        },
        isLive: () => live,
        isRecording: () => !!seg,
        segmentId: () => seg?.id ?? null,
      };
      seen.capture = capture;
      return capture;
    },
  };
  return { deps, seen };
}

const config = normalizeConfig({
  study: 'study-a',
  tasks: [{ id: 't1', prompt: 'One' }, { id: 't2', prompt: 'Two' }, { id: 't3', prompt: 'Three' }],
});

async function startSession({ audio = false, store = memoryStore() } = {}) {
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config, store, deps });
  await controller.beginPreflight();
  await controller.start({ consent: true, audio });
  return { store, seen, controller };
}

function savedSession(store) {
  return [...store.sessions.values()][0];
}

// Must stay the first test that starts a session: the exporter caches the
// player for the whole process, so later starts load nothing.
test('only an active session prefetches the player: not on boot, not in setup, once on start', async () => {
  const { deps } = fakeDeps();
  const controller = await createController({ config, store: memoryStore(), deps });
  await controller.beginPreflight();
  assert.equal(globalThis.__playerLoads || 0, 0);
  await controller.start({ consent: true, audio: false });
  assert.equal(globalThis.__playerLoads, 1);
});

test('start → next ×3 counts every task and stops', async () => {
  const { store, seen, controller } = await startSession();
  for (let i = 0; i < 3; i++) await controller.nextTask();
  const s = controller.getState();
  assert.equal(s.phase, 'stopped');
  assert.equal(s.tasksCompleted, 3);
  const ends = store.log.filter((e) => e.type === 'task-end');
  assert.deepEqual(ends.map((e) => [e.taskId, e.completed]), [['t1', true], ['t2', true], ['t3', true]]);
  assert.deepEqual(seen.marks.filter((m) => m.tag === 'testkit:task-end').map((m) => m.payload.completed), [true, true, true]);
  assert.equal(store.getActiveSessionId('study-a'), null);
  assert.equal(store.getLastSessionId('study-a'), s.sessionId);
  assert.equal(savedSession(store).phase, 'stopped');
});

test('stop mid-task ends it with completed: false and does not count it', async () => {
  const { store, controller } = await startSession();
  await controller.nextTask();
  await controller.stop();
  const ends = store.log.filter((e) => e.type === 'task-end');
  assert.deepEqual(ends.map((e) => [e.taskId, e.completed]), [['t1', true], ['t2', false]]);
  assert.equal(controller.getState().tasksCompleted, 1);
});

test('nothing is logged after session-end', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  await controller.stop();
  seen.problem('ended'); // e.g. the mic track ends after Stop
  const i = store.log.findIndex((e) => e.type === 'session-end');
  assert.equal(i, store.log.length - 1, store.log.map((e) => e.type).join(','));
});

test('every persist refreshes lastActivityAt on the record and the active pointer', async () => {
  const { store, controller } = await startSession();
  const before = store.getActivePointer('study-a').lastActivityAt;
  await settle();
  await controller.nextTask();
  const after = store.getActivePointer('study-a');
  assert.ok(after.lastActivityAt > before);
  assert.equal(after.study, 'study-a');
  assert.equal(savedSession(store).lastActivityAt, after.lastActivityAt);
  await controller.stop();
});

function seedRecording(store, overrides = {}) {
  const now = Date.now();
  const rec = {
    id: 'old', study: 'study-a', startedAt: now - 60_000, endedAt: null, phase: 'recording',
    taskIndex: 1, taskStartedAt: now - 30_000, tasks: config.tasks, config: structuredClone(config),
    segments: [{ segmentId: 'seg0', url: 'https://example.test/first', startedAt: now - 60_000 }],
    audio: { enabled: false, mime: null }, muted: false, pausedMs: 0, pausedAt: null, tasksCompleted: 1,
    lastActivityAt: now - 1000, rev: 3, ...overrides,
  };
  store.sessions.set(rec.id, rec);
  store.setActiveSessionId('study-a', rec.id, rec.lastActivityAt);
  return rec;
}

test('boot imports the spill before reading the session', async () => {
  const store = memoryStore();
  seedRecording(store);
  const { deps } = fakeDeps();
  const controller = await createController({ config, store, deps });
  assert.equal(store.calls[0], 'importSpill');
  assert.ok(store.calls.indexOf('getSession') > 0);
  await controller.stop();
});

test('a stale active session is stopped at its last activity, not resumed', async () => {
  const store = memoryStore();
  const at = Date.now() - STALE_MS - 60_000;
  seedRecording(store, { lastActivityAt: at, startedAt: at - 60_000, segments: [{ segmentId: 's', url: 'https://example.test/first', startedAt: at - 60_000 }] });
  store.setActiveSessionId('study-a', 'old', at);
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config, store, deps });
  const s = controller.getState();
  assert.equal(s.phase, 'stopped');
  assert.equal(seen.recorderConfigs.length, 0, 'capture must not start');
  assert.equal(store.sessions.get('old').endedAt, at);
  assert.equal(store.getActiveSessionId('study-a'), null);
  assert.equal(store.getLastSessionId('study-a'), 'old');
  const end = store.log.find((e) => e.type === 'session-end');
  assert.deepEqual([end.reason, end.ts], ['stale', at]);
  const taskEnd = store.log.find((e) => e.type === 'task-end');
  assert.deepEqual([taskEnd.taskId, taskEnd.completed], ['t2', false]);
});

test('resume records with the saved session config, not the page config', async () => {
  const store = memoryStore();
  seedRecording(store);
  const page = { ...config, mask: { inputs: false }, checkoutEveryNms: 1, inlineImages: false };
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config: page, store, deps });
  assert.equal(controller.getState().phase, 'recording');
  assert.equal(seen.mask, true);
  assert.equal(seen.recorderConfigs[0].mask.inputs, true);
  assert.equal(seen.recorderConfigs[0].checkoutEveryNms, config.checkoutEveryNms);
  assert.equal(seen.recorderConfigs[0].inlineImages, true);
  await controller.stop();
});

test('a stopped session found under the active pointer gets a last pointer', async () => {
  const store = memoryStore();
  seedRecording(store, { phase: 'stopped', endedAt: Date.now() });
  const { deps } = fakeDeps();
  await createController({ config, store, deps });
  assert.equal(store.getLastSessionId('study-a'), 'old');
  assert.equal(store.getActiveSessionId('study-a'), null);
});

for (const action of ['stop', 'discard']) {
  test(`${action} while the restore awaits lastAudioChunk() never touches the mic`, async () => {
    const store = memoryStore();
    seedRecording(store, { audio: { enabled: true, mime: 'audio/webm' } });
    let release;
    store.setLastChunk(new Promise((r) => (release = r)));
    const { deps, seen } = fakeDeps();
    const controller = await createController({ config, store, deps });
    await controller[action]();
    release(null);
    await settle();
    assert.equal(seen.acquires, 0);
    assert.notEqual(controller.getState().audio.status, 'live');
  });
}

test('any NotAllowedError in a session sets stopAsking (Firefox/Safari forget a one-off block) and keeps enabled', async () => {
  const denied = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
  for (const [permission, stopAsking] of [['prompt', true], ['denied', true]]) {
    permissions.state = permission;
    const store = memoryStore();
    seedRecording(store, { audio: { enabled: true, mime: 'audio/webm' } });
    const { deps } = fakeDeps({ micError: denied });
    const controller = await createController({ config, store, deps });
    await settle();
    const saved = store.sessions.get('old').audio;
    assert.equal(saved.enabled, true, `permission ${permission}: intent is kept`);
    assert.equal(!!saved.stopAsking, stopAsking, `permission ${permission}`);
    assert.equal(controller.getState().audio.status, 'denied');
    assert.equal(controller.getState().audio.stopAsking, stopAsking);
    await controller.stop();
  }
  permissions.state = 'prompt';
});

test('a bfcache restore into a session paused elsewhere releases the mic', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  // Another page paused the session while this one sat in the bfcache.
  const rec = savedSession(store);
  Object.assign(rec, { phase: 'paused', pausedAt: Date.now(), rev: rec.rev + 10 });
  store.setActiveSessionId('study-a', rec.id);
  const listeners = windowListeners.pageshow;
  listeners[listeners.length - 1]({ persisted: true });
  await settle();
  assert.equal(controller.getState().phase, 'paused');
  assert.ok(seen.releases >= 1, 'mic released');
  assert.notEqual(controller.getState().audio.status, 'live');
  await controller.stop();
});

// ---------------------------------------------------------------------------
// Audio recovery and status (audio-recording-plan.md §0–§4)

// A fresh page load of the same session: the previous page's controller is
// stopped against a throwaway copy so its timers don't outlive the test.
async function navigate(store, controller) {
  const rec = structuredClone(savedSession(store));
  const next = memoryStore();
  next.sessions.set(rec.id, rec);
  next.log.push(...store.log);
  next.audio.push(...store.audio);
  next.setActiveSessionId('study-a', rec.id, Date.now());
  await controller.stop();
  // Undo what stop() wrote to the old store; `next` holds the live session.
  const { deps, seen } = fakeDeps();
  const page = await createController({ config, store: next, deps });
  await settle();
  return { store: next, seen, controller: page };
}

test('status is live only after the first chunk of the active segment is saved', async () => {
  const { seen, controller } = await startSession({ audio: true });
  assert.equal(controller.getState().audio.status, 'pending');
  seen.capture.emit();
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  await controller.pause();
  assert.notEqual(controller.getState().audio.status, 'live', 'a stopped segment is not live');
  await controller.resume();
  assert.equal(controller.getState().audio.status, 'pending');
  seen.capture.emit();
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  await controller.stop();
});

for (const [name, fail, expected] of [
  ['device ended', ({ seen }) => seen.problem('ended'), 'Microphone disconnected'],
  ['recorder error', ({ seen }) => seen.problem('error', new Error('boom')), 'Audio recording failed: boom'],
  ['persistence failure', ({ seen, store }) => {
    store.failAudio = new Error('disk said no');
    seen.capture.emit();
  }, 'Audio could not be saved: disk said no'],
  ['IndexedDB quota', ({ seen, store }) => {
    store.failAudio = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    seen.capture.emit();
  }, 'Browser storage is full, so audio stopped saving. The screen is still recording; stop and download the session soon.'],
]) {
  test(`${name}: status leaves live, segment stops, visual capture continues, gap logged`, async () => {
    const { store, seen, controller } = await startSession({ audio: true });
    seen.capture.emit();
    await settle();
    assert.equal(controller.getState().audio.status, 'live');
    await fail({ seen, store });
    await settle();
    const s = controller.getState();
    assert.equal(s.audio.status, 'error');
    assert.equal(s.audio.error, expected);
    assert.equal(s.phase, 'recording', 'visual recording keeps going');
    assert.equal(seen.capture.isRecording(), false, 'failed segment stopped');
    const gap = store.log.find((e) => e.type === 'audio-gap');
    assert.equal(gap?.message, expected);
    await controller.stop();
  });
}

test('a write failure of a segment that already stopped does not demote the new one', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  const first = store.appendAudio;
  let rejectLate;
  store.appendAudio = (id, chunk) => (chunk.audioSegmentId === 'aseg1' ? new Promise((_, r) => (rejectLate = r)) : first(id, chunk));
  seen.capture.emit(); // aseg1 chunk still writing
  await controller.pause();
  await controller.resume(); // aseg2
  seen.capture.emit();
  await settle();
  rejectLate(new Error('late'));
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  await controller.stop();
});

test('retryMic after the device ended starts a new segment and keeps saved audio', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  seen.capture.kill();
  seen.problem('ended');
  await settle();
  const saved = store.audio.length;
  const retry = controller.retryMic();
  assert.equal(controller.getState().audio.status, 'reconnecting');
  const res = await retry;
  assert.deepEqual(res, { ok: true });
  assert.equal(seen.segments.length, 2);
  assert.equal(controller.getState().audio.status, 'reconnecting', 'not live until a chunk lands');
  seen.capture.emit();
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  assert.equal(store.audio.length, saved + 1);
  const gaps = store.log.filter((e) => e.type === 'audio-gap');
  assert.equal(gaps.length, 2);
  assert.equal(gaps[1].gapStart, gaps[0].gapStart, 'the retry closes the gap the failure opened');
  assert.ok(gaps[1].gapMs >= 0);
  await controller.stop();
});

test('retryMic denied: no segments cleared, stopAsking set, session continues without audio', async () => {
  permissions.state = 'denied';
  const { store, seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  seen.capture.kill();
  seen.problem('ended');
  seen.micError = Object.assign(new Error('no'), { name: 'NotAllowedError' });
  const res = await controller.retryMic();
  assert.equal(res.ok, false);
  assert.equal(res.persistent, true);
  const s = controller.getState();
  assert.equal(s.audio.status, 'denied');
  assert.equal(s.audio.stopAsking, true);
  assert.equal(s.phase, 'recording');
  assert.equal(savedSession(store).audio.enabled, true);
  assert.equal(savedSession(store).audio.stopAsking, true);
  assert.equal(store.audio.length, 1, 'saved audio untouched');
  await controller.stop();
  permissions.state = 'prompt';
});

test('Stop while a retry prompt is open releases the late grant', async () => {
  const { seen, controller } = await startSession({ audio: true });
  seen.capture.kill();
  seen.problem('ended');
  let grant;
  seen.gate = new Promise((r) => (grant = r));
  const retry = controller.retryMic();
  await settle();
  await controller.stop();
  const releasesAtStop = seen.releases;
  grant();
  const res = await retry;
  assert.equal(res.stale, true);
  assert.notEqual(controller.getState().audio.status, 'live');
  assert.ok(seen.releases >= releasesAtStop, 'released');
  assert.equal(seen.capture.isLive(), false, 'no live microphone after Stop');
});

test('retryMic while paused re-acquires but leaves segment start to resume()', async () => {
  const { seen, controller } = await startSession({ audio: true });
  seen.capture.kill();
  seen.problem('ended');
  await controller.pause();
  const res = await controller.retryMic();
  assert.equal(res.ok, true);
  assert.equal(seen.segments.length, 1, 'no segment while paused');
  assert.equal(controller.getState().audio.status, 'pending', 'not stuck at reconnecting, not live');
  await controller.resume();
  assert.equal(seen.segments.length, 2);
  await controller.stop();
});

test('continueWithoutMic stops asking, releases the mic, and later pages do not prompt', async () => {
  let { store, seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  await controller.continueWithoutMic();
  assert.equal(controller.getState().audio.status, 'off');
  assert.equal(controller.getState().audio.stopAsking, true);
  assert.equal(seen.capture.isLive(), false);
  assert.equal(store.audio.length, 1);
  ({ store, seen, controller } = await navigate(store, controller));
  assert.equal(seen.acquires, 0, 'no prompt on the next page');
  assert.equal(controller.getState().audio.enabled, true);
  // The tester can still change their mind: Retry asks again.
  const res = await controller.retryMic();
  assert.equal(res.ok, true);
  assert.equal(savedSession(store).audio.stopAsking, false);
  await controller.stop();
});

test('mute survives navigation and is applied before the new segment starts', async () => {
  let { store, seen, controller } = await startSession({ audio: true });
  await controller.toggleMute();
  assert.equal(controller.getState().audio.status, 'muted');
  ({ store, seen, controller } = await navigate(store, controller));
  const s = controller.getState();
  assert.equal(s.muted, true);
  assert.equal(s.audio.status, 'muted');
  assert.deepEqual(seen.segments.map((x) => x.mutedAtStart), [true]);
  await controller.toggleMute();
  assert.equal(controller.getState().audio.status, 'pending', 'unmuted but nothing saved yet');
  seen.capture.emit();
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  await controller.stop();
});

test('pause survives navigation: no segment, mic not requested until resume', async () => {
  let { store, seen, controller } = await startSession({ audio: true });
  await controller.pause();
  ({ store, seen, controller } = await navigate(store, controller));
  assert.equal(controller.getState().phase, 'paused');
  assert.equal(seen.acquires, 0);
  assert.equal(seen.segments.length, 0);
  await controller.resume();
  assert.equal(seen.acquires, 1);
  assert.equal(seen.segments.length, 1);
  const gap = store.log.filter((e) => e.type === 'audio-gap').at(-1);
  assert.equal(gap.message, undefined, 'a successful resume logs the gap without a failure reason');
  await controller.stop();
});

test('older records: enabled:false without stopAsking never prompts again', async () => {
  const store = memoryStore();
  seedRecording(store, { audio: { enabled: false, mime: 'audio/webm' } });
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config, store, deps });
  await settle();
  assert.equal(seen.acquires, 0);
  assert.equal(controller.getState().audio.stopAsking, true);
  await controller.stop();
});

test('stopped state carries the saved-audio verdict from persisted segments', async () => {
  const { seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  await controller.stop();
  assert.equal(controller.getState().savedAudio.segments, 1);
  assert.match(controller.getState().savedAudio.label, /^Audio recorded/);

  const none = await startSession({ audio: false });
  await none.controller.stop();
  assert.equal(none.controller.getState().savedAudio.kind, 'none');
  assert.equal(none.controller.getState().savedAudio.label, 'No audio recorded');
});

test('export: audio too large to encode → exact copy, Download without audio offered and works', async () => {
  const { store, controller } = await startSession({ audio: true });
  await controller.stop();
  const rec = savedSession(store);
  const broken = { arrayBuffer: async () => { throw new RangeError('Invalid string length'); }, type: 'audio/webm', size: 1 };
  store.loadSessionData = async () => ({
    session: structuredClone(rec), events: [{ type: 4, timestamp: rec.startedAt }], log: [],
    audio: [{ audioSegmentId: 'a', startTs: rec.startedAt, endTs: rec.endedAt, mime: 'audio/webm', blob: broken }], audioDropped: [],
  });
  await assert.rejects(controller.exportSession(), { message: 'The session file is too large to include the audio. Download the visual replay without audio instead.' });
  assert.equal(controller.getState().exportWithoutAudio, true);
  assert.equal(controller.getState().phase, 'stopped');
  const clicked = [];
  const saved = { createElement: document.createElement, documentElement: document.documentElement };
  document.createElement = () => ({ style: {}, click() { clicked.push(this.download); }, remove() {} });
  document.documentElement = { appendChild: noop };
  // download() revokes the object URL after 60 s; don't hold the test process open.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const t = realSetTimeout(fn, ms, ...args);
    if (ms >= 60_000) t.unref?.();
    return t;
  };
  try {
    const res = await controller.exportSession({ withoutAudio: true });
    assert.equal(res.withoutAudio, true);
    assert.equal(clicked.length, 1);
  } finally {
    Object.assign(document, saved);
    globalThis.setTimeout = realSetTimeout;
  }
});

test('after a devicechange, Retry swaps to a fresh stream; events from the old capture are ignored', async () => {
  const { seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  seen.observe('device-change');
  assert.equal(controller.getState().audio.deviceChanged, true);
  const old = seen.capture;
  const oldProblem = seen.problem;
  const releases = seen.releases;
  assert.equal((await controller.retryMic()).ok, true);
  assert.notEqual(seen.capture, old, 'new capture');
  assert.equal(seen.releases, releases + 1, 'old stream released');
  assert.equal(controller.getState().audio.deviceChanged, false);
  oldProblem('ended'); // the released stream's tracks ending must not demote the new one
  seen.capture.emit();
  await settle();
  assert.equal(controller.getState().audio.status, 'live');
  await controller.stop();
});

test('a Retry grant landing while pause() persists never records through the pause', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  seen.capture.emit();
  await settle();
  seen.capture.kill();
  seen.problem('ended');
  const update = store.updateSession;
  store.updateSession = async (...args) => {
    await new Promise((r) => setTimeout(r, 50)); // slow IndexedDB write
    return update(...args);
  };
  const pausing = controller.pause();
  await new Promise((r) => setTimeout(r, 5)); // pause() is now awaiting persist, phase still 'recording'
  const retry = controller.retryMic();
  await Promise.all([pausing, retry]);
  await settle();
  const s = controller.getState();
  assert.equal(s.phase, 'paused');
  assert.equal(seen.capture.isRecording(), false, 'no segment running through the pause');
  assert.equal(seen.segments.length, 1);
  assert.ok(!['live', 'reconnecting'].includes(s.audio.status), s.audio.status);
  store.updateSession = update;
  await controller.resume();
  assert.equal(seen.segments.length, 2, 'resume starts it');
});

test('a denial at Start sets stopAsking so later pages never prompt', async () => {
  const store = memoryStore();
  const { deps, seen } = fakeDeps({ micError: Object.assign(new Error('no'), { name: 'NotAllowedError' }) });
  const controller = await createController({ config, store, deps });
  await controller.beginPreflight();
  await controller.start({ consent: true, audio: true });
  assert.equal(savedSession(store).audio.enabled, true);
  assert.equal(savedSession(store).audio.stopAsking, true);
  assert.equal(controller.getState().audio.stopAsking, true);
  const acquires = seen.acquires;
  const next = await navigate(store, controller);
  assert.equal(next.seen.acquires, 0, 'no prompt on the next page');
  assert.equal(seen.acquires, acquires);
});

test('skipTask ends the task as skipped, counts it apart from completed ones, and advances', async () => {
  const { store, seen, controller } = await startSession();
  await controller.nextTask();
  await controller.skipTask();
  let s = controller.getState();
  assert.equal(s.phase, 'recording');
  assert.equal(s.taskIndex, 2);
  assert.equal(s.tasksCompleted, 1);
  assert.equal(s.tasksSkipped, 1);
  assert.equal(savedSession(store).tasksSkipped, 1, 'persisted');
  await controller.skipTask(); // the last task: stops like nextTask()
  s = controller.getState();
  assert.equal(s.phase, 'stopped');
  assert.equal(s.tasksSkipped, 2);
  const ends = store.log.filter((e) => e.type === 'task-end');
  assert.deepEqual(ends.map((e) => [e.taskId, e.completed, e.reason]), [['t1', true, undefined], ['t2', false, 'skipped'], ['t3', false, 'skipped']]);
  assert.deepEqual(seen.marks.filter((m) => m.tag === 'testkit:task-end').map((m) => m.payload.reason), [undefined, 'skipped', 'skipped']);
  assert.equal(store.log.filter((e) => e.type === 'session-end').length, 1);
});

test('skipTask is a no-op while paused and records no follow-up answer', async () => {
  const { store, controller } = await startSession();
  await controller.pause();
  await controller.skipTask();
  assert.equal(controller.getState().taskIndex, 0);
  await controller.resume();
  await controller.skipTask({ followUpAnswer: 'ignored' });
  assert.equal(store.log.filter((e) => e.type === 'followup').length, 0);
  assert.equal(controller.getState().taskIndex, 1);
});

// download() needs an anchor and revokes the object URL after 60 s.
async function withDownloadStubs(fn) {
  const saved = { createElement: document.createElement, documentElement: document.documentElement };
  document.createElement = () => ({ style: {}, click() {}, remove() {} });
  document.documentElement = { appendChild: noop };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => {
    const t = realSetTimeout(cb, ms, ...args);
    if (ms >= 60_000) t.unref?.();
    return t;
  };
  try {
    return await fn();
  } finally {
    Object.assign(document, saved);
    globalThis.setTimeout = realSetTimeout;
  }
}

function exportable(store) {
  store.loadSessionData = async (id) => ({ session: structuredClone(store.sessions.get(id)), events: [], log: [], audio: [], audioDropped: [] });
}

test('Start new session from stopped: cancel returns to the stopped session; start keeps an undownloaded one', async () => {
  const { store, controller } = await startSession();
  await controller.stop();
  const oldId = controller.getState().sessionId;
  assert.equal(controller.getState().downloaded, false);
  await controller.beginPreflight();
  assert.equal(controller.getState().phase, 'preflight');
  assert.equal(controller.getState().previousDownloadedAt, null);
  assert.equal(store.getLastSessionId('study-a'), oldId, 'still exportable after a reload during setup');
  await controller.cancelPreflight();
  assert.equal(controller.getState().phase, 'stopped');
  assert.equal(controller.getState().sessionId, oldId);
  await controller.beginPreflight();
  await controller.start({ consent: true, audio: false });
  const s = controller.getState();
  assert.equal(s.phase, 'recording');
  assert.notEqual(s.sessionId, oldId);
  assert.ok(store.sessions.has(oldId), 'never deletes a session that was not downloaded');
  assert.equal(store.getActiveSessionId('study-a'), s.sessionId);
  assert.equal(store.getLastSessionId('study-a'), null);
});

test('a downloaded session is marked, survives a reload as downloaded, and is deleted when the next session starts', async () => {
  const { store, controller } = await startSession();
  exportable(store);
  await controller.stop();
  const oldId = controller.getState().sessionId;
  await withDownloadStubs(() => controller.exportSession());
  assert.equal(controller.getState().downloaded, true);
  assert.ok(store.sessions.get(oldId).exportedAt > 0, 'persisted');
  const reloaded = await createController({ config, store, deps: fakeDeps().deps });
  assert.equal(reloaded.getState().phase, 'stopped');
  assert.equal(reloaded.getState().downloaded, true);
  await reloaded.beginPreflight();
  assert.equal(reloaded.getState().downloaded, false, 'setup is a fresh state');
  assert.equal(reloaded.getState().previousDownloadedAt, store.sessions.get(oldId).exportedAt, 'setup says when the previous file was downloaded');
  assert.ok(store.sessions.has(oldId), 'kept through setup');
  await reloaded.start({ consent: true, audio: false });
  assert.equal(store.sessions.has(oldId), false);
  assert.equal(store.sessions.size, 1);
});

test('a without-audio download does not count as downloaded: the audio is never deleted by starting over', async () => {
  const { store, controller } = await startSession({ audio: true });
  await controller.stop();
  const oldId = controller.getState().sessionId;
  const rec = savedSession(store);
  store.loadSessionData = async () => ({
    session: structuredClone(rec), events: [], log: [],
    audio: [{ audioSegmentId: 'a', startTs: rec.startedAt, endTs: rec.endedAt, mime: 'audio/webm', blob: new Blob(['x']) }], audioDropped: [],
  });
  await withDownloadStubs(() => controller.exportSession({ withoutAudio: true }));
  const s = controller.getState();
  assert.equal(s.downloaded, false);
  assert.equal(s.downloadedWithoutAudio, true);
  assert.equal(store.sessions.get(oldId).exportedAt, undefined);
  assert.ok(store.sessions.get(oldId).exportedWithoutAudioAt > 0, 'persisted');
  const reloaded = await createController({ config, store, deps: fakeDeps().deps });
  assert.equal(reloaded.getState().downloadedWithoutAudio, true);
  await reloaded.beginPreflight();
  await reloaded.start({ consent: true, audio: false });
  assert.ok(store.sessions.has(oldId), 'the only copy of the audio stays');
  // A full download afterwards does count.
  await withDownloadStubs(() => controller.exportSession());
  assert.equal(controller.getState().downloaded, true);
});

test('a double click on Skip/Next advances once: a call for a task that is no longer current is ignored', async () => {
  const { store, controller } = await startSession();
  await controller.nextTask({ taskIndex: 0 });
  // Second-to-last task, double-clicked: must not end the session.
  await Promise.all([controller.skipTask({ taskIndex: 1 }), controller.skipTask({ taskIndex: 1 })]);
  let s = controller.getState();
  assert.equal(s.phase, 'recording');
  assert.equal(s.taskIndex, 2);
  assert.equal(s.tasksSkipped, 1);
  await Promise.all([controller.nextTask({ taskIndex: 2 }), controller.nextTask({ taskIndex: 2 })]);
  s = controller.getState();
  assert.equal(s.phase, 'stopped');
  assert.equal(s.tasksCompleted, 2);
  assert.equal(store.log.filter((e) => e.type === 'task-end').length, 3);
});

test('free exploration (no tasks): nextTask() and skipTask() record nothing and keep recording', async () => {
  const { deps } = fakeDeps();
  const store = memoryStore();
  const controller = await createController({ config: normalizeConfig({ study: 'study-a', tasks: [] }), store, deps });
  await controller.beginPreflight();
  await controller.start({ consent: true, audio: false });
  await controller.nextTask();
  await controller.skipTask();
  const s = controller.getState();
  assert.equal(s.phase, 'recording');
  assert.equal(s.tasksCompleted, 0);
  assert.equal(s.tasksSkipped, 0);
  assert.equal(store.log.filter((e) => e.type === 'task-end').length, 0);
});

// The mirror carries the count across a navigation whose IndexedDB write was
// aborted at unload (MIRRORED in session.js must list tasksSkipped).
test('tasksSkipped survives a navigation that aborted the IndexedDB write', async () => {
  const store = memoryStore();
  const mirrors = new Map();
  store.setSessionMirror = (m) => mirrors.set(m.id, structuredClone(m));
  store.getSessionMirror = (id) => mirrors.get(id) ?? null;
  store.clearSessionMirror = (id) => mirrors.delete(id);
  const { controller } = await startSession({ store });
  await controller.skipTask();
  const id = controller.getState().sessionId;
  Object.assign(store.sessions.get(id), { tasksSkipped: 0, taskIndex: 0, rev: 1 }); // the write never landed
  const next = await createController({ config, store, deps: fakeDeps().deps });
  const s = next.getState();
  assert.equal(s.phase, 'recording');
  assert.equal(s.taskIndex, 1);
  assert.equal(s.tasksSkipped, 1);
});
