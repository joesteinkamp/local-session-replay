import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_MARGIN,
  FREE_PROMPT,
  createAdvanceGuard,
  describeDuration,
  finishLine,
  formatBytes,
  formatCountdown,
  formatElapsed,
  hasMovedPastThreshold,
  AUDIO_COPY,
  audioAnnouncement,
  parsePosition,
  setupCopy,
  snapPosition,
  stepLabel,
  taskEyebrow,
  taskRemainingMs,
  tasksCompleted,
} from '../src/overlay/model.js';

test('formatElapsed uses mm:ss, then h:mm:ss past an hour', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(192_000), '03:12');
  assert.equal(formatElapsed(3_600_000), '1:00:00');
  assert.equal(formatElapsed(3_792_000), '1:03:12');
  assert.equal(formatElapsed(-5), '00:00');
  assert.equal(formatElapsed(undefined), '00:00');
});

test('describeDuration reads naturally', () => {
  assert.equal(describeDuration(0), '0 seconds');
  assert.equal(describeDuration(61_000), '1 minute 1 second');
  assert.equal(describeDuration(3_720_000), '1 hour 2 minutes');
});

test('formatBytes scales units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15.0 MB');
});

test('taskRemainingMs is null for untimed tasks and goes negative when over', () => {
  assert.equal(taskRemainingMs({ timeLimit: null }, 1000, 2000), null);
  assert.equal(taskRemainingMs({ timeLimit: 60 }, null, 2000), null);
  assert.equal(taskRemainingMs({ timeLimit: 60 }, 0, 30_000), 30_000);
  assert.ok(taskRemainingMs({ timeLimit: 60 }, 0, 61_000) < 0);
});

test('formatCountdown rounds up and floors at zero', () => {
  assert.equal(formatCountdown(90_000), '1:30');
  assert.equal(formatCountdown(400), '0:01');
  assert.equal(formatCountdown(-3000), '0:00');
});

test('snapPosition picks the nearer side and clamps y', () => {
  const base = { width: 44, height: 44, viewportW: 1000, viewportH: 800 };
  assert.deepEqual(snapPosition({ ...base, x: 100, y: 300 }), { side: 'left', y: 300 });
  assert.deepEqual(snapPosition({ ...base, x: 700, y: 300 }), { side: 'right', y: 300 });
  assert.equal(snapPosition({ ...base, x: 0, y: -50 }).y, EDGE_MARGIN);
  assert.equal(snapPosition({ ...base, x: 0, y: 5000 }).y, 800 - 44 - EDGE_MARGIN);
});

test('parsePosition rejects garbage', () => {
  assert.deepEqual(parsePosition('{"side":"left","y":40}'), { side: 'left', y: 40 });
  assert.equal(parsePosition('{"side":"top","y":40}'), null);
  assert.equal(parsePosition('{"side":"left","y":"x"}'), null);
  assert.equal(parsePosition('not json'), null);
  assert.equal(parsePosition(null), null);
});

test('drag threshold distinguishes a click from a drag', () => {
  assert.equal(hasMovedPastThreshold(2, 2), false);
  assert.equal(hasMovedPastThreshold(4, 0), false);
  assert.equal(hasMovedPastThreshold(3, 3), true);
});

test('tasksCompleted prefers the controller count and clamps the fallback', () => {
  const tasks = [{}, {}, {}];
  assert.equal(tasksCompleted({ tasks, taskIndex: 1, tasksCompleted: 2 }), 2);
  assert.equal(tasksCompleted({ tasks, taskIndex: 1 }), 1);
  assert.equal(tasksCompleted({ tasks, taskIndex: 3 }), 3);
  assert.equal(tasksCompleted({ tasks, taskIndex: 9 }), 3);
  assert.equal(tasksCompleted({ tasks, taskIndex: -1 }), 0);
  assert.equal(tasksCompleted({ tasks, taskIndex: 2 }, { finishedLast: true }), 3);
  assert.equal(tasksCompleted({ tasks, taskIndex: 2, tasksCompleted: 1 }, { finishedLast: true }), 1);
});

test('setupCopy: the button is the consent, so the copy says what is recorded', () => {
  const voice = setupCopy({ study: 'grid-filters-v2', tasks: [{}, {}, {}], audioEnabled: true });
  assert.equal(voice.heading, 'Record your screen and voice?');
  assert.match(voice.text, /^3 tasks for grid-filters-v2\. Everything stays on this device/);
  assert.equal(voice.screenOnly, true);
  const screen = setupCopy({ study: 'grid-filters-v2', tasks: [{}], audioEnabled: false });
  assert.equal(screen.heading, 'Record your screen?');
  assert.match(screen.text, /^1 task for /);
  assert.equal(screen.screenOnly, false, 'no Screen only link when voice is off anyway');
  assert.match(setupCopy({ study: 'x', tasks: [], audioEnabled: true }).text, /^Explore x and think aloud/);
});

