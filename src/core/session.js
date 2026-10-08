// Session controller: the only object the overlay talks to. Owns the session
// lifecycle (preflight → recording ⇄ paused → stopped → export/discard) and
// coordinates rrweb, the interaction log, audio and the store. See
// "Controller" in docs/CONTRACTS.md.
//
// State-changing methods run through a serial queue so double clicks and fast
// sequences (pause → resume) can't interleave. Nothing here throws into the
// page: failures land in state.error.

import { createRecorder } from './recorder.js';
import { createInteractionLog } from './interaction-log.js';
import { classifyMicError, createAudioCapture, micPermissionState, pickMimeType } from './audio.js';
import { clip } from './selector.js';
import { elapsedMsFor } from './store.js';
import { exportSession as buildExport } from '../export/exporter.js';
import { AUDIO_EXPORT_FAILED } from '../export/payload.js';
import { audioReport } from '../export/summary.js';

const TICK_MS = 1000;
const MAX_ANSWER = 1000;
const CHANNEL = 'testkit';
const PING_TIMEOUT_MS = 150;
const OTHER_TAB_ERROR = 'Recording is active in another tab';
// A session untouched for this long is not resumed (tab closed, browser
// crashed): it's stopped and left exportable. Must match src/loader.js.
export const STALE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 15_000;
const REAL_DEPS = { createRecorder, createInteractionLog, createAudioCapture };

// Failure copy (docs/CONTRACTS.md → Audio state). Supported session length is
// 60 minutes; past that, these are what the tester sees when limits hit.
export const AUDIO_QUOTA_ERROR = 'Browser storage is full, so audio stopped saving. The screen is still recording; stop and download the session soon.';
export const AUDIO_SAVE_ERROR = 'Audio could not be saved';
export const STORAGE_FULL_ERROR = 'Browser storage is full. Stop and download the session now; new activity may not be saved.';
export const MIC_DISCONNECTED = 'Microphone disconnected';
export const MIC_TURNED_OFF = 'Microphone turned off by the tester';
export { AUDIO_EXPORT_FAILED };

const isQuotaError = (err) => err?.name === 'QuotaExceededError' || /quota/i.test(err?.message || '');

