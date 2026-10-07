import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilename, buildHtml, byteLength, escapeHtml, escapeInlineScript, fileStamp, serializePayload, slugify,
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
  assert.ok(html.includes("connect-src 'none'"), 'CSP blocks network egress');
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
  assert.deepEqual(Object.keys(payload).sort(), ['audio', 'events', 'exportedAt', 'log', 'session', 'summaryMarkdown', 'testkitVersion', 'version']);
});
