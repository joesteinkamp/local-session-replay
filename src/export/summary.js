// Builds the agent-ready markdown summary from a session's interaction log.
// Pure functions only: this module is bundled into both the core (at export
// time) and the player (as a fallback when the payload has no summary).

export const RAGE_CLICK_COUNT = 3;
export const RAGE_CLICK_WINDOW_MS = 1000;
export const IDLE_THRESHOLD_MS = 20000;

const TRAIL_TYPES = new Set(['click', 'input', 'change', 'submit', 'nav', 'error', 'rejection', 'pause', 'resume', 'mute', 'unmute', 'audio-gap']);
const ERROR_TYPES = new Set(['error', 'rejection']);
// rrweb IncrementalSource values that mean "the tester was doing something".
const ACTIVITY_SOURCES = new Set([1, 2, 3, 5, 6]); // MouseMove, MouseInteraction, Scroll, Input, TouchMove
const RRWEB_INCREMENTAL = 3;
const RRWEB_CUSTOM = 5;

// ---------- formatting ----------

// Durations round to the nearest second; trail clocks floor, like a video
// timestamp, so an event never appears later than it happened.
export function formatDuration(ms, { floor = false } = {}) {
  const sec = Math.max(0, (Number(ms) || 0) / 1000);
  const total = floor ? Math.floor(sec) : Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

const clock = (ms) => formatDuration(ms, { floor: true });

export function formatTimestamp(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'n/a';
}

// Compact "Chrome 128 on macOS" label; falls back to the raw UA.
export function describeBrowser(ua) {
  if (!ua) return 'unknown';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : null;
  // Edge and Opera also claim Chrome, so they are checked first.
  const match = ua.match(/(Edg|OPR)\/(\d+)/) || ua.match(/(Firefox|Chrome)\/(\d+)/)
    || (/Safari/.test(ua) && ua.match(/(Version)\/(\d+(?:\.\d+)?)/));
  if (!match) return ua;
  const name = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' }[match[1]] || match[1];
  return `${name} ${match[2]}${os ? ` on ${os}` : ''}`;
}

// Strips the prototype's origin so trail lines stay short.
export function shortUrl(url, baseUrl) {
  if (!url) return '';
  try {
    const u = new URL(url, baseUrl || undefined);
    const base = baseUrl ? new URL(baseUrl) : null;
    if (base && u.origin === base.origin) return `${u.pathname}${u.search}${u.hash}`;
    return u.href;
  } catch {
    return String(url);
  }
}

function quote(text, max = 80) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const cut = clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  return `"${cut.replace(/"/g, '\\"')}"`;
}

function gapMsOf(entry) {
  const v = entry.gapMs ?? entry.durationMs ?? entry.value;
  return Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null;
}

// ---------- spans ----------

// Paused intervals [start, end) from pause/resume log entries. A pause with no
// resume runs to `endTs`.
export function pausedSpans(log, endTs = Infinity) {
  const spans = [];
  let open = null;
  for (const e of log) {
    if (e.type === 'pause' && open === null) open = e.ts;
    else if (e.type === 'resume' && open !== null) {
      spans.push({ start: open, end: Math.max(open, e.ts) });
      open = null;
    } else if (e.type === 'session-end' && open !== null) {
      spans.push({ start: open, end: Math.max(open, e.ts) });
      open = null;
    }
  }
  if (open !== null && Number.isFinite(endTs)) spans.push({ start: open, end: Math.max(open, endTs) });
  return spans;
}

export function overlapMs(start, end, spans) {
  let total = 0;
  for (const s of spans) total += Math.max(0, Math.min(end, s.end) - Math.max(start, s.start));
  return total;
}

