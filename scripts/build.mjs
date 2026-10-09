// Builds TestKit into public/ (the GitHub Pages artifact) and dist/ (the npm
// package: ES module entries `.` and `./react`, plus copies of the script-tag
// files).
import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
// `--out-dir=<dir>` writes public/ and dist/ under <dir> instead of the repo
// (tests build into a temp dir so `npm test` leaves the real outputs alone).
const outDirArg = process.argv.find((a) => a.startsWith('--out-dir='));
const outRoot = outDirArg ? path.resolve(outDirArg.slice('--out-dir='.length)) : root;
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Output path follows the major version (/v1/, /v2/, …) so a breaking release
// never overwrites the path existing prototypes load.
const out = path.join(outRoot, 'public', `v${version.split('.')[0]}`);
const dist = path.join(outRoot, 'dist');

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox110', 'safari16'],
  minify: !watch,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { __TESTKIT_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
};

// `virtual:player-bundle` exports `loadPlayerJs() → Promise<string>`, the
// built player's source, needed only at export. Kept out of the core so host
// bundlers don't see a >500 kB chunk:
// - package build: a dynamic import() of the text, which esbuild splits into
//   its own chunk (chunks/testkit-player-*.js);
// - script build: src/export/player-script.js, which injects
//   testkit-player-source.js from the folder testkit-core.js was loaded from.
const playerFile = () => path.join(out, 'testkit-player.js');
const playerBundlePlugin = (mode) => ({
  name: 'player-bundle',
  setup(build) {
    build.onResolve({ filter: /^virtual:player-bundle$/ }, () =>
      mode === 'script'
        ? { path: path.join(root, 'src/export/player-script.js') }
        : { path: 'player-bundle', namespace: 'player-bundle' });
    // Chrome caches a failed dynamic import() for the life of the page, so a
    // failure here is marked `reloadToRetry`: only a reload can try again.
    build.onLoad({ filter: /.*/, namespace: 'player-bundle' }, () => ({
      contents: `export const loadPlayerJs = () => import('virtual:player-text').then((m) => m.default, (cause) => {
        const err = new Error('The replay player could not be loaded: ' + (cause && cause.message ? cause.message : cause), { cause });
        err.name = 'PlayerLoadError';
        err.reloadToRetry = true;
        throw err;
      });`,
      resolveDir: root,
    }));
    build.onResolve({ filter: /^virtual:player-text$/ }, () => ({ path: playerFile(), namespace: 'player-text' }));
    build.onLoad({ filter: /.*/, namespace: 'player-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
});

// Prototype pages may not declare a charset, so the bundles must be pure ASCII:
// esbuild escapes non-ASCII in strings but not inside regex literals.
async function assertAscii(files) {
  for (const file of files) {
    const buf = await readFile(file);
    const at = buf.findIndex((b) => b > 127);
    if (at !== -1) throw new Error(`${path.relative(root, file)} contains a non-ASCII byte at offset ${at}; escape it in the source (e.g. \\u0300)`);
  }
}

async function buildAll() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/player/player.js')], outfile: playerFile() });
  // The player's source as a script that defines a string (player-script.js).
  await writeFile(path.join(out, 'testkit-player-source.js'), `window.__TestKitPlayerSource=${JSON.stringify(await readFile(playerFile(), 'utf8'))};\n`);
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/core/index.js')], outfile: path.join(out, 'testkit-core.js'), plugins: [playerBundlePlugin('script')] });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/loader.js')], outfile: path.join(out, 'testkit.js') });
  await assertAscii(['testkit.js', 'testkit-core.js', 'testkit-player.js', 'testkit-player-source.js'].map((f) => path.join(out, f)));
  // Package entries (`.` and `./react`): splitting turns the dynamic import of
  // the recorder into its own chunk, shared by both entries, which the host's
  // bundler then splits again. React stays a bare import the host resolves.
  await rm(dist, { recursive: true, force: true });
  await esbuild.build({
    ...common,
    entryPoints: [
      { in: path.join(root, 'src/index.js'), out: 'index' },
      { in: path.join(root, 'src/react/index.js'), out: 'react' },
    ],
    outdir: dist,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    external: ['react', 'react-dom'],
    plugins: [playerBundlePlugin('package')],
  });
  await cp(path.join(root, 'src/index.d.ts'), path.join(dist, 'index.d.ts'));
  await cp(path.join(root, 'src/react.d.ts'), path.join(dist, 'react.d.ts'));
  await cp(out, path.join(dist, 'script'), { recursive: true });
  const esm = (await readdir(dist, { recursive: true })).filter((f) => f.endsWith('.js') && !f.startsWith('script'));
  await assertAscii(esm.map((f) => path.join(dist, f)));
  await rm(path.join(outRoot, 'public', 'demo'), { recursive: true, force: true });
  await cp(path.join(root, 'demo'), path.join(outRoot, 'public', 'demo'), { recursive: true });
}

await buildAll();

if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch((e) => console.error(e.message)), 100);
  };
  fsWatch(path.join(root, 'src'), { recursive: true }, rebuild);
  fsWatch(path.join(root, 'demo'), { recursive: true }, rebuild);
  console.log('watching src/ and demo/ …');
}
