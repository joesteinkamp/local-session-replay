import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssUrls, findRemoteAssets } from '../src/player/assets.js';

let id = 1;
const el = (tagName, attributes = {}, childNodes = []) => ({ type: 2, tagName, attributes, childNodes, id: id++ });
const text = (textContent, isStyle = false) => ({ type: 3, textContent, isStyle, id: id++ });
const snapshot = (node) => ({ type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [node], id: id++ }, initialOffset: { left: 0, top: 0 } } });

test('cssUrls extracts url() in any quoting and @import', () => {
  assert.deepEqual(cssUrls(`a{background:url(https://a.test/1.png)} b{background:url('//b.test/2.png')} @font-face{src:url("https://c.test/f.woff2")} @import "https://d.test/x.css";`),
    ['https://a.test/1.png', '//b.test/2.png', 'https://c.test/f.woff2', 'https://d.test/x.css']);
  assert.deepEqual(cssUrls(null), []);
});

test('findRemoteAssets: images, srcset, CSS text, style attributes, fetching links', () => {
  const html = el('html', {}, [
    el('head', {}, [
      el('style', {}, [text('h{background:url(https://cdn.test/hero.png)} i{background:url(data:image/png;base64,AA==)}', true)]),
      el('link', { rel: 'stylesheet', href: 'https://cdn.test/theme.css' }),
      el('link', { rel: 'stylesheet', href: 'https://cdn.test/inlined.css', _cssText: 'p{color:red}' }),
      el('link', { rel: 'canonical', href: 'https://site.test/' }),
    ]),
    el('body', { style: 'background-image:url(https://cdn.test/bg.jpg)' }, [
      el('img', { src: 'https://example.com/x.png', srcset: 'https://example.com/x2.png 2x, data:image/png;base64,AA== 3x' }),
      el('img', { src: 'data:image/png;base64,AA==' }),
      el('img', { src: '/relative.png' }),
      el('a', { href: 'https://site.test/elsewhere', style: 'background:url(https://cdn.test/a.png)' }),
      el('script', { src: 'https://cdn.test/app.js' }),
      el('svg', {}, [el('image', { href: 'https://cdn.test/s.svg' })]),
      el('p', {}, [text('url(https://not-css.test/x.png) in body copy')]),
    ]),
  ]);
  assert.deepEqual(findRemoteAssets([snapshot(html)]), [
    'https://cdn.test/a.png', 'https://cdn.test/bg.jpg', 'https://cdn.test/hero.png', 'https://cdn.test/s.svg',
    'https://cdn.test/theme.css', 'https://example.com/x.png', 'https://example.com/x2.png',
  ]);
});

test('findRemoteAssets: mutations, attribute changes, and stylesheet rules', () => {
  const img = el('img', { src: 'data:,' });
  const events = [
    snapshot(el('html', {}, [el('body', {}, [img])])),
    { type: 3, timestamp: 2, data: { source: 0, texts: [], removes: [], adds: [{ parentId: 1, nextId: null, node: el('img', { src: 'https://m.test/added.png' }) }], attributes: [] } },
    { type: 3, timestamp: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: img.id, attributes: { src: 'https://m.test/changed.png', style: { 'background-image': 'url(https://m.test/obj.png)' } } }] } },
    { type: 3, timestamp: 4, data: { source: 8, id: 1, adds: [{ rule: '.x{background:url(https://m.test/rule.png)}' }] } },
    { type: 3, timestamp: 5, data: { source: 13, id: 1, set: { property: 'background', value: 'url(https://m.test/decl.png)' } } },
    { type: 3, timestamp: 6, data: { source: 1, positions: [] } },
  ];
  assert.deepEqual(findRemoteAssets(events), [
    'https://m.test/added.png', 'https://m.test/changed.png', 'https://m.test/decl.png', 'https://m.test/obj.png', 'https://m.test/rule.png',
  ]);
});

test('findRemoteAssets: empty and malformed input', () => {
  assert.deepEqual(findRemoteAssets(), []);
  assert.deepEqual(findRemoteAssets([null, {}, { type: 2 }, { type: 3, data: {} }]), []);
});
