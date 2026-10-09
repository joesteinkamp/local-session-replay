// Builds the agent-ready markdown summary from a session's interaction log.
// Pure functions only: this module is bundled into both the core (at export
// time) and the player (as a fallback when the payload has no summary).

export const RAGE_CLICK_COUNT = 3;
export const RAGE_CLICK_WINDOW_MS = 1000;
export const IDLE_THRESHOLD_MS = 20000;
// Recorder start latency leaves sub-second slivers at segment edges; ignore them.
export const AUDIO_GAP_MIN_MS = 500;

// Page errors stay in the raw log but are left out of the summary: this is a
// usability test of the design, not a test of the prototype's code.
const TRAIL_TYPES = new Set(['click', 'input', 'change', 'submit', 'nav', 'pause', 'resume', 'mute', 'unmute', 'audio-gap']);
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

const pathKey = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
};

// Unique pages in visit order, starting with the page the session started
// on. A replaceState that only rewrites the query/hash of the page just
// listed (hosts syncing state into the URL) updates that entry instead of
// adding one.
export function pagesVisited({ session = {}, log = [], baseUrl = null } = {}) {
  const urls = [];
  const first = session.meta?.prototypeUrl || session.segments?.[0]?.url;
  if (first) urls.push(first);
  for (const e of log) {
    if (e.type !== 'nav' || e.navType === 'beforeunload') continue;
    const url = e.to || e.url;
    if (!url) continue;
    const last = urls[urls.length - 1];
    if (e.navType === 'replaceState' && last && pathKey(last) === pathKey(url)) urls[urls.length - 1] = url;
    else urls.push(url);
  }
  return [...new Set(urls.map((u) => shortUrl(u, baseUrl)))];
}

function quote(text, max = 80) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const cut = clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  return `"${cut.replace(/"/g, '\\"')}"`;
}

