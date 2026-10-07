// public/v1/testkit.js — tiny loader included by every prototype page.
// Casual viewers pay only for this file; the recorder (testkit-core.js) is
// fetched from the same base URL only when testing is activated.

// Per-study pointer written by testkit-core's store.js. Study normalization
// must match normalizeConfig() in src/core/config.js.
const ACTIVE_PREFIX = 'testkit:active:';
const studyOf = (config) => String(config.study || 'untitled-study');
const script = document.currentScript;
const baseUrl = script?.src ? script.src.replace(/[^/]*(\?.*)?$/, '') : './';

function readActive(study) {
  try {
    return localStorage.getItem(ACTIVE_PREFIX + study);
  } catch {
    return null;
  }
}

function isActivated(activate, study) {
  const params = new URLSearchParams(location.search);
  if (params.get('test') === '0') return false;
  if (readActive(study)) return true; // this study has a session in progress: survive navigation
  if (typeof activate === 'function') return !!activate();
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
