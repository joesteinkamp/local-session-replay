// The player source is prefetched when recording starts and kept in memory,
// so an export still works offline; a failed load is retried at export.
// `virtual:player-bundle` is stubbed with a loader scripted from the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'virtual:player-bundle') return { url: 'data:text/javascript,export const loadPlayerJs = () => globalThis.__loadPlayer()', shortCircuit: true };
      return next(specifier, context);
    }`)}`,
);

const loads = [];
let online = true;
globalThis.__loadPlayer = () => {
  loads.push(online);
  return online ? Promise.resolve('/* player */') : Promise.reject(new Error('Could not load the replay player'));
};

const { exportSession, prefetchPlayer } = await import('../src/export/exporter.js');
const settle = () => new Promise((r) => setTimeout(r, 0));
const data = () => ({
  session: { id: 's', study: 'study', startedAt: 1, endedAt: 2, tasks: [] },
  events: [], log: [], audio: [], audioDropped: [],
});

test('a failed prefetch is silent, and export still reports the error (no cache to fall back on)', async () => {
  online = false;
  prefetchPlayer(); // must not throw or leave an unhandled rejection
  await settle();
  await assert.rejects(exportSession(data()), /Could not load the replay player/);
  assert.equal(loads.length, 2, 'the export retried rather than reusing the failure');
});

test('after a successful prefetch, export works offline from the cache', async () => {
  online = true;
  loads.length = 0;
  prefetchPlayer();
  await settle();
  online = false; // the tester's network goes away
  const { blob } = await exportSession(data());
  assert.ok((await blob.text()).includes('/* player */'));
  prefetchPlayer();
  await exportSession(data());
  assert.deepEqual(loads, [true], 'loaded once, then served from memory');
});
