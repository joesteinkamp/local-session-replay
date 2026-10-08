// In-memory stand-in for createController() (docs/CONTRACTS.md → Controller),
// used only to exercise the overlay visually. Not bundled into the product.

export function createMockController({ study = 'grid-filters-v2', tasks = [], audioEnabled = true, mic = 'ok' } = {}) {
  const listeners = new Set();
  let pausedTotal = 0;
  let pausedAt = null;
  let previous = null;
  let state = {
    phase: 'idle',
    sessionId: null,
    study,
    tasks,
    taskIndex: -1,
    startedAt: null,
    elapsedMs: 0,
    taskStartedAt: null,
    muted: false,
    audio: { enabled: audioEnabled, status: 'off', error: null },
    tasksCompleted: 0,
    tasksSkipped: 0,
    downloaded: false,
    error: null,
  };

  const elapsed = () => {
    if (!state.startedAt) return 0;
    const end = pausedAt ?? state.endedAt ?? Date.now();
    return end - state.startedAt - pausedTotal;
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    const snapshot = api.getState();
    for (const fn of listeners) fn(snapshot);
  };
  const audio = (patch) => ({ ...state.audio, ...patch });

  const api = {
    getState: () => ({ ...state, elapsedMs: elapsed() }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // From 'stopped' the previous session comes back if setup is cancelled.
    beginPreflight() {
      if (state.phase !== 'idle' && state.phase !== 'stopped') return;
      previous = state.phase === 'stopped' ? state : null;
      set({ phase: 'preflight', sessionId: 'mock-1', downloaded: false, savedAudio: null });
    },
    cancelPreflight() {
      if (previous) {
        const back = previous;
        previous = null;
        return set(back);
      }
      return set({ phase: 'idle', sessionId: null, audio: audio({ status: 'off' }) });
    },
    requestMic() {
      set({ audio: audio({ status: 'pending' }) });
      return new Promise((resolve) => setTimeout(() => {
        if (mic === 'denied') {
          set({ audio: audio({ status: 'denied', error: 'NotAllowedError' }) });
          resolve({ ok: false, error: 'NotAllowedError' });
        } else {
          set({ audio: audio({ status: 'live' }) });
          resolve({ ok: true });
        }
      }, 400));
    },
    getMicLevel: () => (state.audio.status === 'live' ? 0.1 + 0.15 * (1 + Math.sin(Date.now() / 120)) : 0),
    start({ audio: withAudio }) {
      const now = Date.now();
      previous = null;
      pausedTotal = 0;
      set({
        phase: 'recording',
        startedAt: now,
        endedAt: null,
        tasksCompleted: 0,
        tasksSkipped: 0,
        downloaded: false,
        taskIndex: 0,
        taskStartedAt: now,
        audio: audio({ enabled: withAudio && audioEnabled, status: withAudio ? 'live' : 'off' }),
      });
    },
    nextTask() {
      state = { ...state, tasksCompleted: state.tasksCompleted + 1 };
      if (state.taskIndex >= state.tasks.length - 1) return api.stop();
      return set({ taskIndex: state.taskIndex + 1, taskStartedAt: Date.now() });
    },
    skipTask() {
      state = { ...state, tasksSkipped: state.tasksSkipped + 1 };
      if (state.taskIndex >= state.tasks.length - 1) return api.stop();
      return set({ taskIndex: state.taskIndex + 1, taskStartedAt: Date.now() });
    },
    pause() {
      pausedAt = Date.now();
      set({ phase: 'paused' });
    },
    resume() {
      pausedTotal += Date.now() - pausedAt;
      pausedAt = null;
      set({ phase: 'recording' });
    },
    retryMic() {
      set({ audio: audio({ status: 'reconnecting', error: null }) });
      return new Promise((resolve) => setTimeout(() => {
        set({ audio: audio({ status: state.muted ? 'muted' : 'live', stopAsking: false }) });
        resolve({ ok: true });
      }, 400));
    },
    continueWithoutMic: () => set({ audio: audio({ status: 'off', stopAsking: true, error: null }) }),
    toggleMute: () => set({ muted: !state.muted, audio: audio({ status: state.muted ? 'live' : 'muted' }) }),
    stop() {
      if (pausedAt) {
        pausedTotal += Date.now() - pausedAt;
        pausedAt = null;
      }
      const savedAudio = state.audio.enabled
        ? { kind: 'recorded', label: 'Audio recorded', gaps: 0, gapMs: 0, segments: 1, unreliable: 0, dropped: 0 }
        : { kind: 'none', label: 'No audio recorded', gaps: 0, gapMs: 0, segments: 0, unreliable: 0, dropped: 0 };
      set({ phase: 'stopped', endedAt: Date.now(), savedAudio, audio: audio({ status: 'off' }) });
    },
    exportSession() {
      set({ phase: 'exporting' });
      return new Promise((resolve) => setTimeout(() => {
        set({ phase: 'stopped', downloaded: true });
        resolve({ filename: `testkit-${study}-20261006-1412.html`, bytes: 2_431_000 });
      }, 700));
    },
    discard: () => set({ phase: 'idle', sessionId: null, taskIndex: -1, startedAt: null, endedAt: null, taskStartedAt: null, tasksCompleted: 0, tasksSkipped: 0, downloaded: false }),
    // Test hook: jump straight into a phase.
    _set: set,
  };
  return api;
}
