// Readable, reasonably stable CSS selectors and visible labels for logged
// elements. The interaction log uses these so a human or an agent can map a
// click back to real markup; they're descriptive, not guaranteed-unique
// locators (we stop at MAX_DEPTH levels to keep them readable).

const MAX_DEPTH = 5;
const MAX_LABEL = 80;
const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
const NAMED_TAGS = new Set(['input', 'select', 'textarea', 'button', 'form', 'iframe', 'fieldset', 'output']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);
// Clicks on an <svg><path> inside a button should be reported as the button.
const INTERACTIVE =
  'a[href],button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="tab"],' +
  '[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[contenteditable=""],' +
  '[contenteditable="true"]';
// Classes that flip with UI state would make the same element look different
// from one click to the next.
const STATE_CLASS =
  /^(is-|has-)|^(active|focus|focused|hover|hovered|selected|open|opened|closed|visible|hidden|disabled|checked|current|show|showing|expanded|collapsed)$/i;

/**
 * True for class names / ids that look machine-generated (CSS-in-JS hashes,
 * CSS-module suffixes, framework ids) or that would need heavy escaping.
 */
export function isGeneratedToken(token) {
  if (!token || token.length > 40) return true;
  if (/[^\w-]/.test(token)) return true; // `md:flex`, `w-[10px]`, React `:r1:`
  if (/^\d/.test(token) || /^_[\w-]*\d/.test(token)) return true;
  if (/^(css|sc|jsx|emotion|styled|svelte|astro|data-v)-/i.test(token) && /\d/.test(token)) return true;
  if (/^ng-/.test(token)) return true;
  if (/__[\w-]{5,}$/.test(token) && /\d/.test(token.split('__').pop())) return true; // CSS modules
  if (/^[\da-f]{8}-[\da-f]{4}-/i.test(token)) return true; // uuid
  if ((token.match(/\d/g) || []).length >= 4) return true; // ember1234, el-48213
  // Separator-free mixed-case-plus-digit runs (`aB3dE5`) are hashes.
  if (!/[-_]/.test(token) && token.length >= 6 && /\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token)) return true;
  return false;
}

/** CSS.escape, with a spec-following fallback for environments without it. */
export function escapeIdent(value) {
  const s = String(value);
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    if (code === 0) out += '\uFFFD';
    else if ((code >= 1 && code <= 0x1f) || code === 0x7f || (i === 0 && isDigit) || (i === 1 && isDigit && s[0] === '-')) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && ch === '-' && s.length === 1) out += '\\-';
    else if (code >= 0x80 || ch === '-' || ch === '_' || /[a-zA-Z0-9]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

function quoteAttr(value) {
  return `"${String(value).replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
}

/** Element for a node (text nodes resolve to their parent), else null. */
export function toElement(node) {
  if (!node) return null;
  if (node.nodeType === 1) return node;
  if (node.nodeType === 3) return node.parentElement || null;
  return null;
}

/** Nearest interactive ancestor-or-self, falling back to the element itself. */
export function interactiveTarget(node) {
  const el = toElement(node);
  if (!el) return null;
  try {
    return el.closest?.(INTERACTIVE) || el;
  } catch {
    return el;
  }
}

function matchCount(root, selector) {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return Infinity;
  }
}

/** A selector that identifies `el` on its own within `root`, or null. */
function anchorFor(el, root) {
  const tag = el.localName;
  const candidates = [];
  if (el.id && !isGeneratedToken(el.id)) candidates.push(`#${escapeIdent(el.id)}`);
  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) candidates.push(`[${attr}=${quoteAttr(v)}]`);
  }
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length <= 60) candidates.push(`${tag}[aria-label=${quoteAttr(aria)}]`);
  // A link's destination is readable and greps straight to the markup.
  const href = tag === 'a' ? el.getAttribute('href') : null;
  if (href && href !== '#' && href.length <= 80 && !/^javascript:/i.test(href)) candidates.push(`a[href=${quoteAttr(href)}]`);
  const name = el.getAttribute('name');
  if (name && NAMED_TAGS.has(tag)) candidates.push(`${tag}[name=${quoteAttr(name)}]`);
  return candidates.find((sel) => matchCount(root, sel) === 1) || null;
}

function stableClasses(el) {
  const list = el.classList ? Array.from(el.classList) : [];
  return list.filter((c) => !isGeneratedToken(c) && !STATE_CLASS.test(c)).slice(0, 2);
}

/** `tag[role].cls1.cls2:nth-of-type(n)` — nth only when siblings are ambiguous. */
function segmentFor(el) {
  const tag = el.localName;
  let seg = tag;
  const role = el.getAttribute('role');
  if (role && (tag === 'div' || tag === 'span' || tag === 'li')) seg += `[role=${quoteAttr(role)}]`;
  const classes = stableClasses(el);
  seg += classes.map((c) => `.${escapeIdent(c)}`).join('');
  const parent = el.parentElement;
  if (!parent) return seg;
  const sameTag = Array.from(parent.children).filter((s) => s.localName === tag);
  if (sameTag.length > 1) {
    const lookalikes = sameTag.filter(
      (s) => classes.every((c) => s.classList?.contains(c)) && (s.getAttribute('role') || null) === (role || null),
    );
    if (lookalikes.length > 1) seg += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }
  return seg;
}

/** Readable CSS selector for a node, or null. Never throws. */
export function selectorFor(node, { maxDepth = MAX_DEPTH } = {}) {
  try {
    const el = toElement(node);
    if (!el) return null;
    const root = el.getRootNode?.() || el.ownerDocument;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && depth < maxDepth; depth++) {
      const tag = cur.localName;
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag);
        break;
      }
      const anchor = anchorFor(cur, root);
      if (anchor) {
        parts.unshift(anchor);
        break;
      }
      parts.unshift(segmentFor(cur));
      // Stop as soon as the path is already unambiguous: shorter reads better.
      if (matchCount(root, parts.join(' > ')) === 1) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ') || null;
  } catch {
    return null;
  }
}

/** Collapses whitespace and clips to `max` characters. */
export function clip(text, max = MAX_LABEL) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function textOf(el) {
  // innerText respects CSS visibility; textContent is the fallback for
  // detached or non-HTML nodes.
  return el.innerText ?? el.textContent ?? '';
}

/**
 * Trimmed visible label (≤80 chars) for a node. Never returns a form
 * control's typed value; with `mask`, never returns contenteditable text.
 */
export function labelFor(node, { mask = true } = {}) {
  try {
    const el = toElement(node);
    if (!el) return '';
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return clip(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const doc = el.ownerDocument;
      const text = labelledBy
        .split(/\s+/)
        .map((id) => doc?.getElementById(id))
        .filter(Boolean)
        .map(textOf)
        .join(' ');
      if (text.trim()) return clip(text);
    }
    const tag = el.localName;
    if (FORM_CONTROLS.has(tag)) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(type) && el.value) return clip(el.value);
      const labels = el.labels ? Array.from(el.labels).map(textOf).join(' ') : '';
      if (labels.trim()) return clip(labels);
      return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (tag === 'img') return clip(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (mask && el.isContentEditable) return clip(el.getAttribute('title') || '');
    const text = clip(textOf(el));
    return text || clip(el.getAttribute('title') || '');
  } catch {
    return '';
  }
}
