// The built package (dist/): `./react` keeps 'use client' and leaves React to
// the host, the root entry never imports React, and both entries share one
// lazily imported core chunk. Runs the build first, so dist/ is fresh.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const read = (file) => readFileSync(path.join(dist, file), 'utf8');
// Static `import … from "x"` / `import "x"` specifiers (not dynamic import()).
const staticImports = (code) => [...code.matchAll(/import\s*(?:[^'"()]*?from\s*)?["']([^"']+)["']/g)].map((m) => m[1]);

before(() => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'pipe' });
});

test("dist/react.js starts with 'use client' and imports React as a bare specifier", () => {
  const code = read('react.js');
  assert.match(code, /^["']use client["'];/);
  assert.ok(staticImports(code).includes('react'), 'imports "react"');
  assert.doesNotMatch(code, /react\.element|ReactSharedInternals|__CLIENT_INTERNALS/, 'React is not bundled');
});

test('dist/index.js does not import React', () => {
  const code = read('index.js');
  assert.ok(!staticImports(code).some((s) => /^react(-dom)?(\/|$)/.test(s)));
  assert.doesNotMatch(code, /use client/);
});

test('both entries share one boot chunk that lazily imports a separate core chunk', () => {
  const chunks = readdirSync(path.join(dist, 'chunks'));
  const core = chunks.filter((f) => f.startsWith('core-'));
  assert.equal(core.length, 1, 'one core chunk');
  const entries = ['index.js', 'react.js'].map((f) => staticImports(read(f)));
  for (const imports of entries) assert.ok(!imports.some((s) => s.includes(core[0])), 'core is not a static import');
  const shared = entries[0].filter((s) => s.startsWith('./chunks/') && entries[1].includes(s));
  const lazy = shared.filter((s) => read(s).includes(`import("./${core[0]}")`));
  assert.equal(lazy.length, 1, 'a shared chunk dynamically imports core');
});

test('types ship for both entries', () => {
  assert.ok(existsSync(path.join(dist, 'index.d.ts')));
  assert.match(read('react.d.ts'), /export function TestKit\(props: TestKitConfig\): null;/);
});

test('the built React entry renders nothing on the server', async () => {
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { TestKit, version } = await import(path.join(dist, 'react.js'));
  assert.equal(renderToString(createElement(TestKit, { activate: true })), '');
  assert.equal(version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});
