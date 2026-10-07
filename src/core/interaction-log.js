// Human/agent-readable interaction log captured alongside rrweb (which only
// references internal node ids). See LogEntry in docs/CONTRACTS.md.
//
// Every handler is wrapped so a failure here can never surface in the host
// page, and everything originating inside the overlay (`.testkit-block`) is
// ignored.

import { clip, interactiveTarget, labelFor, selectorFor, toElement } from './selector.js';

const BLOCK_CLASS = 'testkit-block';
const INPUT_DEBOUNCE_MS = 500;
const MAX_VALUE = 200;
const MAX_MESSAGE = 500;
const MAX_CONSOLE = 200;
const MAX_STACK = 2000;
const ERROR_DEDUPE_MS = 2000;
const TOGGLE_TYPES = new Set(['checkbox', 'radio']);

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function fromOverlay(event) {
  const path = event.composedPath?.() || [];
  if (path.some((n) => n?.classList?.contains?.(BLOCK_CLASS))) return true;
  return !!toElement(event.target)?.closest?.(`.${BLOCK_CLASS}`);
}

/** Real target, looking through open shadow roots in the prototype. */
function realTarget(event) {
  const first = event.composedPath?.()[0];
  return toElement(first) || toElement(event.target);
}

function isTextField(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.localName;
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return !TOGGLE_TYPES.has((el.type || '').toLowerCase());
}

/**
 * Value to log for a form control. Masked values become '***' (empty stays
 * empty — "cleared the field" isn't sensitive); passwords are always masked.
 * Checkbox/radio state is logged as 'true'/'false' even when masking, as
 * rrweb does, since it's UX signal rather than typed content.
 */
export function inputValue(el, mask) {
  if (!el) return '';
  const type = (el.type || '').toLowerCase();
  if (el.localName === 'input' && TOGGLE_TYPES.has(type)) return String(!!el.checked);
  const raw = el.isContentEditable ? el.innerText ?? el.textContent ?? '' : String(el.value ?? '');
  if (!raw) return '';
  if (mask || type === 'password') return '***';
  return raw.slice(0, MAX_VALUE);
}

function stringifyArg(arg) {
  if (arg instanceof Error) return arg.message || String(arg);
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Normalizes an Error-ish reason into { message, stack }. */
export function describeError(reason) {
  if (reason instanceof Error || (reason && typeof reason === 'object' && 'message' in reason)) {
    return {
      message: clip(reason.message || String(reason), MAX_MESSAGE),
      stack: reason.stack ? String(reason.stack).slice(0, MAX_STACK) : undefined,
    };
  }
  return { message: clip(stringifyArg(reason), MAX_MESSAGE) };
}

// History and console are patched at most once per page and stay patched;
// each wrapper is a passthrough unless a log instance is active. Unwrapping
// could clobber another library that wrapped them after us.
const hooks = { history: null, console: null };

function installHistoryHook() {
  if (hooks.history || typeof history === 'undefined') return;
  hooks.history = { onNav: null };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function testkitHistory(...args) {
      const from = location.href;
      const result = original.apply(this, args);
      safe(() => hooks.history.onNav?.(method, from, location.href));
      return result;
    };
  }
}

function installConsoleHook() {
  if (hooks.console || typeof console === 'undefined') return;
  hooks.console = { onError: null, busy: false };
  const original = console.error;
  console.error = function testkitConsoleError(...args) {
    const h = hooks.console;
    // `busy` stops recursion if anything downstream logs an error itself.
    if (h.onError && !h.busy) {
      h.busy = true;
      safe(() => h.onError(args));
      h.busy = false;
    }
    return original.apply(this, args);
  };
}

/**
 * @param {object} opts
 * @param {boolean} opts.mask              mask input values
 * @param {() => string|null} opts.getTaskId
 * @param {(entry) => void} opts.onEntry   receives every LogEntry
 */
