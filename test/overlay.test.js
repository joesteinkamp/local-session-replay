import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_MARGIN,
  canStart,
  consentText,
  createMicCheck,
  describeDuration,
  formatBytes,
  formatCountdown,
  formatElapsed,
  hasMovedPastThreshold,
  micKind,
  parsePosition,
  snapPosition,
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

test('canStart requires consent and a passed or skipped mic check', () => {
  assert.equal(canStart({ consent: false, audioEnabled: false }), false);
  assert.equal(canStart({ consent: true, audioEnabled: false }), true);
  assert.equal(canStart({ consent: true, audioEnabled: true, micPassed: false, audioSkipped: false }), false);
  assert.equal(canStart({ consent: true, audioEnabled: true, micPassed: true }), true);
  assert.equal(canStart({ consent: true, audioEnabled: true, audioSkipped: true }), true);
  assert.equal(canStart({ consent: false, audioEnabled: true, micPassed: true }), false);
});

test('consentText mentions audio only when recording it', () => {
  assert.match(consentText(true), /microphone audio/);
  assert.doesNotMatch(consentText(false), /microphone/);
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

test('mic check passes only after sustained level, not a single spike', () => {
  const check = createMicCheck(0.15, 300);
  let t = 0;
  assert.equal(check.sample(0.9, t), false);
  // One loud frame then silence: not enough.
  for (let i = 0; i < 20; i++) assert.equal(check.sample(0.01, (t += 16)), false);
  let passed = false;
  for (let i = 0; i < 25 && !passed; i++) passed = check.sample(0.3, (t += 16));
  assert.equal(passed, true);
  check.reset();
  assert.equal(check.sample(0.3, 0), false);
});

test('mic check ignores long frame gaps (backgrounded tab)', () => {
  const check = createMicCheck(0.15, 300);
  check.sample(0.3, 0);
  assert.equal(check.sample(0.3, 5000), false);
});

test('micKind maps controller audio state to an indicator', () => {
  assert.equal(micKind({ enabled: false, status: 'live' }), 'off');
  assert.equal(micKind({ enabled: true, status: 'live' }), 'live');
  assert.equal(micKind({ enabled: true, status: 'denied' }), 'denied');
  assert.equal(micKind({ enabled: true, status: 'bogus' }), 'off');
  assert.equal(micKind(undefined), 'off');
});