// gapMs is null when the mic could not be re-acquired (length unknown).
function gapMsOf(entry) {
  return Number.isFinite(entry.gapMs) ? entry.gapMs : null;
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
    else if (tag === 'testkit:task-end') derived.push({ ts: ev.timestamp, type: 'task-end', taskId: p.taskId ?? null, index: p.index, completed: p.completed, reason: p.reason });
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

// One span per task that was started:
// { taskId, index, task, start, end, ended, completed, skipped }.
// A task without a task-end closes at the next task-start, session-end, or the
// last known timestamp. `ended` means a task-end was logged; `completed` means
// the tester finished it (Next), not that Stop closed it; `skipped` means the
// tester pressed Skip task (task-end reason 'skipped'). task-end carries
// `completed`; older data falls back to session.tasksCompleted, which counts
// Next presses and therefore the first N ended spans.
export function buildTaskSpans({ session = {}, log = [], events = [] }) {
  const tasks = session.tasks || session.config?.tasks || [];
  const entries = boundaryEntries(log, events);
  const { end: sessionEnd } = sessionBounds({ session, log, events });
  const spans = [];
  let current = null;
  const close = (ts, ended, completed = ended ? null : false, reason = null) => {
    if (!current) return;
    current.end = Math.max(current.start, ts);
    current.ended = ended;
    current.skipped = reason === 'skipped';
    current.completed = current.skipped ? false : typeof completed === 'boolean' ? completed : null;
    spans.push(current);
    current = null;
  };
  for (const e of entries) {
    if (e.type === 'task-start') {
      close(e.ts, false);
      const index = Number.isInteger(e.index) ? e.index : tasks.findIndex((t) => t.id === e.taskId);
      current = { taskId: e.taskId ?? tasks[index]?.id ?? null, index, task: tasks[index] || null, start: e.ts, end: null, ended: false };
    } else if (e.type === 'task-end' && current && (e.taskId == null || e.taskId === current.taskId)) {
      close(e.ts, true, e.completed, e.reason);
    } else if (e.type === 'session-end') {
      close(e.ts, false);
    }
  }
  close(sessionEnd ?? current?.start ?? 0, false);
  const known = Number.isFinite(session.tasksCompleted) ? session.tasksCompleted : null;
  let counted = 0;
  for (const span of spans) {
    if (span.completed !== null) continue;
    span.completed = known === null ? span.ended : counted < known;
    counted += 1;
  }
  return spans;
}

// ---------- audio coverage ----------

// Uncovered intervals of [start, end) after removing `covered` spans.
function uncovered(start, end, covered, minMs) {
  const sorted = covered.filter((c) => c.end > start && c.start < end).sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = start;
  for (const c of sorted) {
    if (c.start - cursor >= minMs) out.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (end - cursor >= minMs) out.push({ start: cursor, end });
  return out;
}

// Recording time (minus pauses) with no audio segment. With `audio` segments
// this is computed from coverage, so silent failures show up even when no
// audio-gap entry was logged; each gap borrows the reason from an overlapping
// audio-gap entry (or a segment dropped as unplayable). Without segments it
// falls back to the logged entries. Saved segments always count, whatever
// `session.audio.enabled` says: older sessions set it to false on a later
// denial even though earlier pages had audio. Returns
// [{ start, end, durationMs, reason }].
export function audioGaps({ session = {}, log = [], audio, dropped = [], start, end, pauses = [], minMs = AUDIO_GAP_MIN_MS }) {
  const hasSegments = Array.isArray(audio) && audio.length > 0;
  if (!hasSegments && session.audio?.enabled === false) return [];
  const logged = log.filter((e) => e.type === 'audio-gap').map((e) => {
    const ms = gapMsOf(e);
    const from = Number.isFinite(e.gapStart) ? e.gapStart : ms !== null ? e.ts - ms : e.ts;
    return { start: from, end: ms !== null ? from + ms : e.ts, ts: e.ts, durationMs: ms, reason: e.message || null };
  });
  if (!Array.isArray(audio) || !Number.isFinite(start) || !Number.isFinite(end)) {
    return logged.map(({ ts, ...g }) => g);
  }
  const lost = (dropped || []).filter((d) => Number.isFinite(d.startTs) && Number.isFinite(d.endTs))
    .map((d) => ({ start: d.startTs, end: d.endTs, ts: d.endTs, reason: LOST_SEGMENT_REASON }));
  const reasons = [...logged, ...lost];
  const covered = [...pauses, ...audio.filter((a) => Number.isFinite(a.startTs) && Number.isFinite(a.endTs)).map((a) => ({ start: a.startTs, end: a.endTs }))];
  return uncovered(start, end, covered, minMs).map((g) => {
    const why = reasons.find((l) => l.reason && l.start <= g.end && Math.max(l.end, l.ts) >= g.start);
    return { ...g, durationMs: g.end - g.start, reason: why?.reason || null };
  });
}

export const LOST_SEGMENT_REASON = 'Audio segment lost (its first chunk was not saved)';

// The one "what audio was saved" verdict, shared by the overlay's
// pre-download line, the summary and the player so they can't disagree.
export const SAVED_AUDIO = {
  recorded: 'Audio recorded',
  gaps: 'Audio recorded with gaps',
  none: 'No audio recorded',
};
export const GAPS_MEANING = 'Gaps are stretches where the microphone was not capturing, not places where speech was hard to hear.';

/**
 * `audio` = grouped segments (store.groupAudioChunks), `dropped` = segments
 * lost entirely. Returns { kind: 'recorded'|'gaps'|'none', label, gaps,
 * gapMs, segments, unreliable, dropped }. Based only on persisted segments.
 */
export function audioReport({ session = {}, log = [], events = [], audio = [], dropped = [] } = {}) {
  const segments = Array.isArray(audio) ? audio : [];
  const { start, end } = sessionBounds({ session, log, events });
  const pauses = pausedSpans(log, end ?? Infinity);
  const gaps = segments.length ? audioGaps({ session, log, audio: segments, dropped, start, end, pauses }) : [];
  const kind = !segments.length ? 'none' : gaps.length ? 'gaps' : 'recorded';
  return {
    kind,
    label: SAVED_AUDIO[kind],
    gaps,
    gapMs: gaps.reduce((sum, g) => sum + (g.durationMs || 0), 0),
    segments: segments.length,
    unreliable: segments.filter((s) => Array.isArray(s.seqGaps) && s.seqGaps.length).length,
    dropped: (dropped || []).length,
  };
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
    case 'audio-gap': {
      const gap = gapMsOf(item);
      // The "Audio gaps" line counts only gaps of AUDIO_GAP_MIN_MS or more;
      // say so here, or a short page-load gap looks like a missed one.
      const below = gap !== null && gap < AUDIO_GAP_MIN_MS ? ' (under 0.5s, not counted as a gap)' : '';
      return `${t} audio-gap${gap !== null ? ` ${(gap / 1000).toFixed(1)}s` : ''}${below}${item.message ? ` ${quote(item.message, 120)}` : ''}`;
    }
    default:
      return `${t} ${item.type}`;
  }
}

// ---------- markdown ----------

export function taskStatus(span) {
  if (span.skipped) return 'Skipped';
  return span.completed ? 'Completed' : 'Not completed (session stopped)';
}

// { done, total, skipped } for "2 of 3 completed, 1 skipped"; shared by the
// summary and the player header.
export function taskCounts(spans, tasks = []) {
  return {
    done: spans.filter((s) => s.completed).length,
    total: tasks.length || spans.length,
    skipped: spans.filter((s) => s.skipped).length,
  };
}

export const skippedSuffix = ({ skipped }) => (skipped ? `, ${skipped} skipped` : '');

function inSpan(ts, span) {
  return ts >= span.start && ts <= span.end;
}

function sessionSignals({ session, log, events, spans }) {
  const { start, end } = sessionBounds({ session, log, events });
  const pauses = pausedSpans(log, end ?? Infinity);
  return { start, end, pauses };
}

// `audio` is the segment list ({ startTs, endTs }); when given, audio gaps are
// derived from coverage rather than only from logged audio-gap entries.
export function buildSummary({ session = {}, log = [], events = [], audio, audioDropped = [] } = {}) {
  const meta = session.meta || {};
  const baseUrl = meta.prototypeUrl || session.segments?.[0]?.url || null;
  const spans = buildTaskSpans({ session, log, events });
  const { start, end, pauses } = sessionSignals({ session, log, events, spans });
  const pausedTotal = start !== null && end !== null ? overlapMs(start, end, pauses) : 0;
  const tasks = session.tasks || session.config?.tasks || [];
  const viewport = meta.viewport ? `${meta.viewport.w}×${meta.viewport.h}` : 'unknown';
  // With segments given, gaps come from the same audioReport() the overlay
  // and the player use; older callers without segments use the logged entries.
  const report = Array.isArray(audio) ? audioReport({ session, log, events, audio, dropped: audioDropped }) : null;
  const gaps = report ? report.gaps : audioGaps({ session, log, start, end, pauses });
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
  const counts = taskCounts(spans, tasks);
  // Kept as "Tasks completed: N of M" for readers of older summaries.
  lines.push(`- Tasks completed: ${counts.done} of ${counts.total}${skippedSuffix(counts)}`);
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
    lines.push(`- Status: ${taskStatus(span)}`);
    lines.push(`- Duration: ${formatDuration(active)}${paused ? ` (+${formatDuration(paused)} paused)` : ''}`);
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
    // A gap straddling a task boundary can leave a sliver on one side; skip those.
    for (const g of gaps.filter((gap) => Math.min(gap.end, span.end) - Math.max(gap.start, span.start) >= 100)) {
      const from = Math.max(g.start, span.start);
      const len = g.durationMs === null ? 'unknown length' : `${((Math.min(g.end, span.end) - from) / 1000).toFixed(1)}s`;
      signals.push(`- Audio gap: ${len} from ${clock(from - span.start)}${g.reason ? ` (${g.reason})` : ''}`);
    }
    lines.push('', '### Signals', '', ...(signals.length ? signals : ['- none']), '');
  });

  const started = new Set(spans.map((s) => s.taskId));
  const notReached = tasks.filter((t) => !started.has(t.id));
  if (notReached.length) {
    lines.push('## Tasks not reached', '', ...notReached.map((t) => `- ${t.id}: ${t.prompt}`), '');
  }

  lines.push('## Session-level', '');
  const hasSegments = Array.isArray(audio) && audio.length > 0;
  if (report) {
    lines.push(`- Audio saved: ${report.label}${report.kind === 'gaps' ? ` (${GAPS_MEANING})` : ''}`);
  }
  if (!hasSegments && session.audio?.enabled === false) {
    if (!Array.isArray(audio)) lines.push('- Audio: not recorded');
  } else if (Array.isArray(audio) && !hasSegments) {
    if (audioDropped.length) lines.push(`- Lost audio segments: ${audioDropped.length} (first chunk not saved; unplayable)`);
  } else {
    const gapTotal = gaps.reduce((sum, g) => sum + (g.durationMs || 0), 0);
    const unmeasured = gaps.filter((g) => g.durationMs === null).length;
    const detail = `${(gapTotal / 1000).toFixed(1)}s total${unmeasured ? `, ${unmeasured} without a measured length` : ''}; mm:ss from session start`;
    if (Array.isArray(audio)) lines.push(`- Audio segments: ${audio.length}`);
    const unreliable = hasSegments ? audio.filter((a) => Array.isArray(a.seqGaps) && a.seqGaps.length) : [];
    if (unreliable.length) lines.push(`- Unreliable audio segments: ${unreliable.length} (missing chunks; playback may stop early)`);
    if (audioDropped.length) lines.push(`- Lost audio segments: ${audioDropped.length} (first chunk not saved; unplayable)`);
    lines.push(`- Audio gaps: ${gaps.length ? `${gaps.length} (${detail})` : 'none of 0.5s or more'}`);
    for (const g of gaps.slice(0, 20)) {
      const len = g.durationMs === null ? 'unknown length' : `${(g.durationMs / 1000).toFixed(1)}s`;
      lines.push(`  - ${clock(g.start - start)}–${clock(g.end - start)} (${len})${g.reason ? ` ${g.reason}` : ''}`);
    }
    if (gaps.length > 20) lines.push(`  - … ${gaps.length - 20} more`);
  }
  const mutes = log.filter((e) => e.type === 'mute').length;
  if (mutes) lines.push(`- Muted: ${mutes}×`);
  lines.push(`- Pauses: ${pauses.length ? `${pauses.length} (${formatDuration(pausedTotal)} total)` : 'none'}`);
  const pages = pagesVisited({ session, log, baseUrl });
  if (pages.length) lines.push(`- Pages visited: ${pages.join(', ')}`);
  lines.push(`- Page loads: ${session.segments?.length ?? 'unknown'}`);
  lines.push('');
  return lines.join('\n');
}