// Task boundaries come from the log; when the log has none (older or partial
// data) they are recovered from rrweb custom events.
function boundaryEntries(log, events = []) {
  if (log.some((e) => e.type === 'task-start')) return log;
  const derived = [];
  for (const ev of events) {
    if (ev.type !== RRWEB_CUSTOM) continue;
    const tag = ev.data?.tag;
    const p = ev.data?.payload || {};
    if (tag === 'testkit:task-start') derived.push({ ts: ev.timestamp, type: 'task-start', taskId: p.taskId ?? null, index: p.index });
    else if (tag === 'testkit:task-end') derived.push({ ts: ev.timestamp, type: 'task-end', taskId: p.taskId ?? null, index: p.index });
  }
  return derived.length ? [...log, ...derived].sort((a, b) => a.ts - b.ts) : log;
}

function sessionBounds({ session = {}, log = [], events = [] }) {
  const firstEvent = events.length ? events[0].timestamp : Infinity;
  const lastEvent = events.length ? events[events.length - 1].timestamp : -Infinity;
  const firstLog = log.length ? log[0].ts : Infinity;
  const lastLog = log.length ? log[log.length - 1].ts : -Infinity;
  const start = Number.isFinite(session.startedAt) ? session.startedAt : Math.min(firstEvent, firstLog);
  const end = Number.isFinite(session.endedAt) ? session.endedAt : Math.max(lastEvent, lastLog);
  return {
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
  };
}

// One span per task that was started: { taskId, index, task, start, end, ended }.
// A task without a task-end closes at the next task-start, session-end, or the
// last known timestamp.
export function buildTaskSpans({ session = {}, log = [], events = [] }) {
  const tasks = session.tasks || session.config?.tasks || [];
  const entries = boundaryEntries(log, events);
  const { end: sessionEnd } = sessionBounds({ session, log, events });
  const spans = [];
  let current = null;
  const close = (ts, ended) => {
    if (!current) return;
    current.end = Math.max(current.start, ts);
    current.ended = ended;
    spans.push(current);
    current = null;
  };
  for (const e of entries) {
    if (e.type === 'task-start') {
      close(e.ts, false);
      const index = Number.isInteger(e.index) ? e.index : tasks.findIndex((t) => t.id === e.taskId);
      current = { taskId: e.taskId ?? tasks[index]?.id ?? null, index, task: tasks[index] || null, start: e.ts, end: null, ended: false };
    } else if (e.type === 'task-end' && current && (e.taskId == null || e.taskId === current.taskId)) {
      close(e.ts, true);
    } else if (e.type === 'session-end') {
      close(e.ts, false);
    }
  }
  close(sessionEnd ?? current?.start ?? 0, false);
  return spans;
}

// ---------- signals ----------

// Bursts of ≥count clicks on one selector where every gap is under windowMs
// and at least `count` of them fall inside a single window.
export function detectRageClicks(log, { count = RAGE_CLICK_COUNT, windowMs = RAGE_CLICK_WINDOW_MS } = {}) {
  const bySelector = new Map();
  for (const e of log) {
    if (e.type !== 'click' || !e.selector) continue;
    if (!bySelector.has(e.selector)) bySelector.set(e.selector, []);
    bySelector.get(e.selector).push(e);
  }
  const bursts = [];
  for (const [selector, clicks] of bySelector) {
    let run = [clicks[0]];
    const flush = () => {
      let hit = false;
      for (let i = 0; i + count - 1 < run.length && !hit; i++) {
        hit = run[i + count - 1].ts - run[i].ts <= windowMs;
      }
      if (hit) bursts.push({ selector, text: run[0].text || '', start: run[0].ts, end: run[run.length - 1].ts, count: run.length });
    };
    for (let i = 1; i < clicks.length; i++) {
      if (clicks[i].ts - clicks[i - 1].ts <= windowMs) run.push(clicks[i]);
      else {
        flush();
        run = [clicks[i]];
      }
    }
    flush();
  }
  return bursts.sort((a, b) => a.start - b.start);
}

