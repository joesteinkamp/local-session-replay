// Assembles the self-contained export HTML. Pure (no DOM, no bundle import) so
// it runs under node:test.

export function slugify(text) {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
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

// Every '<' becomes < so no '</script' or '<!--' can end the data block;
// U+2028/2029 are escaped for parsers that predate JSON ⊂ ECMAScript.
export function serializePayload(payload) {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Neutralizes '</script' so the inline bundle cannot close its own element.
// '<\/' is equivalent inside strings, templates, and regexes (even /u ones).
// esbuild already escapes this in string literals; this is a backstop.
export function escapeInlineScript(js) {
  return String(js).replace(/<\/(script)/gi, '<\\/$1');
}

// connect-src 'none' guarantees the exported file cannot phone home, while
// still letting the replay load the prototype's own images and fonts.
const CSP = "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function buildHtml({ payload, playerJs }) {
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
<title>${escapeHtml(title)}</title>
</head>
<body>
<noscript>This TestKit replay needs JavaScript. Open it in a desktop browser with scripts enabled.</noscript>
<div id="testkit-app"></div>
<script type="application/json" id="testkit-data">${serializePayload(payload)}</script>
<script>${escapeInlineScript(playerJs)}</script>
</body>
</html>
`;
}

export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}
