import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkEvents, elapsedMsFor, flattenEventChunks, groupAudioChunks, sortLog } from '../src/core/store.js';

test('chunkEvents splits on session/segment changes and stamps the first timestamp', () => {
  const pending = [
    { sessionId: 's', segmentId: 'a', event: { timestamp: 10 } },
    { sessionId: 's', segmentId: 'a', event: { timestamp: 11 } },
    { sessionId: 's', segmentId: 'b', event: { timestamp: 12 } },
  ];
  const chunks = chunkEvents(pending);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], { sessionId: 's', segmentId: 'a', ts: 10, events: [{ timestamp: 10 }, { timestamp: 11 }] });
  assert.equal(chunks[1].segmentId, 'b');
});

test('flattenEventChunks sorts by timestamp, stable for ties', () => {
  const events = flattenEventChunks([
    { events: [{ timestamp: 5, n: 'late' }] },
    { events: [{ timestamp: 1, n: 'meta' }, { timestamp: 1, n: 'snapshot' }] },
  ]);
  assert.deepEqual(events.map((e) => e.n), ['meta', 'snapshot', 'late']);
});

test('sortLog orders by ts and strips storage keys', () => {
  const log = sortLog([
    { id: 2, sessionId: 's', ts: 20, type: 'click' },
    { id: 1, sessionId: 's', ts: 10, type: 'nav' },
  ]);
  assert.deepEqual(log, [{ ts: 10, type: 'nav' }, { ts: 20, type: 'click' }]);
});

test('groupAudioChunks stitches each segment in seq order', async () => {
  const blob = (s) => new Blob([s], { type: 'audio/webm' });
  const segments = groupAudioChunks([
    { audioSegmentId: 'b', seq: 0, ts: 9000, startTs: 6000, mime: 'audio/mp4', blob: blob('B0') },
    { audioSegmentId: 'a', seq: 1, ts: 4000, startTs: 1000, mime: 'audio/webm', blob: blob('A1') },
    { audioSegmentId: 'a', seq: 0, ts: 2000, startTs: 1000, mime: 'audio/webm', blob: blob('A0') },
  ]);
  assert.deepEqual(
    segments.map(({ audioSegmentId, startTs, endTs, mime }) => ({ audioSegmentId, startTs, endTs, mime })),
    [
      { audioSegmentId: 'a', startTs: 1000, endTs: 4000, mime: 'audio/webm' },
      { audioSegmentId: 'b', startTs: 6000, endTs: 9000, mime: 'audio/mp4' },
    ],
  );
  assert.equal(await segments[0].blob.text(), 'A0A1');
  assert.equal(segments[1].blob.type, 'audio/mp4');
});

test('elapsedMsFor excludes accumulated and in-progress pauses', () => {
  assert.equal(elapsedMsFor(null), 0);
  assert.equal(elapsedMsFor({ startedAt: 1000, pausedMs: 0 }, 5000), 4000);
  assert.equal(elapsedMsFor({ startedAt: 1000, pausedMs: 1000 }, 5000), 3000);
  assert.equal(elapsedMsFor({ startedAt: 1000, pausedMs: 1000, pausedAt: 4000 }, 5000), 2000);
  assert.equal(elapsedMsFor({ startedAt: 1000, endedAt: 3000, pausedMs: 500 }, 99999), 1500);
});
