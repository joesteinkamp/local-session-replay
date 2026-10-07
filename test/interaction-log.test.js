import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionLog, describeError, inputValue } from '../src/core/interaction-log.js';

const input = (type, value, extra = {}) => ({ localName: 'input', type, value, ...extra });

test('inputValue masks typed values but keeps empty and toggle state', () => {
  assert.equal(inputValue(input('text', 'secret'), true), '***');
  assert.equal(inputValue(input('text', ''), true), '');
  assert.equal(inputValue(input('text', 'hello'), false), 'hello');
  assert.equal(inputValue(input('password', 'pw'), false), '***');
  assert.equal(inputValue(input('checkbox', 'on', { checked: true }), true), 'true');
  assert.equal(inputValue(input('text', 'x'.repeat(500)), false).length, 200);
});

test('inputValue masks contenteditable text', () => {
  const editable = { localName: 'div', isContentEditable: true, innerText: 'typed' };
  assert.equal(inputValue(editable, true), '***');
  assert.equal(inputValue(editable, false), 'typed');
});

test('describeError handles errors, strings and objects', () => {
  const err = new Error('boom');
  assert.equal(describeError(err).message, 'boom');
  assert.match(describeError(err).stack, /boom/);
  assert.equal(describeError('plain').message, 'plain');
  assert.equal(describeError({ code: 1 }).message, '{"code":1}');
  assert.equal(describeError(undefined).message, 'undefined');
});

test('log() stamps ts, type, url and taskId, and survives a throwing sink', () => {
  globalThis.location ??= { href: 'https://example.test/p' };
  const entries = [];
  const log = createInteractionLog({ getTaskId: () => 'filter', onEntry: (e) => entries.push(e) });
  const entry = log.log('task-start', { text: 'Go' });
  assert.equal(entry.type, 'task-start');
  assert.equal(entry.taskId, 'filter');
  assert.equal(entry.url, location.href);
  assert.equal(typeof entry.ts, 'number');
  assert.equal(entries.length, 1);
  const throwing = createInteractionLog({ onEntry: () => { throw new Error('sink'); } });
  assert.doesNotThrow(() => throwing.log('pause'));
});
