// Script-tag build only: `virtual:player-bundle` resolves here for
// public/v1/testkit-core.js. The replay player's source (~270 kB) is needed
// only when a session is exported, so it ships as testkit-player-source.js
// next to testkit-core.js and is injected like the loader injects the core.
// The package build resolves the same specifier to a dynamic import() chunk
// instead (scripts/build.mjs).

const FILE = 'testkit-player-source.js';
const GLOBAL = '__TestKitPlayerSource';

// Captured while testkit-core.js evaluates: currentScript.src is absolute, so
// a later SPA navigation (pushState to another path) can't change it.
function coreBase() {
  try {
    const src = document.currentScript?.src || document.querySelector('script[src*="testkit-core.js"]')?.src;
    return src ? new URL('.', src).href : null;
  } catch {
    return null;
  }
}
const base = coreBase();
let pending = null;

/** Resolves to the player bundle's source text. */
export function loadPlayerJs() {
  if (typeof window[GLOBAL] === 'string') return Promise.resolve(window[GLOBAL]);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const url = new URL(FILE, base || location.href).href;
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.className = 'testkit-block';
    el.onload = () => {
      el.remove();
      if (typeof window[GLOBAL] === 'string') resolve(window[GLOBAL]);
      else reject(new Error(`${FILE} did not define the replay player`));
    };
    el.onerror = () => {
      el.remove();
      reject(new Error(`Could not load the replay player from ${url}`));
    };
    (document.head || document.documentElement).appendChild(el);
  }).catch((err) => {
    pending = null; // allow Download again to retry
    throw err;
  });
  return pending;
}