export function createInteractionLog({ mask = true, getTaskId = () => null, onEntry, onNavigationIntent = () => {} }) {
  let active = false;
  let currentUrl = typeof location !== 'undefined' ? location.href : '';
  // element → { timer, fields }. Fields (ts, url, taskId, masked value) are
  // captured at event time so a debounced entry can't drift into the next task.
  const pendingInputs = new Map();
  const recentErrors = new Map(); // message → ts
  let pendingPop = null; // { timer, from, to }

  function log(type, fields = {}) {
    const entry = { ts: Date.now(), type, url: safe(() => location.href) ?? '', taskId: safe(getTaskId) ?? null, ...fields };
    safe(() => onEntry(entry));
    return entry;
  }

  function logNav(navType, from, to) {
    currentUrl = to ?? currentUrl;
    log('nav', { navType, from, to });
  }

  function inputFields(el, previous) {
    return {
      ts: Date.now(),
      url: safe(() => location.href) ?? '',
      taskId: safe(getTaskId) ?? null,
      // Selector/label don't change while typing; compute them once per burst.
      selector: previous ? previous.selector : selectorFor(el),
      text: previous ? previous.text : labelFor(el, { mask }),
      value: inputValue(el, mask), // masked before it's retained
    };
  }

  function logInput(type, el) {
    log(type, inputFields(el));
  }

  function flushInput(el) {
    const pending = pendingInputs.get(el);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingInputs.delete(el);
    log('input', pending.fields);
  }

  function flushPending() {
    for (const el of Array.from(pendingInputs.keys())) safe(() => flushInput(el));
    if (pendingPop) {
      clearTimeout(pendingPop.timer);
      const { from, to } = pendingPop;
      pendingPop = null;
      logNav('popstate', from, to);
    }
  }

  function logError(fields, type = 'error') {
    const now = Date.now();
    // An error thrown every frame would otherwise flood the log.
    const last = recentErrors.get(fields.message);
    if (last && now - last < ERROR_DEDUPE_MS) return;
    recentErrors.set(fields.message, now);
    if (recentErrors.size > 200) recentErrors.clear();
    log(type, fields);
  }

  const handlers = {
    click(e) {
      if (fromOverlay(e)) return;
      const el = interactiveTarget(realTarget(e));
      if (!el) return;
      log('click', {
        selector: selectorFor(el),
        text: labelFor(el, { mask }),
        x: Math.round(e.clientX || 0),
        y: Math.round(e.clientY || 0),
      });
      // A link click may unload the page before the next scheduled flush.
      if (el.closest?.('a[href]')) safe(onNavigationIntent);
    },
    input(e) {
      if (fromOverlay(e)) return;
      const el = realTarget(e);
      // Toggles and selects are logged once, on 'change'.
      if (!isTextField(el)) return;
      const previous = pendingInputs.get(el);
      clearTimeout(previous?.timer);
      pendingInputs.set(el, {
        fields: inputFields(el, previous?.fields),
        timer: setTimeout(() => safe(() => flushInput(el)), INPUT_DEBOUNCE_MS),
      });
    },
    change(e) {
      if (fromOverlay(e)) return;
      const el = realTarget(e);
      if (!el) return;
      flushInput(el); // keep input → change ordering
      logInput('change', el);
    },
    submit(e) {
      if (fromOverlay(e)) return;
      const form = realTarget(e);
      log('submit', { selector: selectorFor(form), text: labelFor(e.submitter || form, { mask }) });
      safe(onNavigationIntent);
    },
    popstate() {
      // Following a hash link fires popstate then hashchange; hold popstate a
      // tick so the pair is logged once, as hashchange (not as backtracking).
      if (pendingPop) clearTimeout(pendingPop.timer);
      const pop = { from: currentUrl, to: location.href };
      pop.timer = setTimeout(() => {
        if (pendingPop !== pop) return;
        pendingPop = null;
        safe(() => logNav('popstate', pop.from, pop.to));
      }, 0);
      pendingPop = pop;
    },
    hashchange(e) {
      if (pendingPop && pendingPop.to === e.newURL) {
        clearTimeout(pendingPop.timer);
        pendingPop = null;
      }
      logNav('hashchange', e.oldURL || currentUrl, e.newURL || location.href);
    },
    beforeunload() {
      flushPending();
      log('nav', { navType: 'beforeunload', from: location.href, to: null });
    },
    error(e) {
      if (e && 'message' in e && 'filename' in e) {
        const { message, stack } = describeError(e.error || e.message);
        const where = e.filename ? `${e.filename}:${e.lineno || 0}:${e.colno || 0}` : undefined;
        logError({ source: 'window', message: message || 'Script error', stack: stack || where });
        return;
      }
      // Resource load failures (img/script/link) reach a capturing window listener too.
      const el = toElement(e?.target);
      if (!el || fromOverlay(e)) return;
      const src = el.currentSrc || el.src || el.href || '';
      logError({ source: 'resource', message: clip(`Failed to load <${el.localName}> ${src}`, MAX_MESSAGE), selector: selectorFor(el) });
    },
    unhandledrejection(e) {
      logError({ source: 'promise', ...describeError(e.reason) }, 'rejection');
    },
  };

  const DOCUMENT_EVENTS = ['click', 'input', 'change', 'submit'];
  const WINDOW_EVENTS = ['popstate', 'hashchange', 'beforeunload', 'error', 'unhandledrejection'];
  const wrapped = {};
  for (const [name, fn] of Object.entries(handlers)) {
    wrapped[name] = (e) => {
      if (active) safe(() => fn(e));
    };
  }

  function start({ pageLoad = false } = {}) {
    if (active) return;
    active = true;
    currentUrl = location.href;
    for (const name of DOCUMENT_EVENTS) document.addEventListener(name, wrapped[name], true);
    for (const name of WINDOW_EVENTS) window.addEventListener(name, wrapped[name], true);
    installHistoryHook();
    installConsoleHook();
    hooks.history.onNav = (method, from, to) => {
      if (active && from !== to) logNav(method, from, to);
    };
    hooks.console.onError = (args) => {
      if (!active) return;
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[TestKit]')) return;
      // Only the first argument, clipped: prototypes often log whole form
      // state objects, which would bypass input masking.
      let message;
      if (first instanceof Error) message = first.message;
      else if (typeof first === 'string') message = first;
      else if (first && typeof first === 'object') message = `[${first.constructor?.name || 'object'}]`;
      else message = String(first);
      logError({
        source: 'console',
        message: clip(message || 'console.error', MAX_CONSOLE),
        stack: first instanceof Error && first.stack ? String(first.stack).slice(0, MAX_STACK) : undefined,
      });
    };
    if (pageLoad) logNav('load', safe(() => document.referrer) || null, location.href);
  }

  function stop() {
    if (!active) return;
    flushPending();
    active = false;
    for (const name of DOCUMENT_EVENTS) document.removeEventListener(name, wrapped[name], true);
    for (const name of WINDOW_EVENTS) window.removeEventListener(name, wrapped[name], true);
    if (hooks.history) hooks.history.onNav = null;
    if (hooks.console) hooks.console.onError = null;
  }

  return { start, stop, log, flushPending, isActive: () => active };
}
