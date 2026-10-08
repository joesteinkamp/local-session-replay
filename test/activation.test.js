// Activation rules (src/activation.js) and where the script-tag loader fetches
// testkit-core.js from (src/loader.js), against stubbed browser globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null };
globalThis.location = { search: '' };
const appended = [];
globalThis.document = {
  currentScript: null,
  head: { appendChild: (el) => appended.push(el) },
  createElement: () => ({}),
};
globalThis.window = {};
globalThis.__TESTKIT_VERSION__ = 'test';

const { isActivated, studyOf } = await import('../src/activation.js');

test('query mode activates only with ?test=1', () => {
  location.search = '';
  assert.equal(isActivated({}), false);
  location.search = '?test=1';
  assert.equal(isActivated({}), true);
});

test('?test=0 overrides activate: true', () => {
  location.search = '?test=0';
  assert.equal(isActivated({ activate: true }), false);
});

test('a throwing activate predicate counts as inactive', () => {
  location.search = '';
  assert.equal(isActivated({ activate: () => { throw new Error('boom'); } }), false);
  assert.equal(isActivated({ activate: () => 1 }), true);
});

test('a fresh session for the same study keeps recording across navigation; a stale or other-study one does not', () => {
  location.search = '';
  storage.set('testkit:active:s1', JSON.stringify({ id: 'x', lastActivityAt: Date.now() }));
  assert.equal(isActivated({ study: 's1', activate: false }), true);
  assert.equal(isActivated({ study: 's2', activate: false }), false);
  storage.set('testkit:active:s1', JSON.stringify({ id: 'x', lastActivityAt: Date.now() - 31 * 60 * 1000 }));
  assert.equal(isActivated({ study: 's1', activate: false }), false);
  assert.equal(studyOf({}), 'untitled-study');
});

test('loader fetches testkit-core.js from config.baseUrl when given', async () => {
  location.search = '';
  await import('../src/loader.js');
  window.TestKit.init({ activate: true, baseUrl: 'https://cdn.example/tk' });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, 'https://cdn.example/tk/testkit-core.js');
  window.TestKit.init({ activate: true, baseUrl: 'https://other.example/' });
  assert.equal(appended.length, 1, 'only the first init() counts');
});

// A fresh module instance, evaluated while the URL reads `search` (as on the
// page load where the package is first imported).
let instance = 0;
async function importedAt(search) {
  location.search = search;
  return import(`../src/activation.js?instance=${++instance}`);
}

test('?test=1 seen at first import survives a router redirect that drops it', async () => {
  const mod = await importedAt('?test=1');
  location.search = ''; // beforeLoad redirect: /?test=1 → /signal-report
  assert.equal(mod.isActivated({}), true);
  location.search = '?tab=2'; // SPA navigates on; TestKit mounts much later
  assert.equal(mod.isActivated({}), true, 'one page load = one claim');
});

test('without ?test=1 at first import, a later bare URL stays inactive', async () => {
  const mod = await importedAt('');
  location.search = '';
  assert.equal(mod.isActivated({}), false);
  location.search = '?test=1';
  assert.equal(mod.isActivated({}), true, 'the live URL still counts');
});

test('an explicit ?test=0, in the snapshot or the live URL, wins', async () => {
  const offAtImport = await importedAt('?test=0');
  location.search = '?test=1';
  assert.equal(offAtImport.isActivated({}), false);
  assert.equal(offAtImport.isActivated({ activate: true }), false);
  const onAtImport = await importedAt('?test=1');
  location.search = '?test=0';
  assert.equal(onAtImport.isActivated({}), false);
});

test('the snapshot only feeds query mode', async () => {
  const mod = await importedAt('?test=1');
  location.search = '';
  assert.equal(mod.isActivated({ activate: false }), false);
  assert.equal(mod.isActivated({ activate: () => false }), false);
});

test('module evaluation is SSR-safe (no window, no location)', async () => {
  const saved = { window: globalThis.window, location: globalThis.location };
  delete globalThis.window;
  delete globalThis.location;
  try {
    const mod = await import(`../src/activation.js?ssr=${++instance}`);
    assert.equal(typeof mod.isActivated, 'function');
  } finally {
    Object.assign(globalThis, saved);
  }
});
