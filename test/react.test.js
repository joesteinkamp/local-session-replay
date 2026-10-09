// The React entry (src/react/index.js): a server render outputs nothing and
// never touches the browser globals, so Next/Remix pages can render it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';

globalThis.__TESTKIT_VERSION__ = 'test';
const { TestKit, version } = await import('../src/react/index.js');

test('<TestKit /> renders nothing on the server and does not boot', () => {
  assert.equal(typeof window, 'undefined');
  const tasks = [{ id: 'filter', prompt: 'Filter to healthcare companies' }];
  assert.equal(renderToString(createElement(TestKit, { study: 's', activate: true, tasks })), '');
  assert.equal(renderToString(createElement(StrictMode, null, createElement(TestKit))), '');
  assert.equal(typeof window, 'undefined', 'no globals were created');
  assert.equal(version, 'test');
});
