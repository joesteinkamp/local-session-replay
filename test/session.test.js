// Controller lifecycle regressions that don't need a browser. rrweb and the
// esbuild-only player bundle are stubbed via a module resolve hook; the
// store and browser APIs are minimal fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const RRWEB_STUB = 'export function record() { return () => {}; } record.addCustomEvent = () => {}; record.takeFullSnapshot = () => {};';
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'virtual:player-bundle') return { url: 'data:text/javascript,export default ""', shortCircuit: true };
      if (specifier === 'rrweb') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(RRWEB_STUB)}), shortCircuit: true };
      return next(specifier, context);
    }`)}`,
);

const noop = () => {};
const target = () => ({ addEventListener: noop, removeEventListener: noop });
globalThis.window = { ...target(), innerWidth: 800, innerHeight: 600 };
const docHandlers = {};
globalThis.document = {
  addEventListener: (name, fn) => (docHandlers[name] = fn),
  removeEventListener: noop,
  referrer: '',
  visibilityState: 'visible',
  querySelector: () => null,
};
globalThis.location = { href: 'https://example.test/page' };
globalThis.history = { pushState: noop, replaceState: noop };
delete globalThis.BroadcastChannel; // nothing to coordinate with, and it would keep the process alive

const mic = { calls: 0, stops: 0, pending: null };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'node-test',
    mediaDevices: {
      getUserMedia() {
        mic.calls++;
        const track = { readyState: 'live', enabled: true, addEventListener: noop, stop() { mic.stops++; this.readyState = 'ended'; } };
        const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
        return new Promise((resolve) => (mic.pending = () => resolve(stream)));
      },
    },
  },
});

const { createController } = await import('../src/core/session.js');
const { normalizeConfig } = await import('../src/core/config.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  Object.assign(mic, { calls: 0, stops: 0, pending: null });
  const config = normalizeConfig({ study: 'study-a', tasks: [{ id: 't1', prompt: 'Do it' }] });
  const rec = {
    id: 's1', study: 'study-a', startedAt: Date.now() - 5000, endedAt: null, phase: 'recording',
    taskIndex: 0, taskStartedAt: Date.now() - 5000, tasks: config.tasks, config: JSON.parse(JSON.stringify(config)),
    segments: [{ segmentId: 'seg0', url: location.href, startedAt: Date.now() - 5000 }],
    audio: { enabled: true, mime: 'audio/webm' }, muted: false, pausedMs: 0, pausedAt: null, tasksCompleted: 0, rev: 1,
  };
  const lastChunk = deferred();
  const log = [];
  const store = {
    getActiveSessionId: (study) => (study === rec.study ? rec.id : null),
    getLastSessionId: () => null,
    getSession: async () => structuredClone(rec),
    updateSession: async (id, patch) => Object.assign(rec, patch),
    appendEvents: async () => {},
    appendLog: async (id, entry) => log.push(entry),
    appendAudio: async () => {},
    lastAudioChunk: () => lastChunk.promise,
    flush: async () => {},
    deleteSession: async () => {},
    getSessionMirror: () => null,
    setSessionMirror: noop, clearSessionMirror: noop,
    setActiveSessionId: noop, clearActiveSessionId: noop, setLastSessionId: noop, clearLastSessionId: noop,
  };
  return { config, rec, store, lastChunk, log };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

for (const action of ['stop', 'discard']) {
  test(`${action} during a pending lastAudioChunk() never acquires the mic`, async () => {
    const { config, store, lastChunk } = setup();
    const controller = await createController({ config, store });
    assert.equal(controller.getState().phase, 'recording');
    await controller[action]();
    lastChunk.resolve(null);
    await settle();
    assert.equal(mic.calls, 0);
    assert.notEqual(controller.getState().audio.status, 'live');
  });

  test(`${action} while getUserMedia is pending releases the late stream`, async () => {
    const { config, store, lastChunk } = setup();
    const controller = await createController({ config, store });
    lastChunk.resolve(null);
    await settle();
    assert.equal(mic.calls, 1, 'restore should be waiting on getUserMedia');
    await controller[action]();
    mic.pending();
    await settle();
    assert.equal(mic.stops, 1, 'late stream must be stopped');
    assert.notEqual(controller.getState().audio.status, 'live');
  });
}

test('stop mid-task logs task-end with completed: false', async () => {
  const { config, store, lastChunk, log } = setup();
  const controller = await createController({ config, store });
  lastChunk.resolve(null);
  await controller.stop();
  mic.pending?.();
  await settle();
  const end = log.find((e) => e.type === 'task-end');
  assert.equal(end.completed, false);
});

test("a page from another study doesn't resume the session", async () => {
  const { store } = setup();
  const other = normalizeConfig({ study: 'study-b' });
  const controller = await createController({ config: other, store });
  assert.equal(controller.getState().phase, 'idle');
});

test('resume uses the saved session config, not the page config', async () => {
  const { config, rec, store, lastChunk, log } = setup();
  rec.config.mask.inputs = true;
  const loose = { ...config, mask: { inputs: false }, audio: { enabled: false, bitrate: 1 } };
  const controller = await createController({ config: loose, store });
  // Saved config keeps audio on, so the restore still asks for the mic.
  lastChunk.resolve(null);
  await settle();
  assert.equal(mic.calls, 1);
  const field = { nodeType: 1, localName: 'input', type: 'text', value: 'private', getAttribute: () => null, closest: () => null };
  docHandlers.input({ target: field, composedPath: () => [field] });
  await controller.stop(); // flushes the debounced input
  mic.pending();
  await settle();
  const input = log.find((e) => e.type === 'input');
  assert.equal(input?.value, '***', 'saved mask.inputs: true must win over the page config');
});
