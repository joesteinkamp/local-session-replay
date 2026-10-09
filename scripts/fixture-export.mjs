// Writes a synthetic exported session for checking the player by hand.
// Usage: node scripts/fixture-export.mjs [outDir]   (default: $TMPDIR/testkit-fixture)
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { buildPayload } from '../src/export/payload.js';
import { buildFilename, buildHtmlBlob } from '../src/export/html.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'testkit-fixture'));
await mkdir(outDir, { recursive: true });

const playerFile = path.join(outDir, 'testkit-player.js');
await esbuild.build({
  entryPoints: [path.join(root, 'src/player/player.js')],
  outfile: playerFile,
  bundle: true,
  format: 'iife',
  minify: true,
  legalComments: 'none',
  loader: { '.css': 'text', '.woff2': 'base64' },
  logLevel: 'warning',
});
const playerJs = await readFile(playerFile, 'utf8');

// ---------- synthetic rrweb stream ----------

const T0 = Date.UTC(2026, 9, 6, 14, 0, 0);
const at = (s) => T0 + Math.round(s * 1000);
const BASE = 'https://prototypes.example.gitlab.io/checkout/';

let nextId = 1;
const el = (tagName, attributes = {}, childNodes = []) => ({ type: 2, tagName, attributes, childNodes, id: nextId++ });
const text = (textContent) => ({ type: 3, textContent, id: nextId++ });

const CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#1a1a1a}
header{background:#1e3a8a;color:#fff;padding:16px 32px}main{padding:32px;max-width:720px}
label{display:block;margin:16px 0 4px}input{font:inherit;padding:8px;width:280px;border:1px solid #888;border-radius:6px}
button{font:inherit;padding:8px 16px;margin-top:12px;border:0;border-radius:6px;background:#2563eb;color:#fff}
ul{padding-left:20px}li{margin:6px 0}a{color:#1d4ed8}
@font-face{font-family:Brand;src:url(https://fonts.example.com/brand.woff2) format('woff2')}
header{background-image:url("https://cdn.example.com/hero.png")}`;

function page(title, bodyChildren) {
  nextId = 1;
  const ids = {};
  const docId = nextId++;
  const doctype = { type: 1, name: 'html', publicId: '', systemId: '', id: nextId++ };
  const styleText = text(CSS);
  styleText.isStyle = true;
  // Remote assets the recorder could not inline; the export must not fetch them.
  const head = el('head', {}, [el('meta', { charset: 'utf-8' }), el('title', {}, [text(title)]), el('style', {}, [styleText]),
    el('link', { rel: 'stylesheet', href: 'https://cdn.example.com/theme.css' })]);
  const body = el('body', {}, bodyChildren(ids));
  const html = el('html', { lang: 'en' }, [head, body]);
  return { node: { type: 0, childNodes: [doctype, html], id: docId }, ids };
}

function indexPage() {
  return page('Checkout prototype', (ids) => {
    const search = el('input', { id: 'search', type: 'text', placeholder: 'Search products', value: '' });
    const apply = el('button', { id: 'apply', type: 'button' }, [text('Apply')]);
    const resultText = text('12 results');
    const results = el('p', { id: 'results' }, [resultText]);
    const aboutLink = el('a', { href: `${BASE}about.html` }, [text('About this store')]);
    Object.assign(ids, { search: search.id, apply: apply.id, resultText: resultText.id, about: aboutLink.id });
    return [
      el('header', {}, [el('h1', {}, [text('Acme Outfitters')])]),
      el('main', {}, [
        el('h2', {}, [text('Find a jacket')]),
        el('label', { for: 'search' }, [text('Search')]),
        search,
        el('br'),
        apply,
        results,
        el('ul', {}, ['Trail Shell', 'Down Parka', 'Rain Jacket'].map((t) => el('li', {}, [text(t)]))),
        el('img', { src: 'https://example.com/x.png', alt: 'Featured jacket', width: '120', height: '80' }),
        el('p', {}, [aboutLink]),
      ]),
    ];
  });
}

function aboutPage() {
  return page('About', (ids) => {
    const back = el('a', { href: BASE }, [text('Back to products')]);
    ids.back = back.id;
    return [
      el('header', {}, [el('h1', {}, [text('About Acme')])]),
      el('main', {}, [el('p', {}, [text('We make outerwear for wet places.')]), el('p', {}, [back])]),
    ];
  });
}

const W = 1280;
const H = 800;
const events = [];
const meta = (s, href) => events.push({ type: 4, data: { href, width: W, height: H }, timestamp: at(s) });
const full = (s, node) => events.push({ type: 2, data: { node, initialOffset: { left: 0, top: 0 } }, timestamp: at(s) });
const inc = (s, data) => events.push({ type: 3, data, timestamp: at(s) });
const custom = (s, tag, payload = {}) => events.push({ type: 5, data: { tag, payload }, timestamp: at(s) });
const move = (s, id, x, y) => inc(s, { source: 1, positions: [{ x, y, id, timeOffset: 0 }] });
const click = (s, id, x, y) => {
  inc(s, { source: 2, type: 1, id, x, y });
  inc(s + 0.05, { source: 2, type: 0, id, x, y });
  inc(s + 0.1, { source: 2, type: 2, id, x, y });
};
const typing = (s, id, value) => [...value].forEach((_, i) => inc(s + i * 0.15, { source: 5, text: '*'.repeat(i + 1), isChecked: false, id }));

const p1 = indexPage();
meta(0, BASE);
full(0.01, p1.node);
custom(1, 'testkit:task-start', { taskId: 'find-jacket', index: 0, prompt: 'Find a rain jacket under $150' });
for (let s = 1.5; s < 4; s += 0.25) move(s, p1.ids.search, 200 + s * 40, 180 + s * 10);
click(4, p1.ids.search, 300, 210);
typing(4.5, p1.ids.search, 'rain jacket');
for (let s = 7; s < 9; s += 0.25) move(s, p1.ids.apply, 300 - (s - 7) * 60, 260);
click(9, p1.ids.apply, 210, 270);
inc(9.4, { source: 0, texts: [{ id: p1.ids.resultText, value: '0 results' }], attributes: [], removes: [], adds: [] });
click(20, p1.ids.apply, 212, 271);
click(20.3, p1.ids.apply, 213, 270);
click(20.6, p1.ids.apply, 211, 272);
// Reading: pointer drifts, nothing logged, so the summary flags idle with activity.
for (let s = 22; s < 48; s += 1) move(s, p1.ids.resultText, 220 + (s % 7) * 30, 300 + (s % 5) * 20);
custom(55, 'testkit:task-end', { taskId: 'find-jacket', index: 0, completed: true });
custom(56, 'testkit:pause');
custom(70, 'testkit:resume');
custom(71, 'testkit:task-start', { taskId: 'about', index: 1, prompt: 'Find out where Acme is based' });
move(71.5, p1.ids.about, 260, 520);
click(72, p1.ids.about, 260, 525);

const p2 = aboutPage();
meta(73, `${BASE}about.html`);
full(73.01, p2.node);
for (let s = 74; s < 82; s += 0.5) move(s, p2.ids.back, 300 + s, 240);
click(84, p2.ids.back, 330, 250);

const p3 = indexPage();
meta(85, BASE);
full(85.01, p3.node);
for (let s = 85.5; s < 88; s += 0.5) move(s, p3.ids.apply, 400, 300 + s);
custom(88, 'testkit:task-end', { taskId: 'about', index: 1, completed: false });
custom(90, 'testkit:session-end');

// ---------- log ----------

const L = (s, type, extra = {}) => ({ ts: at(s), type, url: extra.url ?? (s < 73 || s >= 85 ? BASE : `${BASE}about.html`), taskId: extra.taskId ?? null, ...extra });
const t1 = { taskId: 'find-jacket' };
const t2 = { taskId: 'about' };
const log = [
  L(0, 'session-start'),
  L(0, 'nav', { navType: 'load', from: null, to: BASE }),
  L(1, 'task-start', t1),
  L(4, 'click', { ...t1, selector: 'input#search', text: '', x: 300, y: 210 }),
  ...[...'rain jacket'].map((_, i) => L(4.5 + i * 0.15, 'input', { ...t1, selector: 'input#search', value: '***' })),
  L(6.3, 'change', { ...t1, selector: 'input#search', value: '***' }),
  L(9, 'click', { ...t1, selector: 'button#apply', text: 'Apply', x: 210, y: 270 }),
  L(20, 'click', { ...t1, selector: 'button#apply', text: 'Apply', x: 212, y: 271 }),
  L(20.3, 'click', { ...t1, selector: 'button#apply', text: 'Apply', x: 213, y: 270 }),
  L(20.6, 'click', { ...t1, selector: 'button#apply', text: 'Apply', x: 211, y: 272 }),
  L(21, 'error', { ...t1, message: 'TypeError: Cannot read properties of undefined (reading \'price\')', stack: 'TypeError: Cannot read properties of undefined (reading \'price\')\n    at applyFilter (app.js:42:17)' }),
  L(55, 'task-end', { ...t1, completed: true }),
  L(55.5, 'followup', { ...t1, answer: 'The filter said zero results even though I could see rain jackets. Confusing.' }),
  L(56, 'pause'),
  L(70, 'resume'),
  L(71, 'task-start', t2),
  L(72, 'click', { ...t2, selector: 'main > p > a', text: 'About this store', x: 260, y: 525 }),
  L(72.2, 'nav', { ...t2, navType: 'beforeunload', from: BASE, to: null }),
  L(73, 'nav', { ...t2, navType: 'load', from: BASE, to: `${BASE}about.html` }),
  L(73.7, 'audio-gap', { ...t2, gapStart: at(72.2), gapMs: 1500 }),
  L(84, 'click', { ...t2, selector: 'main > p > a', text: 'Back to products', x: 330, y: 250 }),
  L(84.2, 'nav', { ...t2, navType: 'beforeunload', from: `${BASE}about.html`, to: null }),
  L(85, 'nav', { ...t2, navType: 'load', from: `${BASE}about.html`, to: BASE }),
  // Stop pressed mid-task: the span ends but the task is not completed.
  L(88, 'task-end', { ...t2, completed: false }),
  L(89, 'error', { message: 'ResizeObserver loop completed with undelivered notifications.' }),
  L(90, 'session-end'),
];

// ---------- audio: 8 kHz 8-bit WAV tones, one pitch per segment ----------

function wav(seconds, freq) {
  const rate = 8000;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) {
    // Half-second beeps so drift and seeking are audible.
    const on = (i / rate) % 1 < 0.5;
    buf[44 + i] = 128 + (on ? Math.round(40 * Math.sin((2 * Math.PI * freq * i) / rate)) : 0);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const audio = [
  { audioSegmentId: 'a1', startTs: at(0), endTs: at(56), mime: 'audio/wav', blob: wav(56, 440) },
  { audioSegmentId: 'a2', startTs: at(70.2), endTs: at(72.2), mime: 'audio/wav', blob: wav(2, 550) },
  { audioSegmentId: 'a3', startTs: at(73.7), endTs: at(84.2), mime: 'audio/wav', blob: wav(10.5, 660) },
  { audioSegmentId: 'a4', startTs: at(85.6), endTs: at(90), mime: 'audio/wav', blob: wav(4.4, 770) },
];

const tasks = [
  { id: 'find-jacket', prompt: 'Find a rain jacket under $150', successHint: 'Results list shows Rain Jacket', timeLimit: 45, followUp: 'What, if anything, was confusing?' },
  { id: 'about', prompt: 'Find out where Acme is based', successHint: 'About page reached', timeLimit: null, followUp: null },
  { id: 'checkout', prompt: 'Add the jacket to your cart and check out', successHint: null, timeLimit: null, followUp: null },
];

const session = {
  id: 'fixture-0001',
  study: 'Checkout Flow — Round 2',
  createdAt: at(-30),
  startedAt: at(0),
  endedAt: at(90),
  phase: 'stopped',
  taskIndex: 1,
  tasksCompleted: 1,
  tasks,
  config: { study: 'Checkout Flow — Round 2', tasks },
  meta: {
    prototypeUrl: BASE,
    commitSha: '3f9c2ab',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    viewport: { w: W, h: H },
    consentAt: at(-5),
  },
  segments: [
    { segmentId: 's1', url: BASE, startedAt: at(0) },
    { segmentId: 's2', url: `${BASE}about.html`, startedAt: at(73) },
    { segmentId: 's3', url: BASE, startedAt: at(85) },
  ],
  audio: { enabled: true, mime: 'audio/wav' },
  muted: false,
};

events.sort((a, b) => a.timestamp - b.timestamp);
const payload = await buildPayload({ session, events, log, audio }, { testkitVersion: 'fixture' });
// Same Blob path the exporter uses in the browser.
const { blob } = buildHtmlBlob({ payload, playerJs });
const file = path.join(outDir, buildFilename(session));
await writeFile(file, Buffer.from(await blob.arrayBuffer()));
await writeFile(path.join(outDir, 'summary.md'), payload.summaryMarkdown);
console.log(`${file} (${(blob.size / 1024).toFixed(0)} KB)`);
