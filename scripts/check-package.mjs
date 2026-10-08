// Checks the package as consumers get it, not as the repo links it: packs the
// tarball, installs it into throwaway apps outside the repo (React 18, React 19,
// and no React at all), and imports both entries there. Needs network access
// for the React installs. Usage: npm run check:package
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Runs inside each consumer. Prints one line of JSON describing what resolved.
const probe = `
const out = {};
const rootEntry = await import('local-session-replay');
out.root = Object.keys(rootEntry).sort();
out.version = rootEntry.version;
try {
  const { TestKit } = await import('local-session-replay/react');
  const { createElement, version } = await import('react');
  const { renderToString } = await import('react-dom/server');
  out.react = version;
  out.ssr = renderToString(createElement(TestKit, { study: 'pack-check', activate: true }));
  out.reactEntry = Object.keys(await import('local-session-replay/react')).sort();
} catch (err) {
  out.reactError = err.code || err.message;
}
console.log(JSON.stringify(out));
`;

const scratch = await mkdtemp(path.join(tmpdir(), 'lsr-pack-'));
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

try {
  // `npm pack` runs `prepare`, so the tarball holds a fresh build.
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', scratch], root));
  const tarball = path.join(scratch, packed.filename);
  const files = packed.files.map((f) => f.path);
  const { version } = packed;
  for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/react.js', 'dist/react.d.ts', 'dist/script/testkit.js']) {
    check(files.includes(f), `tarball ships ${f}`);
  }
  check(!files.some((f) => f.startsWith('examples/') || f.startsWith('src/')), 'tarball ships no examples/ or src/');

  for (const react of [null, '18', '19']) {
    const label = react ? `React ${react}` : 'no React';
    const app = path.join(scratch, react ? `app-react${react}` : 'app-no-react');
    await mkdir(app);
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    await writeFile(path.join(app, 'probe.mjs'), probe);
    const deps = react ? [`react@${react}`, `react-dom@${react}`] : [];
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball, ...deps], app);
    const out = JSON.parse(run(process.execPath, ['probe.mjs'], app).trim());
    check(out.root.join() === 'init,version' && out.version === version, `${label}: root exports { init, version } (${out.version})`);
    if (!react) {
      check(out.reactError === 'ERR_MODULE_NOT_FOUND', `${label}: root imports without React; ./react needs it (${out.reactError})`);
      continue;
    }
    check(out.react?.startsWith(`${react}.`), `${label}: resolved react ${out.react}`);
    check(out.reactEntry?.join() === 'TestKit,version', `${label}: ./react exports { TestKit, version }`);
    check(out.ssr === '', `${label}: <TestKit /> server-renders to ''`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\npackage check passed');
