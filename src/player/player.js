// Replay page inlined into every export. Runs offline (file:// included): all
// data comes from #testkit-data and audio is data URLs. See docs/CONTRACTS.md.
import rrwebPlayer from 'rrweb-player';
import RRWEB_CSS from 'rrweb-player/dist/style.css';
import PLAYER_CSS from './player.css';
import {
  GAPS_MEANING, audioReport, buildSummary, buildTaskSpans, describeBrowser, detectRageClicks, formatDuration, overlapMs, pausedSpans,
  skippedSuffix, taskCounts,
} from '../export/summary.js';
import { buildFilename } from '../export/html.js';
import { findRemoteAssets } from './assets.js';

const SEEK_STEP_MS = 5000;
const SEEK_PAGE_MS = 30000;
const DRIFT_TOLERANCE_S = 0.3;
// play() takes a moment to produce sound while the replayer keeps going, so
// the element starts behind by that latency × speed (measured ≈250 ms at 1×
// in Chrome). Once it is actually playing, it gets one tighter correction.
const SETTLE_TOLERANCE_S = 0.08;
const SETTLE_DELAY_MS = 250;
// Chrome and Firefox mute media above 4× (and speech is unintelligible anyway).
const MAX_AUDIBLE_RATE = 4;
const MIN_SKIPPABLE_PAUSE_MS = 1500;
const CONTROLLER_HEIGHT = 80; // rrweb-player's fixed controller bar
const RRWEB_META = 4;
const RRWEB_FULL_SNAPSHOT = 2;
const BAND_COLORS = 5;

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- tiny DOM helper ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `${RRWEB_CSS}\n${PLAYER_CSS}`;
  document.head.append(style);
}

