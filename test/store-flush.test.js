// flush()/deleteSession() against a scripted fake IndexedDB: the first
// write aborts, so its batch sits in the retry backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const writes = []; // rows that actually committed
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
      delete: () => {},
      get: () => request(undefined),
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
