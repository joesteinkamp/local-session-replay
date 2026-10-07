// Builds TestKit into public/ (the GitLab Pages artifact).
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Output path follows the major version (/v1/, /v2/, …) so a breaking release
// never overwrites the path existing prototypes load.
const out = path.join(root, 'public', `v${version.split('.')[0]}`);

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
  await mkdir(out, { recursive: true });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/player/player.js')], outfile: path.join(out, 'testkit-player.js') });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/core/index.js')], outfile: path.join(out, 'testkit-core.js'), plugins: [playerBundlePlugin] });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/loader.js')], outfile: path.join(out, 'testkit.js') });
  await assertAscii([path.join(out, 'testkit.js'), path.join(out, 'testkit-core.js'), path.join(out, 'testkit-player.js')]);
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
