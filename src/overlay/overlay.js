// TestKit overlay: a shadow-DOM bubble, recording bar, and cards driven entirely
// by the controller (see docs/CONTRACTS.md → Controller / Overlay). Designed for
// the happy path (ui.pen → 07 · C · Happy path): a setup card (agree and start),
// a bar with the current task while recording (Next, Stop), and a finish card
// (download). Local state is UI-only: bubble position, open/collapsed, whether
// the task card is showing, and the download/discard progress.
import CSS from './styles.css';
import {
  EDGE_MARGIN,
  FREE_PROMPT,
  audioAnnouncement,
  clamp,
  createAdvanceGuard,
  defaultPosition,
  finishLine,
  formatBytes,
  hasMovedPastThreshold,
  parsePosition,
  setupCopy,
  snapPosition,
  stepLabel,
  taskEyebrow,
  taskRemainingMs,
} from './model.js';

const POS_KEY = 'testkit:overlay-pos';
const OPEN_KEY = 'testkit:overlay-open';
const TICK_MS = 250;
const MIN_CARD_SPACE = 200;
const CARD_GAP = 10;

const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const ARROW_SVG = svg('<path d="M5 12h14M12 5l7 7-7 7"/>');
const STOP_SVG = svg('<rect x="5" y="5" width="14" height="14" rx="2"/>');
const PLAY_SVG = svg('<path d="M7 4l13 8-13 8z"/>');
const DOWNLOAD_SVG = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>');
const DONE_SVG = svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>');
const CHEVRON_DOWN_SVG = svg('<path d="m6 9 6 6 6-6"/>');
const CHEVRON_UP_SVG = svg('<path d="m18 15-6-6-6 6"/>');

const ACTIVE = new Set(['recording', 'paused']);

function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error('[TestKit] overlay error', err);
      return undefined;
    }
  };
}

function errorMessage(err) {
  if (!err) return 'Something went wrong.';
  return String(err.message || err);
}

function readStorage(storage, key) {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    window[storage].setItem(key, value);
  } catch {
    // Storage can be unavailable (privacy modes); position just won't persist.
  }
}

// Tiny element builder. Props: class, text, ref, on* listeners, booleans as properties.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'ref') v(el);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), guard(v));
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

const icon = (markup, cls) => h('span', { html: markup, class: cls, 'aria-hidden': 'true', style: 'display:inline-flex' });

export function mountOverlay(controller) {
  try {
    return mount(controller);
  } catch (err) {
    console.error('[TestKit] overlay failed to mount', err);
    return { destroy() {} };
  }
}