function formatLocal(ts) {
  if (!Number.isFinite(ts)) return 'unknown';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- data ----------

function readPayload() {
  const el = document.getElementById('testkit-data');
  if (!el) throw new Error('This file has no embedded session data (#testkit-data is missing).');
  const payload = JSON.parse(el.textContent);
  if (!payload || typeof payload !== 'object') throw new Error('The embedded session data is not an object.');
  if (payload.version !== 1) throw new Error(`Unsupported export version: ${payload.version}. Open it with a matching TestKit player.`);
  return {
    ...payload,
    // The embedded text is already the payload as JSON (escaping keeps it
    // valid), so "Download raw JSON" re-reads it instead of re-serializing,
    // and nothing holds a second copy between downloads.
    rawJson: () => el.textContent,
    session: payload.session || {},
    events: Array.isArray(payload.events) ? payload.events : [],
    log: Array.isArray(payload.log) ? payload.log : [],
    audio: Array.isArray(payload.audio) ? payload.audio : [],
    audioDropped: Array.isArray(payload.audioDropped) ? payload.audioDropped : [],
    omittedAudio: Array.isArray(payload.omittedAudio) ? payload.omittedAudio : [],
  };
}

function viewportOf(session, events) {
  const vp = session.meta?.viewport;
  if (vp?.w && vp?.h) return vp;
  const meta = events.find((e) => e.type === RRWEB_META);
  return meta?.data?.width ? { w: meta.data.width, h: meta.data.height } : { w: 1280, h: 800 };
}

// ---------- audio sync ----------

// One hidden <audio> per segment. The replayer is the clock: on every time
// update the segment covering wall time is played at (wall - startTs) and
// everything else is paused.
function createAudioSync(segments, { onStatus }) {
  const host = h('div', { hidden: true, 'aria-hidden': 'true' });
  document.body.append(host);
  let volume = 1;
  let muted = false;
  let blocked = false;
  let lastKey = '';

  const items = segments.map((seg, i) => {
    const el = h('audio', { preload: 'auto' });
    const item = { seg, el, index: i, ready: false, failed: false, settleAt: null };
    el.addEventListener('playing', () => {
      item.settleAt = performance.now() + SETTLE_DELAY_MS;
    });
    // MediaRecorder WebM has no duration/cues; seeking far forward once makes
    // the browser index the file so later seeks land correctly.
    el.addEventListener('loadedmetadata', () => {
      if (el.duration !== Infinity) {
        item.ready = true;
        return;
      }
      const done = () => {
        if (!Number.isFinite(el.duration)) return;
        el.removeEventListener('durationchange', done);
        el.currentTime = 0;
        item.ready = true;
      };
      el.addEventListener('durationchange', done);
      el.currentTime = 1e7;
    });
    el.addEventListener('error', () => {
      item.failed = true;
      lastKey = '';
    });
    el.src = seg.dataUrl;
    host.append(el);
    return item;
  });

  const status = (key, text, warn = false) => {
    if (key === lastKey) return;
    lastKey = key;
    onStatus(text, warn);
  };

  const pauseAll = (except) => {
    for (const it of items) if (it !== except && !it.el.paused) it.el.pause();
  };

  const covering = (wall) => items.find((it) => wall >= it.seg.startTs && wall < it.seg.endTs);

  function update({ wall, playing, speed, skipping }) {
    if (!items.length) return;
    const it = covering(wall);
    pauseAll(it);
    if (!it) {
      status('gap', 'No audio at this point (gap between recordings)');
      return;
    }
    const label = `segment ${it.index + 1} of ${items.length}${it.seg.seqGaps?.length ? ', missing chunks' : ''}`;
    if (it.failed) {
      status(`fail-${it.index}`, `Audio ${label} can't be played in this browser (${it.seg.mime || 'unknown format'})`, true);
      return;
    }
    const target = (wall - it.seg.startTs) / 1000;
    if (!playing || skipping) {
      if (!it.el.paused) it.el.pause();
      if (it.ready && !it.el.seeking && Math.abs(it.el.currentTime - target) > DRIFT_TOLERANCE_S) it.el.currentTime = target;
      status(skipping ? 'skip' : `paused-${it.index}`, skipping ? 'Audio paused while skipping inactivity' : `Ready: ${label}`);
      return;
    }
    if (!it.ready) {
      status(`load-${it.index}`, `Loading audio ${label}…`);
      return;
    }
    if (speed > MAX_AUDIBLE_RATE) {
      if (!it.el.paused) it.el.pause();
      status(`fast-${it.index}`, `Muted above ${MAX_AUDIBLE_RATE}× (${label})`);
      return;
    }
    try {
      if (it.el.playbackRate !== speed) it.el.playbackRate = speed;
    } catch {
      it.el.pause();
      status(`rate-${speed}`, `Audio can't play at ${speed}×`, true);
      return;
    }
    const drift = Math.abs(it.el.currentTime - target);
    if (it.el.ended && target < it.el.duration - DRIFT_TOLERANCE_S) it.el.currentTime = target;
    else if (!it.el.seeking && drift > DRIFT_TOLERANCE_S) it.el.currentTime = target;
    else if (!it.el.seeking && !it.el.paused && it.settleAt !== null && performance.now() >= it.settleAt) {
      it.settleAt = null;
      if (drift > SETTLE_TOLERANCE_S) it.el.currentTime = target;
    }
    it.el.volume = volume;
    it.el.muted = muted;
    if (it.el.paused && !it.el.ended) {
      it.el.play().then(() => {
        blocked = false;
      }).catch((err) => {
        if (err?.name === 'NotAllowedError') {
          blocked = true;
          lastKey = '';
          status('blocked', 'The browser blocked audio. Press "Enable audio".', true);
        }
      });
    }
    if (!blocked) status(`play-${it.index}-${muted}`, muted ? `Muted (${label})` : `Playing ${label}`);
  }

  return {
    get count() { return items.length; },
    get blocked() { return blocked; },
    update,
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      for (const it of items) it.el.volume = volume;
    },
    setMuted(m) {
      muted = m;
      lastKey = '';
      for (const it of items) it.el.muted = muted;
    },
    // Called from a click so play() runs inside a user gesture.
    unblock(wall) {
      blocked = false;
      lastKey = '';
      const it = covering(wall);
      if (it) it.el.play().catch(() => {});
    },
    pause: () => pauseAll(null),
  };
}

// ---------- volume control ----------

// Lucide volume-2 / volume-x, inline so the export stays offline.
const SPEAKER = 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z';
const speakerIcon = (extra) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${SPEAKER}"/>${extra}</svg>`;
const ICON_ON = speakerIcon('<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>');
const ICON_OFF = speakerIcon('<path d="M22 9l-6 6"/><path d="M16 9l6 6"/>');

