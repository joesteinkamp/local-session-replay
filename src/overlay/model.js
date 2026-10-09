// Pure helpers for the overlay: formatting, bubble geometry, and card copy.
// Kept DOM-free so they can be unit-tested under node:test.

export const EDGE_MARGIN = 12;
export const DRAG_THRESHOLD = 4;

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

// Prefer the controller's count. Otherwise taskIndex is the task in progress at
// stop, unless the overlay saw the tester finish the last task on this page.
export function tasksCompleted(state, { finishedLast = false } = {}) {
  const total = state.tasks?.length || 0;
  if (Number.isFinite(state.tasksCompleted)) return clamp(state.tasksCompleted, 0, total);
  if (finishedLast) return total;
  return clamp(state.taskIndex ?? 0, 0, total);
}

export const FREE_PROMPT = 'Explore the prototype and think aloud as you go.';

// Setup card. Pressing its button is the consent, so the copy says exactly
// what gets recorded; "Screen only" is offered only when voice is possible.
export function setupCopy({ study, tasks, audioEnabled }) {
  const n = tasks?.length || 0;
  const name = study || 'this study';
  const what = n ? `${n} task${n === 1 ? '' : 's'} for ${name}.` : `Explore ${name} and think aloud as you go.`;
  return {
    heading: audioEnabled ? 'Record your screen and voice?' : 'Record your screen?',
    text: `${what} Everything stays on this device; you’ll download one file at the end.`,
    screenOnly: Boolean(audioEnabled),
  };
}

// Bar step, "2/3"; null in free exploration.
export function stepLabel(state) {
  const total = state.tasks?.length || 0;
  if (!total || !(state.taskIndex >= 0)) return null;
  return `${Math.min(state.taskIndex + 1, total)}/${total}`;
}

// Prompt card eyebrow (shown uppercase): "Task 1 of 3 · 1:42 left".
export function taskEyebrow(taskIndex, total, remainingMs) {
  if (!total) return 'Free exploration';
  const base = `Task ${taskIndex + 1} of ${total}`;
  if (remainingMs == null) return base;
  return remainingMs > 0 ? `${base} · ${formatCountdown(remainingMs)} left` : `${base} · Time’s up`;
}

// Finish card line: "3 of 3 tasks · 14:32 · audio recorded".
export function finishLine(state, opts) {
  const total = state.tasks?.length || 0;
  const parts = [];
  if (total) parts.push(`${tasksCompleted(state, opts)} of ${total} task${total === 1 ? '' : 's'}`);
  parts.push(formatElapsed(state.elapsedMs));
  const label = state.savedAudio?.label;
  if (label) parts.push(label.charAt(0).toLowerCase() + label.slice(1));
  return parts.join(' · ');
}

export const ADVANCE_TIMEOUT_MS = 10_000;

/**
 * One Next call at a time. A press while one is in flight is dropped;
 * if a call never settles, the guard lets go after `timeoutMs` so the button
 * doesn't stay dead until reload (the controller's taskIndex check still stops
 * a double advance). `run(fn)` → false when dropped, else fn's result.
 */
export function createAdvanceGuard({ timeoutMs = ADVANCE_TIMEOUT_MS } = {}) {
  let busy = null; // token of the call holding the guard
  return {
    get busy() {
      return busy !== null;
    },
    run(fn) {
      if (busy) return false;
      const token = {};
      busy = token;
      const release = () => {
        if (busy === token) busy = null;
        clearTimeout(timer);
      };
      const timer = setTimeout(release, timeoutMs);
      let result;
      try {
        result = fn();
      } catch (err) {
        release();
        throw err;
      }
      Promise.resolve(result).then(release, release);
      return result;
    },
  };
}

// Spoken through the live region (the bar shows no mic state), so a
// think-aloud tester using a screen reader still hears the mic die.
export const AUDIO_COPY = {
  stopped: 'Audio stopped — screen is still recording.',
  blocked: 'Microphone blocked — screen is still recording.',
  reconnecting: 'Reconnecting microphone…',
};

export function audioAnnouncement(prev, next) {
  const from = prev?.status;
  const to = next?.status;
  if (!next?.enabled || from === to) return null;
  switch (to) {
    case 'error': return AUDIO_COPY.stopped;
    case 'denied': return AUDIO_COPY.blocked;
    case 'reconnecting': return AUDIO_COPY.reconnecting;
    case 'live': return from === 'reconnecting' || from === 'error' || from === 'denied' ? 'Microphone on again.' : null;
    default: return null;
  }
}