// SessionRecord.audio as written by any version: older records cleared
// `enabled` on a confirmed denial instead of setting `stopAsking`.
function audioFields(audio) {
  const a = audio || {};
  return { enabled: !!a.enabled, mime: a.mime ?? null, stopAsking: typeof a.stopAsking === 'boolean' ? a.stopAsking : a.enabled === false };
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function messageOf(err) {
  return err?.message || String(err);
}

// The config may hold functions (`activate`), which IndexedDB can't clone.
function snapshotConfig(config) {
  return JSON.parse(JSON.stringify(config, (key, value) => (typeof value === 'function' ? '[function]' : value)));
}

// The exporter hands back a Blob assembled from parts (never one giant string).
function download(filename, file) {
  const blob = file instanceof Blob ? file : new Blob([file], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.className = 'testkit-block';
  a.style.display = 'none';
  // Firefox only honours clicks on attached anchors.
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  // Safari starts the download asynchronously; revoking immediately can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * `deps` swaps the capture modules (tests use fakes); defaults to the real ones.
 */
export async function createController({ config, store, deps = {} }) {
  const { createRecorder, createInteractionLog, createAudioCapture } = { ...REAL_DEPS, ...deps };
  const listeners = new Set();
  let session = null; // in-memory mirror of the SessionRecord
  // The stopped session a "Start new session" preflight left: cancelPreflight()
  // returns to it; start() deletes it only if it was downloaded.
  let previous = null;
  let segmentId = null; // this page load's segment
  let recorder = null;
  let ilog = null;
  let audio = null;
  let ticker = null;
  let heartbeat = null;
  let ended = false; // session-end was logged on this page: later entries are dropped
  let chain = Promise.resolve();
  // Bumped whenever a session's lifecycle on this page ends or restarts, so
  // background work (audio restore) started earlier can tell it's stale.
  let generation = 0;
  let owner = false; // this page is the one capturing session.id
  let otherTab = false; // session.id is being captured by another tab
  let channel = null;

  let state = idleState();

  function idleState() {
    return {
      phase: 'idle',
      sessionId: null,
      study: config.study,
      tasks: config.tasks,
      taskIndex: -1,
      startedAt: null,
      taskStartedAt: null,
      muted: false,
      audio: { enabled: config.audio.enabled, stopAsking: false, status: 'off', error: null },
      savedAudio: null,
      exportWithoutAudio: false,
      downloaded: false,
      downloadedWithoutAudio: false,
      otherTab: false,
      error: null,
    };
  }

  // Recording settings come from the session's saved config once it exists:
  // a later page with a different local config must never change masking,
  // audio or snapshot behaviour mid-session.
  const captureConfig = () => (session?.config ? { ...config, ...session.config } : config);

  // -------------------------------------------------------------------------
  // State & subscribers

  function getState() {
    return {
      ...state,
      elapsedMs: elapsedMsFor(session),
      taskElapsedMs: taskElapsedMs(),
      tasksCompleted: session?.tasksCompleted ?? 0,
      tasksSkipped: session?.tasksSkipped ?? 0,
      audio: { ...state.audio },
    };
  }

  // taskStartedAt is shifted forward on resume, so only an ongoing pause needs excluding.
  function taskElapsedMs() {
    if (!session?.taskStartedAt || state.phase === 'stopped') return 0;
    return Math.max(0, (session.pausedAt ?? Date.now()) - session.taskStartedAt);
  }

  function emit() {
    const snapshot = getState();
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        console.warn('[TestKit] state subscriber failed', err);
      }
    }
  }

  function set(patch) {
    state = { ...state, ...patch };
    emit();
  }

  function setAudio(patch) {
    set({ audio: { ...state.audio, ...patch } });
  }

  function reportError(err) {
    console.warn('[TestKit]', err);
    set({ error: messageOf(err) });
  }

  function queue(fn) {
    const run = chain.then(fn).catch((err) => reportError(err));
    chain = run;
    return run;
  }

  // Mutating API calls are inert in a tab that doesn't own the session.
  function act(fn) {
    return queue(() => (otherTab ? undefined : fn()));
  }

  function startTicker() {
    if (!ticker) ticker = setInterval(emit, TICK_MS);
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  store.onError?.((err) => set({ error: isQuotaError(err) ? STORAGE_FULL_ERROR : `Storage error: ${messageOf(err)}` }));

  // -------------------------------------------------------------------------
  // Tab ownership. A duplicated tab (or a second window) would otherwise
  // resume the same session and interleave two DOM streams on one timeline.
  // The capturing page answers pings; a resuming page that hears an answer
  // stays passive.

  function openChannel() {
    if (channel || typeof BroadcastChannel === 'undefined') return channel;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.addEventListener('message', (e) => {
        const m = e.data;
        if (m?.type === 'ping' && owner && session?.id === m.id) channel?.postMessage({ type: 'pong', id: m.id, nonce: m.nonce });
      });
    } catch {
      channel = null;
    }
    return channel;
  }

  function closeChannel() {
    try {
      channel?.close();
    } catch {
      // Already closed.
    }
    channel = null;
  }

  function capturedElsewhere(id) {
    const ch = openChannel();
    if (!ch) return Promise.resolve(false);
    const nonce = newId();
    return new Promise((resolve) => {
      const finish = (answer) => {
        clearTimeout(timer);
        ch.removeEventListener('message', onMessage);
        resolve(answer);
      };
      const onMessage = (e) => {
        if (e.data?.type === 'pong' && e.data.nonce === nonce) finish(true);
      };
      const timer = setTimeout(() => finish(false), PING_TIMEOUT_MS);
      ch.addEventListener('message', onMessage);
      try {
        ch.postMessage({ type: 'ping', id, nonce });
      } catch {
        finish(false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Persistence helpers

  // Fields that must survive an immediate navigation. An IndexedDB write still
  // in flight at unload is aborted, so each persist also mirrors these to
  // localStorage synchronously; restores apply the mirror when its rev is newer.
  const MIRRORED = ['phase', 'taskIndex', 'taskStartedAt', 'tasksCompleted', 'tasksSkipped', 'pausedMs', 'pausedAt', 'muted', 'endedAt', 'audio', 'lastActivityAt'];

  function mirrorFields(rec) {
    const fields = {};
    for (const key of MIRRORED) if (key in rec) fields[key] = rec[key];
    return fields;
  }

  // Every persist doubles as an activity heartbeat: lastActivityAt goes into
  // the record, the mirror and (while live) the loader's active pointer.
  function persist(patch) {
    const now = Date.now();
    session.rev = (session.rev || 0) + 1;
    Object.assign(session, patch, { lastActivityAt: now });
    store.setSessionMirror?.({ id: session.id, rev: session.rev, fields: mirrorFields(session) });
    if (owner && (session.phase === 'recording' || session.phase === 'paused')) {
      store.setActiveSessionId?.(session.study, session.id, now);
    }
    return store.updateSession(session.id, { ...patch, lastActivityAt: now, rev: session.rev }).catch(reportError);
  }

  function startHeartbeat() {
    if (!heartbeat) heartbeat = setInterval(() => session && owner && persist({}), HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function withMirror(rec) {
    const mirror = rec && store.getSessionMirror?.(rec.id);
    if (!rec || mirror?.id !== rec.id || !(mirror.rev > (rec.rev || 0))) return rec;
    return { ...rec, ...mirror.fields, rev: mirror.rev };
  }

  const currentTask = () => (session && session.taskIndex >= 0 ? session.tasks[session.taskIndex] || null : null);

  function log(type, fields) {
    ilog?.log(type, fields);
  }

  function mark(tag, payload) {
    recorder?.addCustomEvent(tag, payload);
  }

  // Debounced inputs belong before any boundary marker that follows them.
  function flushInputs() {
    ilog?.flushPending();
  }

  // Recorder and interaction log are bound to the session id, created once
  // per session per page.
  function attachCapture() {
    const id = session.id;
    const cfg = captureConfig();
    recorder = createRecorder({
      config: cfg,
      onEvent: (event) => store.appendEvents(id, segmentId, [event]),
    });
    ended = false;
    ilog = createInteractionLog({
      mask: cfg.mask.inputs,
      getTaskId: () => currentTask()?.id ?? null,
      // Nothing may follow session-end (e.g. a late audio-gap from a cancelled restore).
      onEntry: (entry) => {
        if (!ended) store.appendLog(id, entry);
        if (entry.type === 'session-end') ended = true;
      },
      onNavigationIntent: () => queueMicrotask(() => store.flush?.()),
    });
    owner = true;
    openChannel();
    startHeartbeat();
  }

  function startCapture({ pageLoad = false } = {}) {
    recorder.start();
    ilog.start({ pageLoad });
  }

  function stopCapture() {
    ilog?.stop();
    recorder?.stop();
  }

  function detach() {
    generation++;
    stopCapture();
    stopTicker();
    stopHeartbeat();
    recorder = null;
    ilog = null;
    session = null;
    segmentId = null;
    owner = false;
    otherTab = false;
  }

  // -------------------------------------------------------------------------
  // Audio

  // Audio status invariant: 'live' only once the active segment has had a
  // chunk persisted (Mute excepted: 'muted' is shown as soon as a segment
  // runs). Any failure demotes it; Retry goes through reconnectAudio().
  let activeAudioSeg = null; // segment the recorder is currently filling
  let confirmedSeg = null; // last segment with a successfully persisted chunk
  let failedAt = null; // when the current audio outage began (gap start for Retry)
  let retrying = null;

  function ensureAudio() {
    if (audio) return audio;
    const capture = createAudioCapture({
      bitrate: captureConfig().audio.bitrate,
      onChunk: (chunk) => {
        if (!session) return;
        const id = session.id;
        store.appendAudio(id, chunk).then(
          () => {
            if (session?.id !== id || chunk.audioSegmentId !== activeAudioSeg) return;
            confirmedSeg = chunk.audioSegmentId;
            if (state.audio.status === 'pending' || state.audio.status === 'reconnecting') setAudio({ status: 'live', error: null });
          },
          (err) => {
            // Only the segment being recorded can still be saved; a late
            // chunk of a stopped one failing changes nothing for the tester.
            if (session?.id !== id || chunk.audioSegmentId !== activeAudioSeg) return;
            console.warn('[TestKit] audio chunk not saved', err);
            audioFailed(isQuotaError(err) ? AUDIO_QUOTA_ERROR : `${AUDIO_SAVE_ERROR}: ${messageOf(err)}`);
          },
        );
      },
      // A released capture (Stop, Retry's fresh stream) no longer speaks for the session.
      onProblem: (kind, err) => {
        if (audio !== capture) return;
        audioFailed(kind === 'ended' ? MIC_DISCONNECTED : `Audio recording failed: ${messageOf(err)}`);
      },
      // Observational (see docs/audio-matrix.md): a muted track may be another
      // app holding the mic, so it is never treated as lost audio.
      onObserve: (kind) => {
        if (audio !== capture) return;
        if (kind === 'device-change') setAudio({ deviceChanged: true });
        else setAudio({ trackMuted: kind === 'track-mute' });
      },
    });
    audio = capture;
    return audio;
  }

  // Recoverable failure: stop the segment, keep visual capture running.
  function audioFailed(error) {
    stopAudioSegment();
    if (!session) {
      setAudio({ status: 'error', error });
      return;
    }
    failedAt ??= Date.now();
    setAudio({ status: 'error', error });
    log('audio-gap', { gapStart: failedAt, gapMs: null, message: error });
  }

  function stopAudioSegment() {
    activeAudioSeg = null;
    return audio ? audio.stopSegment() : Promise.resolve();
  }

  // Asking for the mic is allowed: the study has audio, the tester chose it
  // at Start, and nothing (denial, "Continue without microphone") said stop.
  const micWanted = () =>
    !!session && captureConfig().audio.enabled && !!session.audio?.enabled && !session.audio.stopAsking;

  const sessionWantsAudio = () => (state.phase === 'recording' || state.phase === 'paused') && micWanted();

  /**
   * Acquires the mic. `isCurrent` lets background callers detect that the
   * lifecycle moved on (stop/discard) while the prompt was open; a stream
   * acquired for a stale caller is released unless a live session still
   * wants it, and no status is published for it. In preflight a granted mic
   * shows as 'live' (the level check); in a session the status stays
   * `waiting` until a segment's first chunk is saved.
   */
  async function acquireMic(isCurrent = () => true, { waiting = 'pending' } = {}) {
    const a = ensureAudio();
    setAudio({ status: waiting, error: null });
    try {
      await a.acquire();
      if (!isCurrent()) {
        if (!sessionWantsAudio() || audio !== a) {
          if (audio === a) audio = null;
          await a.release();
        }
        return { ok: false, stale: true };
      }
      a.setMuted(state.muted);
      const ready = state.phase === 'preflight' ? 'live' : waiting;
      setAudio({ status: state.muted ? 'muted' : ready, error: null });
      return { ok: true };
    } catch (err) {
      if (!isCurrent()) return { ok: false, stale: true };
      if (err?.name === 'AbortError') {
        setAudio({ status: 'off', error: null });
        return { ok: false, error: messageOf(err) };
      }
      const { status, error, persistent } = await classifyMicError(err);
      if (!isCurrent()) return { ok: false, stale: true };
      setAudio({ status, error });
      return { ok: false, status, error: error || messageOf(err), persistent };
    }
  }

  async function releaseAudio() {
    const a = audio;
    audio = null;
    activeAudioSeg = null;
    if (a) await a.release();
  }

  function startAudioSegment({ waiting = 'pending' } = {}) {
    if (!micWanted() || !audio?.isLive() || audio.isRecording()) return false;
    try {
      activeAudioSeg = audio.startSegment();
      failedAt = null;
      setAudio({ status: state.muted ? 'muted' : waiting, error: null });
      return true;
    } catch (err) {
      activeAudioSeg = null;
      setAudio({ status: 'error', error: messageOf(err) });
      return false;
    }
  }

  /**
   * The one way audio comes back once it stopped: Retry, resume() after the
   * stream was released, and the restart after a navigation all run through
   * here. Waits for the failed segment's stopSegment() to settle, re-acquires
   * (dropping the result if the lifecycle moved on), starts a new segment
   * when recording and logs the gap; the gap itself is derived from segment
   * coverage, the log entry only supplies the reason. A denial never touches
   * saved segments, but sets stopAsking so no later page asks again.
   *
   * Callers outside the serial queue (Retry, the post-navigation restart)
   * pass `inQueue: false`: the grant can land while pause() is mid-way, so
   * the segment start is queued behind it and re-checks the phase there.
   */
  async function reconnectAudio({ gapStart, isCurrent, waiting, inQueue }) {
    await stopAudioSegment();
    if (!isCurrent()) return { ok: false, stale: true };
    const res = await acquireMic(isCurrent, { waiting });
    if (!isCurrent() || res.stale) return { ok: false, stale: true };
    if (!res.ok) {
      const stop = deniedInSession(res);
      if (stop) persist({ audio: { ...audioFields(session.audio), stopAsking: true } });
      set({ audio: { ...state.audio, stopAsking: stop || state.audio.stopAsking } });
      failedAt ??= gapStart;
      log('audio-gap', { gapStart, gapMs: null, message: `Microphone unavailable: ${res.error}` });
      return { ...res, persistent: stop };
    }
    const begin = () => {
      if (!isCurrent()) return { ok: false, stale: true };
      if (state.phase !== 'recording') {
        // Paused: resume() starts the segment. Not 'live' and no longer reconnecting.
        if (state.audio.status === 'reconnecting') setAudio({ status: state.muted ? 'muted' : 'pending' });
        return { ok: true };
      }
      if (startAudioSegment({ waiting })) log('audio-gap', { gapStart, gapMs: Math.max(0, Date.now() - gapStart) });
      return { ok: true };
    };
    return inQueue ? begin() : queue(begin);
  }

  // Inside a session any NotAllowedError stops the asking, whatever the
  // Permissions API says: Firefox and Safari don't remember a one-off "Block"
  // (state stays 'prompt'), so otherwise every navigation would re-prompt.
  // Retry clears it when the tester asks.
  const deniedInSession = (res) => !!res.persistent || res.status === 'denied';

  // After a navigation the previous page's recorder is gone. Re-acquire the
  // mic without blocking boot (Safari may re-prompt) and log the silence.
  // Every await is followed by a staleness check: Stop or Discard may have
  // happened meanwhile, and must never be followed by a live microphone.
  async function restartAudioAfterNavigation() {
    const gen = generation;
    const id = session.id;
    const isCurrent = () => gen === generation && session?.id === id && (state.phase === 'recording' || state.phase === 'paused');
    const last = await store.lastAudioChunk?.(id).catch(() => null);
    if (!isCurrent()) return;
    // With no stored chunk (e.g. the previous page's audio never persisted),
    // the gap runs from the previous page's start, else the session start.
    const segments = session.segments || [];
    const gapStart = last?.ts ?? segments[segments.length - 2]?.startedAt ?? session.startedAt;
    await reconnectAudio({ gapStart, isCurrent, waiting: 'pending', inQueue: false });
  }

  // A later page of a session that stopped asking after a denial: say
  // "blocked" (with the site-settings help) rather than "off", without asking.
  async function showRememberedDenial() {
    if (!session?.audio?.enabled || !session.audio.stopAsking || !captureConfig().audio.enabled) return;
    const id = session.id;
    if ((await micPermissionState()) !== 'denied' || session?.id !== id || state.audio.status !== 'off') return;
    setAudio({ status: 'denied', error: 'Microphone access was denied' });
  }

  // Pre-download "saved audio" verdict, from persisted segments only and
  // through the same audioReport() the export's summary and player use.
  async function refreshSavedAudio() {
    if (!session || !store.loadAudioReport) return;
    const id = session.id;
    try {
      const data = await store.loadAudioReport(id);
      if (session?.id !== id) return;
      const r = audioReport({ session: data.session, log: data.log, audio: data.audio, dropped: data.audioDropped });
      state = { ...state, savedAudio: { kind: r.kind, label: r.label, gaps: r.gaps.length, gapMs: r.gapMs, segments: r.segments, unreliable: r.unreliable, dropped: r.dropped } };
    } catch (err) {
      console.warn('[TestKit] could not read saved audio', err);
      state = { ...state, savedAudio: null };
    }
  }

  // -------------------------------------------------------------------------
  // Tasks

  // Returns the persist promise: callers await it so a navigation right after
  // "Next task" resumes on the new task, not the previous one.
  function beginTask(index) {
    const task = session.tasks[index];
    const saved = persist({ taskIndex: index, taskStartedAt: Date.now() });
    log('task-start', { taskId: task.id, text: clip(task.prompt) });
    mark('testkit:task-start', { taskId: task.id, index, prompt: task.prompt });
    set({ taskIndex: index, taskStartedAt: session.taskStartedAt });
    return saved;
  }

  // `completed` separates finishing a task (Next) from the span merely
  // ending because the session was stopped; `reason: 'skipped'` marks a task
  // the tester gave up on (Skip task).
  function endTask({ completed, reason }) {
    const task = currentTask();
    if (!task) return;
    const why = reason ? { reason } : {};
    log('task-end', { taskId: task.id, completed, ...why });
    mark('testkit:task-end', { taskId: task.id, index: session.taskIndex, completed, ...why });
  }

  // Next and Skip: end the current task, count it, then begin the next one
  // or stop after the last. `taskIndex` is the task the click was for: a
  // second click queued behind the first (double click) is stale and ignored.
  async function advance({ skipped, followUpAnswer, taskIndex }) {
    if (state.phase !== 'recording') return;
    if (taskIndex != null && taskIndex !== session.taskIndex) return;
    // Free exploration (no tasks): nothing to end or count; Finish is stop().
    const task = currentTask();
    if (!task) return;
    flushInputs();
    if (!skipped && followUpAnswer != null && String(followUpAnswer).trim()) {
      log('followup', { taskId: task.id, text: clip(task.followUp || ''), answer: String(followUpAnswer).trim().slice(0, MAX_ANSWER) });
    }
    endTask(skipped ? { completed: false, reason: 'skipped' } : { completed: true });
    const counted = persist(skipped ? { tasksSkipped: (session.tasksSkipped || 0) + 1 } : { tasksCompleted: (session.tasksCompleted || 0) + 1 });
    const next = session.taskIndex + 1;
    if (next < session.tasks.length) await Promise.all([counted, beginTask(next)]);
    else await doStop({ taskEnded: true });
  }

  // -------------------------------------------------------------------------
  // Restoring a session after a page load (or a bfcache restore)

  function stateFromSession(phase) {
    return {
      phase,
      sessionId: session.id,
      study: session.study,
      tasks: session.tasks,
      taskIndex: session.taskIndex,
      startedAt: session.startedAt,
      taskStartedAt: phase === 'stopped' ? null : session.taskStartedAt ?? null,
      muted: !!session.muted,
      audio: { enabled: audioFields(session.audio).enabled, stopAsking: audioFields(session.audio).stopAsking, status: 'off', error: null },
      savedAudio: null,
      exportWithoutAudio: false,
      downloaded: !!session.exportedAt,
      downloadedWithoutAudio: !!session.exportedWithoutAudioAt,
      otherTab: false,
      error: null,
    };
  }

  async function resumeSession(rec) {
    generation++;
    // A bfcache restore may arrive with the old page's ticker and mic still live.
    stopTicker();
    if (await capturedElsewhere(rec.id)) {
      // Show the session read-only; never write to it from this tab.
      await releaseAudio();
      stopHeartbeat();
      session = rec;
      otherTab = true;
      state = { ...stateFromSession(rec.phase), otherTab: true, error: OTHER_TAB_ERROR };
      emit();
      return;
    }
    otherTab = false;
    session = rec;
    segmentId = newId();
    const segments = [...(rec.segments || []), { segmentId, url: location.href, startedAt: Date.now() }];
    // Also rewrites the mirrored fields so a mirror-reconciled record lands in IndexedDB.
    await persist({ ...mirrorFields(rec), segments });
    attachCapture();
    store.setActiveSessionId?.(session.study, session.id, session.lastActivityAt);
    state = stateFromSession(rec.phase);
    if (rec.phase === 'recording') {
      startCapture({ pageLoad: true });
      log('session-resume', {});
      startTicker();
      if (micWanted()) restartAudioAfterNavigation().catch(reportError);
      else showRememberedDenial().catch(() => {});
    } else {
      // Paused: nothing is captured until resume(), which also re-acquires the
      // mic. Release any stream a bfcache restore brought back.
      await releaseAudio();
      log('session-resume', {});
    }
    emit();
  }

  // The last moment the session was demonstrably alive.
  function lastActivity(rec, pointer) {
    const segments = rec.segments || [];
    return Math.max(
      Number(pointer?.lastActivityAt) || 0,
      Number(rec.lastActivityAt) || 0,
      Number(segments[segments.length - 1]?.startedAt) || 0,
      Number(rec.startedAt) || 0,
    );
  }

  // Stops a session that went quiet (tab closed, crash) without resuming
  // capture, ending it at its last activity so it stays exportable.
  async function stopStale(rec, at) {
    session = rec;
    const url = rec.segments?.[rec.segments.length - 1]?.url ?? location.href;
    const task = currentTask();
    store.setLastSessionId?.(rec.study, rec.id);
    store.clearActiveSessionId?.(rec.study);
    if (task) store.appendLog(rec.id, { ts: at, type: 'task-end', url, taskId: task.id, completed: false, reason: 'stale' });
    store.appendLog(rec.id, { ts: at, type: 'session-end', url, taskId: null, reason: 'stale' });
    const pausedMs = (rec.pausedMs || 0) + (rec.pausedAt ? Math.max(0, at - rec.pausedAt) : 0);
    await persist({ phase: 'stopped', endedAt: at, pausedAt: null, pausedMs, taskStartedAt: null });
    await store.flush?.();
    store.clearSessionMirror?.(rec.id);
    state = stateFromSession('stopped');
    await refreshSavedAudio();
    emit();
  }

  // Returns { resume } for a live session to resume, or { done: true } when
  // the active session was handled here (stale → stopped).
  async function loadActive() {
    const pointer = store.getActivePointer?.(config.study);
    const activeId = pointer?.id ?? store.getActiveSessionId?.(config.study);
    if (!activeId) return {};
    const rec = withMirror(await store.getSession(activeId).catch(() => null));
    if (rec && rec.study === config.study) {
      if (rec.phase === 'recording' || rec.phase === 'paused') {
        const at = lastActivity(rec, pointer);
        if (Date.now() - at > STALE_MS) {
          await stopStale(rec, at);
          return { done: true };
        }
        return { resume: rec };
      }
      // Stopped (the stopping page died before moving the pointer): keep it exportable.
      if (rec.phase === 'stopped') store.setLastSessionId?.(rec.study, rec.id);
    }
    store.clearActiveSessionId?.(config.study);
    return {};
  }

  async function bootFromStore() {
    // Rows the previous page spilled at unload land before anything reads or appends.
    await store.importSpill?.();
    const active = await loadActive();
    if (active.done) return;
    if (active.resume) return resumeSession(active.resume);
    // A stopped-but-not-discarded session stays exportable across reloads.
    const lastId = store.getLastSessionId?.(config.study);
    if (lastId) {
      const rec = withMirror(await store.getSession(lastId).catch(() => null));
      if (rec?.phase === 'stopped' && rec.study === config.study) {
        session = rec;
        state = stateFromSession('stopped');
        await refreshSavedAudio();
        emit();
        return;
      }
      store.clearLastSessionId?.(config.study);
    }
  }

  // -------------------------------------------------------------------------
  // Page lifecycle

  window.addEventListener(
    'pagehide',
    () => {
      try {
        if (session && state.phase === 'recording' && owner) {
          flushInputs();
          // Best effort: the final chunk is written only if the page lives long enough.
          stopAudioSegment();
          store.flush?.();
          store.spill?.();
        }
        // A page entering bfcache must not answer pings for a session it no
        // longer captures; pageshow re-establishes ownership.
        owner = false;
        closeChannel();
      } catch {
        // Unloading; nothing useful left to do.
      }
    },
    { capture: true },
  );

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Hidden usually precedes pagehide: get buffered audio out while the page can still write it.
      if (owner && state.phase === 'recording') audio?.requestData();
      return;
    }
    // A passive tab whose owner went away takes over when the tester returns to it.
    if (otherTab && session) {
      queue(async () => {
        if (!otherTab || !session) return;
        const rec = withMirror(await store.getSession(session.id).catch(() => null));
        if (rec && (rec.phase === 'recording' || rec.phase === 'paused')) await resumeSession(rec);
      });
    }
  });

  // Restored from bfcache: another page may have advanced (or stopped) the
  // session meanwhile, so re-read it rather than trusting memory.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || !session) return;
    queue(async () => {
      const id = session?.id;
      if (!id) return;
      const rec = withMirror(await store.getSession(id).catch(() => null));
      stopCapture();
      if (rec && (rec.phase === 'recording' || rec.phase === 'paused')) {
        await resumeSession(rec);
        return;
      }
      await releaseAudio();
      detach();
      if (rec?.phase === 'stopped') {
        session = rec;
        state = stateFromSession('stopped');
        await refreshSavedAudio();
        emit();
      } else {
        set(idleState());
      }
    });
  });

  // -------------------------------------------------------------------------
  // Public API

  const controller = {
    getState,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    beginPreflight() {
      return act(async () => {
        if (state.phase !== 'idle' && state.phase !== 'stopped') return;
        // Leaving 'stopped' keeps that session's data (and testkit:last) until
        // the new session actually starts; see start().
        if (state.phase === 'stopped') previous = session;
        session = null;
        set({ ...idleState(), phase: 'preflight' });
      });
    },

    cancelPreflight() {
      return act(async () => {
        if (state.phase !== 'preflight') return;
        await releaseAudio();
        const prev = previous;
        previous = null;
        // Back to the stopped session this setup was started from, if it's still there.
        const rec = prev && withMirror(await store.getSession(prev.id).catch(() => null));
        if (rec?.phase === 'stopped' && state.phase === 'preflight') {
          session = rec;
          state = stateFromSession('stopped');
          await refreshSavedAudio();
          emit();
          return;
        }
        set(idleState());
      });
    },

    // Deliberately not queued: the permission prompt can stay open
    // indefinitely and must not block cancelPreflight().
    async requestMic() {
      if (!config.audio.enabled) return { ok: false, error: 'Audio is disabled for this study' };
      if (state.phase !== 'preflight') return { ok: false, error: 'Not in preflight' };
      try {
        return await acquireMic(() => state.phase === 'preflight');
      } catch (err) {
        reportError(err);
        return { ok: false, error: messageOf(err) };
      }
    },

    getMicLevel() {
      return audio ? audio.getLevel() : 0;
    },

    start({ consent, audio: wantAudio = true } = {}) {
      return act(async () => {
        if (state.phase !== 'preflight') return;
        if (consent !== true) {
          set({ error: 'Consent is required before recording' });
          return;
        }
        const consentAt = Date.now();
        const useAudio = config.audio.enabled && wantAudio !== false;
        const startMic = useAudio && !audio?.isLive() ? await acquireMic(() => state.phase === 'preflight') : null;
        if (!useAudio) {
          await releaseAudio();
          setAudio({ enabled: false, status: 'off', error: null });
        }
        if (state.phase !== 'preflight') return; // cancelled while the prompt was open
        const audioOk = useAudio && !!audio?.isLive();
        const now = Date.now();
        const tasks = config.tasks;
        generation++;
        segmentId = newId();
        session = {
          id: newId(),
          study: config.study,
          createdAt: now,
          startedAt: now,
          endedAt: null,
          phase: 'recording',
          taskIndex: -1,
          tasks,
          config: snapshotConfig(config),
          meta: {
            prototypeUrl: location.href,
            commitSha: config.commitSha,
            userAgent: navigator.userAgent,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            consentAt,
          },
          segments: [{ segmentId, url: location.href, startedAt: now }],
          // enabled = the tester chose voice; stopAsking = never prompt again.
          audio: { enabled: useAudio, mime: audioOk ? pickMimeType() || null : null, stopAsking: !!startMic && !startMic.ok && deniedInSession(startMic) },
          muted: false,
          pausedMs: 0,
          pausedAt: null,
          taskStartedAt: null,
          tasksCompleted: 0,
          tasksSkipped: 0,
        };
        // Pointer first: a navigation during the createSession await must not orphan the record.
        store.setActiveSessionId?.(session.study, session.id, now);
        store.clearLastSessionId?.(session.study);
        session.lastActivityAt = now;
        await store.createSession(session);
        await dropPrevious();
        attachCapture();
        state = {
          ...stateFromSession('recording'),
          // enabled reflects intent, so a denied mic is shown as denied rather than off.
          audio: useAudio
            ? { enabled: true, stopAsking: session.audio.stopAsking, status: audioOk ? 'pending' : state.audio.status, error: audioOk ? null : state.audio.error }
            : { enabled: false, stopAsking: false, status: 'off', error: null },
        };
        startCapture();
        log('session-start', { taskId: null });
        if (audioOk) startAudioSegment();
        if (tasks.length) await beginTask(0);
        startTicker();
        emit();
      });
    },

    nextTask({ followUpAnswer, taskIndex } = {}) {
      return act(() => advance({ skipped: false, followUpAnswer, taskIndex }));
    },

    // Like nextTask(), but the task ends as not completed (reason 'skipped')
    // and counts toward tasksSkipped; no follow-up answer is recorded.
    skipTask({ taskIndex } = {}) {
      return act(() => advance({ skipped: true, taskIndex }));
    },

    pause() {
      return act(async () => {
        if (state.phase !== 'recording') return;
        const now = Date.now();
        flushInputs();
        // Mark before stopping rrweb so the marker lands in the stream.
        mark('testkit:pause', {});
        log('pause', {});
        stopCapture();
        // Same-page pause holds the stream (no re-prompt on resume); the
        // segment stops, so the mic is no longer 'live'.
        await stopAudioSegment();
        await persist({ phase: 'paused', pausedAt: now });
        stopTicker();
        set({ phase: 'paused', audio: { ...state.audio, status: state.audio.status === 'live' ? 'pending' : state.audio.status } });
      });
    },

    resume() {
      return act(async () => {
        if (state.phase !== 'paused') return;
        const now = Date.now();
        const pausedFor = session.pausedAt ? now - session.pausedAt : 0;
        await persist({
          phase: 'recording',
          pausedAt: null,
          pausedMs: (session.pausedMs || 0) + pausedFor,
          // Shift the task clock so a timeLimit countdown excludes the pause.
          taskStartedAt: session.taskStartedAt ? session.taskStartedAt + pausedFor : null,
        });
        set({ phase: 'recording', taskStartedAt: session.taskStartedAt });
        startCapture();
        mark('testkit:resume', {});
        log('resume', {});
        startTicker();
        if (micWanted()) {
          const gen = generation;
          const isCurrent = () => gen === generation && state.phase === 'recording';
          if (audio?.isLive()) startAudioSegment();
          else await reconnectAudio({ gapStart: now, isCurrent, waiting: 'pending', inQueue: true });
        }
      });
    },

    toggleMute() {
      return act(async () => {
        if (state.phase !== 'recording' && state.phase !== 'paused') return;
        const muted = !state.muted;
        audio?.setMuted(muted);
        log(muted ? 'mute' : 'unmute', {});
        mark(muted ? 'testkit:mute' : 'testkit:unmute', {});
        await persist({ muted });
        const s = state.audio.status;
        let status = s;
        if (s === 'live' || s === 'muted' || s === 'pending') {
          const appending = !!activeAudioSeg && confirmedSeg === activeAudioSeg;
          status = muted ? 'muted' : appending ? 'live' : 'pending';
        }
        set({ muted, audio: { ...state.audio, status } });
      });
    },

    /**
     * Mid-session "Retry microphone". Not queued, like requestMic(): the
     * permission prompt may stay open, and Stop/Discard must not wait for it
     * (they bump `generation`, which makes this attempt stale and releases
     * whatever it acquired). No consent re-prompt: voice consent was given at
     * Start. Resolves { ok, error?, persistent? }; never clears saved audio.
     */
    retryMic() {
      if (retrying) return retrying;
      const active = () => !otherTab && !!session && (state.phase === 'recording' || state.phase === 'paused');
      if (!active()) return Promise.resolve({ ok: false, error: 'No active session' });
      if (!captureConfig().audio.enabled || !audioFields(session.audio).enabled) {
        return Promise.resolve({ ok: false, error: 'Audio was not chosen for this session' });
      }
      const gen = generation;
      const id = session.id;
      const isCurrent = () => gen === generation && session?.id === id && active();
      const gapStart = failedAt ?? Date.now();
      setAudio({ status: 'reconnecting', error: null, deviceChanged: false }); // progress shows at once
      retrying = (async () => {
        if (session.audio.stopAsking) {
          await persist({ audio: { ...audioFields(session.audio), stopAsking: false } });
          set({ audio: { ...state.audio, stopAsking: false } });
        }
        // Always a fresh stream: after a device change the old one is still
        // live but bound to the previous device.
        await stopAudioSegment();
        await releaseAudio();
        if (!isCurrent()) return { ok: false, stale: true };
        return reconnectAudio({ gapStart, isCurrent, waiting: 'reconnecting', inQueue: false });
      })()
        .catch((err) => {
          reportError(err);
          return { ok: false, error: messageOf(err) };
        })
        .finally(() => {
          retrying = null;
        });
      return retrying;
    },

    /** "Continue without microphone": stop asking, release the mic, keep saved audio. */
    continueWithoutMic() {
      return act(async () => {
        if (!session || (state.phase !== 'recording' && state.phase !== 'paused')) return;
        if (audio?.isRecording()) log('audio-gap', { gapStart: Date.now(), gapMs: null, message: MIC_TURNED_OFF });
        await persist({ audio: { ...audioFields(session.audio), stopAsking: true } });
        await releaseAudio();
        failedAt = null;
        setAudio({ stopAsking: true, status: 'off', error: null });
      });
    },

    stop() {
      return act(() => doStop());
    },

    // Resolves with { filename, bytes }; rejects on failure (the message is
    // also put in state.error), so callers must handle the rejection.
    // `withoutAudio` is the fallback offered (state.exportWithoutAudio) when
    // the audio can't be encoded into the file; the visual replay still works.
    exportSession({ withoutAudio = false } = {}) {
      return act(async () => {
        if (state.phase !== 'stopped' || !session) return { error: 'No stopped session to export' };
        set({ phase: 'exporting', error: null });
        try {
          const data = await store.loadSessionData(session.id);
          const { filename, blob, html, bytes } = await buildExport(data, { withoutAudio });
          if (!blob && typeof html !== 'string') throw new Error('Exporter returned no file');
          download(filename, blob ?? html);
          // Only a file with every saved byte counts as downloaded: a visual-only
          // file leaves the audio in this browser alone, so starting over must
          // still ask. Not persist(): a stopped session has no mirror or active
          // pointer to refresh.
          const full = !withoutAudio || !data.audio?.length;
          const field = full ? 'exportedAt' : 'exportedWithoutAudioAt';
          session[field] = Date.now();
          await store.updateSession(session.id, { [field]: session[field] }).catch(reportError);
          set({ phase: 'stopped', ...(full ? { downloaded: true } : { downloadedWithoutAudio: true }) });
          return { filename, bytes, withoutAudio };
        } catch (err) {
          console.warn('[TestKit] export failed', err);
          const audioTooLarge = err?.name === 'AudioExportError' || (!withoutAudio && err?.message === AUDIO_EXPORT_FAILED);
          const error = audioTooLarge ? AUDIO_EXPORT_FAILED : `Export failed: ${messageOf(err)}`;
          set({ phase: 'stopped', error, exportWithoutAudio: audioTooLarge || state.exportWithoutAudio });
          return { error };
        }
      }).then((res) => {
        if (!res || res.error) throw new Error(res?.error || state.error || 'Export failed');
        return res;
      });
    },

    discard() {
      return act(async () => {
        if (state.phase === 'idle') return;
        const id = session?.id;
        const study = session?.study ?? config.study;
        detach(); // invalidates pending restore work before anything is awaited
        await releaseAudio();
        if (id) {
          await store.deleteSession(id);
          if (store.getActiveSessionId?.(study) === id) store.clearActiveSessionId?.(study);
          if (store.getLastSessionId?.(study) === id) store.clearLastSessionId?.(study);
          store.clearSessionMirror?.(id);
        }
        set(idleState());
      });
    },
  };

  // Once the next session exists, the stopped one it replaced goes: deleted
  // if it was downloaded (it would only fill storage, unreachable from the
  // overlay), otherwise left in IndexedDB. The overlay asks before starting
  // over from an undownloaded session, so that branch is API-only.
  async function dropPrevious() {
    const prev = previous;
    previous = null;
    if (!prev?.exportedAt) return;
    try {
      await store.deleteSession(prev.id);
      store.clearSessionMirror?.(prev.id);
    } catch (err) {
      console.warn('[TestKit] could not delete the previous session', err);
    }
  }

  async function doStop({ taskEnded = false } = {}) {
    if (state.phase !== 'recording' && state.phase !== 'paused') return;
    generation++; // cancels a pending audio restore
    // Set first: however far stopping gets, the session stays exportable.
    store.setLastSessionId?.(session.study, session.id);
    const now = Date.now();
    const wasRecording = state.phase === 'recording';
    flushInputs();
    if (!taskEnded) endTask({ completed: false });
    log('session-end', {});
    if (wasRecording) mark('testkit:session-end', {});
    stopCapture();
    stopTicker();
    stopHeartbeat();
    owner = false;
    await releaseAudio();
    const pausedMs = (session.pausedMs || 0) + (session.pausedAt ? now - session.pausedAt : 0);
    await persist({ phase: 'stopped', endedAt: now, pausedAt: null, pausedMs, taskStartedAt: null });
    await store.flush?.();
    store.clearActiveSessionId?.(session.study);
    // IndexedDB now holds the final record; the mirror would only go stale.
    store.clearSessionMirror?.(session.id);
    failedAt = null;
    await refreshSavedAudio();
    set({ phase: 'stopped', taskStartedAt: null, audio: { ...state.audio, status: 'off' } });
  }

  try {
    await bootFromStore();
  } catch (err) {
    detach();
    state = { ...idleState(), error: `Could not restore session: ${messageOf(err)}` };
  }

  return controller;
}