// The player's only volume control: a speaker button beside fullscreen that
// slides a slider out on hover or keyboard focus. Clicking the speaker mutes.
function createVolumeControl(audioSync) {
  let muted = false;
  let level = 100; // restored on unmute; the slider shows 0 while muted
  const button = h('button', { type: 'button', class: 'tk-volume-btn', 'aria-label': 'Mute', 'aria-pressed': 'false' });
  const slider = h('input', {
    type: 'range', class: 'tk-volume-slider', min: '0', max: '100', value: '100', 'aria-label': 'Volume',
  });
  const render = () => {
    button.innerHTML = muted || slider.value === '0' ? ICON_OFF : ICON_ON;
    button.setAttribute('aria-pressed', String(muted));
    button.title = muted ? 'Unmute' : 'Mute';
    slider.style.setProperty('--tk-level', `${slider.value}%`);
  };
  const setMuted = (m) => {
    muted = m;
    if (m) {
      slider.value = '0';
    } else {
      if (slider.value === '0') slider.value = String(level || 100);
      audioSync.setVolume(Number(slider.value) / 100);
    }
    audioSync.setMuted(m);
    render();
  };
  button.addEventListener('click', () => setMuted(!muted));
  slider.addEventListener('input', () => {
    if (slider.value !== '0') level = Number(slider.value);
    // Dragging the slider up is an unmute, as in any media player.
    if (muted && slider.value !== '0') setMuted(false);
    else {
      audioSync.setVolume(Number(slider.value) / 100);
      render();
    }
  });
  render();
  return h('div', { class: 'tk-volume', role: 'group', 'aria-label': 'Audio volume' }, button, slider);
}

// ---------- timeline ----------

function createTimeline({ t0, t1, spans, pauses, gaps, onSeek, onToggle }) {
  const total = Math.max(1, t1 - t0);
  const pct = (ts) => `${(Math.min(Math.max(ts, t0), t1) - t0) / total * 100}%`;
  const width = (a, b) => `${(Math.min(b, t1) - Math.max(a, t0)) / total * 100}%`;
  let current = 0;
  let dragging = false;

  const bands = spans.map((span, i) => h('div', {
    class: `tk-band tk-band--${i % BAND_COLORS}`,
    style: { left: pct(span.start), width: width(span.start, span.end) },
    title: span.label,
  }, span.short));
  const playhead = h('div', { class: 'tk-playhead' });
  const lane = h('div', { class: 'tk-lane' },
    pauses.map((p) => h('div', { class: 'tk-pause', style: { left: pct(p.start), width: width(p.start, p.end) } })),
    gaps.map((g) => h('div', { class: 'tk-gap', style: { left: pct(g.start), width: width(g.start, g.end) } })));
  const bandPauses = pauses.map((p) => h('div', { class: 'tk-pause tk-pause--band', style: { left: pct(p.start), width: width(p.start, p.end) } }));

  const el = h('div', {
    class: 'tk-timeline',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Session timeline',
    'aria-valuemin': '0',
    'aria-valuemax': String(Math.round(total / 1000)),
    'aria-describedby': 'tk-timeline-hint',
  }, bands, bandPauses, lane, playhead);

  const offsetFromEvent = (ev) => {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) * total;
  };

  let lastSeek = 0;
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    el.focus();
    onSeek(offsetFromEvent(ev));
    lastSeek = performance.now();
  });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const off = offsetFromEvent(ev);
    render(off);
    // Each seek rebuilds the DOM from the last snapshot; throttle while dragging.
    if (performance.now() - lastSeek > 150) {
      onSeek(off);
      lastSeek = performance.now();
    }
  });
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    onSeek(offsetFromEvent(ev));
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', () => { dragging = false; });

  el.addEventListener('keydown', (ev) => {
    const step = { ArrowLeft: -SEEK_STEP_MS, ArrowDown: -SEEK_STEP_MS, ArrowRight: SEEK_STEP_MS, ArrowUp: SEEK_STEP_MS, PageDown: -SEEK_PAGE_MS, PageUp: SEEK_PAGE_MS }[ev.key];
    let target = null;
    if (step !== undefined) target = current + step * (ev.shiftKey ? 6 : 1);
    else if (ev.key === 'Home') target = 0;
    else if (ev.key === 'End') target = total;
    else if (ev.key === ' ') {
      ev.preventDefault();
      onToggle();
      return;
    } else return;
    ev.preventDefault();
    onSeek(Math.min(total, Math.max(0, target)));
  });

  function render(offset) {
    playhead.style.left = `${Math.min(1, Math.max(0, offset / total)) * 100}%`;
  }

  return {
    el,
    update(offset, valueText, currentIndex) {
      current = offset;
      if (!dragging) render(offset);
      el.setAttribute('aria-valuenow', String(Math.round(offset / 1000)));
      el.setAttribute('aria-valuetext', valueText);
      bands.forEach((b, i) => b.classList.toggle('is-current', i === currentIndex));
    },
  };
}

// ---------- speed menu ----------

