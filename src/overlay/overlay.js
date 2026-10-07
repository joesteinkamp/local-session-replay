// TestKit overlay: a shadow-DOM bubble + panel driven entirely by the controller
// (see docs/CONTRACTS.md → Controller / Overlay). Local state is UI-only: bubble
// position, open/collapsed, pre-flight checkbox progress, confirms, follow-up draft.
import CSS from './styles.css';
import {
  EDGE_MARGIN,
  MIC_LABELS,
  MIC_PASS_LEVEL,
  canStart,
  clamp,
  consentText,
  createMicCheck,
  defaultPosition,
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
} from './model.js';

const POS_KEY = 'testkit:overlay-pos';
const OPEN_KEY = 'testkit:overlay-open';
const TICK_MS = 250;
const MIN_PANEL_SPACE = 280;

const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const MIC_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>';
const COLLAPSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M5 12h14"/></svg>';

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
    else if (k === 'value') el.value = v;
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
  const bubble = h('button', { type: 'button', class: 'tk-bubble' });
  const panel = h('section', { class: 'tk-panel', 'aria-label': 'TestKit', hidden: true });
  const layer = h('div', { class: 'tk-layer' }, bubble, panel, live);
  shadow.append(style, layer);
  document.documentElement.appendChild(host);

  let state = readState() || { phase: 'idle', tasks: [], taskIndex: -1, audio: {} };
  let open = readStorage('sessionStorage', OPEN_KEY) === '1';
  let pos = parsePosition(readStorage('localStorage', POS_KEY));
  let clock = { elapsedMs: state.elapsedMs || 0, at: Date.now(), phase: state.phase };
  let lastKey = null;
  let refs = {};
  let drag = null;
  let suppressClick = false;
  let meterRaf = 0;
  let meterAnnouncedAt = 0;
  let destroyed = false;
  const micCheck = createMicCheck();

  const freshPreflight = () => ({
    consent: false,
    mic: 'untested', // untested | pending | ok | failed
    micError: null,
    micPassed: false,
    audioSkipped: false,
  });
  const ui = {
    pre: freshPreflight(),
    confirm: null, // 'stop' | 'discard'
    followUpFor: null, // taskIndex whose follow-up question is showing
    followUpText: '',
    exporting: false,
    exportResult: null,
    exportError: null,
    actionError: null,
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

  // getState().elapsedMs may be a snapshot from the last emit; extrapolate from it
  // while recording so the clock ticks smoothly either way.
  function syncClock(s) {
    if (s.elapsedMs !== clock.elapsedMs || s.phase !== clock.phase) {
      clock = { elapsedMs: s.elapsedMs || 0, at: Date.now(), phase: s.phase };
    }
  }
  function liveElapsed() {
    return clock.phase === 'recording' ? clock.elapsedMs + (Date.now() - clock.at) : clock.elapsedMs;
  }

  // Another tab owns the recording; this tab must not offer controls that fight it.
  function otherTab(s = state) {
    return s.otherTab === true || /another tab/i.test(String(s.error || ''));
  }

  function currentTask() {
    return state.tasks?.[state.taskIndex] || null;
  }

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
    const total = state.tasks?.length || 0;
    const task = currentTask();
    if (!total || !task) return 'Explore the prototype freely.';
    return `Task ${state.taskIndex + 1} of ${total}: ${task.prompt}`;
  }

  // Run a controller action; surface sync throws and async rejections in the panel.
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
    if (otherTab()) return 'collapse';
    switch (state.phase) {
      case 'idle': return 'start';
      case 'preflight': return 'consent';
      case 'recording':
      case 'paused': return ui.followUpFor === state.taskIndex ? 'followup' : 'next';
      default: return 'download';
    }
  }

  // ---- State transitions ----

  function onState(next) {
    if (!next || destroyed) return;
    const prev = state;
    state = next;
    syncClock(next);
    const wasLocked = otherTab(prev);
    if (prev.phase !== next.phase) onPhaseChange(prev.phase, next.phase);
    else if (prev.taskIndex !== next.taskIndex && ACTIVE.has(next.phase)) onTaskChange();
    if (otherTab() && !wasLocked) {
      ui.confirm = null;
      ui.followUpFor = null;
      open = true;
      announce('Recording is active in another tab. Close this tab to continue in the other one.');
    } else if (wasLocked && !otherTab() && ACTIVE.has(next.phase)) {
      // This tab took over after the owner tab closed.
      announce(`Recording continues in this tab. ${taskAnnouncement()}`);
    }
    render();
  }

  function onPhaseChange(from, to) {
    if (from === 'preflight') stopMeter();
    if (to !== 'stopped' && to !== 'exporting') {
      ui.exportResult = null;
      ui.exportError = null;
    }
    ui.confirm = null;
    ui.actionError = null;

    if (to === 'idle' || to === 'preflight') ui.finishedLast = false;
    if (to === 'idle') {
      ui.pre = freshPreflight();
      ui.followUpFor = null;
      ui.followUpText = '';
      ui.focusNext = 'start';
      if (from === 'stopped' || from === 'exporting') announce('Session discarded.');
    } else if (to === 'preflight') {
      ui.pre = freshPreflight();
      ui.focusNext = 'consent';
      open = true;
      announce('Before you start: review consent and check your microphone.');
    } else if (to === 'recording') {
      if (from === 'paused') {
        announce('Recording resumed.');
      } else {
        ui.timeUp = false;
        ui.followUpFor = null;
        ui.focusNext = 'next';
        announce(`Recording started. ${taskAnnouncement()}`);
      }
    } else if (to === 'paused') {
      announce('Recording paused.');
    } else if (to === 'stopped' && from !== 'exporting') {
      ui.followUpFor = null;
      ui.followUpText = '';
      ui.focusNext = 'download';
      open = true;
      announce('Session stopped. Download the session file to keep it.');
    }
    writeStorage('sessionStorage', OPEN_KEY, open ? '1' : '0');
  }

  function onTaskChange() {
    ui.followUpFor = null;
    ui.followUpText = '';
    ui.timeUp = false;
    ui.confirm = null;
    ui.focusNext = 'next';
    announce(taskAnnouncement());
  }

  // ---- Actions ----

  function testMic() {
    ui.pre.mic = 'pending';
    ui.pre.micError = null;
    ui.pre.micPassed = false;
    ui.focusNext = 'mic-pending';
    render();
    const settle = guard((res) => {
      if (state.phase !== 'preflight') return;
      if (res && res.ok) {
        ui.pre.mic = 'ok';
        // A late grant after "Continue without audio" shouldn't pull the tester back.
        if (!ui.pre.audioSkipped) {
          ui.focusNext = 'skip-audio';
          announce('Microphone on. Say something to check the level.');
          startMeter();
        }
      } else {
        ui.pre.mic = 'failed';
        ui.pre.micError = res?.error ? errorMessage(res.error) : null;
        if (!ui.pre.audioSkipped) {
          ui.focusNext = 'test-mic';
          announce('Microphone unavailable.');
        }
      }
      render();
    });
    try {
      Promise.resolve(controller.requestMic()).then(settle, (err) => settle({ ok: false, error: err }));
    } catch (err) {
      settle({ ok: false, error: err });
    }
  }

  function skipAudio() {
    ui.pre.audioSkipped = true;
    stopMeter();
    announce('Continuing without audio.');
    ui.focusNext = 'use-mic';
    render();
  }

  function useMicAgain() {
    ui.pre.audioSkipped = false;
    ui.focusNext = 'test-mic';
    if (ui.pre.mic === 'ok') {
      ui.focusNext = 'start-session';
      startMeter();
    }
    render();
  }

  function startSession() {
    const audio = Boolean(state.audio?.enabled) && !ui.pre.audioSkipped;
    act(() => controller.start({ consent: true, audio }));
  }

  function onNext() {
    const task = currentTask();
    if (task?.followUp && ui.followUpFor !== state.taskIndex) {
      ui.followUpFor = state.taskIndex;
      ui.followUpText = '';
      ui.focusNext = 'followup';
      render();
      return;
    }
    if (!state.tasks?.length) {
      act(() => controller.stop());
      return;
    }
    markIfLast();
    act(() => controller.nextTask({}));
  }

  function submitFollowUp(skip) {
    const answer = skip ? undefined : ui.followUpText.trim();
    markIfLast();
    act(() => controller.nextTask(answer ? { followUpAnswer: answer } : {}));
  }

  function markIfLast() {
    ui.finishedLast = state.taskIndex >= (state.tasks?.length || 0) - 1;
  }

  function togglePause() {
    act(() => (state.phase === 'paused' ? controller.resume() : controller.pause()));
  }

  function askConfirm(kind) {
    ui.confirm = kind;
    ui.focusNext = 'confirm-cancel';
    render();
  }

  function cancelConfirm() {
    const kind = ui.confirm;
    ui.confirm = null;
    ui.focusNext = kind === 'discard' ? 'discard' : 'stop';
    render();
  }

  function doExport() {
    if (ui.exporting) return;
    ui.exporting = true;
    ui.exportError = null;
    ui.actionError = null;
    announce('Preparing session file.');
    render();
    const done = guard(() => {
      ui.exporting = false;
      render();
    });
    try {
      Promise.resolve(controller.exportSession())
        .then(
          (res) => {
            ui.exportResult = res || {};
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

  // ---- Mic meter ----

  function startMeter() {
    if (meterRaf || destroyed) return;
    micCheck.reset();
    const loop = guard((t) => {
      meterRaf = requestAnimationFrame(loop);
      let level = 0;
      try {
        level = clamp(Number(controller.getMicLevel()) || 0, 0, 1);
      } catch {
        level = 0;
      }
      if (refs.meterFill) refs.meterFill.style.transform = `scaleX(${level})`;
      if (refs.meter && t - meterAnnouncedAt > 250) {
        meterAnnouncedAt = t;
        refs.meter.setAttribute('aria-valuenow', String(Math.round(level * 100)));
      }
      if (!ui.pre.micPassed && micCheck.sample(level, t)) {
        ui.pre.micPassed = true;
        // The focused "Continue without audio" button disappears on pass.
        ui.focusNext = ui.pre.consent ? 'start-session' : 'consent';
        announce('Microphone check passed. We can hear you.');
        render();
      }
    });
    meterRaf = requestAnimationFrame(loop);
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = 0;
  }

  // ---- Rendering ----

  function viewKey() {
    return JSON.stringify([
      state.phase, state.taskIndex, state.tasks?.length, state.study, state.muted,
      state.audio?.enabled, state.audio?.status, state.audio?.error ? String(state.audio.error) : null,
      state.error ? String(state.error) : null, state.taskStartedAt, state.otherTab === true,
      open, ui.pre, ui.confirm, ui.followUpFor, ui.exporting, ui.exportResult, ui.exportError,
      ui.actionError, ui.timeUp,
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
    const selection = active?.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null;

    refs = { times: [] };
    bubble.replaceChildren(...bubbleContent());
    bubble.className = `tk-bubble${ACTIVE.has(state.phase) ? '' : ' is-idle'}`;
    bubble.dataset.fid = 'bubble';
    bubble.hidden = open;
    panel.hidden = !open;
    if (open) panel.replaceChildren(panelHead(), panelBody());
    else panel.replaceChildren();

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
    if (el && !el.disabled && !el.hidden) {
      el.focus({ preventScroll: true });
      revealInBody(el);
      if (selection && target === keepFid && el.tagName === 'TEXTAREA') {
        el.setSelectionRange(selection[0], selection[1]);
      }
    } else if (open) {
      panel.querySelector('button:not(:disabled), input, textarea')?.focus({ preventScroll: true });
    }
  }

  // Scrolls only the panel body; focus({ preventScroll }) keeps the page still.
  function revealInBody(el) {
    const body = panel.querySelector('.tk-body');
    if (!body || !body.contains(el) || el.closest('.tk-actions')) return;
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const footer = body.querySelector('.tk-actions')?.offsetHeight || 0;
    if (r.top < b.top) body.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom - footer) body.scrollTop += r.bottom - (b.bottom - footer) + 8;
  }

  function micIndicator() {
    const kind = micKind(state.audio);
    const off = kind !== 'live' && kind !== 'pending';
    return h(
      'span',
      { class: `tk-mic is-${kind}`, title: MIC_LABELS[kind] },
      h('span', { html: off ? MIC_OFF_SVG : MIC_SVG, class: 'tk-mic-glyph' }),
      h('span', { class: 'tk-sr', text: MIC_LABELS[kind] }),
    );
  }

  function recIndicators() {
    const paused = state.phase === 'paused';
    const time = h('span', { class: 'tk-time', text: formatElapsed(liveElapsed()) });
    refs.times.push(time);
    return [
      h(
        'span',
        { class: `tk-status ${paused ? 'is-paused' : 'is-recording'}` },
        h('span', { class: 'tk-dot', 'aria-hidden': 'true' }),
        paused ? 'Paused' : 'REC',
      ),
      micIndicator(),
      h('span', {}, h('span', { class: 'tk-sr', text: 'Elapsed ' }), time),
    ];
  }

  function bubbleContent() {
    const label = h('span', { class: 'tk-sr', text: 'Open TestKit panel. ' });
    const logo = h('span', { class: 'tk-logo', 'aria-hidden': 'true', text: 'TK' });
    if (otherTab()) return [label, logo, 'Other tab'];
    switch (state.phase) {
      case 'recording':
      case 'paused':
        return [label, ...recIndicators()];
      case 'preflight':
        return [label, logo, 'Setup'];
      case 'stopped':
        return [label, logo, 'Done'];
      case 'exporting':
        return [label, logo, 'Saving…'];
      default:
        return [h('span', { class: 'tk-sr', text: 'Open TestKit panel' }), logo];
    }
  }

  function panelHead() {
    const active = ACTIVE.has(state.phase) && !otherTab();
    return h(
      'div',
      { class: 'tk-head' },
      h(
        'div',
        { class: 'tk-head-title' },
        h('span', { class: 'tk-logo', 'aria-hidden': 'true', text: 'TK' }),
        active ? null : h('span', { text: 'TestKit' }),
        active ? null : h('span', { class: 'tk-head-study', text: state.study || '' }),
      ),
      active ? h('div', { class: 'tk-head-indicators' }, ...recIndicators()) : null,
      h('span', { class: 'tk-head-spacer' }),
      h('button', {
        type: 'button',
        class: 'tk-btn is-icon',
        'aria-label': 'Collapse TestKit panel',
        title: 'Collapse (Esc)',
        'data-fid': 'collapse',
        html: COLLAPSE_SVG,
        onclick: () => setOpen(false, { focus: true }),
      }),
    );
  }

  function btn(label, props = {}) {
    const { variant, fid, ...rest } = props;
    return h(
      'button',
      { type: 'button', class: `tk-btn${variant ? ` ${variant}` : ''}`, 'data-fid': fid, ...rest },
      label,
    );
  }

  function notice(text, kind) {
    return h('p', { class: `tk-notice${kind ? ` is-${kind}` : ''}` }, text);
  }

  function errorNotices() {
    const out = [];
    // A failed export also sets state.error; the stopped view already explains it.
    const exportFailure = ui.exportError && (state.phase === 'stopped' || state.phase === 'exporting');
    if (state.error && !exportFailure && !otherTab()) out.push(notice(errorMessage(state.error), 'error'));
    if (ui.actionError) out.push(h('p', { class: 'tk-notice is-error', role: 'alert' }, ui.actionError));
    return out;
  }

  function otherTabView() {
    return [
      h('h2', { class: 'tk-h', text: 'Session open in another tab' }),
      notice('Recording is active in another tab. Close this tab to continue in the other one.', 'warn'),
      h('p', { class: 'tk-p', text: 'Controls are turned off here so the two tabs can’t interfere with each other.' }),
    ];
  }

  function panelBody() {
    let content;
    if (otherTab()) return h('div', { class: 'tk-body' }, ...errorNotices(), ...otherTabView());
    switch (state.phase) {
      case 'preflight': content = preflightView(); break;
      case 'recording':
      case 'paused': content = recordingView(); break;
      case 'stopped':
      case 'exporting': content = stoppedView(); break;
      default: content = idleView();
    }
    return h('div', { class: 'tk-body' }, ...errorNotices(), ...content);
  }

  function idleView() {
    const n = state.tasks?.length || 0;
    const what = state.audio?.enabled ? 'screen activity and voice' : 'screen activity';
    return [
      h('p', { class: 'tk-eyebrow', text: 'Study' }),
      h('h2', { class: 'tk-h', text: state.study || 'Untitled study' }),
      h('p', { class: 'tk-p' }, `${n ? `${n} task${n === 1 ? '' : 's'}. ` : ''}Records your ${what} on this device only.`),
      h('div', { class: 'tk-row' }, btn('Start test session', {
        variant: 'is-primary is-grow',
        fid: 'start',
        onclick: () => act(() => controller.beginPreflight()),
      })),
    ];
  }

  function micSection() {
    const pre = ui.pre;
    const status = state.audio?.status;
    const parts = [h('h3', { class: 'tk-label', id: 'tk-mic-h', text: 'Microphone check' })];

    if (pre.audioSkipped) {
      parts.push(
        h('p', { class: 'tk-p', text: 'Audio won’t be recorded for this session.' }),
        h('div', { class: 'tk-row' }, btn('Use microphone', { fid: 'use-mic', onclick: useMicAgain })),
      );
    } else if (pre.mic === 'untested') {
      parts.push(
        h('p', { class: 'tk-p', text: 'Your browser will ask for microphone access.' }),
        h(
          'div',
          { class: 'tk-row' },
          btn('Test microphone', { variant: 'is-primary', fid: 'test-mic', onclick: testMic }),
          btn('Continue without audio', { fid: 'skip-audio', onclick: skipAudio }),
        ),
      );
    } else if (pre.mic === 'pending') {
      // Focusable so keyboard focus has somewhere to land while no buttons exist.
      parts.push(h(
        'p',
        { class: 'tk-p is-strong tk-inline', tabindex: '-1', 'data-fid': 'mic-pending' },
        h('span', { class: 'tk-spinner', 'aria-hidden': 'true' }),
        'Waiting for microphone permission…',
      ));
      // The browser prompt can stay open indefinitely; never strand the tester.
      parts.push(h('div', { class: 'tk-row' }, btn('Continue without audio', { fid: 'skip-audio', onclick: skipAudio })));
    } else if (pre.mic === 'failed') {
      const denied = status === 'denied' || /denied|notallowed|permission/i.test(pre.micError || '');
      parts.push(
        notice(
          denied
            ? 'Microphone access is blocked. Allow it in your browser’s site settings and try again, or continue without audio.'
            : `Couldn’t start the microphone${pre.micError ? `: ${pre.micError}` : ''}. Try again, or continue without audio.`,
          'error',
        ),
        h(
          'div',
          { class: 'tk-row' },
          btn('Try again', { fid: 'test-mic', onclick: testMic }),
          btn('Continue without audio', { fid: 'skip-audio', onclick: skipAudio }),
        ),
      );
    } else {
      parts.push(
        h(
          'div',
          {
            class: 'tk-meter',
            role: 'meter',
            'aria-label': 'Microphone level',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': '0',
            ref: (el) => { refs.meter = el; },
          },
          h('div', { class: 'tk-meter-fill', ref: (el) => { refs.meterFill = el; } }),
          h('div', { class: 'tk-meter-mark', style: `left: ${MIC_PASS_LEVEL * 100}%` }),
        ),
        pre.micPassed
          ? notice('✓ We can hear you. Your microphone is working.', 'ok')
          : h('p', { class: 'tk-p is-strong', text: 'Say something — the check passes once we hear you.' }),
        pre.micPassed ? null : h('div', { class: 'tk-row' }, btn('Continue without audio', { fid: 'skip-audio', onclick: skipAudio })),
      );
    }
    return h('div', { class: 'tk-card', role: 'group', 'aria-labelledby': 'tk-mic-h' }, ...parts);
  }

  function preflightView() {
    const audioEnabled = Boolean(state.audio?.enabled);
    const withAudio = audioEnabled && !ui.pre.audioSkipped;
    const ready = canStart({ consent: ui.pre.consent, audioEnabled, micPassed: ui.pre.micPassed, audioSkipped: ui.pre.audioSkipped });
    const needs = [];
    if (!ui.pre.consent) needs.push('check the consent box');
    if (audioEnabled && !ui.pre.micPassed && !ui.pre.audioSkipped) needs.push('pass the microphone check (or continue without audio)');

    return [
      h('h2', { class: 'tk-h', text: 'Before you start' }),
      h('p', { class: 'tk-p is-strong', id: 'tk-consent-text', text: consentText(withAudio) }),
      h(
        'label',
        { class: 'tk-check' },
        h('input', {
          type: 'checkbox',
          'data-fid': 'consent',
          checked: ui.pre.consent,
          'aria-describedby': 'tk-consent-text',
          onchange: (e) => {
            ui.pre.consent = e.target.checked;
            ui.focusNext = 'consent';
            render();
          },
        }),
        h('span', { text: withAudio ? 'I agree to have my screen and voice recorded' : 'I agree to have my screen recorded' }),
      ),
      audioEnabled ? micSection() : null,
      needs.length
        ? h('p', { class: 'tk-p', id: 'tk-start-hint', text: `To start, ${needs.join(' and ')}.` })
        : null,
      h(
        'div',
        { class: 'tk-row is-end' },
        btn('Cancel', { fid: 'cancel', onclick: () => act(() => controller.cancelPreflight()) }),
        btn('Start', {
          variant: 'is-primary',
          fid: 'start-session',
          disabled: !ready,
          'aria-describedby': needs.length ? 'tk-start-hint' : null,
          onclick: startSession,
        }),
      ),
    ];
  }

  function recordingView() {
    const total = state.tasks?.length || 0;
    const task = currentTask();
    const paused = state.phase === 'paused';
    const isLast = total > 0 && state.taskIndex >= total - 1;
    const showFollowUp = Boolean(task?.followUp) && ui.followUpFor === state.taskIndex;
    const audio = state.audio || {};
    const out = [];

    if (total && task) {
      out.push(
        h('p', { class: 'tk-eyebrow', text: `Task ${state.taskIndex + 1} of ${total}` }),
        h('h2', { class: 'tk-prompt', text: task.prompt }),
      );
      if (task.timeLimit) {
        out.push(h('p', {
          class: `tk-countdown${ui.timeUp ? ' is-over' : ''}`,
          ref: (el) => { refs.countdown = el; },
        }));
      }
      if (task.successHint) {
        out.push(h(
          'details',
          { class: 'tk-hint' },
          h('summary', { text: 'How will I know I’m done?' }),
          h('p', { text: task.successHint }),
        ));
      }
    } else {
      out.push(
        h('p', { class: 'tk-eyebrow', text: 'Free exploration' }),
        h('h2', { class: 'tk-prompt', text: 'Explore the prototype and think aloud as you go.' }),
      );
    }

    if (paused) out.push(notice('Recording is paused. Nothing is captured until you resume.', 'warn'));
    if (audio.enabled && (audio.status === 'denied' || audio.status === 'error')) {
      out.push(notice(
        `Microphone unavailable${audio.error ? ` (${errorMessage(audio.error)})` : ''} — audio isn’t being recorded.`,
        'warn',
      ));
    }

    if (showFollowUp) {
      out.push(h(
        'div',
        { class: 'tk-card' },
        h('label', { class: 'tk-label', for: 'tk-followup', text: task.followUp }),
        h('textarea', {
          id: 'tk-followup',
          class: 'tk-textarea',
          'data-fid': 'followup',
          value: ui.followUpText,
          oninput: (e) => { ui.followUpText = e.target.value; },
        }),
      ));
    }

    // Controls stay pinned below long prompts so Next/Stop are always reachable.
    const actions = [];
    if (showFollowUp) {
      actions.push(h(
        'div',
        { class: 'tk-row' },
        btn('Skip', { fid: 'followup-skip', onclick: () => submitFollowUp(true) }),
        btn(isLast ? 'Submit and finish' : 'Submit and continue', {
          variant: 'is-primary is-grow',
          fid: 'followup-submit',
          onclick: () => submitFollowUp(false),
        }),
      ));
    } else {
      actions.push(h('div', { class: 'tk-row' }, btn(total ? (isLast ? 'Finish' : 'Next task') : 'Finish session', {
        variant: 'is-primary is-grow',
        fid: 'next',
        disabled: paused,
        onclick: onNext,
      })));
    }

    if (ui.confirm === 'stop') {
      actions.push(h(
        'div',
        { class: 'tk-card', role: 'group', 'aria-labelledby': 'tk-stop-q' },
        h('p', { class: 'tk-p is-strong', id: 'tk-stop-q', text: 'Stop the session now? You can still download what’s been recorded.' }),
        h(
          'div',
          { class: 'tk-row is-end' },
          btn('Keep recording', { fid: 'confirm-cancel', onclick: cancelConfirm }),
          btn('Stop session', { variant: 'is-danger', fid: 'confirm-yes', onclick: () => act(() => controller.stop()) }),
        ),
      ));
    } else {
      const canMute = audio.enabled && (audio.status === 'live' || audio.status === 'muted');
      actions.push(h(
        'div',
        { class: 'tk-row' },
        btn(paused ? 'Resume' : 'Pause', { fid: 'pause', onclick: togglePause }),
        canMute
          ? btn(state.muted ? 'Unmute' : 'Mute', { fid: 'mute', disabled: paused, onclick: () => act(() => controller.toggleMute()) })
          : null,
        h('span', { class: 'tk-head-spacer' }),
        btn('Stop', { variant: 'is-danger-quiet', fid: 'stop', onclick: () => askConfirm('stop') }),
      ));
    }
    out.push(h('div', { class: 'tk-actions' }, ...actions));
    return out;
  }

  function stoppedView() {
    const total = state.tasks?.length || 0;
    const done = tasksCompleted(state, { finishedLast: ui.finishedLast });
    const exporting = ui.exporting || state.phase === 'exporting';
    const res = ui.exportResult;
    const out = [
      h('h2', { class: 'tk-h', text: total && done >= total ? 'Session complete' : 'Session stopped' }),
      h(
        'dl',
        { class: 'tk-meta' },
        h('dt', { text: 'Study' }), h('dd', { text: state.study || 'Untitled study' }),
        h('dt', { text: 'Duration' }),
        h('dd', {}, h('span', { 'aria-hidden': 'true', text: formatElapsed(state.elapsedMs) }), h('span', { class: 'tk-sr', text: describeDuration(state.elapsedMs) })),
        total ? h('dt', { text: 'Tasks done' }) : null,
        total ? h('dd', { text: `${done} of ${total}` }) : null,
      ),
    ];

    if (res && !exporting) {
      const size = res.bytes ? ` (${formatBytes(res.bytes)})` : '';
      // We only know the download was handed to the browser, not that it landed.
      out.push(notice(`Download started: ${res.filename || 'session file'}${size}. Check your downloads folder; if it isn’t there, use Download again.`, 'ok'));
    }
    if (ui.exportError && !exporting) out.push(notice(`Export failed: ${ui.exportError}`, 'error'));
    if (!res && !exporting && !ui.exportError) {
      out.push(h('p', { class: 'tk-p', text: 'The recording is saved in this browser until you download or discard it.' }));
    }

    out.push(h('div', { class: 'tk-row' }, btn(
      exporting
        ? [h('span', { class: 'tk-spinner', 'aria-hidden': 'true' }), 'Preparing file…']
        : res ? 'Download again' : (ui.exportError ? 'Try download again' : 'Download session file'),
      {
        variant: 'is-primary is-grow',
        fid: 'download',
        disabled: exporting,
        'aria-busy': exporting ? 'true' : null,
        onclick: doExport,
      },
    )));

    if (ui.confirm === 'discard') {
      out.push(h(
        'div',
        { class: 'tk-card', role: 'group', 'aria-labelledby': 'tk-discard-q' },
        h('p', {
          class: 'tk-p is-strong',
          id: 'tk-discard-q',
          text: `Delete this session from this device?${res ? '' : ' You haven’t downloaded it yet.'} This can’t be undone.`,
        }),
        h(
          'div',
          { class: 'tk-row is-end' },
          btn('Cancel', { fid: 'confirm-cancel', onclick: cancelConfirm }),
          btn('Discard session', { variant: 'is-danger', fid: 'confirm-yes', onclick: () => act(() => controller.discard()) }),
        ),
      ));
    } else {
      out.push(h('div', { class: 'tk-row is-end' }, btn(res ? 'Finish and clear' : 'Discard', {
        variant: 'is-danger-quiet',
        fid: 'discard',
        disabled: exporting,
        onclick: () => askConfirm('discard'),
      })));
    }
    return out;
  }

  // Updates time-driven text without rebuilding the DOM.
  function tick() {
    if (destroyed || !ACTIVE.has(state.phase)) return;
    const fresh = readState();
    if (fresh) syncClock(fresh);
    const text = formatElapsed(liveElapsed());
    for (const el of refs.times || []) if (el.textContent !== text) el.textContent = text;

    const task = currentTask();
    // Prefer pause-aware task time when the controller provides it.
    const remaining = Number.isFinite(fresh?.taskElapsedMs) && task?.timeLimit
      ? task.timeLimit * 1000 - fresh.taskElapsedMs
      : taskRemainingMs(task, state.taskStartedAt, Date.now());
    if (remaining == null) return;
    const over = remaining <= 0;
    if (over && !ui.timeUp) {
      ui.timeUp = true;
      announce('Time’s up — move on when you’re ready.');
      render();
      return;
    }
    if (refs.countdown) {
      const label = over
        ? 'Time’s up — move on when ready'
        : `${formatCountdown(remaining)} left`;
      if (refs.countdown.textContent !== label) refs.countdown.textContent = label;
    }
  }

  // ---- Position & drag ----

  function bubbleSize() {
    return { w: bubble.offsetWidth || 44, h: bubble.offsetHeight || 44 };
  }

  function applyPosition() {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    // Measure even while hidden by briefly showing; panel placement keys off it.
    const wasHidden = bubble.hidden;
    if (wasHidden) bubble.hidden = false;
    const { w, h: bh } = bubbleSize();
    if (wasHidden) bubble.hidden = true;

    if (!pos) pos = defaultPosition(vh, bh);
    const y = clamp(pos.y, EDGE_MARGIN, vh - bh - EDGE_MARGIN);
    if (!drag?.moved) {
      bubble.style.top = `${y}px`;
      bubble.style.left = `${pos.side === 'left' ? EDGE_MARGIN : vw - w - EDGE_MARGIN}px`;
    }

    panel.style.left = pos.side === 'left' ? `${EDGE_MARGIN}px` : 'auto';
    panel.style.right = pos.side === 'right' ? `${EDGE_MARGIN}px` : 'auto';
    // Grow away from the nearer vertical edge so the panel opens where the bubble was.
    const topHalf = y + bh / 2 < vh / 2;
    const spaceBelow = vh - y - EDGE_MARGIN;
    const spaceAbove = y + bh - EDGE_MARGIN;
    if (topHalf && spaceBelow >= MIN_PANEL_SPACE) {
      panel.style.top = `${y}px`;
      panel.style.bottom = 'auto';
      panel.style.maxHeight = `${spaceBelow}px`;
    } else if (!topHalf && spaceAbove >= MIN_PANEL_SPACE) {
      panel.style.top = 'auto';
      panel.style.bottom = `${vh - y - bh}px`;
      panel.style.maxHeight = `${spaceAbove}px`;
    } else {
      panel.style.top = `${EDGE_MARGIN}px`;
      panel.style.bottom = 'auto';
      panel.style.maxHeight = `${vh - EDGE_MARGIN * 2}px`;
    }
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = bubble.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
    try {
      bubble.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort; moves still arrive while the pointer is over the bubble.
    }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (!hasMovedPastThreshold(dx, dy)) return;
      drag.moved = true;
      bubble.classList.add('is-dragging');
    }
    e.preventDefault();
    const { w, h: bh } = bubbleSize();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    bubble.style.left = `${clamp(drag.left + dx, 0, vw - w)}px`;
    bubble.style.top = `${clamp(drag.top + dy, 0, window.innerHeight - bh)}px`;
  }

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved } = drag;
    try {
      bubble.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (moved) {
      const rect = bubble.getBoundingClientRect();
      pos = snapPosition({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        viewportW: document.documentElement.clientWidth || window.innerWidth,
        viewportH: window.innerHeight,
      });
      writeStorage('localStorage', POS_KEY, JSON.stringify(pos));
      // Swallow the click that follows a drag; clear on the next task in case none fires.
      suppressClick = !cancelled;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    drag = null;
    bubble.classList.remove('is-dragging');
    if (moved) applyPosition();
  }

  function onBubbleClick() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setOpen(true, { focus: true });
  }

  // Keys typed in the overlay (e.g. the follow-up textarea) must not trigger
  // prototype shortcuts. Stopping at window capture is the earliest point we
  // can reach: it blocks every document/element listener and window listeners
  // registered after ours. Limitation: window capture listeners the prototype
  // registered before TestKit loaded still fire first; nothing in-page can
  // prevent that. Default actions (typing, Tab, Enter/Space on buttons) are
  // unaffected, and Esc is handled here since inner listeners never see keys.
  function onKey(e) {
    if (!e.composedPath().includes(host)) return;
    e.stopImmediatePropagation();
    if (e.type === 'keydown' && e.key === 'Escape' && open) {
      if (ui.confirm) cancelConfirm();
      else setOpen(false, { focus: true });
    }
  }
  const onKeyGuarded = guard(onKey);
  const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

  const onResize = guard(() => applyPosition());

  bubble.addEventListener('pointerdown', guard(onPointerDown));
  bubble.addEventListener('pointermove', guard(onPointerMove));
  bubble.addEventListener('pointerup', guard((e) => endDrag(e, false)));
  bubble.addEventListener('pointercancel', guard((e) => endDrag(e, true)));
  bubble.addEventListener('click', guard(onBubbleClick));
  for (const type of KEY_EVENTS) window.addEventListener(type, onKeyGuarded, true);
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
      stopMeter();
      clearInterval(ticker);
      clearTimeout(announceTimer);
      window.removeEventListener('resize', onResize);
      for (const type of KEY_EVENTS) window.removeEventListener(type, onKeyGuarded, true);
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch {
        // Controller already torn down.
      }
      host.remove();
    },
  };
}
