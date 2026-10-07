// Controller lifecycle against an in-memory store and fake capture modules
// injected through createController({ deps }). rrweb and the esbuild-only
// player bundle are stubbed by a resolve hook because session.js imports
// them statically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'virtual:player-bundle') return { url: 'data:text/javascript,export default ""', shortCircuit: true };
      if (specifier === 'rrweb') return { url: 'data:text/javascript,export function record() {}', shortCircuit: true };
      return next(specifier, context);
    }`)}`,
);

const noop = () => {};
const windowListeners = {};
globalThis.window = {
  addEventListener: (name, fn) => (windowListeners[name] ||= []).push(fn),
  removeEventListener: noop,
  innerWidth: 800,
  innerHeight: 600,
};
globalThis.document = { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', querySelector: () => null };
globalThis.location = { href: 'https://example.test/p' };
delete globalThis.BroadcastChannel; // no other tabs; an open channel would keep the process alive
const permissions = { state: 'prompt' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node-test', permissions: { query: async () => ({ state: permissions.state }) } },
});

const { createController, STALE_MS } = await import('../src/core/session.js');
const { normalizeConfig } = await import('../src/core/config.js');

const settle = () => new Promise((r) => setTimeout(r, 10));

function memoryStore() {
  const sessions = new Map();
  const log = [];
  const ls = new Map();
  const calls = [];
  let lastChunk = Promise.resolve(null);
  const store = {
    sessions, log, ls, calls,
    setLastChunk: (p) => (lastChunk = p),
    importSpill: async () => calls.push('importSpill'),
    getSession: async (id) => {
      calls.push('getSession');
      return sessions.has(id) ? structuredClone(sessions.get(id)) : null;
    },
    createSession: async (rec) => sessions.set(rec.id, structuredClone(rec)),
    updateSession: async (id, patch) => Object.assign(sessions.get(id), structuredClone(patch)),
    appendEvents: async () => {},
    appendLog: async (id, entry) => log.push({ ...entry, sessionId: id }),
    appendAudio: async () => {},
    lastAudioChunk: () => lastChunk,
    flush: async () => {},
    spill: noop,
    deleteSession: async (id) => sessions.delete(id),
    onError: noop,
    getActivePointer: (study) => JSON.parse(ls.get(`active:${study}`) || 'null'),
    getActiveSessionId: (study) => store.getActivePointer(study)?.id ?? null,
    setActiveSessionId: (study, id, lastActivityAt = Date.now()) => ls.set(`active:${study}`, JSON.stringify({ id, study, lastActivityAt })),
    clearActiveSessionId: (study) => ls.delete(`active:${study}`),
    getLastSessionId: (study) => ls.get(`last:${study}`) ?? null,
    setLastSessionId: (study, id) => ls.set(`last:${study}`, id),
    clearLastSessionId: (study) => ls.delete(`last:${study}`),
    getSessionMirror: () => null,
    setSessionMirror: noop,
    clearSessionMirror: noop,
  };
  return store;
}

function fakeDeps({ micError } = {}) {
  const seen = { recorderConfigs: [], marks: [], acquires: 0, releases: 0, problem: null };
  const deps = {
    createRecorder: ({ config }) => {
      seen.recorderConfigs.push(config);
      let on = false;
      return {
        start: () => (on = true),
        stop: () => (on = false),
        addCustomEvent: (tag, payload) => on && seen.marks.push({ tag, payload }),
        takeFullSnapshot: noop,
        isRecording: () => on,
      };
    },
    createInteractionLog: ({ getTaskId, onEntry, mask }) => {
      seen.mask = mask;
      return {
        start: noop,
        stop: noop,
        flushPending: noop,
        log: (type, fields = {}) => onEntry({ ts: Date.now(), type, url: location.href, taskId: getTaskId(), ...fields }),
      };
    },
    createAudioCapture: ({ onProblem }) => {
      seen.problem = onProblem;
      let live = false;
      let recording = false;
      return {
        acquire: async () => {
          seen.acquires++;
          if (micError) throw micError;
          live = true;
        },
        startSegment: () => (recording = true),
        stopSegment: async () => (recording = false),
        requestData: noop,
        setMuted: noop,
        getLevel: () => 0,
        release: async () => {
          seen.releases++;
          live = false;
          recording = false;
        },
        isLive: () => live,
        isRecording: () => recording,
      };
    },
  };
  return { deps, seen };
}

