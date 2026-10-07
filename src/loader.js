// public/v1/testkit.js — tiny loader included by every prototype page.
// Casual viewers pay only for this file; the recorder (testkit-core.js) is
// fetched from the same base URL only when testing is activated.
import { claimInit, isActivated } from './activation.js';

const script = document.currentScript;
const scriptBase = script?.src ? script.src.replace(/[^/]*(\?.*)?$/, '') : './';

// `config.baseUrl` overrides the folder testkit-core.js is fetched from, for
// hosts that inject this file without a <script src> (so currentScript is null).
const baseOf = (config) => (config.baseUrl ? String(config.baseUrl).replace(/\/?$/, '/') : scriptBase);

function init(config = {}) {
  if (!claimInit()) return;
  if (!isActivated(config)) return;
  const baseUrl = baseOf(config);
  const boot = () => window.__TestKitCore.boot(config);
  if (window.__TestKitCore) return boot();
  const el = document.createElement('script');
  el.src = `${baseUrl}testkit-core.js`;
  el.async = true;
  el.onload = boot;
  el.onerror = () => console.warn('[TestKit] failed to load testkit-core.js from', baseUrl);
  (document.head || document.documentElement).appendChild(el);
}

window.TestKit = window.TestKit || { init, version: __TESTKIT_VERSION__ };
