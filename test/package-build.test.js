// The built package (dist/): `./react` keeps 'use client' and leaves React to
// the host, the root entry never imports React, and both entries share one
// lazily imported core chunk. Builds into a temp dir, so the repo's dist/ and
// public/ are left alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'lsr-build-'));
const dist = path.join(outDir, 'dist');
const read = (file) => readFileSync(path.join(dist, file), 'utf8');
// Static `import … from "x"` / `import "x"` specifiers (not dynamic import()).
const staticImports = (code) => [...code.matchAll(/import\s*(?:[^'"()]*?from\s*)?["']([^"']+)["']/g)].map((m) => m[1]);

before(() => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), `--out-dir=${outDir}`], { cwd: root, stdio: 'pipe' });
  // The built React entry imports `react` by bare name; resolve it from the repo.
  symlinkSync(path.join(root, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
});

after(() => rmSync(outDir, { recursive: true, force: true }));

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

// Vite warns on chunks over 500 kB; the replay player (~270 kB of source text
// inlined into exports) is loaded only at export time.
const KB500 = 500 * 1024;

test('the core chunk stays under 500 kB; the player text is a separate chunk it imports lazily', () => {
  const chunks = readdirSync(path.join(dist, 'chunks'));
  const [core] = chunks.filter((f) => f.startsWith('core-'));
  const players = chunks.filter((f) => f.startsWith('testkit-player-'));
  assert.equal(players.length, 1, 'one player chunk');
  const code = read(`chunks/${core}`);
  assert.ok(code.length < KB500, `core chunk is ${code.length} bytes`);
  assert.ok(code.includes(`import("./${players[0]}")`), 'core imports the player chunk dynamically');
  assert.ok(!staticImports(code).some((s) => s.includes(players[0])), 'never statically');
  assert.doesNotMatch(code, /TestKitPlayer/, 'player source is not inlined in core');
});

test('script build: testkit-core.js under 500 kB; testkit-player-source.js defines the player source', () => {
  const core = read('script/testkit-core.js');
  assert.ok(core.length < KB500, `testkit-core.js is ${core.length} bytes`);
  assert.match(core, /testkit-player-source\.js/);
  const window = {};
  new Function('window', read('script/testkit-player-source.js'))(window);
  assert.equal(window.__TestKitPlayerSource, read('script/testkit-player.js'));
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
