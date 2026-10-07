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
import { createAudioCapture, micErrorStatus, pickMimeType } from './audio.js';
import { clip } from './selector.js';
import { elapsedMsFor } from './store.js';
import { exportSession as buildExport } from '../export/exporter.js';

const TICK_MS = 1000;
const MAX_ANSWER = 1000;
const CHANNEL = 'testkit';
const PING_TIMEOUT_MS = 150;
const OTHER_TAB_ERROR = 'Recording is active in another tab';

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

export async function createController({ config, store }) {
  const listeners = new Set();
  let session = null; // in-memory mirror of the SessionRecord
  let segmentId = null; // this page load's segment
  let recorder = null;
  let ilog = null;
  let audio = null;
  let ticker = null;
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
      audio: { enabled: config.audio.enabled, status: 'off', error: null },
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

  store.onError?.((err) => set({ error: `Storage error: ${messageOf(err)}` }));

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
  const MIRRORED = ['phase', 'taskIndex', 'taskStartedAt', 'tasksCompleted', 'pausedMs', 'pausedAt', 'muted', 'endedAt', 'audio'];

  function mirrorFields(rec) {
    const fields = {};
    for (const key of MIRRORED) if (key in rec) fields[key] = rec[key];
    return fields;
  }

  function persist(patch) {
    session.rev = (session.rev || 0) + 1;
    Object.assign(session, patch);
    store.setSessionMirror?.({ id: session.id, rev: session.rev, fields: mirrorFields(session) });
    return store.updateSession(session.id, { ...patch, rev: session.rev }).catch(reportError);
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
    ilog = createInteractionLog({
      mask: cfg.mask.inputs,
      getTaskId: () => currentTask()?.id ?? null,
      onEntry: (entry) => store.appendLog(id, entry),
    });
    owner = true;
    openChannel();
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
    recorder = null;
    ilog = null;
    session = null;
    segmentId = null;
    owner = false;
    otherTab = false;
  }

  // -------------------------------------------------------------------------
  // Audio

  function ensureAudio() {
    if (audio) return audio;
    audio = createAudioCapture({
      bitrate: captureConfig().audio.bitrate,
      onChunk: (chunk) => {
        if (session) store.appendAudio(session.id, chunk).catch(reportError);
      },
      onProblem: (kind, err) => {
        const error = kind === 'ended' ? 'Microphone disconnected' : `Audio recording failed: ${messageOf(err)}`;
        audio?.stopSegment();
        setAudio({ status: 'error', error });
        if (session) log('audio-gap', { gapStart: Date.now(), gapMs: null, message: error });
      },
    });
    return audio;
  }

  const sessionWantsAudio = () =>
    !!session && (state.phase === 'recording' || state.phase === 'paused') && !!session.audio?.enabled;

  /**
   * Acquires the mic. `isCurrent` lets background callers detect that the
   * lifecycle moved on (stop/discard) while the prompt was open; a stream
   * acquired for a stale caller is released unless a live session still
   * wants it, and no status is published for it.
   */
  async function acquireMic(isCurrent = () => true) {
    const a = ensureAudio();
    setAudio({ status: 'pending', error: null });
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
      setAudio({ status: state.muted ? 'muted' : 'live', error: null });
      return { ok: true };
    } catch (err) {
      if (!isCurrent()) return { ok: false, stale: true };
      const { status, error } = err?.name === 'AbortError' ? { status: 'off', error: null } : micErrorStatus(err);
      setAudio({ status, error });
      return { ok: false, error: error || messageOf(err) };
    }
  }

  async function releaseAudio() {
    const a = audio;
    audio = null;
    if (a) await a.release();
  }

  function startAudioSegment() {
    if (!session?.audio.enabled || !audio?.isLive() || audio.isRecording()) return false;
    try {
      audio.startSegment();
      setAudio({ status: state.muted ? 'muted' : 'live', error: null });
      return true;
    } catch (err) {
      setAudio({ status: 'error', error: messageOf(err) });
      return false;
    }
  }

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
    const res = await acquireMic(isCurrent);
    if (!isCurrent() || res.stale) return;
    if (!res.ok) {
      // Don't re-prompt on every page once the tester has said no.
      if (state.audio.status === 'denied') persist({ audio: { ...session.audio, enabled: false } });
      log('audio-gap', { gapStart, gapMs: null, message: `Microphone unavailable: ${res.error}` });
      return;
    }
    if (state.phase !== 'recording') return; // resume() starts the segment
    if (startAudioSegment()) log('audio-gap', { gapStart, gapMs: Math.max(0, Date.now() - gapStart) });
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
  // ending because the session was stopped.
  function endTask({ completed }) {
    const task = currentTask();
    if (!task) return;
    log('task-end', { taskId: task.id, completed });
    mark('testkit:task-end', { taskId: task.id, index: session.taskIndex, completed });
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
      audio: { enabled: !!session.audio?.enabled, status: 'off', error: null },
      otherTab: false,
      error: null,
    };
  }

  async function resumeSession(rec) {
    generation++;
    if (await capturedElsewhere(rec.id)) {
      // Show the session read-only; never write to it from this tab.
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
    state = stateFromSession(rec.phase);
    if (rec.phase === 'recording') {
      startCapture({ pageLoad: true });
      log('session-resume', {});
      startTicker();
      if (captureConfig().audio.enabled && session.audio?.enabled) {
        restartAudioAfterNavigation().catch(reportError);
      }
    } else {
      // Paused: nothing is captured until resume(), which also re-acquires the mic.
      log('session-resume', {});
    }
    emit();
  }

  async function loadActive() {
    const activeId = store.getActiveSessionId?.(config.study);
    if (!activeId) return null;
    const rec = withMirror(await store.getSession(activeId).catch(() => null));
    if (rec && rec.study === config.study && (rec.phase === 'recording' || rec.phase === 'paused')) return rec;
    store.clearActiveSessionId?.(config.study);
    return null;
  }

  async function bootFromStore() {
    const active = await loadActive();
    if (active) return resumeSession(active);
    // A stopped-but-not-discarded session stays exportable across reloads.
    const lastId = store.getLastSessionId?.(config.study);
    if (lastId) {
      const rec = withMirror(await store.getSession(lastId).catch(() => null));
      if (rec?.phase === 'stopped' && rec.study === config.study) {
        session = rec;
        state = stateFromSession('stopped');
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
          audio?.stopSegment();
          store.flush?.();
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
        // Leaving 'stopped' keeps that session's data until it's discarded.
        session = null;
        set({ ...idleState(), phase: 'preflight' });
      });
    },

    cancelPreflight() {
      return act(async () => {
        if (state.phase !== 'preflight') return;
        await releaseAudio();
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
        if (useAudio && !audio?.isLive()) await acquireMic(() => state.phase === 'preflight');
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
          audio: { enabled: audioOk, mime: audioOk ? pickMimeType() || null : null },
          muted: false,
          pausedMs: 0,
          pausedAt: null,
          taskStartedAt: null,
          tasksCompleted: 0,
        };
        await store.createSession(session);
        store.setActiveSessionId?.(session.study, session.id);
        store.clearLastSessionId?.(session.study);
        attachCapture();
        state = {
          ...stateFromSession('recording'),
          // enabled reflects intent, so a denied mic is shown as denied rather than off.
          audio: useAudio
            ? { enabled: true, status: audioOk ? 'live' : state.audio.status, error: audioOk ? null : state.audio.error }
            : { enabled: false, status: 'off', error: null },
        };
        startCapture();
        log('session-start', { taskId: null });
        if (audioOk) startAudioSegment();
        if (tasks.length) await beginTask(0);
        startTicker();
        emit();
      });
    },

    nextTask({ followUpAnswer } = {}) {
      return act(async () => {
        if (state.phase !== 'recording') return;
        flushInputs();
        const task = currentTask();
        if (task && followUpAnswer != null && String(followUpAnswer).trim()) {
          log('followup', { taskId: task.id, text: clip(task.followUp || ''), answer: String(followUpAnswer).trim().slice(0, MAX_ANSWER) });
        }
        endTask({ completed: true });
        const counted = persist({ tasksCompleted: (session.tasksCompleted || 0) + 1 });
        const next = session.taskIndex + 1;
        if (next < session.tasks.length) await Promise.all([counted, beginTask(next)]);
        else await doStop({ taskEnded: true });
      });
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
        await audio?.stopSegment();
        await persist({ phase: 'paused', pausedAt: now });
        stopTicker();
        set({ phase: 'paused' });
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
        if (captureConfig().audio.enabled && session.audio?.enabled) {
          const gen = generation;
          if (!audio?.isLive()) {
            const res = await acquireMic(() => gen === generation && state.phase === 'recording');
            if (!res.ok && !res.stale) log('audio-gap', { gapStart: now, gapMs: null, message: `Microphone unavailable: ${res.error}` });
          }
          if (gen === generation && state.phase === 'recording') startAudioSegment();
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
        const status = state.audio.status === 'live' || state.audio.status === 'muted' ? (muted ? 'muted' : 'live') : state.audio.status;
        set({ muted, audio: { ...state.audio, status } });
      });
    },

    stop() {
      return act(() => doStop());
    },

    // Resolves with { filename, bytes }; rejects on failure (the message is
    // also put in state.error), so callers must handle the rejection.
    exportSession() {
      return act(async () => {
        if (state.phase !== 'stopped' || !session) return { error: 'No stopped session to export' };
        set({ phase: 'exporting', error: null });
        try {
          const data = await store.loadSessionData(session.id);
          const { filename, blob, html, bytes } = await buildExport(data);
          if (!blob && typeof html !== 'string') throw new Error('Exporter returned no file');
          download(filename, blob ?? html);
          set({ phase: 'stopped' });
          return { filename, bytes };
        } catch (err) {
          console.warn('[TestKit] export failed', err);
          const error = `Export failed: ${messageOf(err)}`;
          set({ phase: 'stopped', error });
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

  async function doStop({ taskEnded = false } = {}) {
    if (state.phase !== 'recording' && state.phase !== 'paused') return;
    generation++; // cancels a pending audio restore
    const now = Date.now();
    const wasRecording = state.phase === 'recording';
    flushInputs();
    if (!taskEnded) endTask({ completed: false });
    log('session-end', {});
    if (wasRecording) mark('testkit:session-end', {});
    stopCapture();
    stopTicker();
    owner = false;
    await releaseAudio();
    const pausedMs = (session.pausedMs || 0) + (session.pausedAt ? now - session.pausedAt : 0);
    await persist({ phase: 'stopped', endedAt: now, pausedAt: null, pausedMs, taskStartedAt: null });
    await store.flush?.();
    store.clearActiveSessionId?.(session.study);
    store.setLastSessionId?.(session.study, session.id);
    // IndexedDB now holds the final record; the mirror would only go stale.
    store.clearSessionMirror?.(session.id);
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
