import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioGaps, audioReport, buildSummary, buildTaskSpans, GAPS_MEANING, LOST_SEGMENT_REASON, collapseTrail, describeBrowser, detectBacktracking, detectIdle,
  detectRageClicks, formatDuration, formatTrailLine, overlapMs, pausedSpans, shortUrl, taskCounts, taskStatus,
} from '../src/export/summary.js';

const T = 1_760_000_000_000;
const at = (s) => T + s * 1000;
const click = (s, selector = 'button#apply', text = 'Apply') => ({ ts: at(s), type: 'click', selector, text, url: 'https://x.test/' });

test('formatDuration rounds by default, floors on request, adds hours', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(59_600), '01:00');
  assert.equal(formatDuration(59_600, { floor: true }), '00:59');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatDuration(-5), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
});

test('describeBrowser names common browsers and OSes', () => {
  assert.equal(describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), 'Chrome 141 on macOS');
  assert.equal(describeBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox 131 on Windows');
  assert.equal(describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'Safari 18.1 on macOS');
  assert.equal(describeBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge 130 on Windows');
  assert.equal(describeBrowser(''), 'unknown');
  assert.equal(describeBrowser('curl/8'), 'curl/8');
});

test('shortUrl strips the prototype origin only', () => {
  assert.equal(shortUrl('https://x.test/a/b.html?q=1#h', 'https://x.test/a/'), '/a/b.html?q=1#h');
  assert.equal(shortUrl('https://other.test/z', 'https://x.test/'), 'https://other.test/z');
  assert.equal(shortUrl('', 'https://x.test/'), '');
  assert.equal(shortUrl('not a url'), 'not a url');
});

test('detectRageClicks: 3 clicks within 1s on one selector', () => {
  const hits = detectRageClicks([click(1), click(1.3), click(1.6)]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 3);
  assert.equal(hits[0].selector, 'button#apply');
  assert.equal(hits[0].start, at(1));
});

test('detectRageClicks: ignores slow clicks, 2-click bursts, and mixed selectors', () => {
  assert.equal(detectRageClicks([click(1), click(1.6), click(2.2)]).length, 0, 'spread over 1.2s');
  assert.equal(detectRageClicks([click(1), click(1.2)]).length, 0);
  assert.equal(detectRageClicks([click(1, 'a'), click(1.1, 'b'), click(1.2, 'c')]).length, 0);
  assert.equal(detectRageClicks([{ ts: at(1), type: 'click' }, { ts: at(1.1), type: 'click' }, { ts: at(1.2), type: 'click' }]).length, 0, 'no selector');
});

test('detectRageClicks: one burst per run, interleaved selectors tracked separately', () => {
  const log = [click(1), click(1.2, 'a'), click(1.3), click(1.5), click(1.7), click(1.8, 'a'), click(5), click(5.1), click(5.2)];
  const hits = detectRageClicks(log);
  assert.deepEqual(hits.map((h) => [h.selector, h.count]), [['button#apply', 4], ['button#apply', 3]]);
});

test('detectRageClicks: honors custom thresholds', () => {
  assert.equal(detectRageClicks([click(1), click(1.5), click(2)], { windowMs: 1000 }).length, 1);
  assert.equal(detectRageClicks([click(1), click(1.5), click(2)], { count: 4 }).length, 0);
});

test('pausedSpans pairs pause/resume and closes open pauses', () => {
  const log = [{ ts: at(10), type: 'pause' }, { ts: at(20), type: 'resume' }, { ts: at(30), type: 'pause' }];
  assert.deepEqual(pausedSpans(log, at(40)), [{ start: at(10), end: at(20) }, { start: at(30), end: at(40) }]);
  assert.deepEqual(pausedSpans(log), [{ start: at(10), end: at(20) }], 'no end: open pause dropped');
  assert.deepEqual(pausedSpans([{ ts: at(1), type: 'pause' }, { ts: at(2), type: 'pause' }, { ts: at(3), type: 'resume' }]), [{ start: at(1), end: at(3) }]);
  assert.deepEqual(pausedSpans([{ ts: at(1), type: 'pause' }, { ts: at(4), type: 'session-end' }]), [{ start: at(1), end: at(4) }]);
});

test('overlapMs sums intersections', () => {
  const spans = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  assert.equal(overlapMs(0, 100, spans), 20);
  assert.equal(overlapMs(15, 35, spans), 10);
  assert.equal(overlapMs(20, 30, spans), 0);
});

test('detectIdle: flags ≥20s gaps between entries within bounds', () => {
  const log = [{ ts: at(5), type: 'click' }, { ts: at(30), type: 'click' }];
  const idle = detectIdle(log, { start: at(0), end: at(35) });
  assert.equal(idle.length, 1);
  assert.equal(idle[0].start, at(5));
  assert.equal(idle[0].durationMs, 25000);
  assert.equal(idle[0].activity, false);
});

test('detectIdle: just under the threshold is not idle; gap to the end counts', () => {
  assert.equal(detectIdle([{ ts: at(1), type: 'click' }], { start: at(0), end: at(20.9) }).length, 0);
  const idle = detectIdle([{ ts: at(1), type: 'click' }], { start: at(0), end: at(21) });
  assert.equal(idle.length, 1);
  assert.equal(idle[0].end, at(21));
});

test('detectIdle: paused time is excluded', () => {
  const log = [{ ts: at(0), type: 'click' }, { ts: at(30), type: 'click' }];
  assert.equal(detectIdle(log, { start: at(0), end: at(30), pauses: [{ start: at(5), end: at(20) }] }).length, 0);
  assert.equal(detectIdle(log, { start: at(0), end: at(30), pauses: [{ start: at(5), end: at(8) }] })[0].durationMs, 27000);
});

test('detectIdle: notes rrweb pointer/scroll activity during the gap', () => {
  const events = [{ type: 3, timestamp: at(12), data: { source: 1 } }];
  assert.equal(detectIdle([], { start: at(0), end: at(25), events })[0].activity, true);
  const mutationOnly = [{ type: 3, timestamp: at(12), data: { source: 0 } }];
  assert.equal(detectIdle([], { start: at(0), end: at(25), events: mutationOnly })[0].activity, false);
  const duringPause = { start: at(10), end: at(14) };
  assert.equal(detectIdle([], { start: at(0), end: at(30), pauses: [duringPause], events })[0].activity, false);
});

test('detectIdle: empty input', () => {
  assert.deepEqual(detectIdle([]), []);
});

test('detectBacktracking: popstate and returning to a visited URL', () => {
  const nav = (s, navType, from, to) => ({ ts: at(s), type: 'nav', navType, from, to });
  const log = [
    nav(1, 'pushState', 'https://x.test/', 'https://x.test/a'),
    nav(2, 'pushState', 'https://x.test/a', 'https://x.test/b'),
    nav(3, 'popstate', 'https://x.test/b', 'https://x.test/a'),
    nav(4, 'pushState', 'https://x.test/a', 'https://x.test/'),
  ];
  const hits = detectBacktracking(log, { initialUrls: ['https://x.test/'] });
  assert.deepEqual(hits.map((h) => h.ts), [at(3), at(4)]);
});

test('detectBacktracking: reloads, replaceState and beforeunload are not backtracking', () => {
  const nav = (s, navType, from, to) => ({ ts: at(s), type: 'nav', navType, from, to });
  const log = [
    nav(1, 'beforeunload', 'https://x.test/', null),
    nav(2, 'load', 'https://x.test/', 'https://x.test/'),
    nav(3, 'replaceState', 'https://x.test/', 'https://x.test/?q=1'),
    nav(4, 'load', 'https://x.test/', 'https://x.test/b'),
  ];
  assert.deepEqual(detectBacktracking(log, { initialUrls: ['https://x.test/'] }), []);
});

test('detectBacktracking: multi-page return via load, trailing slash insensitive', () => {
  const log = [
    { ts: at(1), type: 'nav', navType: 'load', from: 'https://x.test/', to: 'https://x.test/about.html' },
    { ts: at(2), type: 'nav', navType: 'load', from: 'https://x.test/about.html', to: 'https://x.test' },
  ];
  assert.equal(detectBacktracking(log, { initialUrls: ['https://x.test/'] }).length, 1);
});

test('collapseTrail merges input/change runs on one selector', () => {
  const log = [
    { ts: at(1), type: 'input', selector: '#a', value: 'h' },
    { ts: at(2), type: 'input', selector: '#a', value: 'he' },
    { ts: at(3), type: 'change', selector: '#a', value: 'hey' },
    { ts: at(4), type: 'input', selector: '#b', value: 'x' },
    { ts: at(5), type: 'click', selector: '#go' },
    { ts: at(6), type: 'input', selector: '#a', value: 'again' },
    { ts: at(7), type: 'task-start' },
    { ts: at(8), type: 'nav', navType: 'beforeunload' },
  ];
  const trail = collapseTrail(log);
  assert.deepEqual(trail.map((t) => [t.type, t.selector, t.value, t.edits]), [
    ['input', '#a', 'hey', 3], ['input', '#b', 'x', 1], ['click', '#go', undefined, 1], ['input', '#a', 'again', 1],
  ]);
  assert.equal(trail[0].ts, at(1), 'run keeps its first timestamp');
});

test('collapseTrail keeps a lone change as change', () => {
  const trail = collapseTrail([{ ts: at(1), type: 'change', selector: 'select#size', value: 'M' }]);
  assert.equal(formatTrailLine(trail[0], at(0)), '00:01 change select#size = "M"');
});

test('formatTrailLine formats each kind compactly', () => {
  assert.equal(formatTrailLine({ ...click(12.9), edits: 1 }, at(0)), '00:12 click button#apply "Apply"');
  assert.equal(formatTrailLine({ ts: at(3), type: 'click', selector: 'div.card', text: '' }, at(0)), '00:03 click div.card');
  assert.equal(formatTrailLine({ ts: at(3), type: 'input', selector: '#e', value: '***', edits: 5 }, at(0)), '00:03 input #e = "***" (5 edits)');
  assert.equal(formatTrailLine({ ts: at(3), type: 'nav', navType: 'pushState', to: 'https://x.test/a?b=1' }, at(0), 'https://x.test/'), '00:03 nav pushState /a?b=1');
  assert.equal(formatTrailLine({ ts: at(3), type: 'error', message: 'Boom' }, at(0)), '00:03 error "Boom"');
  assert.equal(formatTrailLine({ ts: at(3), type: 'audio-gap', gapMs: 1500 }, at(0)), '00:03 audio-gap 1.5s');
  assert.equal(formatTrailLine({ ts: at(3), type: 'pause' }, at(0)), '00:03 pause');
  assert.equal(formatTrailLine({ ts: at(3), type: 'click', selector: '#q', text: 'Say "hi"\n  now' }, at(0)), '00:03 click #q "Say \\"hi\\" now"');
  const long = formatTrailLine({ ts: at(3), type: 'click', selector: '#q', text: 'x'.repeat(200) }, at(0));
  assert.ok(long.length < 110 && long.endsWith('…"'));
});

test('buildTaskSpans: closes at task-end, next task-start, or session end', () => {
  const session = { tasks: [{ id: 't1', prompt: 'One' }, { id: 't2', prompt: 'Two' }, { id: 't3', prompt: 'Three' }], startedAt: at(0), endedAt: at(100) };
  const log = [
    { ts: at(1), type: 'task-start', taskId: 't1' },
    { ts: at(10), type: 'task-end', taskId: 't1' },
    { ts: at(11), type: 'task-start', taskId: 't2' },
    { ts: at(20), type: 'task-start', taskId: 't3' },
  ];
  const spans = buildTaskSpans({ session, log });
  assert.deepEqual(spans.map((s) => [s.taskId, s.index, s.start, s.end, s.ended]), [
    ['t1', 0, at(1), at(10), true], ['t2', 1, at(11), at(20), false], ['t3', 2, at(20), at(100), false],
  ]);
  assert.equal(spans[0].task.prompt, 'One');
});

test('buildTaskSpans falls back to rrweb custom events', () => {
  const session = { tasks: [{ id: 't1', prompt: 'One' }] };
  const events = [
    { type: 4, timestamp: at(0), data: {} },
    { type: 5, timestamp: at(1), data: { tag: 'testkit:task-start', payload: { taskId: 't1', index: 0 } } },
    { type: 5, timestamp: at(9), data: { tag: 'testkit:task-end', payload: { taskId: 't1', index: 0 } } },
  ];
  const spans = buildTaskSpans({ session, log: [], events });
  assert.deepEqual(spans.map((s) => [s.taskId, s.start, s.end, s.ended]), [['t1', at(1), at(9), true]]);
});

function fixture() {
  const tasks = [
    { id: 'find', prompt: 'Find a jacket', successHint: 'Results show a jacket', timeLimit: 30, followUp: 'Anything confusing?' },
    { id: 'about', prompt: 'Open About', successHint: null, timeLimit: null, followUp: null },
    { id: 'never', prompt: 'Checkout', successHint: null, timeLimit: null, followUp: null },
  ];
  const session = {
    id: 's1', study: 'Checkout study', startedAt: at(0), endedAt: at(120), tasks,
    meta: { prototypeUrl: 'https://x.test/proto/', commitSha: 'abc1234', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36', viewport: { w: 1280, h: 800 } },
    segments: [{ segmentId: 'g1', url: 'https://x.test/proto/', startedAt: at(0) }],
    audio: { enabled: true },
  };
  const u = 'https://x.test/proto/';
  const log = [
    { ts: at(0), type: 'session-start', url: u, taskId: null },
    { ts: at(1), type: 'task-start', url: u, taskId: 'find' },
    { ts: at(2), type: 'click', url: u, taskId: 'find', selector: 'input#q', text: '' },
    { ts: at(3), type: 'input', url: u, taskId: 'find', selector: 'input#q', value: '***' },
    { ts: at(3.2), type: 'input', url: u, taskId: 'find', selector: 'input#q', value: '***' },
    { ts: at(5), type: 'click', url: u, taskId: 'find', selector: 'button#apply', text: 'Apply' },
    { ts: at(5.2), type: 'click', url: u, taskId: 'find', selector: 'button#apply', text: 'Apply' },
    { ts: at(5.4), type: 'click', url: u, taskId: 'find', selector: 'button#apply', text: 'Apply' },
    { ts: at(6), type: 'error', url: u, taskId: 'find', message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at f (app.js:1:2)' },
    { ts: at(40), type: 'task-end', url: u, taskId: 'find' },
    { ts: at(41), type: 'followup', url: u, taskId: 'find', answer: 'The filter was empty' },
    { ts: at(42), type: 'pause', url: u, taskId: null },
    { ts: at(60), type: 'resume', url: u, taskId: null },
    { ts: at(61), type: 'task-start', url: u, taskId: 'about' },
    { ts: at(62), type: 'nav', url: u, taskId: 'about', navType: 'pushState', from: u, to: `${u}about` },
    { ts: at(63), type: 'nav', url: `${u}about`, taskId: 'about', navType: 'popstate', from: `${u}about`, to: u },
    { ts: at(64), type: 'audio-gap', url: u, taskId: 'about', gapMs: 1200 },
    { ts: at(70), type: 'task-end', url: u, taskId: 'about' },
    { ts: at(80), type: 'rejection', url: u, taskId: null, message: 'Unhandled: nope' },
    { ts: at(120), type: 'session-end', url: u, taskId: null },
  ];
  return { session, log, events: [] };
}

test('buildSummary: header carries study metadata', () => {
  const md = buildSummary(fixture());
  assert.match(md, /^# TestKit session: Checkout study/);
  for (const line of ['- Prototype: https://x.test/proto/', '- Commit: abc1234', '- Browser: Chrome 141 on macOS', '- Viewport: 1280×800',
    '- Started: 2025-10-09T08:53:20Z', '- Duration: 02:00 (01:42 active, 00:18 paused)', '- Tasks completed: 2 of 3']) {
    assert.ok(md.includes(line), `missing: ${line}\n${md}`);
  }
});

test('buildSummary: per-task details, trail, and signals', () => {
  const md = buildSummary(fixture());
  const task1 = md.slice(md.indexOf('## Task 1'), md.indexOf('## Task 2'));
  assert.ok(task1.includes('## Task 1: Find a jacket'));
  assert.ok(task1.includes('- Expected: Results show a jacket'));
  assert.ok(task1.includes('- Duration: 00:39'));
  assert.ok(task1.includes('- Time limit: 00:30 (exceeded by 00:09)'));
  assert.ok(task1.includes('- Follow-up: Anything confusing?'));
  assert.ok(task1.includes('  - Answer: "The filter was empty"'));
  assert.ok(task1.includes('00:01 click input#q'));
  assert.ok(task1.includes('00:02 input input#q = "***" (2 edits)'));
  assert.ok(task1.includes('- 00:05 error: TypeError: x is undefined (at f (app.js:1:2)) on /proto/'));
  assert.ok(task1.includes('- Rage click: 3× on button#apply "Apply" at 00:04'));
  assert.ok(task1.includes('- Long idle: 00:34 without logged interaction from 00:05'));
  assert.ok(task1.includes('- Time limit exceeded: 00:39 vs 00:30'));

  const task2 = md.slice(md.indexOf('## Task 2'), md.indexOf('## Tasks not reached'));
  assert.ok(task2.includes('00:01 nav pushState /proto/about'));
  assert.ok(task2.includes('- Backtracking: back/forward to /proto/ at 00:02'));
  assert.ok(task2.includes('00:03 audio-gap 1.2s'));
  assert.ok(!task2.includes('Time limit'));
});

test('buildSummary: unreached tasks and session-level section', () => {
  const md = buildSummary(fixture());
  assert.ok(md.includes('## Tasks not reached\n\n- never: Checkout'));
  assert.ok(md.includes('- Errors outside tasks: 1'));
  assert.ok(md.includes('rejection: Unhandled: nope'));
  assert.ok(md.includes('- Audio gaps: 1 (1.2s total; mm:ss from session start)'));
  assert.ok(md.includes('- Pauses: 1 (00:18 total)'));
});

test('buildSummary: paused time inside a task is excluded from its duration', () => {
  const f = fixture();
  f.log.splice(5, 0, { ts: at(10), type: 'pause', taskId: null }, { ts: at(30), type: 'resume', taskId: null });
  f.log.sort((a, b) => a.ts - b.ts);
  const md = buildSummary(f);
  assert.ok(md.includes('- Duration: 00:19 (+00:20 paused)'), md);
  assert.ok(md.includes('- Time limit: 00:30 (within)'));
  assert.ok(!md.includes('Long idle'), 'idle measured without paused time');
});

test('buildSummary: survives empty and minimal input', () => {
  const md = buildSummary({});
  assert.match(md, /# TestKit session: untitled-study/);
  assert.ok(md.includes('- Started: n/a'));
  const noTasks = buildSummary({ session: { study: 'x', startedAt: at(0), endedAt: at(5), audio: { enabled: false } }, log: [] });
  assert.ok(noTasks.includes('- Audio: not recorded'));
  assert.ok(noTasks.includes('- Tasks completed: 0 of 0'));
});

test('buildSummary: unfinished task is marked', () => {
  const session = { study: 's', startedAt: at(0), endedAt: at(50), tasks: [{ id: 't', prompt: 'P' }] };
  const md = buildSummary({ session, log: [{ ts: at(1), type: 'task-start', taskId: 't' }, { ts: at(50), type: 'session-end', taskId: null }] });
  assert.ok(md.includes('- Status: Not completed (session stopped)'));
  assert.ok(md.includes('- Duration: 00:49'));
  assert.ok(md.includes('(no interactions recorded)'));
});

test('audio-gap entries from the core: gapMs may be null and carry a message', () => {
  assert.equal(formatTrailLine({ ts: at(3), type: 'audio-gap', gapStart: at(3), gapMs: null, message: 'Microphone unavailable: denied' }, at(0)),
    '00:03 audio-gap "Microphone unavailable: denied"');
  const session = { study: 's', startedAt: at(0), endedAt: at(10), audio: { enabled: true } };
  const md = buildSummary({ session, log: [{ ts: at(2), type: 'audio-gap', gapMs: null, message: 'Microphone unavailable: denied' }] });
  assert.ok(md.includes('- Audio gaps: 1 (0.0s total, 1 without a measured length; mm:ss from session start)'));
  assert.ok(md.includes('Microphone unavailable: denied'));
});

test('buildTaskSpans: completed comes from task-end.completed (Stop mid-task is not completed)', () => {
  const session = { tasks: [{ id: 't1', prompt: 'One' }, { id: 't2', prompt: 'Two' }], startedAt: at(0), endedAt: at(30), tasksCompleted: 0 };
  const log = [
    { ts: at(1), type: 'task-start', taskId: 't1' },
    { ts: at(10), type: 'task-end', taskId: 't1', completed: true },
    { ts: at(11), type: 'task-start', taskId: 't2' },
    { ts: at(20), type: 'task-end', taskId: 't2', completed: false },
    { ts: at(20), type: 'session-end', taskId: null },
  ];
  const spans = buildTaskSpans({ session, log });
  assert.deepEqual(spans.map((sp) => [sp.taskId, sp.ended, sp.completed]), [['t1', true, true], ['t2', true, false]]);
  const md = buildSummary({ session, log });
  assert.ok(md.includes('- Tasks completed: 1 of 2'));
  const task2 = md.slice(md.indexOf('## Task 2'));
  assert.ok(task2.includes('- Status: Not completed (session stopped)'));
  assert.ok(md.slice(md.indexOf('## Task 1'), md.indexOf('## Task 2')).includes('- Status: Completed'));
});

test('buildTaskSpans: without the flag, falls back to session.tasksCompleted', () => {
  // The controller's Stop path: task-start, task-end, session-end, nothing completed.
  const log = [
    { ts: at(1), type: 'task-start', taskId: 't1' },
    { ts: at(5), type: 'task-end', taskId: 't1' },
    { ts: at(5), type: 'session-end', taskId: null },
  ];
  const session = { tasks: [{ id: 't1', prompt: 'One' }], startedAt: at(0), endedAt: at(5), tasksCompleted: 0 };
  assert.equal(buildTaskSpans({ session, log })[0].completed, false);
  assert.ok(buildSummary({ session, log }).includes('- Tasks completed: 0 of 1'));
  assert.equal(buildTaskSpans({ session: { ...session, tasksCompleted: 1 }, log })[0].completed, true);
  // Legacy data with neither field: an ended task counts as completed.
  const { tasksCompleted, ...legacy } = session;
  assert.equal(buildTaskSpans({ session: legacy, log })[0].completed, true);
});

test('buildTaskSpans: completed flag is read from rrweb custom events too', () => {
  const events = [
    { type: 5, timestamp: at(1), data: { tag: 'testkit:task-start', payload: { taskId: 't1', index: 0 } } },
    { type: 5, timestamp: at(9), data: { tag: 'testkit:task-end', payload: { taskId: 't1', index: 0, completed: false } } },
  ];
  assert.equal(buildTaskSpans({ session: { tasks: [{ id: 't1' }] }, log: [], events })[0].completed, false);
});

test('audioGaps: computed from coverage, excluding pauses and sub-threshold slivers', () => {
  const audio = [{ startTs: at(10), endTs: at(20) }, { startTs: at(20.2), endTs: at(40) }, { startTs: at(60), endTs: at(70) }];
  const pauses = [{ start: at(40), end: at(55) }];
  const gaps = audioGaps({ session: { audio: { enabled: true } }, log: [], audio, start: at(0), end: at(80), pauses });
  assert.deepEqual(gaps.map((g) => [g.start, g.end, g.durationMs]), [
    [at(0), at(10), 10000], [at(55), at(60), 5000], [at(70), at(80), 10000],
  ]);
});

test('audioGaps: one segment covering only the middle page yields gaps on both sides', () => {
  const md = buildSummary({
    session: { study: 's', startedAt: at(0), endedAt: at(90), audio: { enabled: true } },
    log: [],
    audio: [{ startTs: at(30), endTs: at(60) }],
  });
  assert.ok(md.includes('- Audio segments: 1'));
  assert.ok(md.includes('- Audio gaps: 2 (60.0s total'), md);
  assert.ok(md.includes('  - 00:00–00:30 (30.0s)'));
  assert.ok(md.includes('  - 01:00–01:30 (30.0s)'));
});

test('audioGaps: no segments at all while enabled is one whole-session gap; reasons come from the log', () => {
  const log = [{ ts: at(1), type: 'audio-gap', gapStart: at(0), gapMs: null, message: 'Microphone unavailable: denied' }];
  const gaps = audioGaps({ session: { audio: { enabled: true } }, log, audio: [], start: at(0), end: at(30) });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].durationMs, 30000);
  assert.equal(gaps[0].reason, 'Microphone unavailable: denied');
});

test('audioGaps: disabled audio has no gaps; without segments falls back to logged entries', () => {
  assert.deepEqual(audioGaps({ session: { audio: { enabled: false } }, audio: [], start: at(0), end: at(10) }), []);
  const logged = audioGaps({ session: {}, log: [{ ts: at(5), type: 'audio-gap', gapStart: at(3), gapMs: 2000 }] });
  assert.deepEqual(logged, [{ start: at(3), end: at(5), durationMs: 2000, reason: null }]);
});

test('buildSummary: per-task audio gap signal from coverage', () => {
  const session = { study: 's', startedAt: at(0), endedAt: at(40), tasks: [{ id: 't', prompt: 'P' }], audio: { enabled: true } };
  const log = [{ ts: at(1), type: 'task-start', taskId: 't' }, { ts: at(40), type: 'task-end', taskId: 't', completed: true }];
  const md = buildSummary({ session, log, audio: [{ startTs: at(0), endTs: at(20) }, { startTs: at(22), endTs: at(40) }] });
  assert.ok(md.includes('- Audio gap: 2.0s from 00:19'), md);
});

test('audioGaps: saved segments count even when an older record says enabled:false', () => {
  const session = { audio: { enabled: false } };
  const gaps = audioGaps({ session, audio: [{ startTs: at(0), endTs: at(20) }], start: at(0), end: at(30) });
  assert.deepEqual(gaps.map((g) => [g.start, g.end]), [[at(20), at(30)]]);
});

test('audioReport: one verdict from persisted segments, pauses excluded, 500 ms threshold', () => {
  const session = { startedAt: at(0), endedAt: at(30), audio: { enabled: true } };
  const pausedLog = [{ ts: at(10), type: 'pause' }, { ts: at(15), type: 'resume' }];
  const full = audioReport({ session, log: pausedLog, audio: [{ startTs: at(0), endTs: at(10) }, { startTs: at(15.4), endTs: at(30) }] });
  assert.deepEqual([full.kind, full.label, full.gaps.length], ['recorded', 'Audio recorded', 0]);
  const gappy = audioReport({ session, log: [], audio: [{ startTs: at(0), endTs: at(10) }, { startTs: at(12), endTs: at(30) }] });
  assert.deepEqual([gappy.kind, gappy.label, gappy.gapMs], ['gaps', 'Audio recorded with gaps', 2000]);
  const none = audioReport({ session, log: [], audio: [] });
  assert.deepEqual([none.kind, none.label, none.gaps], ['none', 'No audio recorded', []]);
});

test('audioReport: denied on page 3 after audio on pages 1–2 is "with gaps", never "not recorded"', () => {
  const session = { study: 's', startedAt: at(0), endedAt: at(90), audio: { enabled: false } }; // older record
  const log = [{ ts: at(60), type: 'audio-gap', gapStart: at(60), gapMs: null, message: 'Microphone unavailable: Microphone access was denied' }];
  const audio = [{ startTs: at(0), endTs: at(30) }, { startTs: at(30.3), endTs: at(60) }];
  const report = audioReport({ session, log, audio });
  assert.equal(report.label, 'Audio recorded with gaps');
  assert.equal(report.gaps[0].reason, 'Microphone unavailable: Microphone access was denied');
  const md = buildSummary({ session, log, audio });
  assert.ok(md.includes(`- Audio saved: Audio recorded with gaps (${GAPS_MEANING})`), md);
  assert.ok(!md.includes('not recorded'), md);
});

test('buildSummary: seq problems are surfaced; a dropped segment explains its gap', () => {
  const session = { study: 's', startedAt: at(0), endedAt: at(30), audio: { enabled: true } };
  const audio = [{ startTs: at(0), endTs: at(10), seqGaps: [3] }, { startTs: at(20), endTs: at(30) }];
  const dropped = [{ startTs: at(10), endTs: at(20), reason: 'missing-first-chunk' }];
  const md = buildSummary({ session, log: [], audio, audioDropped: dropped });
  assert.ok(md.includes('- Unreliable audio segments: 1 (missing chunks; playback may stop early)'), md);
  assert.ok(md.includes('- Lost audio segments: 1'), md);
  assert.ok(md.includes(LOST_SEGMENT_REASON), md);
  const none = buildSummary({ session, log: [], audio: [] });
  assert.ok(none.includes('- Audio saved: No audio recorded'), none);
});

test('skipped tasks: status Skipped, never Completed, and counted separately', () => {
  const tasks = [{ id: 't1', prompt: 'One' }, { id: 't2', prompt: 'Two' }, { id: 't3', prompt: 'Three' }];
  const session = { tasks, startedAt: at(0), endedAt: at(30), tasksCompleted: 2, tasksSkipped: 1 };
  const log = [
    { ts: at(1), type: 'task-start', taskId: 't1' },
    { ts: at(5), type: 'task-end', taskId: 't1', completed: true },
    { ts: at(5), type: 'task-start', taskId: 't2' },
    { ts: at(9), type: 'task-end', taskId: 't2', completed: false, reason: 'skipped' },
    { ts: at(9), type: 'task-start', taskId: 't3' },
    { ts: at(20), type: 'task-end', taskId: 't3', completed: true },
    { ts: at(20), type: 'session-end', taskId: null },
  ];
  const spans = buildTaskSpans({ session, log });
  assert.deepEqual(spans.map((sp) => [sp.taskId, sp.completed, sp.skipped]), [['t1', true, false], ['t2', false, true], ['t3', true, false]]);
  assert.equal(taskStatus(spans[1]), 'Skipped');
  assert.deepEqual(taskCounts(spans, tasks), { done: 2, total: 3, skipped: 1 });
  const md = buildSummary({ session, log });
  assert.ok(md.includes('- Tasks completed: 2 of 3, 1 skipped'), md);
  assert.ok(md.slice(md.indexOf('## Task 2'), md.indexOf('## Task 3')).includes('- Status: Skipped'));
  // No skips: the line reads as before.
  assert.ok(buildSummary({ session, log: log.filter((e) => e.reason !== 'skipped') }).includes('- Tasks completed: 2 of 3\n'));
});

test('skipped is read from rrweb custom events too', () => {
  const events = [
    { type: 5, timestamp: at(1), data: { tag: 'testkit:task-start', payload: { taskId: 't1', index: 0 } } },
    { type: 5, timestamp: at(9), data: { tag: 'testkit:task-end', payload: { taskId: 't1', index: 0, completed: false, reason: 'skipped' } } },
  ];
  const [span] = buildTaskSpans({ session: { tasks: [{ id: 't1' }] }, log: [], events });
  assert.equal(span.skipped, true);
  assert.equal(span.completed, false);
});