const config = normalizeConfig({
  study: 'study-a',
  tasks: [{ id: 't1', prompt: 'One' }, { id: 't2', prompt: 'Two' }, { id: 't3', prompt: 'Three' }],
});

async function startSession({ audio = false } = {}) {
  const store = memoryStore();
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config, store, deps });
  await controller.beginPreflight();
  await controller.start({ consent: true, audio });
  return { store, seen, controller };
}

function savedSession(store) {
  return [...store.sessions.values()][0];
}

test('start → next ×3 counts every task and stops', async () => {
  const { store, seen, controller } = await startSession();
  for (let i = 0; i < 3; i++) await controller.nextTask();
  const s = controller.getState();
  assert.equal(s.phase, 'stopped');
  assert.equal(s.tasksCompleted, 3);
  const ends = store.log.filter((e) => e.type === 'task-end');
  assert.deepEqual(ends.map((e) => [e.taskId, e.completed]), [['t1', true], ['t2', true], ['t3', true]]);
  assert.deepEqual(seen.marks.filter((m) => m.tag === 'testkit:task-end').map((m) => m.payload.completed), [true, true, true]);
  assert.equal(store.getActiveSessionId('study-a'), null);
  assert.equal(store.getLastSessionId('study-a'), s.sessionId);
  assert.equal(savedSession(store).phase, 'stopped');
});

test('stop mid-task ends it with completed: false and does not count it', async () => {
  const { store, controller } = await startSession();
  await controller.nextTask();
  await controller.stop();
  const ends = store.log.filter((e) => e.type === 'task-end');
  assert.deepEqual(ends.map((e) => [e.taskId, e.completed]), [['t1', true], ['t2', false]]);
  assert.equal(controller.getState().tasksCompleted, 1);
});

test('nothing is logged after session-end', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  await controller.stop();
  seen.problem('ended'); // e.g. the mic track ends after Stop
  const i = store.log.findIndex((e) => e.type === 'session-end');
  assert.equal(i, store.log.length - 1, store.log.map((e) => e.type).join(','));
});

test('every persist refreshes lastActivityAt on the record and the active pointer', async () => {
  const { store, controller } = await startSession();
  const before = store.getActivePointer('study-a').lastActivityAt;
  await settle();
  await controller.nextTask();
  const after = store.getActivePointer('study-a');
  assert.ok(after.lastActivityAt > before);
  assert.equal(after.study, 'study-a');
  assert.equal(savedSession(store).lastActivityAt, after.lastActivityAt);
  await controller.stop();
});

function seedRecording(store, overrides = {}) {
  const now = Date.now();
  const rec = {
    id: 'old', study: 'study-a', startedAt: now - 60_000, endedAt: null, phase: 'recording',
    taskIndex: 1, taskStartedAt: now - 30_000, tasks: config.tasks, config: structuredClone(config),
    segments: [{ segmentId: 'seg0', url: 'https://example.test/first', startedAt: now - 60_000 }],
    audio: { enabled: false, mime: null }, muted: false, pausedMs: 0, pausedAt: null, tasksCompleted: 1,
    lastActivityAt: now - 1000, rev: 3, ...overrides,
  };
  store.sessions.set(rec.id, rec);
  store.setActiveSessionId('study-a', rec.id, rec.lastActivityAt);
  return rec;
}

test('boot imports the spill before reading the session', async () => {
  const store = memoryStore();
  seedRecording(store);
  const { deps } = fakeDeps();
  const controller = await createController({ config, store, deps });
  assert.equal(store.calls[0], 'importSpill');
  assert.ok(store.calls.indexOf('getSession') > 0);
  await controller.stop();
});

