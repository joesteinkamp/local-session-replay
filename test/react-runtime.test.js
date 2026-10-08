// <TestKit /> in a real React client render (happy-dom): effects run, so this
// covers what the SSR test can't — props reach boot once, at mount, and a
// failed boot is caught. Boot is injected via the internal createTestKit().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'location']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? win : win[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__TESTKIT_VERSION__ = 'test';

const { act, createElement: h, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createTestKit, TestKit } = await import('../src/react/TestKit.js');

function fakeBoot(impl = async () => {}) {
  const fn = (config) => {
    fn.calls.push(config);
    return impl(config);
  };
  fn.calls = [];
  return fn;
}

async function mount(element) {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(element));
  return {
    rerender: (next) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
}

test('boots once at mount with the first props; rerenders and unmount never re-boot', async () => {
  const boot = fakeBoot();
  const Kit = createTestKit(boot);
  const first = { study: 'first', activate: true, tasks: [{ id: 't', prompt: 'Do it' }] };
  const view = await mount(h(Kit, first));
  assert.equal(boot.calls.length, 1);
  assert.deepEqual(boot.calls[0], first);
  await view.rerender(h(Kit, { study: 'second' }));
  await view.unmount();
  assert.equal(boot.calls.length, 1);
});

test('nothing boots during a server render', () => {
  const boot = fakeBoot();
  assert.equal(renderToString(h(createTestKit(boot), { study: 's', activate: true })), '');
  assert.equal(boot.calls.length, 0);
});

test('a rejected boot is logged, not left unhandled', async () => {
  const errors = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  const consoleError = console.error;
  console.error = (...args) => errors.push(args);
  process.on('unhandledRejection', onUnhandled);
  try {
    await mount(h(createTestKit(fakeBoot(() => Promise.reject(new Error('chunk failed')))), {}));
    await new Promise((resolve) => setTimeout(resolve, 20)); // let rejection tracking run
  } finally {
    console.error = consoleError;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.ok(errors.some(([msg, err]) => msg === '[TestKit] failed to start' && err?.message === 'chunk failed'));
});

test('StrictMode runs the effect twice, and the real boot still claims once', async () => {
  const boot = fakeBoot();
  await mount(h(StrictMode, null, h(createTestKit(boot), {})));
  assert.equal(boot.calls.length, 2, 'React dev StrictMode double-invokes effects');

  let activateCalls = 0;
  const activate = () => { activateCalls += 1; return false; };
  await mount(h(StrictMode, null, h(TestKit, { study: 'strict', activate })));
  assert.equal(activateCalls, 1, 'only the first effect got past claimInit');
  assert.equal(window.__TestKitInitialized, true);
  assert.equal(window.TestKit.version, 'test');
  assert.equal(window.__TestKitCore, undefined, 'inactive: core never imported');
});
