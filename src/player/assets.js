// Finds remote (http/https/protocol-relative) assets referenced by a recorded
// rrweb stream. The export's CSP blocks them all to stay local-only, so the
// player uses this to tell the viewer what the replay is missing. Pure, so it
// runs under node:test.

const NODE_ELEMENT = 2;
const NODE_TEXT = 3;
const EV_FULL_SNAPSHOT = 2;
const EV_INCREMENTAL = 3;
const SRC_MUTATION = 0;
const SRC_STYLE_SHEET_RULE = 8;
const SRC_STYLE_DECLARATION = 13;

const URL_ATTRS = new Set(['src', 'poster', 'data', 'background']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
// <link> rels that fetch; canonical/alternate/etc. are just metadata.
const FETCHING_RELS = /\b(stylesheet|icon|preload|prefetch|modulepreload|manifest|apple-touch-icon)\b/i;
// Elements whose src rrweb never loads on replay (scripts become inert,
// iframes are rebuilt from their own snapshot).
const INERT_TAGS = new Set(['script', 'iframe', 'frame']);

const isRemote = (url) => /^(https?:)?\/\//i.test(String(url).trim());

export function cssUrls(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) out.push(m[2].trim());
  for (const m of text.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) out.push(m[2].trim());
  return out;
}

function srcsetUrls(value) {
  return String(value).split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
}

function attributeUrls(tagName, attributes = {}) {
  const tag = String(tagName || '').toLowerCase();
  const out = [];
  const inert = INERT_TAGS.has(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    const key = name.toLowerCase();
    if (key === 'style') {
      // Attribute mutations may carry a style object ({ prop: value | [value, priority] }).
      const text = typeof value === 'object' ? Object.values(value).flat().join(';') : String(value);
      out.push(...cssUrls(text));
    } else if (key === '_csstext') {
      out.push(...cssUrls(String(value)));
    } else if (inert) {
      continue;
    } else if (URL_ATTRS.has(key)) {
      out.push(String(value));
    } else if (SRCSET_ATTRS.has(key)) {
      out.push(...srcsetUrls(value));
    } else if ((key === 'href' || key === 'xlink:href') && (tag === 'image' || tag === 'use' || tag === 'feimage')) {
      out.push(String(value));
    } else if (key === 'href' && tag === 'link' && FETCHING_RELS.test(String(attributes.rel || '')) && !attributes._cssText) {
      out.push(String(value));
    }
  }
  return out;
}

function walk(node, add) {
  if (!node || typeof node !== 'object') return;
  if (node.type === NODE_ELEMENT) attributeUrls(node.tagName, node.attributes).forEach(add);
  else if (node.type === NODE_TEXT && node.isStyle) cssUrls(node.textContent).forEach(add);
  if (Array.isArray(node.childNodes)) for (const child of node.childNodes) walk(child, add);
}

// Returns a sorted array of unique remote URLs referenced anywhere in the stream.
export function findRemoteAssets(events = []) {
  const found = new Set();
  const add = (url) => {
    if (isRemote(url)) found.add(url.trim());
  };
  // Attribute mutations only carry the node id, so remember tag names.
  const tags = new Map();
  const remember = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === NODE_ELEMENT) tags.set(node.id, node.tagName);
    if (Array.isArray(node.childNodes)) node.childNodes.forEach(remember);
  };
  for (const ev of events) {
    if (ev?.type === EV_FULL_SNAPSHOT) {
      remember(ev.data?.node);
      walk(ev.data?.node, add);
    } else if (ev?.type === EV_INCREMENTAL) {
      const d = ev.data || {};
      if (d.source === SRC_MUTATION) {
        for (const a of d.adds || []) {
          remember(a.node);
          walk(a.node, add);
        }
        for (const a of d.attributes || []) attributeUrls(tags.get(a.id) || '', a.attributes).forEach(add);
        for (const t of d.texts || []) cssUrls(t.value).forEach(add);
      } else if (d.source === SRC_STYLE_SHEET_RULE) {
        for (const r of d.adds || []) cssUrls(r.rule).forEach(add);
        for (const r of d.replace ? [d.replace] : []) cssUrls(r).forEach(add);
        for (const r of d.replaceSync ? [d.replaceSync] : []) cssUrls(r).forEach(add);
      } else if (d.source === SRC_STYLE_DECLARATION) {
        cssUrls(d.set?.value).forEach(add);
      }
    }
  }
  return [...found].sort();
}
