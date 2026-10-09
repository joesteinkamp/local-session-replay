import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilename, buildHtml, buildHtmlBlob, byteLength, escapeHtml, escapeInlineScript, escapeJson, fileStamp, htmlParts,
  payloadParts, serializePayload, slugify,
} from '../src/export/html.js';
import { blobToDataUrl, buildPayload, encodeAudio } from '../src/export/payload.js';

test('slugify produces filename-safe slugs', () => {
  assert.equal(slugify('Checkout Flow — Round 2'), 'checkout-flow-round-2');
  assert.equal(slugify('  Café Über / Test!! '), 'cafe-uber-test');
  assert.equal(slugify(''), 'untitled-study');
  assert.equal(slugify('***'), 'untitled-study');
  assert.ok(slugify('a'.repeat(100)).length <= 60);
  assert.ok(!slugify(`${'a'.repeat(59)} b`).endsWith('-'));
});

test('fileStamp and buildFilename use local time from startedAt', () => {
  const ts = new Date(2026, 0, 2, 3, 4).getTime(); // local time
  assert.equal(fileStamp(ts), '20260102-0304');
  assert.equal(buildFilename({ study: 'My Study', startedAt: ts }), 'testkit-my-study-20260102-0304.html');
  assert.equal(buildFilename({ study: 'My Study', startedAt: ts }, 'json'), 'testkit-my-study-20260102-0304.json');
  assert.equal(buildFilename({ study: 'S', startedAt: null, createdAt: ts }), 'testkit-s-20260102-0304.html');
});

test('escapeHtml escapes markup characters', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('serializePayload escapes every < and line separators, and round-trips', () => {
  const payload = { s: '</script><!-- <b>', ls: 'a b c' };
  const out = serializePayload(payload);
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes(' ') && !out.includes(' '));
  assert.deepEqual(JSON.parse(out), payload);
});

test('escapeInlineScript neutralizes </script in any case and keeps JS equivalent', () => {
  const js = 'var a="</script>";var b=/<\\/Script/u;var c=`</SCRIPT>`;';
  const out = escapeInlineScript(js);
  assert.ok(!/<\/script/i.test(out));
  const ctx = {};
  new Function('ctx', `${out};ctx.a=a;ctx.b=b;ctx.c=c;`)(ctx);
  assert.equal(ctx.a, '</script>');
  assert.equal(ctx.c, '</SCRIPT>');
  assert.ok(ctx.b.test('</Script'));
});

