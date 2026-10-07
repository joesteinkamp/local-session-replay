// The package entry (src/index.js): safe on the server, and never loads the
// recorder when inactive.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__TESTKIT_VERSION__ = 'test';
const { init, version } = await import('../src/index.js');

test('init() is a no-op during server rendering', async () => {
  assert.equal(typeof window, 'undefined');
  await init({ activate: true });
  assert.equal(version, 'test');
});

test('inactive init() exposes window.TestKit without booting the recorder', async () => {
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => null };
  globalThis.location = { search: '' };
  await init({});
  assert.equal(window.TestKit.version, 'test');
  assert.equal(window.__TestKitCore, undefined, 'core was not imported');
});

test('only the first init() on the page counts, whichever copy calls it', async () => {
  location.search = '?test=1';
  await init({}); // would import core (and rrweb) if it ran
  assert.equal(window.__TestKitCore, undefined);
});
