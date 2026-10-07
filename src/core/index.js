// public/v1/testkit-core.js — loaded by the loader only when testing is active.
import { normalizeConfig } from './config.js';
import * as store from './store.js';
import { createController } from './session.js';
import { mountOverlay } from '../overlay/overlay.js';

let booted = false;

async function boot(userConfig) {
  if (booted) return;
  booted = true;
  const config = normalizeConfig(userConfig);
  await store.openStore();
  const controller = await createController({ config, store });
  const mount = () => mountOverlay(controller);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  window.TestKit.controller = controller; // for debugging & automated checks
}

window.__TestKitCore = {
  boot: (config, baseUrl) =>
    boot(config, baseUrl).catch((err) => console.error('[TestKit] boot failed', err)),
};