test('buildHtml embeds payload and player safely', () => {
  const payload = { version: 1, testkitVersion: '1.0.0', session: { study: 'A <b>bold</b> study', startedAt: Date.UTC(2026, 9, 6, 14, 5) }, events: [], log: [{ text: '</script><script>alert(1)</script>' }], audio: [], summaryMarkdown: '# x' };
  const html = buildHtml({ payload, playerJs: 'console.log("</script>")' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>TestKit replay: A &lt;b&gt;bold&lt;/b&gt; study (2026-10-06 14:05 UTC)</title>'));
  assert.equal(html.match(/<\/script>/g).length, 2, 'only the two real closing tags');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.startsWith("default-src 'none'"), 'default-deny CSP');
  assert.ok(!/https?:|\*|'self'/.test(csp), 'no network source is allowed anywhere');
  for (const d of ["script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:', 'media-src data: blob:']) {
    assert.ok(csp.includes(d), d);
  }
  assert.ok(html.includes('<link rel="icon" href="data:,">'), 'no favicon request');
  const data = html.match(/<script type="application\/json" id="testkit-data">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(data), payload);
  assert.ok(html.includes('<script>console.log("<\\/script>")</script>'));
});

test('byteLength counts UTF-8 bytes', () => {
  assert.equal(byteLength('abc'), 3);
  assert.equal(byteLength('é'), 2);
  assert.equal(byteLength('—'), 3);
});

test('blobToDataUrl encodes via arrayBuffer in node and prefers the given mime', async () => {
  const blob = new Blob([new Uint8Array([0, 1, 2, 250, 255])], { type: '' });
  assert.equal(await blobToDataUrl(blob, 'audio/webm;codecs=opus'), 'data:audio/webm;codecs=opus;base64,AAEC+v8=');
  assert.equal(await blobToDataUrl(new Blob(['hi'], { type: 'text/plain' })), 'data:text/plain;base64,aGk=');
});

test('blobToDataUrl handles large blobs without overflowing the call stack', async () => {
  const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
  const url = await blobToDataUrl(new Blob([bytes]), 'audio/mp4');
  const decoded = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(decoded.length, bytes.length);
  assert.equal(decoded[299_999], 299_999 % 256);
});

test('encodeAudio keeps existing dataUrls, drops empties, sorts by startTs', async () => {
  const out = await encodeAudio([
    { audioSegmentId: 'b', startTs: 20, endTs: 30, mime: 'audio/mp4', blob: new Blob([new Uint8Array([1])]) },
    { audioSegmentId: 'a', startTs: 10, endTs: 15, mime: 'audio/webm', dataUrl: 'data:audio/webm;base64,AA==' },
    { audioSegmentId: 'c', startTs: 5, endTs: 6, mime: 'audio/webm' },
    null,
  ]);
  assert.deepEqual(out.map((s) => s.audioSegmentId), ['a', 'b']);
  assert.equal(out[0].dataUrl, 'data:audio/webm;base64,AA==');
  assert.equal(out[1].dataUrl, 'data:audio/mp4;base64,AQ==');
  assert.ok(!('blob' in out[1]));
});

test('buildPayload matches the export contract', async () => {
  const session = { id: 's', study: 'S', startedAt: 1000, endedAt: 5000, tasks: [] };
  const payload = await buildPayload({ session, events: [{ type: 4, timestamp: 1000 }], log: [], audio: [] }, { testkitVersion: '1.0.0', now: 42 });
  assert.equal(payload.version, 1);
  assert.equal(payload.testkitVersion, '1.0.0');
  assert.equal(payload.exportedAt, 42);
  assert.equal(payload.session, session);
  assert.deepEqual(payload.audio, []);
  assert.match(payload.summaryMarkdown, /^# TestKit session: S/);
  assert.deepEqual(Object.keys(payload).sort(), ['audio', 'audioDropped', 'audioOmitted', 'events', 'exportedAt', 'log', 'omittedAudio', 'session', 'summaryMarkdown', 'testkitVersion', 'version']);
});

const naive = (payload) => escapeJson(JSON.stringify(payload));

test('payloadParts joined equals escaped JSON.stringify, for any chunk size', () => {
  const payload = {
    version: 1,
    session: { study: 'x</script>', tasks: [] },
    events: Array.from({ length: 50 }, (_, i) => ({ type: 3, timestamp: i, data: { text: `<b>${i}</b>\u2028`, skip: undefined } })),
    log: [{ ts: 1, type: 'click', text: '<!--' }, undefined],
    audio: [
      { audioSegmentId: 'a', startTs: 1, endTs: 2, mime: 'audio/webm', dataUrl: 'data:audio/webm;codecs=opus;base64,AAEC+v8=' },
      { audioSegmentId: 'b', startTs: 3, endTs: 4, mime: null, dataUrl: 'data:text/plain,<odd>"' },
      { dataUrl: null },
    ],
    summaryMarkdown: '# <h1>',
    dropped: undefined,
  };
  for (const partChars of [1, 7, 100, 1e9]) {
    const parts = [...payloadParts(payload, { partChars })];
    assert.equal(parts.join(''), naive(payload), `partChars=${partChars}`);
    for (const part of parts) assert.ok(!part.includes('<'), 'every part is escaped on its own');
  }
  assert.deepEqual(JSON.parse(serializePayload(payload)), JSON.parse(JSON.stringify(payload)));
});

test('payloadParts splits events into bounded chunks and emits audio data URLs verbatim', () => {
  const dataUrl = `data:audio/webm;base64,${'A'.repeat(50_000)}`;
  const payload = { version: 1, events: Array.from({ length: 1000 }, (_, i) => ({ i, pad: 'x'.repeat(100) })), audio: [{ audioSegmentId: 'a', dataUrl }] };
  const parts = [...payloadParts(payload, { partChars: 10_000 })];
  const eventParts = parts.filter((p) => p.includes('"pad"'));
  assert.ok(eventParts.length >= 10);
  assert.ok(eventParts.every((p) => p.length < 10_000 + 200));
  assert.ok(parts.some((p) => p === dataUrl), 'data URL is its own part, not re-stringified');
  assert.equal(parts.join(''), naive(payload));
});

test('buildHtmlBlob matches buildHtml byte for byte', async () => {
  const payload = { version: 1, session: { study: 'S', startedAt: 0 }, events: [{ a: '<x>' }], log: [], audio: [], summaryMarkdown: 'm' };
  const html = buildHtml({ payload, playerJs: 'void "</script>"' });
  const { blob } = buildHtmlBlob({ payload, playerJs: 'void "</script>"', flushChars: 16 });
  assert.equal(blob.type, 'text/html;charset=utf-8');
  assert.equal(blob.size, byteLength(html));
  assert.equal(await blob.text(), html);
  assert.equal([...htmlParts({ payload, playerJs: '' })].join('').match(/<\/script>/g).length, 2);
});

test('large session: ~150 MB payload exports as a Blob without one giant string', async () => {
  // 150 snapshot-like events of ~1 MB each (inlined-image sized).
  const blobChars = 1024 * 1024;
  const events = Array.from({ length: 150 }, (_, i) => ({ type: 2, timestamp: i, data: { img: `data:image/png;base64,${String.fromCharCode(65 + (i % 26)).repeat(blobChars)}` } }));
  const audio = [{ audioSegmentId: 'a', startTs: 0, endTs: 1, mime: 'audio/webm', dataUrl: `data:audio/webm;base64,${'Q'.repeat(10 * blobChars)}` }];
  const payload = { version: 1, session: { study: 'Big', startedAt: 0 }, events, log: [], audio, summaryMarkdown: '' };
  const payloadChars = 160 * blobChars;
  global.gc?.();
  const before = process.memoryUsage();
  const { blob, largestPart } = buildHtmlBlob({ payload, playerJs: 'void 0' });
  const after = process.memoryUsage();
  assert.ok(blob.size > payloadChars, `blob ${blob.size}`);
  // No part bigger than the largest single item (the 10 MB audio data URL).
  assert.ok(largestPart <= 10 * blobChars + 64, `largest part ${largestPart}`);
  const grew = (after.rss - before.rss) / payloadChars;
  assert.ok(grew < 3, `rss grew ${grew.toFixed(2)}× the payload`);
  // Round-trip the tail only, to keep the test's own memory modest.
  const tail = await blob.slice(blob.size - 200).text();
  assert.ok(tail.endsWith('</script>\n</body>\n</html>\n'));
});

test('buildPayload: audio that cannot be encoded raises AudioExportError; withoutAudio builds the visual-only file', async () => {
  const { AudioExportError, AUDIO_EXPORT_FAILED } = await import('../src/export/payload.js');
  const broken = { arrayBuffer: async () => { throw new RangeError('Invalid string length'); }, type: 'audio/webm', size: 1 };
  const data = { session: { study: 'S', startedAt: 0, endedAt: 10_000, audio: { enabled: true } }, events: [], log: [], audio: [{ audioSegmentId: 'a', startTs: 0, endTs: 10_000, mime: 'audio/webm', blob: broken }] };
  await assert.rejects(buildPayload(data), (err) => err instanceof AudioExportError && err.message === AUDIO_EXPORT_FAILED);
  const visual = await buildPayload(data, { withoutAudio: true });
  assert.deepEqual(visual.audio, []);
  assert.equal(visual.audioOmitted, true);
  assert.deepEqual(visual.omittedAudio, [{ audioSegmentId: 'a', startTs: 0, endTs: 10_000, mime: 'audio/webm' }], 'metadata kept for the player');
  assert.match(visual.summaryMarkdown, /- Audio saved: Audio recorded\n/);
  assert.match(visual.summaryMarkdown, /left out of this file/);
});

test('60 minutes of audio at the default bitrate (≈14.4 MB) assembles into an export', async () => {
  const bytes = new Uint8Array(3600 * 4000).map((_, i) => i & 255);
  const payload = await buildPayload({ session: { study: 'Long', startedAt: 0, endedAt: 3_600_000, audio: { enabled: true } }, events: [{ type: 4, timestamp: 0 }], log: [], audio: [{ audioSegmentId: 'a', startTs: 0, endTs: 3_600_000, mime: 'audio/webm', blob: new Blob([bytes]) }] });
  const { blob } = buildHtmlBlob({ payload, playerJs: '' });
  assert.ok(blob.size > bytes.length * 4 / 3, `${blob.size}`);
});