const SPEEDS = [0.5, 1, 1.25, 1.5, 2, 4, 8];
// Lucide chevron-down / check, inline so the export stays offline.
const lucide = (size, d) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
const ICON_CHEVRON = lucide(14, 'm6 9 6 6 6-6');
const ICON_CHECK = lucide(16, 'M20 6 9 17l-5-5');

// rrweb-player's row of speed buttons, collapsed into one "1× ⌄" button that
// opens a menu upward over the replay (as in Slack's player). Menu-button
// keyboard pattern: arrows move, Enter/Space pick, Escape closes.
function createSpeedMenu({ speeds, initial, hasAudio, onChange }) {
  let current = initial;
  const value = h('span', { class: 'tk-speed-value' });
  const button = h('button', {
    type: 'button', class: 'tk-speed-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'tk-speed-menu',
  }, h('span', { class: 'tk-sr' }, 'Playback speed '), value);
  button.insertAdjacentHTML('beforeend', ICON_CHEVRON);
  const items = speeds.map((s) => {
    const item = h('div', { class: 'tk-speed-item', role: 'menuitemradio', tabindex: '-1', 'data-speed': s },
      h('span', { class: 'tk-speed-check' }), `${s}×`,
      hasAudio && s > MAX_AUDIBLE_RATE ? h('span', { class: 'tk-speed-note' }, 'No audio') : null);
    item.firstChild.innerHTML = ICON_CHECK;
    return item;
  });
  const menu = h('div', { class: 'tk-speed-menu', id: 'tk-speed-menu', role: 'menu', 'aria-label': 'Playback speed' }, ...items);
  const popover = h('div', { class: 'tk-speed-popover', hidden: true },
    h('div', { class: 'tk-speed-head', 'aria-hidden': 'true' }, 'Playback speed'), menu);
  const el = h('div', { class: 'tk-speed' }, button, popover);

  const render = () => {
    value.textContent = `${current}×`;
    items.forEach((it) => it.setAttribute('aria-checked', String(Number(it.dataset.speed) === current)));
  };
  const isOpen = () => !popover.hidden;
  const close = (refocus) => {
    if (!isOpen()) return;
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  // The focus ring only shows when the keyboard is driving the menu.
  const open = (focusIndex, byKeyboard) => {
    popover.classList.toggle('is-keyboard', Boolean(byKeyboard));
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const checked = items.findIndex((it) => it.getAttribute('aria-checked') === 'true');
    items[focusIndex ?? Math.max(0, checked)].focus();
  };
  const pick = (s) => {
    close(true);
    if (s === current) return;
    current = s;
    render();
    onChange(s);
  };

  // Keep focus where it is on press, so Safari (which never focuses buttons on
  // click) doesn't blur the open menu and immediately reopen it.
  button.addEventListener('mousedown', (ev) => ev.preventDefault());
  // detail is 0 for clicks synthesized by Enter/Space.
  button.addEventListener('click', (ev) => (isOpen() ? close(true) : open(undefined, ev.detail === 0)));
  button.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    open(ev.key === 'ArrowUp' ? items.length - 1 : undefined, true);
  });
  menu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.tk-speed-item');
    if (item) pick(Number(item.dataset.speed));
  });
  menu.addEventListener('keydown', (ev) => {
    popover.classList.add('is-keyboard');
    const i = items.indexOf(document.activeElement);
    const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[ev.key];
    if (move !== undefined) items[(move + items.length) % items.length].focus();
    else if (ev.key === 'Enter' || ev.key === ' ') pick(Number(items[i].dataset.speed));
    else if (ev.key === 'Escape') close(true);
    else if (ev.key === 'Tab') close(false);
    else return;
    if (ev.key !== 'Tab') ev.preventDefault();
  });
  // Clicking anywhere else, the replay iframe included, takes focus away.
  el.addEventListener('focusout', (ev) => {
    if (!el.contains(ev.relatedTarget)) close(false);
  });

  render();
  return {
    el,
    // Follow speed changes made elsewhere (TestKitPlayer.player.setSpeed).
    set(s) {
      if (s === current || !speeds.includes(s)) return;
      current = s;
      render();
    },
  };
}

