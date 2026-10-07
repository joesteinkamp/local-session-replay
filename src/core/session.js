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

function download(filename, html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
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
      error: null,
    };
  }

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

  function startTicker() {
    if (!ticker) ticker = setInterval(emit, TICK_MS);
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  store.onError?.((err) => set({ error: `Storage error: ${messageOf(err)}` }));

  // -------------------------------------------------------------------------
  // Persistence helpers

  function persist(patch) {
    Object.assign(session, patch);
    return store.updateSession(session.id, patch).catch(reportError);
  }

  const currentTask = () => (session && session.taskIndex >= 0 ? session.tasks[session.taskIndex] || null : null);

  function log(type, fields) {
    ilog?.log(type, fields);
  }

  function mark(tag, payload) {
    recorder?.addCustomEvent(tag, payload);
  }

  // Recorder and interaction log are bound to the session id, created once
  // per session per page.
  function attachCapture() {
    const id = session.id;
    recorder = createRecorder({
      config,
      onEvent: (event) => store.appendEvents(id, segmentId, [event]),
    });
    ilog = createInteractionLog({
      mask: config.mask.inputs,
      getTaskId: () => currentTask()?.id ?? null,
      onEntry: (entry) => store.appendLog(id, entry),
    });
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
    stopCapture();
    stopTicker();
    recorder = null;
    ilog = null;
    session = null;
    segmentId = null;
  }

  // -------------------------------------------------------------------------
  // Audio

  function ensureAudio() {
    if (audio) return audio;
    audio = createAudioCapture({
      bitrate: config.audio.bitrate,
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

  async function acquireMic() {
    ensureAudio();
    setAudio({ status: 'pending', error: null });
    try {
      await audio.acquire();
      audio.setMuted(state.muted);
      setAudio({ status: state.muted ? 'muted' : 'live', error: null });
      return { ok: true };
    } catch (err) {
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
  async function restartAudioAfterNavigation() {
    const id = session.id;
    const last = await store.lastAudioChunk?.(id).catch(() => null);
    const res = await acquireMic();
    if (session?.id !== id) return; // discarded meanwhile
    const gapStart = last?.ts ?? null;
    if (!res.ok) {
      // Don't re-prompt on every page once the tester has said no.
      if (state.audio.status === 'denied') persist({ audio: { ...session.audio, enabled: false } });
      log('audio-gap', { gapStart, gapMs: null, message: `Microphone unavailable: ${res.error}` });
      return;
    }
    if (state.phase !== 'recording') return; // resume() starts the segment
    if (startAudioSegment() && gapStart) log('audio-gap', { gapStart, gapMs: Date.now() - gapStart });
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

  function endTask() {
    const task = currentTask();
    if (!task) return;
    log('task-end', { taskId: task.id });
    mark('testkit:task-end', { taskId: task.id, index: session.taskIndex });
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
      error: null,
    };
  }

  async function resumeSession(rec) {
    session = rec;
    segmentId = newId();
    const segments = [...(rec.segments || []), { segmentId, url: location.href, startedAt: Date.now() }];
    await persist({ segments });
    attachCapture();
    state = stateFromSession(rec.phase);
    if (rec.phase === 'recording') {
      startCapture({ pageLoad: true });
      log('session-resume', {});
      startTicker();
      if (config.audio.enabled && session.audio?.enabled) {
        restartAudioAfterNavigation().catch(reportError);
      }
    } else {
      // Paused: nothing is captured until resume(), which also re-acquires the mic.
      log('session-resume', {});
    }
    emit();
  }

  async function bootFromStore() {
    const activeId = store.getActiveSessionId?.();
    if (activeId) {
      const rec = await store.getSession(activeId).catch(() => null);
      if (rec && (rec.phase === 'recording' || rec.phase === 'paused')) return resumeSession(rec);
      store.clearActiveSessionId?.();
    }
    // A stopped-but-not-discarded session stays exportable across reloads.
    const lastId = store.getLastSessionId?.();
    if (lastId) {
      const rec = await store.getSession(lastId).catch(() => null);
      if (rec?.phase === 'stopped') {
        session = rec;
        state = stateFromSession('stopped');
        emit();
        return;
      }
      store.clearLastSessionId?.();
    }
  }

  // -------------------------------------------------------------------------
  // Page lifecycle

  window.addEventListener(
    'pagehide',
    () => {
      if (!session || state.phase !== 'recording') return;
      try {
        ilog?.flushPending();
        // Best effort: the final chunk is written only if the page lives long enough.
        audio?.stopSegment();
        store.flush?.();
      } catch {
        // Unloading; nothing useful left to do.
      }
    },
    { capture: true },
  );

  // Restored from bfcache: another page may have advanced (or stopped) the
  // session meanwhile, so re-read it rather than trusting memory.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || !session) return;
    queue(async () => {
      const id = session?.id;
      if (!id) return;
      const rec = await store.getSession(id).catch(() => null);
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
      return queue(async () => {
        if (state.phase !== 'idle' && state.phase !== 'stopped') return;
        // Leaving 'stopped' keeps that session's data until it's discarded.
        session = null;
        set({ ...idleState(), phase: 'preflight' });
      });
    },

    cancelPreflight() {
      return queue(async () => {
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
        return await acquireMic();
      } catch (err) {
        reportError(err);
        return { ok: false, error: messageOf(err) };
      }
    },

    getMicLevel() {
      return audio ? audio.getLevel() : 0;
    },

    start({ consent, audio: wantAudio = true } = {}) {
      return queue(async () => {
        if (state.phase !== 'preflight') return;
        if (consent !== true) {
          set({ error: 'Consent is required before recording' });
          return;
        }
        const consentAt = Date.now();
        const useAudio = config.audio.enabled && wantAudio !== false;
        if (useAudio && !audio?.isLive()) await acquireMic();
        if (!useAudio) {
          await releaseAudio();
          setAudio({ enabled: false, status: 'off', error: null });
        }
        if (state.phase !== 'preflight') return; // cancelled while the prompt was open
        const audioOk = useAudio && !!audio?.isLive();
        const now = Date.now();
        const tasks = config.tasks;
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
        store.setActiveSessionId?.(session.id);
        store.clearLastSessionId?.();
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
      return queue(async () => {
        if (state.phase !== 'recording') return;
        const task = currentTask();
        if (task && followUpAnswer != null && String(followUpAnswer).trim()) {
          log('followup', { taskId: task.id, text: clip(task.followUp || ''), answer: String(followUpAnswer).trim().slice(0, MAX_ANSWER) });
        }
        endTask();
        const counted = persist({ tasksCompleted: (session.tasksCompleted || 0) + 1 });
        const next = session.taskIndex + 1;
        if (next < session.tasks.length) await Promise.all([counted, beginTask(next)]);
        else await doStop({ taskEnded: true });
      });
    },

    pause() {
      return queue(async () => {
        if (state.phase !== 'recording') return;
        const now = Date.now();
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
      return queue(async () => {
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
        if (config.audio.enabled && session.audio?.enabled) {
          if (!audio?.isLive()) {
            const res = await acquireMic();
            if (!res.ok) log('audio-gap', { gapStart: now, gapMs: null, message: `Microphone unavailable: ${res.error}` });
          }
          if (state.phase === 'recording') startAudioSegment();
        }
      });
    },

    toggleMute() {
      return queue(async () => {
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
      return queue(() => doStop());
    },

    // Resolves with { filename, bytes }; rejects on failure (the message is
    // also put in state.error), so callers must handle the rejection.
    exportSession() {
      return queue(async () => {
        if (state.phase !== 'stopped' || !session) return { error: 'No stopped session to export' };
        set({ phase: 'exporting', error: null });
        try {
          const data = await store.loadSessionData(session.id);
          const { filename, html, bytes } = await buildExport(data);
          download(filename, html);
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
      return queue(async () => {
        if (state.phase === 'idle') return;
        const id = session?.id;
        await releaseAudio();
        detach();
        if (id) {
          await store.deleteSession(id);
          if (store.getActiveSessionId?.() === id) store.clearActiveSessionId?.();
          if (store.getLastSessionId?.() === id) store.clearLastSessionId?.();
        }
        set(idleState());
      });
    },
  };

  async function doStop({ taskEnded = false } = {}) {
    if (state.phase !== 'recording' && state.phase !== 'paused') return;
    const now = Date.now();
    const wasRecording = state.phase === 'recording';
    if (!taskEnded) endTask();
    log('session-end', {});
    if (wasRecording) mark('testkit:session-end', {});
    stopCapture();
    stopTicker();
    await releaseAudio();
    const pausedMs = (session.pausedMs || 0) + (session.pausedAt ? now - session.pausedAt : 0);
    await persist({ phase: 'stopped', endedAt: now, pausedAt: null, pausedMs, taskStartedAt: null });
    await store.flush?.();
    store.clearActiveSessionId?.();
    store.setLastSessionId?.(session.id);
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
