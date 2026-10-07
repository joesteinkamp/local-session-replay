// Builds TestKit into public/ (the GitLab Pages artifact).
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'v1');
const watch = process.argv.includes('--watch');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

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

// Resolves `virtual:player-bundle` to the built player as a string.
const playerBundlePlugin = {
  name: 'player-bundle',
  setup(build) {
    build.onResolve({ filter: /^virtual:player-bundle$/ }, () => ({
      path: path.join(out, 'testkit-player.js'),
      namespace: 'player-bundle',
    }));
    build.onLoad({ filter: /.*/, namespace: 'player-bundle' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

async function buildAll() {
  await mkdir(out, { recursive: true });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/player/player.js')], outfile: path.join(out, 'testkit-player.js') });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/core/index.js')], outfile: path.join(out, 'testkit-core.js'), plugins: [playerBundlePlugin] });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/loader.js')], outfile: path.join(out, 'testkit.js') });
  await rm(path.join(root, 'public', 'demo'), { recursive: true, force: true });
  await cp(path.join(root, 'demo'), path.join(root, 'public', 'demo'), { recursive: true });
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
