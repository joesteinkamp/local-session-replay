// Assembles the self-contained export HTML. Pure (no DOM, no bundle import) so
// it runs under node:test.

export function slugify(text) {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'untitled-study';
}

const pad = (n) => String(n).padStart(2, '0');

// Local time, matching what the facilitator saw on their clock.
export function fileStamp(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function buildFilename(session = {}, ext = 'html') {
  const ts = session.startedAt ?? session.createdAt;
  return `testkit-${slugify(session.study)}-${fileStamp(ts)}.${ext}`;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Every '<' becomes \u003c so no '</script' or '<!--' can end the data block;
// U+2028/2029 are escaped for parsers that predate JSON ⊂ ECMAScript. The
// rules are per character, so escaping each part on its own is exact.
export function escapeJson(json) {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Target size (chars) for one serialized chunk of a large array. A single
// item larger than this (e.g. a full snapshot with inlined images) becomes
// its own part; nothing bigger than one item is ever built.
export const PART_CHARS = 4 * 1024 * 1024;
const CHUNKED_ARRAYS = new Set(['events', 'log']);
// Characters a base64 data URL can contain; none need JSON or HTML escaping.
const SAFE_DATA_URL = /^data:[A-Za-z0-9+/=:;,._-]*$/;

function* arrayParts(items, partChars) {
  yield '[';
  let batch = [];
  let size = 0;
  for (let i = 0; i < items.length; i++) {
    const json = JSON.stringify(items[i]) ?? 'null';
    batch.push(json);
    size += json.length + 1;
    if (size >= partChars) {
      yield `${i + 1 > batch.length ? ',' : ''}${escapeJson(batch.join(','))}`;
      batch = [];
      size = 0;
    }
  }
  if (batch.length) yield `${items.length > batch.length ? ',' : ''}${escapeJson(batch.join(','))}`;
  yield ']';
}

// Audio data URLs are the largest strings; emit them verbatim between quotes
// instead of re-stringifying (which would copy them again).
function* audioParts(segments) {
  yield '[';
  for (let i = 0; i < segments.length; i++) {
    const { dataUrl, ...rest } = segments[i] || {};
    const head = escapeJson(JSON.stringify(rest)).slice(0, -1);
    yield `${i ? ',' : ''}${head}${head.length > 1 ? ',' : ''}"dataUrl":`;
    if (typeof dataUrl === 'string' && SAFE_DATA_URL.test(dataUrl)) {
      yield '"';
      yield dataUrl;
      yield '"}';
    } else {
      yield `${escapeJson(JSON.stringify(dataUrl ?? null))}}`;
    }
  }
  yield ']';
}

// The payload as escaped JSON text, in parts. Joining the parts equals
// escapeJson(JSON.stringify(payload)).
export function* payloadParts(payload, { partChars = PART_CHARS } = {}) {
  yield '{';
  let first = true;
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || typeof value === 'function') continue;
    yield `${first ? '' : ','}${escapeJson(JSON.stringify(key))}:`;
    first = false;
    if (CHUNKED_ARRAYS.has(key) && Array.isArray(value)) yield* arrayParts(value, partChars);
    else if (key === 'audio' && Array.isArray(value)) yield* audioParts(value);
    else yield escapeJson(JSON.stringify(value));
  }
  yield '}';
}

export function serializePayload(payload) {
  return [...payloadParts(payload)].join('');
}

// Neutralizes '</script' so the inline bundle cannot close its own element.
// '<\/' is equivalent inside strings, templates, and regexes (even /u ones).
// esbuild already escapes this in string literals; this is a backstop.
export function escapeInlineScript(js) {
  return String(js).replace(/<\/(script)/gi, '<\\/$1');
}

// Default-deny: the file may not fetch anything. Inline script/style run the
// player and rebuild the replay; data:/blob: carry inlined images, fonts, and
// audio. Remote assets the recording did not inline are deliberately blocked
// (local-only beats fidelity); the player reports how many. The replay iframe
// is about:blank, which inherits this policy and needs no frame-src.
export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function htmlHead(payload) {
  const session = payload.session || {};
  const study = session.study || 'untitled-study';
  const when = Number.isFinite(session.startedAt) ? new Date(session.startedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
  const title = `TestKit replay: ${study}${when ? ` (${when} UTC)` : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="generator" content="TestKit${payload.testkitVersion ? ` ${escapeHtml(payload.testkitVersion)}` : ''}">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
</head>
<body>
<noscript>This TestKit replay needs JavaScript. Open it in a desktop browser with scripts enabled.</noscript>
<div id="testkit-app"></div>
<script type="application/json" id="testkit-data">`;
}

// The export file as a sequence of strings; no part is larger than one
// payload item or the player bundle.
export function* htmlParts({ payload, playerJs, partChars }) {
  yield htmlHead(payload);
  yield* payloadParts(payload, { partChars });
  yield '</script>\n<script>';
  yield escapeInlineScript(playerJs);
  yield '</script>\n</body>\n</html>\n';
}

export function buildHtml({ payload, playerJs }) {
  return [...htmlParts({ payload, playerJs })].join('');
}

// Folds parts into a Blob every ~flushChars so the strings can be collected
// as we go; browsers compose Blobs by reference, so peak memory stays near
// the payload objects plus one flush window plus the Blob itself.
export function buildHtmlBlob({ payload, playerJs, partChars, flushChars = 32 * 1024 * 1024 }) {
  const type = 'text/html;charset=utf-8';
  let blob = new Blob([], { type });
  let pending = [];
  let size = 0;
  let largestPart = 0;
  for (const part of htmlParts({ payload, playerJs, partChars })) {
    pending.push(part);
    size += part.length;
    largestPart = Math.max(largestPart, part.length);
    if (size >= flushChars) {
      blob = new Blob([blob, ...pending], { type });
      pending = [];
      size = 0;
    }
  }
  if (pending.length) blob = new Blob([blob, ...pending], { type });
  return { blob, largestPart };
}

export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}