test('a stale active session is stopped at its last activity, not resumed', async () => {
  const store = memoryStore();
  const at = Date.now() - STALE_MS - 60_000;
  seedRecording(store, { lastActivityAt: at, startedAt: at - 60_000, segments: [{ segmentId: 's', url: 'https://example.test/first', startedAt: at - 60_000 }] });
  store.setActiveSessionId('study-a', 'old', at);
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config, store, deps });
  const s = controller.getState();
  assert.equal(s.phase, 'stopped');
  assert.equal(seen.recorderConfigs.length, 0, 'capture must not start');
  assert.equal(store.sessions.get('old').endedAt, at);
  assert.equal(store.getActiveSessionId('study-a'), null);
  assert.equal(store.getLastSessionId('study-a'), 'old');
  const end = store.log.find((e) => e.type === 'session-end');
  assert.deepEqual([end.reason, end.ts], ['stale', at]);
  const taskEnd = store.log.find((e) => e.type === 'task-end');
  assert.deepEqual([taskEnd.taskId, taskEnd.completed], ['t2', false]);
});

test('resume records with the saved session config, not the page config', async () => {
  const store = memoryStore();
  seedRecording(store);
  const page = { ...config, mask: { inputs: false }, checkoutEveryNms: 1, inlineImages: false };
  const { deps, seen } = fakeDeps();
  const controller = await createController({ config: page, store, deps });
  assert.equal(controller.getState().phase, 'recording');
  assert.equal(seen.mask, true);
  assert.equal(seen.recorderConfigs[0].mask.inputs, true);
  assert.equal(seen.recorderConfigs[0].checkoutEveryNms, config.checkoutEveryNms);
  assert.equal(seen.recorderConfigs[0].inlineImages, true);
  await controller.stop();
});

test('a stopped session found under the active pointer gets a last pointer', async () => {
  const store = memoryStore();
  seedRecording(store, { phase: 'stopped', endedAt: Date.now() });
  const { deps } = fakeDeps();
  await createController({ config, store, deps });
  assert.equal(store.getLastSessionId('study-a'), 'old');
  assert.equal(store.getActiveSessionId('study-a'), null);
});

for (const action of ['stop', 'discard']) {
  test(`${action} while the restore awaits lastAudioChunk() never touches the mic`, async () => {
    const store = memoryStore();
    seedRecording(store, { audio: { enabled: true, mime: 'audio/webm' } });
    let release;
    store.setLastChunk(new Promise((r) => (release = r)));
    const { deps, seen } = fakeDeps();
    const controller = await createController({ config, store, deps });
    await controller[action]();
    release(null);
    await settle();
    assert.equal(seen.acquires, 0);
    assert.notEqual(controller.getState().audio.status, 'live');
  });
}

test('a dismissed prompt is retried on the next page; a real denial is not', async () => {
  const denied = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
  for (const [permission, enabledAfter] of [['prompt', true], ['denied', false]]) {
    permissions.state = permission;
    const store = memoryStore();
    seedRecording(store, { audio: { enabled: true, mime: 'audio/webm' } });
    const { deps } = fakeDeps({ micError: denied });
    const controller = await createController({ config, store, deps });
    await settle();
    assert.equal(store.sessions.get('old').audio.enabled, enabledAfter, `permission ${permission}`);
    assert.equal(controller.getState().audio.status, 'denied');
    await controller.stop();
  }
});

test('a bfcache restore into a session paused elsewhere releases the mic', async () => {
  const { store, seen, controller } = await startSession({ audio: true });
  assert.equal(controller.getState().audio.status, 'live');
  // Another page paused the session while this one sat in the bfcache.
  const rec = savedSession(store);
  Object.assign(rec, { phase: 'paused', pausedAt: Date.now(), rev: rec.rev + 10 });
  store.setActiveSessionId('study-a', rec.id);
  const listeners = windowListeners.pageshow;
  listeners[listeners.length - 1]({ persisted: true });
  await settle();
  assert.equal(controller.getState().phase, 'paused');
  assert.ok(seen.releases >= 1, 'mic released');
  assert.notEqual(controller.getState().audio.status, 'live');
  await controller.stop();
});