// popstate, or arriving at a URL already visited this session. Reloads of the
// current page and replaceState are not backtracking.
export function detectBacktracking(log, { initialUrls = [] } = {}) {
  const norm = (u) => String(u || '').replace(/\/$/, '');
  const visited = new Set(initialUrls.filter(Boolean).map(norm));
  const hits = [];
  let current = initialUrls.length ? norm(initialUrls[initialUrls.length - 1]) : null;
  for (const e of log) {
    if (e.type !== 'nav') {
      if (current === null && e.url) {
        current = norm(e.url);
        visited.add(current);
      }
      continue;
    }
    if (e.navType === 'beforeunload' || e.navType === 'replaceState') continue;
    const to = norm(e.to || e.url);
    if (!to) continue;
    const reload = to === current || (e.navType === 'load' && norm(e.from) === to);
    if (!reload && (e.navType === 'popstate' || visited.has(to))) {
      hits.push({ ts: e.ts, from: e.from || current, to: e.to || e.url, navType: e.navType || null });
    }
    visited.add(to);
    current = to;
  }
  return hits;
}

// Gaps ≥ thresholdMs between consecutive log entries inside [start, end],
// with paused time subtracted. Each result notes whether rrweb saw pointer,
// scroll, or input activity during the gap (reading vs. truly idle).
export function detectIdle(log, { start, end, pauses = [], events = [], thresholdMs = IDLE_THRESHOLD_MS } = {}) {
  const lo = Number.isFinite(start) ? start : log[0]?.ts;
  const hi = Number.isFinite(end) ? end : log[log.length - 1]?.ts;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const points = [lo, ...log.map((e) => e.ts).filter((ts) => ts > lo && ts < hi), hi];
  const idle = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const active = b - a - overlapMs(a, b, pauses);
    if (active >= thresholdMs) {
      const activity = events.some((ev) => ev.type === RRWEB_INCREMENTAL && ev.timestamp > a && ev.timestamp < b
        && ACTIVITY_SOURCES.has(ev.data?.source) && !pauses.some((p) => ev.timestamp >= p.start && ev.timestamp < p.end));
      idle.push({ start: a, end: b, durationMs: active, activity });
    }
  }
  return idle;
}

// ---------- trail ----------

// Collapses runs of input/change on the same selector into one line that
// keeps the final value.
export function collapseTrail(entries) {
  const out = [];
  for (const e of entries) {
    if (!TRAIL_TYPES.has(e.type)) continue;
    if (e.type === 'nav' && (e.navType === 'beforeunload' || e.navType === 'replaceState')) continue;
    const prev = out[out.length - 1];
    if ((e.type === 'input' || e.type === 'change') && prev && (prev.type === 'input' || prev.type === 'change')
      && prev.selector === e.selector) {
      prev.value = e.value ?? prev.value;
      prev.edits += 1;
      prev.lastTs = e.ts;
      if (e.type === 'input') prev.type = 'input';
      continue;
    }
    out.push({ ...e, edits: 1, lastTs: e.ts });
  }
  return out;
}

export function formatTrailLine(item, originTs, baseUrl) {
  const t = clock(item.ts - originTs);
  switch (item.type) {
    case 'click':
      return `${t} click ${item.selector || '(unknown)'}${item.text ? ` ${quote(item.text)}` : ''}`;
    case 'input':
    case 'change': {
      const value = item.value === undefined || item.value === null ? '' : ` = ${quote(item.value, 60)}`;
      return `${t} ${item.type} ${item.selector || '(unknown)'}${value}${item.edits > 1 ? ` (${item.edits} edits)` : ''}`;
    }
    case 'submit':
      return `${t} submit ${item.selector || '(form)'}`;
    case 'nav':
      return `${t} nav ${item.navType || ''} ${shortUrl(item.to || item.url, baseUrl)}`.replace(/\s+/g, ' ');
    case 'error':
    case 'rejection':
      return `${t} ${item.type} ${quote(item.message || 'unknown error', 120)}`;
    case 'audio-gap': {
      const gap = gapMsOf(item);
      return `${t} audio-gap${gap !== null ? ` ${(gap / 1000).toFixed(1)}s` : ''}${item.message ? ` ${quote(item.message, 120)}` : ''}`;
    }
    default:
      return `${t} ${item.type}`;
  }
}

// ---------- markdown ----------

function inSpan(ts, span) {
  return ts >= span.start && ts <= span.end;
}

