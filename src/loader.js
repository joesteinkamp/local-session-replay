// public/v1/testkit.js — tiny loader included by every prototype page.
// Casual viewers pay only for this file; the recorder (testkit-core.js) is
// fetched from the same base URL only when testing is activated.

const ACTIVE_KEY = 'testkit:active';
const script = document.currentScript;
const baseUrl = script?.src ? script.src.replace(/[^/]*(\?.*)?$/, '') : './';

function readActive() {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function isActivated(activate) {
  const params = new URLSearchParams(location.search);
  if (params.get('test') === '0') return false;
  if (readActive()) return true; // a session is in progress: survive navigation
  if (typeof activate === 'function') return !!activate();
  if (typeof activate === 'boolean') return activate;
  return params.get('test') === '1';
}

let initialized = false;

function init(config = {}) {
  if (initialized) return;
  initialized = true;
  if (!isActivated(config.activate ?? 'query')) return;
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