function mount(controller) {
  document.getElementById('testkit-root')?.remove();

  const host = document.createElement('div');
  host.id = 'testkit-root';
  host.className = 'testkit-block';
  // Inline !important so prototype CSS can't restyle or reflow the host.
  host.setAttribute(
    'style',
    'all: initial !important; display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;',
  );
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;

  const live = h('div', { class: 'tk-sr', role: 'status', 'aria-live': 'polite' });
  const bubble = h('button', { type: 'button', class: 'tk-bubble', 'data-fid': 'bubble' });
  const card = h('section', { hidden: true });
  const bar = h('div', { class: 'tk-bar', role: 'toolbar', 'aria-label': 'TestKit recording', hidden: true });
  const dock = h('div', { class: 'tk-dock' }, card, bar);
  const layer = h('div', { class: 'tk-layer' }, bubble, dock, live);
  shadow.append(style, layer);
  document.documentElement.appendChild(host);

  let state = readState() || { phase: 'idle', tasks: [], taskIndex: -1, audio: {} };
  let open = readStorage('sessionStorage', OPEN_KEY) === '1';
  let pos = parsePosition(readStorage('localStorage', POS_KEY));
  let lastKey = null;
  let refs = {};
  let drag = null;
  let suppressClick = false;
  let destroyed = false;

  const ui = {
    taskCard: true, // the prompt card beside the bar
    starting: false, // Agree and start in flight (the mic prompt can take a while)
    exporting: false,
    exportResult: null,
    exportError: null,
    actionError: null,
    confirmDiscard: false, // second click on Discard deletes an undownloaded session
    timeUp: false,
    finishedLast: false, // tester pressed Finish on the last task (this page load)
    focusNext: null, // data-fid to focus after the next render
    forceFocus: false, // focus even if focus wasn't inside the overlay
  };

  function readState() {
    try {
      return controller.getState();
    } catch (err) {
      console.error('[TestKit] getState failed', err);
      return null;
    }
  }

  // Another tab owns the recording; this tab must not offer controls that fight it.
  function otherTab(s = state) {
    return s.otherTab === true || /another tab/i.test(String(s.error || ''));
  }

  const recordingView = () => ACTIVE.has(state.phase) && !otherTab();
  const total = () => state.tasks?.length || 0;
  const currentTask = () => state.tasks?.[state.taskIndex] || null;

  let announceTimer = 0;
  function announce(msg) {
    // Clear first so repeating the same text is still announced.
    live.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      live.textContent = msg;
    }, 60);
  }

  function taskAnnouncement() {
    const task = currentTask();
    if (!total() || !task) return FREE_PROMPT;
    return `Task ${state.taskIndex + 1} of ${total()}: ${task.prompt}`;
  }

  // Run a controller action; surface sync throws and async rejections in the card.
  function act(fn) {
    ui.actionError = null;
    const fail = (err) => {
      ui.actionError = errorMessage(err);
      render();
    };
    try {
      const result = fn();
      if (result && typeof result.then === 'function') result.catch(guard(fail));
      return result;
    } catch (err) {
      fail(err);
      return undefined;
    }
  }

  function setOpen(next, { focus = false } = {}) {
    open = next;
    writeStorage('sessionStorage', OPEN_KEY, next ? '1' : '0');
    if (focus) {
      ui.focusNext = next ? primaryFid() : 'bubble';
      ui.forceFocus = true;
    }
    render(true);
  }

  function primaryFid() {
    if (otherTab()) return 'lock';
    switch (state.phase) {
      case 'idle':
      case 'preflight': return 'start';
      case 'recording': return 'next';
      case 'paused': return 'resume';
      default: return 'download';
    }
  }

  // ---- State transitions ----

  function onState(next) {
    if (!next || destroyed) return;
    const prev = state;
    state = next;
    const wasLocked = otherTab(prev);
    if (prev.phase !== next.phase) onPhaseChange(prev.phase, next.phase);
    else if (prev.taskIndex !== next.taskIndex && ACTIVE.has(next.phase)) onTaskChange();
    if (ACTIVE.has(next.phase) && prev.phase === next.phase && !otherTab(next)) {
      const said = audioAnnouncement(prev.audio, next.audio);
      if (said) announce(said);
    }
    if (otherTab() && !wasLocked) {
      open = true;
      announce('Recording is active in another tab. Close this tab to continue in the other one.');
    } else if (wasLocked && !otherTab() && ACTIVE.has(next.phase)) {
      // This tab took over after the owner tab closed.
      announce(`Recording continues in this tab. ${taskAnnouncement()}`);
    }
    render();
  }

  function onPhaseChange(from, to) {
    if (to !== 'stopped' && to !== 'exporting') {
      ui.exportResult = null;
      ui.exportError = null;
    }
    ui.confirmDiscard = false;
    ui.actionError = null;

    if (to === 'idle') {
      ui.finishedLast = false;
      ui.focusNext = 'start';
      if (from === 'stopped' || from === 'exporting') announce('Session discarded.');
    } else if (to === 'recording') {
      if (from === 'paused') {
        ui.focusNext = 'next';
        announce('Recording resumed.');
      } else {
        ui.taskCard = true;
        ui.timeUp = false;
        ui.focusNext = 'next';
        announce(`Recording started. ${taskAnnouncement()}`);
      }
    } else if (to === 'paused') {
      ui.focusNext = 'resume';
      announce('Recording paused.');
    } else if (to === 'stopped' && from !== 'exporting') {
      ui.focusNext = 'download';
      open = true;
      announce('Session finished. Download the session file to keep it.');
    }
    writeStorage('sessionStorage', OPEN_KEY, open ? '1' : '0');
  }

  function onTaskChange() {
    ui.taskCard = true;
    ui.timeUp = false;
    ui.focusNext = 'next';
    announce(taskAnnouncement());
  }

  // ---- Actions ----

  // Pressing Agree and start is the consent; start() asks for the mic itself.
  function startSession(withAudio) {
    if (ui.starting) return;
    ui.starting = true;
    render();
    const audio = Boolean(state.audio?.enabled) && withAudio;
    const done = guard(() => {
      ui.starting = false;
      render();
    });
    act(async () => {
      try {
        if (state.phase !== 'preflight') await controller.beginPreflight();
        await controller.start({ consent: true, audio });
      } finally {
        done();
      }
    });
  }

  // The second click of a double click (event.detail 2+) may land on the next
  // task's freshly rendered button; it is never a separate decision.
  const repeatClick = (e) => Number(e?.detail) > 1;

  // One task change per click: a double click (or a second press before the
  // controller answers) must not advance twice. The controller also ignores a
  // call whose taskIndex is no longer current.
  const advanceGuard = createAdvanceGuard();

  function onNext(e) {
    if (repeatClick(e)) return;
    if (!total()) {
      act(() => controller.stop());
      return;
    }
    const taskIndex = state.taskIndex;
    ui.finishedLast = taskIndex >= total() - 1;
    advanceGuard.run(() => act(() => controller.nextTask({ taskIndex })));
  }

  function toggleTaskCard() {
    ui.taskCard = !ui.taskCard;
    ui.focusNext = ui.taskCard ? 'collapse-card' : 'step';
    render();
  }

  // A full download (audio included) counts; a visual-only one doesn't.
  const downloadedFully = () => Boolean(state.downloaded || (ui.exportResult && !ui.exportResult.withoutAudio));

  // Nothing leaves the browser until the file is downloaded, so an undownloaded
  // session takes a second click to delete.
  function onDiscard() {
    if (!downloadedFully() && !ui.confirmDiscard) {
      ui.confirmDiscard = true;
      ui.focusNext = 'discard';
      announce('Press again to discard without downloading. This can’t be undone.');
      render();
      return;
    }
    act(() => controller.discard());
  }

  // Package build: Chrome keeps a failed player chunk import for the life of
  // the page, so retrying means a reload. ?test=1 brings the overlay back and
  // the stopped session restores from testkit:last.
  function reloadForExport() {
    writeStorage('sessionStorage', OPEN_KEY, '1');
    announce('Reloading the page. Your session is saved.');
    const url = new URL(location.href);
    url.searchParams.set('test', '1');
    location.assign(url.href);
  }

  function doExport(options) {
    if (state.exportNeedsReload) {
      reloadForExport();
      return;
    }
    if (ui.exporting) return;
    ui.exporting = true;
    ui.exportError = null;
    ui.actionError = null;
    ui.confirmDiscard = false;
    announce('Preparing session file.');
    render();
    const done = guard(() => {
      ui.exporting = false;
      render();
    });
    try {
      Promise.resolve(options ? controller.exportSession(options) : controller.exportSession())
        .then(
          (res) => {
            ui.exportResult = res || {};
            ui.focusNext = 'discard';
            const size = res?.bytes ? ` (${formatBytes(res.bytes)})` : '';
            announce(`Download started${size}. Check your downloads folder.`);
          },
          (err) => {
            ui.exportError = errorMessage(err);
            announce('Export failed.');
          },
        )
        .finally(done);
    } catch (err) {
      ui.exportError = errorMessage(err);
      done();
    }
  }

  // ---- Rendering ----

  function viewKey() {
    return JSON.stringify([
      state.phase, state.taskIndex, state.tasks?.length, state.study, state.audio?.enabled,
      state.savedAudio, state.exportWithoutAudio, state.exportNeedsReload, state.downloaded,
      state.tasksCompleted, state.error ? String(state.error) : null, state.taskStartedAt,
      state.otherTab === true, open, pos, ui.taskCard, ui.starting, ui.exporting, ui.exportResult,
      ui.exportError, ui.actionError, ui.confirmDiscard, ui.timeUp,
    ]);
  }

  function render(force = false) {
    if (destroyed) return;
    const key = viewKey();
    if (!force && key === lastKey && !ui.focusNext && !ui.forceFocus) {
      tick();
      return;
    }
    lastKey = key;

    const active = shadow.activeElement;
    const hadFocus = Boolean(active);
    const keepFid = active?.dataset?.fid || null;

    refs = {};
    const rec = recordingView();
    bubble.replaceChildren(...bubbleContent());
    bubble.classList.toggle('is-text', !rec && !otherTab() && state.phase === 'stopped');
    bubble.hidden = rec || open;
    bar.hidden = !rec;
    if (rec) bar.replaceChildren(...barContent().filter(Boolean));
    else bar.replaceChildren();

    const showCard = rec ? ui.taskCard : open;
    card.hidden = !showCard;
    if (showCard) {
      const view = cardView();
      card.className = view.className;
      card.setAttribute('aria-label', view.label);
      card.replaceChildren(...view.children.filter(Boolean));
    } else {
      card.replaceChildren();
    }

    applyPosition();
    tick();

    // Move focus only if it was already inside the overlay (or the user just
    // opened/closed it), so state changes never pull focus from the prototype.
    const target = ui.focusNext || keepFid;
    const allowed = hadFocus || ui.forceFocus;
    ui.focusNext = null;
    ui.forceFocus = false;
    if (!allowed || !target) return;
    const el = shadow.querySelector(`[data-fid="${target}"]`);
    if (el && !el.disabled && !el.hidden) el.focus({ preventScroll: true });
    else layer.querySelector('button:not(:disabled):not([hidden])')?.focus({ preventScroll: true });
  }

  function logo() {
    return h('span', { class: 'tk-logo', 'aria-hidden': 'true', text: 'TEST' });
  }

  function bubbleContent() {
    const label = (text) => h('span', { class: 'tk-sr', text: `Open TestKit${text ? `: ${text}` : ''}` });
    if (otherTab()) return [label('recording in another tab'), logo(), 'Other tab'];
    switch (state.phase) {
      case 'stopped': return [label('session finished'), h('span', { 'aria-hidden': 'true', text: 'Done' })];
      case 'exporting': return [label('saving'), logo(), 'Saving…'];
      default: return [label(''), logo()];
    }
  }

  function barContent() {
    const paused = state.phase === 'paused';
    const n = total();
    const step = stepLabel(state);
    const isLast = n > 0 && state.taskIndex >= n - 1;
    return [
      h(
        'span',
        { class: `tk-rec${paused ? ' is-paused' : ''}` },
        h('span', { class: 'tk-dot', 'aria-hidden': 'true' }),
        paused ? 'Paused' : 'REC',
      ),
      step ? h('span', { class: 'tk-divider', 'aria-hidden': 'true' }) : null,
      step
        ? h('button', {
          type: 'button',
          class: 'tk-step',
          'data-fid': 'step',
          'aria-expanded': String(ui.taskCard),
          'aria-label': `Task ${state.taskIndex + 1} of ${n}. ${ui.taskCard ? 'Hide' : 'Show'} task`,
          text: step,
          onclick: toggleTaskCard,
        })
        : null,
      paused
        ? h('button', { type: 'button', class: 'tk-pill', 'data-fid': 'resume', onclick: () => act(() => controller.resume()) }, 'Resume', icon(PLAY_SVG))
        : h('button', { type: 'button', class: 'tk-pill', 'data-fid': 'next', onclick: onNext }, n && !isLast ? 'Next' : 'Finish', icon(ARROW_SVG)),
      h('button', {
        type: 'button',
        class: 'tk-icon-btn',
        'data-fid': 'stop',
        'aria-label': 'Stop session',
        title: 'Stop session',
        html: STOP_SVG,
        onclick: () => act(() => controller.stop()),
      }),
    ];
  }

  function errorLine() {
    // A failed export also sets state.error; the finish card shows ui.exportError instead.
    const exportFailure = ui.exportError && (state.phase === 'stopped' || state.phase === 'exporting');
    const msg = ui.actionError || (state.error && !exportFailure && !otherTab() ? errorMessage(state.error) : null);
    return msg ? h('p', { class: 'tk-card-error', role: 'alert', text: msg }) : null;
  }

  function cardView() {
    if (recordingView()) return promptCard();
    if (otherTab()) return lockCard();
    if (state.phase === 'stopped' || state.phase === 'exporting') return finishCard();
    return setupCard();
  }

  function setupCard() {
    const copy = setupCopy({ study: state.study, tasks: state.tasks, audioEnabled: Boolean(state.audio?.enabled) });
    return {
      className: 'tk-card',
      label: 'TestKit setup',
      children: [
        logo(),
        h('h2', { class: 'tk-card-h', text: copy.heading }),
        h('p', { class: 'tk-card-p', text: copy.text }),
        errorLine(),
        h(
          'div',
          { class: 'tk-card-actions' },
          h(
            'button',
            { type: 'button', class: 'tk-pill', 'data-fid': 'start', disabled: ui.starting, 'aria-busy': ui.starting ? 'true' : null, onclick: () => startSession(true) },
            ui.starting ? [h('span', { class: 'tk-spinner', 'aria-hidden': 'true' }), 'Starting…'] : ['Agree and start', icon(ARROW_SVG)],
          ),
          copy.screenOnly
            ? h('button', { type: 'button', class: 'tk-link', 'data-fid': 'screen-only', disabled: ui.starting, onclick: () => startSession(false) }, 'Screen only')
            : null,
        ),
      ],
    };
  }

  function promptCard() {
    const n = total();
    const task = currentTask();
    // Above the bar near the bottom of the screen, below it near the top.
    const above = !barInTopHalf();
    return {
      className: 'tk-prompt-card',
      label: 'Current task',
      children: [
        h(
          'div',
          { class: 'tk-prompt-head' },
          h('p', { class: `tk-eyebrow${ui.timeUp ? ' is-over' : ''}`, ref: (el) => { refs.eyebrow = el; }, text: taskEyebrow(state.taskIndex, n, null) }),
          n
            ? h('button', {
              type: 'button',
              class: 'tk-collapse',
              'data-fid': 'collapse-card',
              'aria-label': 'Hide task',
              html: above ? CHEVRON_DOWN_SVG : CHEVRON_UP_SVG,
              onclick: toggleTaskCard,
            })
            : null,
        ),
        h('h2', { class: 'tk-prompt', text: n && task ? task.prompt : FREE_PROMPT }),
        errorLine(),
      ],
    };
  }

  function finishCard() {
    const exporting = ui.exporting || state.phase === 'exporting';
    const done = Boolean(ui.exportResult) || state.downloaded;
    let label = ['Download session', icon(DOWNLOAD_SVG)];
    if (exporting) label = [h('span', { class: 'tk-spinner', 'aria-hidden': 'true' }), 'Preparing file…'];
    else if (state.exportNeedsReload) label = 'Reload and retry';
    else if (ui.exportError) label = 'Try again';
    else if (done) label = ['Download again', icon(DOWNLOAD_SVG)];
    return {
      className: 'tk-card',
      label: 'TestKit session finished',
      children: [
        icon(DONE_SVG, 'tk-done-icon'),
        h('h2', { class: 'tk-card-h', text: 'That’s a wrap. Thanks!' }),
        h('p', { class: 'tk-card-p', text: finishLine(state, { finishedLast: ui.finishedLast }) }),
        ui.exportError && !exporting ? h('p', { class: 'tk-card-error', role: 'alert', text: ui.exportError }) : errorLine(),
        h(
          'div',
          { class: 'tk-card-actions' },
          h('button', { type: 'button', class: 'tk-pill', 'data-fid': 'download', disabled: exporting, 'aria-busy': exporting ? 'true' : null, onclick: () => doExport() }, label),
          state.exportWithoutAudio && !state.exportNeedsReload && !exporting
            ? h('button', { type: 'button', class: 'tk-link', 'data-fid': 'download-visual', onclick: () => doExport({ withoutAudio: true }) }, 'Download without audio')
            : null,
          exporting
            ? null
            : h('button', { type: 'button', class: 'tk-link', 'data-fid': 'discard', onclick: onDiscard }, ui.confirmDiscard ? 'Discard without downloading?' : 'Discard'),
        ),
      ],
    };
  }

  function lockCard() {
    return {
      className: 'tk-card',
      label: 'TestKit',
      children: [
        logo(),
        h('h2', { class: 'tk-card-h', tabindex: '-1', 'data-fid': 'lock', text: 'Recording in another tab' }),
        h('p', { class: 'tk-card-p', text: 'Close this tab to continue in the other one. Controls are off here so the two tabs can’t interfere.' }),
      ],
    };
  }

  // Updates the countdown without rebuilding the DOM.
  function tick() {
    if (destroyed || !recordingView() || !refs.eyebrow) return;
    const fresh = readState();
    const task = currentTask();
    // Prefer pause-aware task time when the controller provides it.
    const remaining = Number.isFinite(fresh?.taskElapsedMs) && task?.timeLimit
      ? task.timeLimit * 1000 - fresh.taskElapsedMs
      : taskRemainingMs(task, state.taskStartedAt, Date.now());
    if (remaining == null) return;
    if (remaining <= 0 && !ui.timeUp) {
      ui.timeUp = true;
      announce('Time’s up — move on when you’re ready.');
      render();
      return;
    }
    const text = taskEyebrow(state.taskIndex, total(), remaining);
    if (refs.eyebrow.textContent !== text) refs.eyebrow.textContent = text;
  }

  // ---- Position & drag ----

  const viewport = () => ({ vw: document.documentElement.clientWidth || window.innerWidth, vh: window.innerHeight });

  // The element the position belongs to: the bar while recording, else the bubble.
  function anchorSize() {
    const el = bar.hidden ? bubble : bar;
    const wasHidden = el.hidden;
    if (wasHidden) el.hidden = false;
    const size = { w: el.offsetWidth || 44, h: el.offsetHeight || 44 };
    if (wasHidden) el.hidden = true;
    return size;
  }

  function anchorY() {
    const { vh } = viewport();
    const { h: ah } = anchorSize();
    if (!pos) pos = defaultPosition(vh, ah);
    return clamp(pos.y, EDGE_MARGIN, vh - ah - EDGE_MARGIN);
  }

  function barInTopHalf() {
    const { h: ah } = anchorSize();
    return anchorY() + ah / 2 < viewport().vh / 2;
  }

  function applyPosition() {
    const { vw, vh } = viewport();
    const { w: aw, h: ah } = anchorSize();
    const y = anchorY();
    const left = pos.side === 'left';
    if (!drag?.moved) {
      bubble.style.top = `${y}px`;
      bubble.style.left = `${left ? EDGE_MARGIN : vw - aw - EDGE_MARGIN}px`;
      dock.style.left = left ? `${EDGE_MARGIN}px` : 'auto';
      dock.style.right = left ? 'auto' : `${EDGE_MARGIN}px`;
    }
    dock.classList.toggle('is-left', left);

    // The card grows away from the nearer vertical edge, from where the bubble or bar sits.
    const topHalf = y + ah / 2 < vh / 2;
    if (!bar.hidden) {
      dock.style.flexDirection = topHalf ? 'column-reverse' : 'column';
      if (!drag?.moved) {
        dock.style.top = topHalf ? `${y}px` : 'auto';
        dock.style.bottom = topHalf ? 'auto' : `${vh - y - ah}px`;
      }
      card.style.maxHeight = `${Math.max(0, (topHalf ? vh - y - ah : y) - CARD_GAP - EDGE_MARGIN)}px`;
      return;
    }
    dock.style.flexDirection = 'column';
    const spaceBelow = vh - y - EDGE_MARGIN;
    const spaceAbove = y + ah - EDGE_MARGIN;
    if (topHalf && spaceBelow >= MIN_CARD_SPACE) {
      dock.style.top = `${y}px`;
      dock.style.bottom = 'auto';
      card.style.maxHeight = `${spaceBelow}px`;
    } else if (!topHalf && spaceAbove >= MIN_CARD_SPACE) {
      dock.style.top = 'auto';
      dock.style.bottom = `${vh - y - ah}px`;
      card.style.maxHeight = `${spaceAbove}px`;
    } else {
      dock.style.top = `${EDGE_MARGIN}px`;
      dock.style.bottom = 'auto';
      card.style.maxHeight = `${vh - EDGE_MARGIN * 2}px`;
    }
  }

  // The bubble drags itself; the bar drags the whole dock (bar + task card),
  // from anywhere that isn't one of its buttons.
  function onPointerDown(e, el) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (el === bar && e.target.closest?.('button')) return;
    const moving = el === bar ? dock : bubble;
    const rect = moving.getBoundingClientRect();
    drag = { el, moving, id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort; moves still arrive while the pointer is over the element.
    }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (!hasMovedPastThreshold(dx, dy)) return;
      drag.moved = true;
      drag.el.classList.add('is-dragging');
    }
    e.preventDefault();
    const { vw, vh } = viewport();
    const { moving } = drag;
    moving.style.left = `${clamp(drag.left + dx, 0, vw - moving.offsetWidth)}px`;
    moving.style.top = `${clamp(drag.top + dy, 0, vh - moving.offsetHeight)}px`;
    moving.style.right = 'auto';
    moving.style.bottom = 'auto';
  }

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, el } = drag;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (moved) {
      const rect = el.getBoundingClientRect();
      const { vw, vh } = viewport();
      pos = snapPosition({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, viewportW: vw, viewportH: vh });
      writeStorage('localStorage', POS_KEY, JSON.stringify(pos));
      // Swallow the click that follows a drag; clear on the next task in case none fires.
      suppressClick = !cancelled;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    drag = null;
    el.classList.remove('is-dragging');
    if (moved) render(true);
  }

  function onBubbleClick() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setOpen(true, { focus: true });
  }

  // Keys typed in the overlay must not trigger prototype shortcuts. Stopping at
  // window capture is the earliest point we can reach: it blocks every
  // document/element listener and window listeners registered after ours.
  // Limitation: window capture listeners the prototype registered before
  // TestKit loaded still fire first; nothing in-page can prevent that. Default
  // actions (Tab, Enter/Space on buttons) are unaffected, and Esc is handled
  // here since inner listeners never see keys.
  function onKey(e) {
    if (!e.composedPath().includes(host)) return;
    e.stopImmediatePropagation();
    if (e.type !== 'keydown' || e.key !== 'Escape') return;
    if (ui.confirmDiscard) {
      ui.confirmDiscard = false;
      ui.focusNext = 'discard';
      render();
    } else if (recordingView()) {
      if (ui.taskCard && total()) toggleTaskCard();
    } else if (open) {
      setOpen(false, { focus: true });
    }
  }
  const onKeyGuarded = guard(onKey);
  const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

  // Host focus traps (MUI's FocusTrap listens for document `focusin` and
  // pulls focus back into its dialog or menu whenever document.activeElement,
  // which is our shadow host, is outside it). Focus moving within the overlay
  // is none of the host's business, so focusin/focusout whose target is inside
  // the overlay stop at window capture, like keys. Focus itself is unaffected
  // (these events aren't cancelable), and events of the host's own elements
  // are untouched. Same limitation: window capture listeners registered before
  // TestKit loaded still see them.
  function onFocusEvent(e) {
    if (e.composedPath().includes(host)) e.stopImmediatePropagation();
  }
  const onFocusGuarded = guard(onFocusEvent);
  const FOCUS_EVENTS = ['focusin', 'focusout'];

  const onResize = guard(() => applyPosition());

  for (const el of [bubble, bar]) {
    el.addEventListener('pointerdown', guard((e) => onPointerDown(e, el)));
    el.addEventListener('pointermove', guard(onPointerMove));
    el.addEventListener('pointerup', guard((e) => endDrag(e, false)));
    el.addEventListener('pointercancel', guard((e) => endDrag(e, true)));
  }
  bubble.addEventListener('click', guard(onBubbleClick));
  for (const type of KEY_EVENTS) window.addEventListener(type, onKeyGuarded, true);
  for (const type of FOCUS_EVENTS) window.addEventListener(type, onFocusGuarded, true);
  window.addEventListener('resize', onResize);

  let unsubscribe = null;
  try {
    unsubscribe = controller.subscribe(guard(onState));
  } catch (err) {
    console.error('[TestKit] subscribe failed', err);
  }
  const ticker = setInterval(guard(tick), TICK_MS);
  // Place the bubble without animating in from the corner on first paint.
  bubble.style.transition = 'none';
  render(true);
  requestAnimationFrame(() => { bubble.style.transition = ''; });

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(ticker);
      clearTimeout(announceTimer);
      window.removeEventListener('resize', onResize);
      for (const type of KEY_EVENTS) window.removeEventListener(type, onKeyGuarded, true);
      for (const type of FOCUS_EVENTS) window.removeEventListener(type, onFocusGuarded, true);
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch {
        // Controller already torn down.
      }
      host.remove();
    },
  };
}
