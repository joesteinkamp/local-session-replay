import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micErrorStatus, pickMimeType, rmsToLevel } from '../src/core/audio.js';

const recorderSupporting = (...types) => ({ isTypeSupported: (t) => types.includes(t) });

test('pickMimeType follows the contract preference order', () => {
  assert.equal(pickMimeType(recorderSupporting('audio/mp4', 'audio/webm;codecs=opus')), 'audio/webm;codecs=opus');
  assert.equal(pickMimeType(recorderSupporting('audio/mp4')), 'audio/mp4');
  assert.equal(pickMimeType(recorderSupporting('audio/ogg;codecs=opus')), 'audio/ogg;codecs=opus');
  assert.equal(pickMimeType(recorderSupporting()), '');
  assert.equal(pickMimeType(undefined), '');
  assert.equal(pickMimeType({ isTypeSupported: () => { throw new Error('x'); } }), '');
});

test('rmsToLevel maps silence to 0 and normal speech into ~0.3–0.8', () => {
  assert.equal(rmsToLevel(0), 0);
  assert.equal(rmsToLevel(NaN), 0);
  assert.ok(rmsToLevel(0.001) < 0.05);
  for (const rms of [0.02, 0.05, 0.1]) {
    const level = rmsToLevel(rms);
    assert.ok(level >= 0.3 && level <= 0.85, `${rms} → ${level}`);
  }
  assert.equal(rmsToLevel(1), 1);
});

test('micErrorStatus distinguishes denial from device problems', () => {
  assert.equal(micErrorStatus({ name: 'NotAllowedError' }).status, 'denied');
  assert.equal(micErrorStatus({ name: 'NotFoundError' }).status, 'error');
  assert.match(micErrorStatus({ name: 'NotReadableError' }).error, /in use/);
  assert.equal(micErrorStatus(new Error('weird')).error, 'weird');
});
