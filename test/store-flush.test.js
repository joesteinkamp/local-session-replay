// flush()/deleteSession() against a scripted fake IndexedDB: the first
// write aborts, so its batch sits in the retry backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const writes = []; // rows that actually committed
const rows = new Map(); // committed rows by store + key (put semantics)
const sessions = new Map();
let abortNext = 0;

function request(result) {
  const req = { result };
  queueMicrotask(() => req.onsuccess?.({ target: req }));
  return req;
}

function fakeTx(names) {
  const staged = [];
  const tx = {
    error: null,
    objectStore: (name) => ({
      add: (row) => staged.push({ name, row }),
      put: (row) => staged.push({ name, row }),
      delete: () => {},
      get: (key) => request(name === 'sessions' ? sessions.get(key) : undefined),
      index: () => ({ getAll: () => request([]), getAllKeys: () => request([]) }),
    }),
    abort() {},
    commit() {},
  };
  setTimeout(() => {
    if (staged.length && abortNext > 0) {
      abortNext--;
      tx.error = new Error('transient');
      tx.onabort?.();
      return;
    }
    writes.push(...staged);
    for (const { name, row } of staged) if (row.id !== undefined) rows.set(`${name}/${row.id}`, row);
    tx.oncomplete?.();
  }, 5);
  return tx;
}

globalThis.IDBKeyRange = { only: (v) => v };
globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = { objectStoreNames: { contains: () => true }, transaction: fakeTx, close() {} };
      req.onsuccess();
    });
    return req;
  },
};

const store = await import('../src/core/store.js');
await store.openStore();

test('a later flush() waits for an earlier batch stuck in retry backoff', async () => {
  writes.length = 0;
  abortNext = 1;
  store.appendLog('s1', { ts: 1, type: 'click' });
  store.flush(); // first attempt aborts → retry in 250 ms
  await new Promise((r) => setTimeout(r, 20));
  await store.flush();
  assert.equal(writes.filter((w) => w.row.sessionId === 's1').length, 1);
});

test('deleteSession() tombstones the id so a pending retry writes nothing', async () => {
  writes.length = 0;
  abortNext = 1;
  store.appendLog('s2', { ts: 1, type: 'click' });
  store.flush();
  await new Promise((r) => setTimeout(r, 20));
  await store.deleteSession('s2');
  await new Promise((r) => setTimeout(r, 400)); // past any backoff
  assert.equal(writes.filter((w) => w.row.sessionId === 's2').length, 0);
});

test('spill() + importSpill() restores unflushed rows exactly once', async () => {
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  // Object.keys(sessionStorage) must list stored keys, like the real Storage.
  globalThis.sessionStorage = new Proxy(globalThis.sessionStorage, {
    ownKeys: () => [...storage.keys()],
    getOwnPropertyDescriptor: (t, k) => (storage.has(k) ? { enumerable: true, configurable: true, value: storage.get(k) } : Reflect.getOwnPropertyDescriptor(t, k)),
  });
  sessions.set('s3', { id: 's3' });
  rows.clear();
  // pagehide: the IDB write commits AND the rows are spilled (the worst case for duplicates).
  store.appendLog('s3', { ts: 1, type: 'click' });
  store.appendEvents('s3', 'seg', [{ type: 3, timestamp: 1 }]);
  store.flush();
  store.spill();
  assert.ok(storage.has('testkit:spill:s3'));
  await store.flush();
  const imported = await store.importSpill();
  assert.equal(imported, 2);
  assert.equal(storage.has('testkit:spill:s3'), false, 'spill removed after import');
  const keys = [...rows.keys()].filter((k) => rows.get(k).sessionId === 's3');
  assert.equal(keys.length, 2, `rows deduplicated by key: ${keys.join(', ')}`);
});

test('importSpill() skips sessions that no longer exist', async () => {
  globalThis.sessionStorage.setItem('testkit:spill:gone', JSON.stringify({ events: [], log: [{ id: 'x:l0', sessionId: 'gone', ts: 1, type: 'click' }] }));
  rows.clear();
  await store.importSpill();
  assert.equal([...rows.values()].filter((r) => r.sessionId === 'gone').length, 0);
});

// The real write path: 14 entries in one millisecond, then a second batch in
// the same millisecond whose random id sorts first. Read back in IndexedDB key
// order (string compare), the export order must still be the append order.
test('log rows written in one millisecond come back in append order', async () => {
  sessions.set('s5', { id: 's5' });
  rows.clear();
  const realUUID = crypto.randomUUID;
  const ids = ['zzzz', 'aaaa'];
  crypto.randomUUID = () => ids.shift() ?? realUUID.call(crypto);
  try {
    for (let i = 0; i < 14; i++) store.appendLog('s5', { ts: 1000, type: 'click', selector: `#b${String(i).padStart(2, '0')}` });
    await store.flush();
    store.appendLog('s5', { ts: 1000, type: 'nav', navType: 'pushState' });
    await store.flush();
  } finally {
    crypto.randomUUID = realUUID;
  }
  const stored = [...rows.entries()].filter(([k, r]) => k.startsWith('log/') && r.sessionId === 's5').map(([, r]) => r);
  stored.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.notEqual(stored[0].type, 'click', 'key order alone would misplace the nav (precondition)');
  const log = store.sortLog(stored);
  assert.deepEqual(log.map((e) => e.selector ?? e.type), [...Array.from({ length: 14 }, (_, i) => `#b${String(i).padStart(2, '0')}`), 'nav']);
});
