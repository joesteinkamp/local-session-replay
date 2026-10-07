import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, escapeIdent, isGeneratedToken, labelFor, selectorFor } from '../src/core/selector.js';

// Minimal DOM: just enough Element surface for selector.js, plus a matcher
// for the selector grammar it emits (#id, [attr="v"], tag[attr="v"],
// tag.cls:nth-of-type(n), joined by ' > ').
class El {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.nodeType = 1;
    this.localName = tag;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.classList = {
      list: (attrs.class || '').split(/\s+/).filter(Boolean),
      contains(c) {
        return this.list.includes(c);
      },
      [Symbol.iterator]() {
        return this.list[Symbol.iterator]();
      },
    };
    for (const c of children) this.append(c);
  }
  append(c) {
    c.parentElement = this;
    this.children.push(c);
  }
  get id() {
    return this.attrs.id || '';
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  getRootNode() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return doc(n);
  }
  closest() {
    return null;
  }
}

function all(root) {
  return [root, ...root.children.flatMap(all)];
}

function unquote(v) {
  return v.slice(1, -1).replace(/\\(.)/g, '$1');
}

function matchesSimple(el, simple) {
  const re = /^([a-z0-9]+)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+="(?:[^"\\]|\\.)*"\]|:nth-of-type\(\d+\))*)$/;
  const m = simple.match(re);
  if (!m) throw new Error(`fake matcher cannot parse ${simple}`);
  if (m[1] && el.localName !== m[1]) return false;
  const tokens = m[2].match(/#[\w-]+|\.[\w-]+|\[[\w-]+="(?:[^"\\]|\\.)*"\]|:nth-of-type\(\d+\)/g) || [];
  return tokens.every((t) => {
    if (t[0] === '#') return el.id === t.slice(1);
    if (t[0] === '.') return el.classList.contains(t.slice(1));
    if (t[0] === '[') {
      const [, name, value] = t.match(/^\[([\w-]+)=(".*")\]$/);
      return el.getAttribute(name) === unquote(value);
    }
    const n = Number(t.match(/\d+/)[0]);
    const same = el.parentElement ? el.parentElement.children.filter((s) => s.localName === el.localName) : [el];
    return same.indexOf(el) + 1 === n;
  });
}

function matches(el, selector) {
  const parts = selector.split(' > ');
  let cur = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!cur || !matchesSimple(cur, parts[i])) return false;
    cur = cur.parentElement;
  }
  return true;
}

function doc(rootEl) {
  return { querySelectorAll: (sel) => all(rootEl).filter((el) => matches(el, sel)) };
}

const tree = () => {
  const save = new El('button', { class: 'btn css-1x2y3z is-active' }, [], 'Save');
  const cancel = new El('button', { class: 'btn' }, [], 'Cancel');
  const testId = new El('button', { 'data-testid': 'export-btn' }, [], 'Export');
  const svgIcon = new El('span', { class: 'icon' });
  const named = new El('input', { name: 'email', type: 'email', placeholder: 'Email' });
  const toolbar = new El('div', { class: 'toolbar', role: 'toolbar' }, [save, cancel, testId, svgIcon]);
  const form = new El('form', { id: 'signup' }, [named]);
  const html = new El('html', {}, [new El('body', {}, [new El('main', {}, [toolbar, form])])]);
  return { html, save, cancel, testId, named, toolbar, form };
};

test('isGeneratedToken flags hashes and framework ids, keeps readable names', () => {
  for (const t of ['css-1x2y3z', 'sc-AbCd3', 'Button_primary__3xYz1', ':r1:', 'ember1234', 'aB3dE5', '_1x2y3', 'md:flex', 'ng-star-inserted', '123']) {
    assert.equal(isGeneratedToken(t), true, t);
  }
  for (const t of ['btn', 'primary-cta', 'col-12', 'toolbar', 'nav__item', 'h1']) {
    assert.equal(isGeneratedToken(t), false, t);
  }
});

test('escapeIdent fallback follows CSS.escape for leading digits and punctuation', () => {
  assert.equal(escapeIdent('1a'), '\\31 a');
  assert.equal(escapeIdent('a.b'), 'a\\.b');
  assert.equal(escapeIdent('-'), '\\-');
  assert.equal(escapeIdent('ok_name-2'), 'ok_name-2');
});

test('selectorFor prefers test ids and names', () => {
  const { testId, named } = tree();
  assert.equal(selectorFor(testId), '[data-testid="export-btn"]');
  assert.equal(selectorFor(named), 'input[name="email"]');
});

test('selectorFor drops generated and state classes and disambiguates siblings', () => {
  const { save, cancel } = tree();
  const s = selectorFor(save);
  assert.equal(s, 'button.btn:nth-of-type(1)');
  assert.equal(selectorFor(cancel), 'button.btn:nth-of-type(2)');
  assert.doesNotMatch(s, /css-|is-active/);
});

test('selectorFor resolves text nodes and returns null for non-elements', () => {
  const { save } = tree();
  assert.equal(selectorFor({ nodeType: 3, parentElement: save }), selectorFor(save));
  assert.equal(selectorFor(null), null);
  assert.equal(selectorFor({ nodeType: 9 }), null);
});

test('selectorFor never throws on hostile input', () => {
  const broken = { nodeType: 1, localName: 'div', getAttribute() { throw new Error('boom'); } };
  assert.equal(selectorFor(broken), null);
});

test('labelFor uses visible text, aria-label, and never input values', () => {
  const { save, named } = tree();
  assert.equal(labelFor(save), 'Save');
  assert.equal(labelFor(new El('button', { 'aria-label': '  Close dialog ' })), 'Close dialog');
  named.value = 'person@example.com';
  assert.equal(labelFor(named), 'Email');
  const submit = new El('input', { type: 'submit' });
  submit.value = 'Send';
  assert.equal(labelFor(submit), 'Send');
});

test('labelFor masks contenteditable text when masking', () => {
  const editor = new El('div', { title: 'Notes' }, [], 'my secret notes');
  editor.isContentEditable = true;
  assert.equal(labelFor(editor, { mask: true }), 'Notes');
  assert.equal(labelFor(editor, { mask: false }), 'my secret notes');
});

test('clip collapses whitespace and caps length at 80', () => {
  assert.equal(clip('  a \n  b  '), 'a b');
  const long = clip('x'.repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
});