// ---------- actions ----------

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through: file:// or a denied permission still allows execCommand.
  }
  const ta = h('textarea', { readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function createToast() {
  const el = h('div', { class: 'tk-toast', role: 'status', 'aria-live': 'polite' });
  let timer;
  return {
    el,
    show(text) {
      clearTimeout(timer);
      el.classList.remove('is-hiding');
      el.textContent = text;
      timer = setTimeout(() => {
        el.classList.add('is-hiding');
        timer = setTimeout(() => { el.textContent = ''; }, reducedMotion ? 0 : 200);
      }, 2600);
    },
  };
}

// ---------- v1.5 transcription hook (intentionally not implemented) ----------
// Local Whisper (transformers.js, WASM/WebGPU) will run here, inside the
// exported file on the viewer's machine: it receives payload.audio and resolves
// to [{ startTs, endTs, text }] (wall-clock ms) for the timeline and summary.
// Never use the Web Speech API: Chrome sends the audio to Google.
export async function transcribe(/* payload */) {
  return null;
}

// ---------- page ----------

function renderFatal(root, message) {
  root.replaceChildren(h('main', { class: 'tk-fatal tk-card' },
    h('h1', {}, 'This replay could not be opened'),
    h('p', {}, message),
    h('p', { class: 'tk-hint' }, 'The file may be truncated or edited. Re-export the session from the prototype if you still have it.')));
}

function mount() {
  injectStyles();
  const root = document.getElementById('testkit-app') || document.body.appendChild(h('div', { id: 'testkit-app' }));
  let data;
  try {
    data = readPayload();
  } catch (err) {
    renderFatal(root, err.message);
    return;
  }

  const { session, events, log, audio } = data;
  const meta = session.meta || {};
  const tasks = session.tasks || session.config?.tasks || [];
  // A without-audio export keeps the saved segments' metadata: verdict and
  // gap marks describe what was recorded, not what this file carries.
  const savedSegments = data.audioOmitted ? data.omittedAudio : audio;
  const summary = data.summaryMarkdown || buildSummary({ session, log, events, audio: savedSegments, audioDropped: data.audioDropped });
  const replayable = events.length >= 2 && events.some((e) => e.type === RRWEB_FULL_SNAPSHOT);
  const t0 = replayable ? events[0].timestamp : session.startedAt;
  const t1 = replayable ? events[events.length - 1].timestamp : session.endedAt ?? t0;
  const sessionStart = session.startedAt ?? t0;
  const sessionEnd = session.endedAt ?? t1;
  const pauses = pausedSpans(log, sessionEnd);
  const pausedTotal = overlapMs(sessionStart, sessionEnd, pauses);
  const spans = buildTaskSpans({ session, log, events }).map((span, i) => {
    const n = Number.isInteger(span.index) && span.index >= 0 ? span.index + 1 : i + 1;
    const prompt = span.task?.prompt || span.taskId || 'Untitled task';
    return { ...span, n, prompt, label: `Task ${n}: ${prompt}`, short: `${n}. ${prompt}` };
  });
  const counts = taskCounts(spans, tasks);
  // Same verdict and gap list as the summary and the overlay's pre-download line.
  const saved = audioReport({ session, log, events, audio: savedSegments, dropped: data.audioDropped });
  const { gaps } = saved;
  const savedText = data.audioOmitted ? `${saved.label} — left out of this file (too large to export)` : saved.label;

  // ---- header ----
  const toast = createToast();
  const copySummary = async () => {
    const ok = await copyText(summary);
    toast.show(ok ? 'Agent summary copied to clipboard' : 'Copy failed. Select the summary text below and copy it manually.');
    if (!ok) summaryDetails.open = true;
  };
  const downloadJson = () => {
    download(buildFilename(session, 'json'), data.rawJson(), 'application/json');
    toast.show('Raw JSON download started');
  };
  const durationText = Number.isFinite(sessionEnd - sessionStart)
    ? `${formatDuration(sessionEnd - sessionStart)}${pausedTotal ? ` (${formatDuration(pausedTotal)} paused)` : ''}`
    : 'unknown';
  const metaItem = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
  const protoLink = meta.prototypeUrl
    ? h('a', { href: meta.prototypeUrl, target: '_blank', rel: 'noopener noreferrer' }, meta.prototypeUrl)
    : 'unknown';
  // The export's CSP blocks every remote fetch, so assets the recording did
  // not inline cannot load. Count them from the stream up front, then add any
  // URL a CSP violation reports that the scan missed.
  const blocked = new Set(findRemoteAssets(events));
  const assetNotice = h('p', { class: 'tk-notice', role: 'note', hidden: true });
  const renderAssetNotice = () => {
    const n = blocked.size;
    assetNotice.hidden = n === 0;
    assetNotice.textContent = `${n} remote asset${n === 1 ? '' : 's'} (images, fonts, or stylesheets) referenced by the prototype ${n === 1 ? 'was' : 'were'} not loaded, to keep this file offline. Parts of the replay may look unstyled or show missing images.`;
    assetNotice.title = [...blocked].slice(0, 20).join('\n');
  };
  const noteViolation = (ev) => {
    const uri = ev.blockedURI || '';
    if (!/^https?:/i.test(uri) || blocked.has(uri)) return;
    blocked.add(uri);
    renderAssetNotice();
  };
  document.addEventListener('securitypolicyviolation', noteViolation);
  renderAssetNotice();
  const header = h('header', { class: 'tk-header' },
    h('div', { class: 'tk-header-main' },
      h('p', { class: 'tk-eyebrow' }, 'TestKit session replay'),
      h('h1', { class: 'tk-title' }, session.study || 'Untitled study'),
      h('dl', { class: 'tk-meta' },
        metaItem('Started', formatLocal(sessionStart)),
        metaItem('Duration', durationText),
        metaItem('Tasks', `${counts.done} of ${counts.total} completed${skippedSuffix(counts)}`),
        metaItem('Audio', h('span', { title: saved.kind === 'gaps' ? GAPS_MEANING : null }, savedText)),
        metaItem('Browser', describeBrowser(meta.userAgent)),
        metaItem('Viewport', meta.viewport ? `${meta.viewport.w} × ${meta.viewport.h}` : 'unknown'),
        metaItem('Commit', meta.commitSha ? h('code', {}, meta.commitSha) : 'unknown'),
        metaItem('Prototype', protoLink)),
      assetNotice),
    h('div', { class: 'tk-actions' },
      h('button', { type: 'button', class: 'tk-btn tk-btn--primary', onclick: copySummary }, 'Copy agent summary'),
      h('button', { type: 'button', class: 'tk-btn', onclick: downloadJson }, 'Download raw JSON')));

  // ---- stage + timeline ----
  const stage = h('div', { class: 'tk-stage' });
  const clock = h('p', { class: 'tk-clock', 'aria-hidden': 'true' });
  const audioStatus = h('span', { class: 'tk-audio-status', role: 'status' });
  const timelineCard = h('section', { class: 'tk-timeline-card tk-card', 'aria-labelledby': 'tk-timeline-title' });
  const taskList = h('ol', { class: 'tk-tasks' });

  let player = null;
  let playing = false;
  let offset = 0;
  let currentTask = -1;
  let skipPauses = true;
  let audioSync = null;

  const wallNow = () => t0 + offset;
  const seek = (ms) => {
    if (!player) return;
    player.goto(Math.min(Math.max(0, ms), t1 - t0));
  };
  const toggle = () => player?.toggle();
  const taskAt = (wall) => spans.findIndex((s) => wall >= s.start && wall < s.end);

  let timeline = null;
  if (replayable) {
    timeline = createTimeline({
      t0,
      t1,
      spans,
      pauses,
      gaps,
      onSeek: seek,
      onToggle: toggle,
    });
  }

  const taskButtons = [];
  const pageMain = h('div', { class: 'tk-main' },
    h('div', {}, stage, replayable ? timelineCard : null),
    h('aside', { class: 'tk-side' },
      h('section', { class: 'tk-tasks-card tk-card', 'aria-labelledby': 'tk-tasks-title' },
        h('h2', { class: 'tk-section-title', id: 'tk-tasks-title' }, 'Tasks'),
        taskList)));

  // ---- tasks ----
  const startedIds = new Set(spans.map((s) => s.taskId));
  spans.forEach((span, i) => {
    const entries = log.filter((e) => e.ts >= span.start && e.ts <= span.end);
    const active = span.end - span.start - overlapMs(span.start, span.end, pauses);
    const badges = [];
    // Page errors are not shown: this is a usability test, not a code test.
    if (detectRageClicks(entries).length) badges.push(h('span', { class: 'tk-badge' }, 'Rage clicks'));
    if (span.task?.timeLimit && active > span.task.timeLimit * 1000) badges.push(h('span', { class: 'tk-badge' }, 'Over time limit'));
    if (span.skipped) badges.push(h('span', { class: 'tk-badge' }, 'Skipped'));
    else if (!span.completed) badges.push(h('span', { class: 'tk-badge' }, 'Not completed'));
    const btn = h('button', {
      type: 'button',
      class: 'tk-task',
      disabled: !replayable,
      onclick: () => {
        seek(span.start - t0);
        timeline?.el.focus();
      },
      title: 'Jump to the start of this task',
    },
    h('span', { class: 'tk-task-head' }, h('span', {}, `Task ${span.n}`), h('span', {}, formatDuration(active))),
    h('span', { class: 'tk-task-prompt' }, span.prompt),
    badges.length ? h('span', { class: 'tk-badges' }, badges) : null);
    btn.style.setProperty('--tk-band', `var(--tk-task-${i % BAND_COLORS})`);
    taskButtons.push(btn);
    taskList.append(h('li', {}, btn));
  });
  for (const t of tasks.filter((task) => !startedIds.has(task.id))) {
    taskList.append(h('li', {}, h('button', { type: 'button', class: 'tk-task', disabled: true },
      h('span', { class: 'tk-task-head' }, h('span', {}, 'Not reached'), h('span', {}, '')),
      h('span', { class: 'tk-task-prompt' }, t.prompt || t.id))));
  }
  if (!taskList.children.length) taskList.append(h('li', { class: 'tk-hint' }, 'No tasks were recorded in this session.'));

  // ---- summary ----
  const summaryDetails = h('details', { class: 'tk-summary tk-card' },
    h('summary', {}, 'Agent summary (Markdown)'),
    h('div', { class: 'tk-summary-body' },
      h('div', { class: 'tk-summary-actions' },
        h('button', { type: 'button', class: 'tk-btn tk-btn--small', onclick: copySummary }, 'Copy')),
      h('pre', { class: 'tk-pre', tabindex: '0', 'aria-label': 'Agent summary markdown' }, summary)));

  root.replaceChildren(h('main', { class: 'tk-page' }, header, pageMain, summaryDetails), toast.el);

  if (!replayable) {
    stage.append(h('div', { class: 'tk-card tk-empty' },
      h('strong', {}, 'No replayable recording'),
      'This session has no full page snapshot, so there is nothing to replay. The task list and agent summary are still available.'));
    return;
  }

  // ---- player ----
  const viewport = viewportOf(session, events);
  const size = () => {
    const width = Math.max(320, Math.floor(stage.clientWidth));
    const maxHeight = Math.max(240, Math.floor(window.innerHeight * 0.72) - CONTROLLER_HEIGHT);
    return { width, height: Math.min(maxHeight, Math.round(width * (viewport.h / viewport.w))) };
  };

  try {
    player = new rrwebPlayer({
      target: stage,
      props: {
        events,
        ...size(),
        autoPlay: false,
        // Fast-forwarding inactivity would desync speech, so only skip when silent.
        skipInactive: audio.length === 0,
        showWarning: false,
        mouseTail: !reducedMotion,
        // rrweb-player rejects a speed outside speedOption; its buttons are
        // hidden below in favor of the speed menu.
        speedOption: SPEEDS,
        speed: 1,
        tags: {
          'testkit:task-start': '#2563eb',
          'testkit:task-end': '#4b5260',
          'testkit:pause': '#6b7280',
          'testkit:resume': '#6b7280',
          'testkit:session-end': '#16181d',
        },
      },
    });
  } catch (err) {
    stage.append(h('div', { class: 'tk-card tk-empty', role: 'alert' },
      h('strong', {}, 'The replay failed to start'), String(err?.message || err)));
    return;
  }

  // ---- timeline card ----
  const enableBtn = h('button', { type: 'button', class: 'tk-btn tk-btn--small', hidden: true }, 'Enable audio');
  const skipBox = h('input', { type: 'checkbox', checked: true });
  timelineCard.append(
    h('div', { class: 'tk-timeline-head' },
      h('h2', { class: 'tk-section-title', id: 'tk-timeline-title' }, 'Timeline'),
      clock),
    timeline.el,
    h('p', { class: 'tk-hint', id: 'tk-timeline-hint' },
      'Click or drag to seek. ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' 5 s, ',
      h('kbd', {}, 'Shift'), ' or ', h('kbd', {}, 'Page Up/Down'), ' 30 s, ', h('kbd', {}, 'Home'), ' / ', h('kbd', {}, 'End'),
      ', ', h('kbd', {}, 'Space'), ' play/pause.'),
    h('ul', { class: 'tk-legend', 'aria-label': 'Legend' },
      h('li', {}, h('span', { class: 'tk-swatch tk-swatch--task' }), 'Task'),
      h('li', {}, h('span', { class: 'tk-swatch tk-swatch--pause' }), `Paused (${pauses.length})`),
      h('li', {}, h('span', { class: 'tk-swatch tk-swatch--gap' }), `Audio gap (${gaps.length})`)),
    h('div', { class: 'tk-audio' },
      h('span', { class: 'tk-audio-label' }, 'Audio'),
      audioStatus,
      audio.length ? enableBtn : null,
      pauses.length ? h('label', { class: 'tk-check' }, skipBox, 'Skip paused time') : null));

  if (audio.length) {
    audioSync = createAudioSync(audio, {
      onStatus: (text, warn) => {
        audioStatus.textContent = text;
        audioStatus.classList.toggle('is-warn', warn);
        enableBtn.hidden = !audioSync?.blocked;
      },
    });
    enableBtn.addEventListener('click', () => {
      audioSync.unblock(wallNow());
      enableBtn.hidden = true;
    });
  } else {
    audioStatus.textContent = data.audioOmitted ? 'Audio was left out of this file (too large to export)' : saved.label;
  }
  skipBox.addEventListener('change', () => { skipPauses = skipBox.checked; });

  const replayer = player.getReplayer();
  // Each full snapshot rebuilds the iframe document (document.open), which
  // drops listeners, so re-attach the violation listener every time.
  const watchFrame = () => replayer.iframe?.contentDocument?.addEventListener('securitypolicyviolation', noteViolation);
  watchFrame();
  replayer.on('fullsnapshot-rebuilded', watchFrame);
  // rrweb-player ships icon-only buttons and an untitled iframe; name them.
  replayer.iframe?.setAttribute('title', 'Session replay');
  const controlButtons = stage.querySelectorAll('.rr-controller__btns button');
  const playButton = controlButtons[0];
  const fullscreenButton = controlButtons[controlButtons.length - 1];
  fullscreenButton?.setAttribute('aria-label', 'Toggle fullscreen');
  if (audioSync && fullscreenButton) fullscreenButton.before(createVolumeControl(audioSync));
  playButton?.setAttribute('aria-label', 'Play');
  stage.querySelector('.rr-controller input[type="checkbox"]')?.setAttribute('aria-label', 'Skip inactive periods');
  const isSkipping = () => replayer?.speedService?.state?.value === 'skipping';
  const speedNow = () => Number(replayer?.config?.speed) || 1;
  // The buttons between play and fullscreen are rrweb-player's speed buttons.
  [...controlButtons].slice(1, -1).forEach((b) => { b.hidden = true; });
  const speedMenu = createSpeedMenu({
    speeds: SPEEDS, initial: 1, hasAudio: audio.length > 0, onChange: (s) => player.setSpeed(s),
  });
  playButton?.after(speedMenu.el);

  const sync = () => {
    const wall = wallNow();
    const idx = taskAt(wall);
    if (idx !== currentTask) {
      taskButtons.forEach((b, i) => (i === idx ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
      currentTask = idx;
    }
    const taskText = idx >= 0 ? `, ${spans[idx].label}` : '';
    const elapsed = formatDuration(offset);
    const totalText = formatDuration(t1 - t0);
    clock.replaceChildren(h('strong', {}, elapsed), ` / ${totalText}${idx >= 0 ? ` · Task ${spans[idx].n}` : ''}`);
    timeline.update(offset, `${elapsed} of ${totalText}${taskText}`, idx);

    if (playing && skipPauses) {
      const pause = pauses.find((p) => wall >= p.start && wall < p.end - MIN_SKIPPABLE_PAUSE_MS);
      if (pause) {
        seek(pause.end - t0);
        return;
      }
    }
    if (!isSkipping()) speedMenu.set(speedNow());
    audioSync?.update({ wall, playing, speed: speedNow(), skipping: isSkipping() });
  };

  player.addEventListener('ui-update-current-time', ({ payload }) => {
    offset = Number(payload) || 0;
    sync();
  });
  player.addEventListener('ui-update-player-state', ({ payload }) => {
    playing = payload === 'playing';
    playButton?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (!playing) audioSync?.pause();
    sync();
  });
  sync();

  const ro = new ResizeObserver(() => {
    player.$set(size());
    // triggerResize reads the iframe size, which Svelte updates on the next tick.
    requestAnimationFrame(() => player.triggerResize());
  });
  ro.observe(stage);
  window.addEventListener('resize', () => player.$set(size()));

  transcribe(data); // v1.5 hook; resolves to null today.
  window.TestKitPlayer = { player, data, seekToWall: (ts) => seek(ts - t0), getOffset: () => offset };
}

// Mount after `load`: rrweb rebuilds the replay iframe with document.open()
// and never closes it, which would otherwise hold the page in "loading".
if (document.readyState === 'complete') mount();
else window.addEventListener('load', mount, { once: true });