function sessionSignals({ session, log, events, spans }) {
  const { start, end } = sessionBounds({ session, log, events });
  const pauses = pausedSpans(log, end ?? Infinity);
  const outside = log.filter((e) => !spans.some((s) => inSpan(e.ts, s)));
  return { start, end, pauses, outside };
}

export function buildSummary({ session = {}, log = [], events = [] } = {}) {
  const meta = session.meta || {};
  const baseUrl = meta.prototypeUrl || session.segments?.[0]?.url || null;
  const spans = buildTaskSpans({ session, log, events });
  const { start, end, pauses, outside } = sessionSignals({ session, log, events, spans });
  const pausedTotal = start !== null && end !== null ? overlapMs(start, end, pauses) : 0;
  const tasks = session.tasks || session.config?.tasks || [];
  const viewport = meta.viewport ? `${meta.viewport.w}×${meta.viewport.h}` : 'unknown';
  const lines = [];

  lines.push(`# TestKit session: ${session.study || 'untitled-study'}`, '');
  lines.push(`- Prototype: ${meta.prototypeUrl || 'unknown'}`);
  lines.push(`- Commit: ${meta.commitSha || session.config?.commitSha || 'unknown'}`);
  lines.push(`- Browser: ${describeBrowser(meta.userAgent)}`);
  lines.push(`- Viewport: ${viewport}`);
  lines.push(`- Started: ${formatTimestamp(start)}`);
  lines.push(`- Ended: ${formatTimestamp(end)}`);
  if (start !== null && end !== null) {
    const paused = pausedTotal ? ` (${formatDuration(end - start - pausedTotal)} active, ${formatDuration(pausedTotal)} paused)` : '';
    lines.push(`- Duration: ${formatDuration(end - start)}${paused}`);
  }
  lines.push(`- Tasks completed: ${spans.filter((s) => s.ended).length} of ${tasks.length || spans.length}`);
  lines.push(`- Session ID: ${session.id || 'unknown'}`);
  lines.push('', 'Times in trails are mm:ss from the start of each task. Input values of "***" were masked.', '');

  spans.forEach((span, i) => {
    const task = span.task || {};
    const label = Number.isInteger(span.index) && span.index >= 0 ? span.index + 1 : i + 1;
    const entries = log.filter((e) => inSpan(e.ts, span) && (e.taskId == null || e.taskId === span.taskId));
    const taskPauses = pauses.filter((p) => p.end > span.start && p.start < span.end);
    const paused = overlapMs(span.start, span.end, taskPauses);
    const active = span.end - span.start - paused;
    const followUp = log.find((e) => e.type === 'followup' && e.taskId === span.taskId);

    lines.push(`## Task ${label}: ${task.prompt || span.taskId || 'untitled task'}`, '');
    if (task.successHint) lines.push(`- Expected: ${task.successHint}`);
    lines.push(`- Duration: ${formatDuration(active)}${paused ? ` (+${formatDuration(paused)} paused)` : ''}${span.ended ? '' : ' (not ended; session stopped)'}`);
    if (task.timeLimit) {
      const over = active > task.timeLimit * 1000;
      lines.push(`- Time limit: ${formatDuration(task.timeLimit * 1000)}${over ? ` (exceeded by ${formatDuration(active - task.timeLimit * 1000)})` : ' (within)'}`);
    }
    if (task.followUp || followUp) {
      lines.push(`- Follow-up: ${task.followUp || '(question)'}`);
      lines.push(`  - Answer: ${followUp?.answer ? quote(followUp.answer, 2000) : '(no answer)'}`);
    }

    const trail = collapseTrail(entries);
    lines.push('', '### Trail', '');
    if (trail.length) {
      lines.push('```', ...trail.map((item) => formatTrailLine(item, span.start, baseUrl)), '```');
    } else {
      lines.push('(no interactions recorded)');
    }

    const errors = entries.filter((e) => ERROR_TYPES.has(e.type));
    if (errors.length) {
      lines.push('', '### Errors', '');
      for (const e of errors) {
        const frame = String(e.stack || '').split('\n').map((l) => l.trim()).find((l) => l && l !== e.message);
        lines.push(`- ${clock(e.ts - span.start)} ${e.type}: ${e.message || 'unknown error'}${frame ? ` (${frame})` : ''} on ${shortUrl(e.url, baseUrl) || 'unknown page'}`);
      }
    }

    const signals = [];
    for (const r of detectRageClicks(entries)) {
      signals.push(`- Rage click: ${r.count}× on ${r.selector}${r.text ? ` ${quote(r.text)}` : ''} at ${clock(r.start - span.start)}`);
    }
    const initial = log.filter((e) => e.ts < span.start && e.type === 'nav').map((e) => e.to || e.url);
    const firstUrl = session.segments?.[0]?.url || meta.prototypeUrl;
    for (const b of detectBacktracking(entries, { initialUrls: [firstUrl, ...initial].filter(Boolean) })) {
      signals.push(`- Backtracking: ${b.navType === 'popstate' ? 'back/forward' : 'returned'} to ${shortUrl(b.to, baseUrl)} at ${clock(b.ts - span.start)}`);
    }
    for (const idle of detectIdle(entries, { start: span.start, end: span.end, pauses: taskPauses, events })) {
      signals.push(`- Long idle: ${formatDuration(idle.durationMs)} without logged interaction from ${clock(idle.start - span.start)}${idle.activity ? ' (pointer/scroll activity seen; likely reading)' : ''}`);
    }
    if (task.timeLimit && active > task.timeLimit * 1000) signals.push(`- Time limit exceeded: ${formatDuration(active)} vs ${formatDuration(task.timeLimit * 1000)}`);
    if (errors.length) signals.push(`- Errors: ${errors.length}`);
    lines.push('', '### Signals', '', ...(signals.length ? signals : ['- none']), '');
  });

  const started = new Set(spans.map((s) => s.taskId));
  const notReached = tasks.filter((t) => !started.has(t.id));
  if (notReached.length) {
    lines.push('## Tasks not reached', '', ...notReached.map((t) => `- ${t.id}: ${t.prompt}`), '');
  }

  lines.push('## Session-level', '');
  const outsideErrors = outside.filter((e) => ERROR_TYPES.has(e.type));
  lines.push(`- Errors outside tasks: ${outsideErrors.length || 'none'}`);
  for (const e of outsideErrors) lines.push(`  - ${formatTimestamp(e.ts)} ${e.type}: ${e.message || 'unknown error'} on ${shortUrl(e.url, baseUrl) || 'unknown page'}`);
  const gaps = log.filter((e) => e.type === 'audio-gap');
  if (session.audio?.enabled === false) lines.push('- Audio: not recorded');
  else {
    const gapTotal = gaps.reduce((sum, e) => sum + (gapMsOf(e) || 0), 0);
    const unmeasured = gaps.filter((e) => gapMsOf(e) === null).length;
    const detail = `${(gapTotal / 1000).toFixed(1)}s total${unmeasured ? `, ${unmeasured} without a measured length` : ''}`;
    lines.push(`- Audio gaps: ${gaps.length ? `${gaps.length} (${detail})` : 'none'}`);
    for (const e of gaps.filter((g) => g.message)) lines.push(`  - ${formatTimestamp(e.ts)} ${e.message}`);
  }
  const mutes = log.filter((e) => e.type === 'mute').length;
  if (mutes) lines.push(`- Muted: ${mutes}×`);
  lines.push(`- Pauses: ${pauses.length ? `${pauses.length} (${formatDuration(pausedTotal)} total)` : 'none'}`);
  const pages = [...new Set(log.filter((e) => e.type === 'nav' && e.navType !== 'beforeunload').map((e) => shortUrl(e.to || e.url, baseUrl)))];
  if (pages.length) lines.push(`- Pages visited: ${pages.join(', ')}`);
  lines.push(`- Page loads: ${session.segments?.length ?? 'unknown'}`);
  lines.push('');
  return lines.join('\n');
}