test('stepLabel: n/total for scripted tasks, nothing in free exploration', () => {
  const tasks = [{}, {}, {}];
  assert.equal(stepLabel({ tasks, taskIndex: 0 }), '1/3');
  assert.equal(stepLabel({ tasks, taskIndex: 2 }), '3/3');
  assert.equal(stepLabel({ tasks, taskIndex: 7 }), '3/3');
  assert.equal(stepLabel({ tasks, taskIndex: -1 }), null);
  assert.equal(stepLabel({ tasks: [], taskIndex: 0 }), null);
});

test('taskEyebrow: task position, countdown, then time is up', () => {
  assert.equal(taskEyebrow(0, 3, null), 'Task 1 of 3');
  assert.equal(taskEyebrow(0, 3, 102_000), 'Task 1 of 3 · 1:42 left');
  assert.equal(taskEyebrow(1, 3, 0), 'Task 2 of 3 · Time’s up');
  assert.equal(taskEyebrow(0, 0, null), 'Free exploration');
  assert.match(FREE_PROMPT, /think aloud/);
});

test('finishLine: tasks, duration, and the saved-audio verdict', () => {
  const tasks = [{}, {}, {}];
  assert.equal(
    finishLine({ tasks, tasksCompleted: 3, elapsedMs: 872_000, savedAudio: { label: 'Audio recorded' } }),
    '3 of 3 tasks · 14:32 · audio recorded',
  );
  assert.equal(finishLine({ tasks: [], elapsedMs: 65_000, savedAudio: { label: 'No audio recorded' } }), '01:05 · no audio recorded');
  assert.equal(finishLine({ tasks: [{}], tasksCompleted: 0, elapsedMs: 0, savedAudio: null }), '0 of 1 task · 00:00');
  assert.equal(finishLine({ tasks, taskIndex: 2, elapsedMs: 0 }, { finishedLast: true }), '3 of 3 tasks · 00:00');
});

test('audioAnnouncement: mic death and recovery are spoken even when collapsed', () => {
  assert.equal(audioAnnouncement({ enabled: true, status: 'live' }, { enabled: true, status: 'error' }), AUDIO_COPY.stopped);
  assert.equal(audioAnnouncement({ enabled: true, status: 'reconnecting' }, { enabled: true, status: 'denied' }), AUDIO_COPY.blocked);
  assert.equal(audioAnnouncement({ enabled: true, status: 'reconnecting' }, { enabled: true, status: 'live' }), 'Microphone on again.');
  assert.equal(audioAnnouncement({ enabled: true, status: 'pending' }, { enabled: true, status: 'live' }), null, 'normal start is quiet');
  assert.equal(audioAnnouncement({ enabled: true, status: 'live' }, { enabled: true, status: 'live' }), null);
});

test('advance guard: drops presses while a call is in flight, and lets go of a call that never settles', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const guard = createAdvanceGuard({ timeoutMs: 10_000 });
    let calls = 0;
    const never = () => {
      calls++;
      return new Promise(() => {});
    };
    guard.run(never);
    assert.equal(guard.run(never), false, 'second press dropped');
    assert.equal(calls, 1);
    mock.timers.tick(9_999);
    assert.equal(guard.busy, true);
    mock.timers.tick(1);
    assert.equal(guard.busy, false, 'released after the timeout');
    guard.run(() => {
      calls++;
      return Promise.resolve();
    });
    assert.equal(calls, 2, 'Next works again');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(guard.busy, false, 'a settled call releases at once');
    assert.throws(() => guard.run(() => { throw new Error('sync'); }));
    assert.equal(guard.busy, false, 'a throwing call releases');
  } finally {
    mock.timers.reset();
  }
});

test('advance guard: a timed-out call that settles late does not release a newer one', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const guard = createAdvanceGuard({ timeoutMs: 100 });
    let finishFirst;
    guard.run(() => new Promise((r) => { finishFirst = r; }));
    mock.timers.tick(100);
    guard.run(() => new Promise(() => {})); // the newer call holds the guard
    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(guard.busy, true);
  } finally {
    mock.timers.reset();
  }
});
