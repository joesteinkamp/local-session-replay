// Pure helpers for the overlay: formatting, bubble geometry, and view gating.
// Kept DOM-free so they can be unit-tested under node:test.

export const EDGE_MARGIN = 12;
export const DRAG_THRESHOLD = 4;
export const MIC_PASS_LEVEL = 0.15;
export const MIC_PASS_MS = 300;

const pad = (n) => String(n).padStart(2, '0');

// mm:ss, or h:mm:ss once past an hour.
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Spoken form for screen readers: "1 hour 3 minutes 12 seconds".
export function describeDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || !parts.length) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Remaining ms for the current task's timeLimit (seconds), or null when untimed.
// Negative once the limit has passed; callers show "time's up" rather than advancing.
export function taskRemainingMs(task, taskStartedAt, now) {
  if (!task || !task.timeLimit || taskStartedAt == null) return null;
  return task.timeLimit * 1000 - (now - taskStartedAt);
}

export function formatCountdown(remainingMs) {
  // Ceil so "0:01" shows until the limit is actually reached.
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export function clamp(v, min, max) {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

// Where a released bubble settles: the nearer vertical edge, y kept on-screen.
export function snapPosition({ x, y, width, height, viewportW, viewportH }) {
  const side = x + width / 2 < viewportW / 2 ? 'left' : 'right';
  return { side, y: clamp(y, EDGE_MARGIN, viewportH - height - EDGE_MARGIN) };
}

export function defaultPosition(viewportH, height) {
  return { side: 'right', y: Math.max(EDGE_MARGIN, viewportH - height - 24) };
}

// Validates a value read back from localStorage.
export function parsePosition(raw) {
  try {
    const p = JSON.parse(raw);
    if (p && (p.side === 'left' || p.side === 'right') && Number.isFinite(p.y)) {
      return { side: p.side, y: p.y };
    }
  } catch {
    // Corrupt or absent: fall through to the default.
  }
  return null;
}

export function hasMovedPastThreshold(dx, dy, threshold = DRAG_THRESHOLD) {
  return dx * dx + dy * dy > threshold * threshold;
}

// Start needs consent, plus either a passed mic check or an explicit audio skip.
export function canStart({ consent, audioEnabled, micPassed, audioSkipped }) {
  if (!consent) return false;
  if (!audioEnabled) return true;
  return Boolean(micPassed || audioSkipped);
}

export function consentText(withAudio) {
  return withAudio
    ? 'This session records your screen activity and microphone audio on this device only. Nothing is uploaded. You’ll download a file at the end.'
    : 'This session records your screen activity on this device only. Nothing is uploaded. You’ll download a file at the end.';
}

// Prefer the controller's count. Otherwise taskIndex is the task in progress at
// stop, unless the overlay saw the tester finish the last task on this page.
export function tasksCompleted(state, { finishedLast = false } = {}) {
  const total = state.tasks?.length || 0;
  if (Number.isFinite(state.tasksCompleted)) return clamp(state.tasksCompleted, 0, total);
  if (finishedLast) return total;
  return clamp(state.taskIndex ?? 0, 0, total);
}

// Accumulates time spent above the pass level; the mic check passes once the
// tester has been audible for a moment rather than on a single spike.
export function createMicCheck(level = MIC_PASS_LEVEL, needMs = MIC_PASS_MS) {
  let heard = 0;
  let last = null;
  return {
    sample(value, now) {
      const dt = last == null ? 0 : Math.min(now - last, 100);
      last = now;
      if (value > level) heard += dt;
      return heard >= needMs;
    },
    reset() {
      heard = 0;
      last = null;
    },
  };
}

export const MIC_LABELS = {
  live: 'Microphone live',
  muted: 'Microphone muted',
  denied: 'Microphone blocked',
  error: 'Microphone error',
  pending: 'Microphone starting',
  off: 'Microphone off',
};

export function micKind(audio) {
  if (!audio || !audio.enabled) return 'off';
  return MIC_LABELS[audio.status] ? audio.status : 'off';
}
