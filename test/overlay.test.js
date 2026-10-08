import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_MARGIN,
  canSkipTask,
  canStart,
  createAdvanceGuard,
  consentText,
  createMicCheck,
  describeDuration,
  formatBytes,
  formatCountdown,
  formatElapsed,
  hasMovedPastThreshold,
  AUDIO_COPY,
  audioAnnouncement,
  audioNotice,
  micKind,
  parsePosition,
  previousDownloadText,
  savedAudioText,
  snapPosition,
  taskRemainingMs,
  taskTally,
  tasksCompleted,
  tasksSkipped,
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
  assert.equal(micKind({ enabled: true, status: 'reconnecting' }), 'reconnecting');
  assert.equal(micKind({ enabled: true, status: 'live' }, 'paused'), 'paused', 'session phase owns the badge');
  assert.equal(micKind({ enabled: true, status: 'error' }, 'paused'), 'error', 'a failure still shows while paused');
});

test('audioNotice: recoverable vs blocked vs tester-chosen off', () => {
  assert.equal(audioNotice({ enabled: true, status: 'error' }), 'stopped');
  assert.equal(audioNotice({ enabled: true, status: 'denied' }), 'blocked');
  assert.equal(audioNotice({ enabled: true, status: 'reconnecting' }), 'reconnecting');
  assert.equal(audioNotice({ enabled: true, status: 'off', stopAsking: true }), 'off');
  assert.equal(audioNotice({ enabled: true, status: 'off', stopAsking: false }), null);
  assert.equal(audioNotice({ enabled: true, status: 'live' }), null);
  assert.equal(audioNotice({ enabled: false, status: 'error' }), null, 'no voice chosen at Start: nothing to recover');
  assert.equal(AUDIO_COPY.stopped, 'Audio stopped — screen is still recording.');
  assert.equal(AUDIO_COPY.blocked, 'Microphone blocked — screen is still recording.');
  assert.equal(AUDIO_COPY.paused, 'Session paused — prototype interaction and voice are not saved.');
  assert.equal(AUDIO_COPY.pausedMic, 'Your browser may still show the microphone as in use until you stop the session.');
});

test('audioAnnouncement: mic death and recovery are spoken even when collapsed', () => {
  assert.equal(audioAnnouncement({ enabled: true, status: 'live' }, { enabled: true, status: 'error' }), AUDIO_COPY.stopped);
  assert.equal(audioAnnouncement({ enabled: true, status: 'reconnecting' }, { enabled: true, status: 'denied' }), AUDIO_COPY.blocked);
  assert.equal(audioAnnouncement({ enabled: true, status: 'reconnecting' }, { enabled: true, status: 'live' }), 'Microphone on again.');
  assert.equal(audioAnnouncement({ enabled: true, status: 'pending' }, { enabled: true, status: 'live' }), null, 'normal start is quiet');
  assert.equal(audioAnnouncement({ enabled: true, status: 'live' }, { enabled: true, status: 'live' }), null);
});

test('savedAudioText: exactly one verdict; gaps explain what a gap means', () => {
  assert.equal(savedAudioText({ kind: 'recorded', label: 'Audio recorded' }), 'Audio recorded');
  assert.equal(savedAudioText({ kind: 'none', label: 'No audio recorded' }), 'No audio recorded');
  assert.match(savedAudioText({ kind: 'gaps', label: 'Audio recorded with gaps', gaps: 2, gapMs: 4200 }),
    /^Audio recorded with gaps \(2 gaps, about 4 s\)\. Gaps are stretches where the microphone was not capturing/);
  assert.equal(savedAudioText(null), null);
});

test('taskTally: skipped tasks are counted apart from completed ones', () => {
  const tasks = [{}, {}, {}];
  assert.equal(taskTally({ tasks, tasksCompleted: 2, tasksSkipped: 1 }), '2 of 3 completed, 1 skipped');
  assert.equal(taskTally({ tasks, tasksCompleted: 3, tasksSkipped: 0 }), '3 of 3 completed');
  assert.equal(tasksSkipped({ tasks }), 0, 'older controllers report no skips');
  assert.equal(tasksSkipped({ tasks, tasksSkipped: 9 }), 3);
});

test('previousDownloadText: says when the previous file was handed to the browser, only if it was', () => {
  assert.equal(previousDownloadText(null), null);
  const text = previousDownloadText(new Date(2026, 9, 8, 14, 12).getTime());
  assert.match(text, /downloaded at .*12/);
  assert.match(text, /Cancel to download it again/);
});

test('canSkipTask: only for a scripted task, never in free exploration', () => {
  assert.equal(canSkipTask({ tasks: [], taskIndex: -1 }), false);
  assert.equal(canSkipTask({ tasks: [], taskIndex: 0 }), false);
  assert.equal(canSkipTask({ tasks: [{ id: 'a' }], taskIndex: 0 }), true);
  assert.equal(canSkipTask({ tasks: [{ id: 'a' }], taskIndex: 1 }), false);
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
