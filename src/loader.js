// public/v1/testkit.js — tiny loader included by every prototype page.
// Casual viewers pay only for this file; the recorder (testkit-core.js) is
// fetched from the same base URL only when testing is activated.

// Per-study pointer `{ id, study, lastActivityAt }` written by testkit-core's
// store.js. Study normalization must match normalizeConfig() in
// src/core/config.js, and STALE_MS must match session.js.
const ACTIVE_PREFIX = 'testkit:active:';
const STALE_MS = 30 * 60 * 1000;
const studyOf = (config) => String(config.study || 'untitled-study');
const script = document.currentScript;
const baseUrl = script?.src ? script.src.replace(/[^/]*(\?.*)?$/, '') : './';

// A session idle for longer than STALE_MS (tab closed, browser crashed) must
// not silently restart screen and mic recording on a later visit.
function hasFreshSession(study) {
  try {
    const pointer = JSON.parse(localStorage.getItem(ACTIVE_PREFIX + study) || 'null');
    return !!pointer?.id && Date.now() - Number(pointer.lastActivityAt) < STALE_MS;
  } catch {
    return false;
  }
}

function isActivated(activate, study) {
  const params = new URLSearchParams(location.search);
  if (params.get('test') === '0') return false;
  if (hasFreshSession(study)) return true; // this study has a session in progress: survive navigation
  if (typeof activate === 'function') {
    // A throwing predicate must not abort the host's TestKit.init() call.
    try {
      return !!activate();
    } catch {
      return false;
    }
  }
  if (typeof activate === 'boolean') return activate;
  return params.get('test') === '1';
}

let initialized = false;

function init(config = {}) {
  if (initialized) return;
  initialized = true;
  if (!isActivated(config.activate ?? 'query', studyOf(config))) return;
  const boot = () => window.__TestKitCore.boot(config, baseUrl);
  if (window.__TestKitCore) return boot();
  const el = document.createElement('script');
  el.src = `${baseUrl}testkit-core.js`;
  el.async = true;
  el.onload = boot;
  el.onerror = () => console.warn('[TestKit] failed to load testkit-core.js from', baseUrl);
  (document.head || document.documentElement).appendChild(el);
}

window.TestKit = window.TestKit || { init, version: __TESTKIT_VERSION__ };
