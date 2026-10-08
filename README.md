# TestKit

Local session replay and think-aloud recording for web prototypes.
Install TestKit into an app, mount `<TestKit />` (or call `init()`), open it with `?test=1`, run through scripted
tasks while thinking aloud, and download **one self-contained HTML file** with
the replay, synced audio, and an agent-ready summary.

No backend, no third-party services. Nothing leaves the tester's machine until
they download the file.

## Install

Install TestKit into the app you're testing, then mount it. The recorder is
only downloaded when testing is active, so casual viewers pay ~1 KB.

```sh
npm i -D github:joesteinkamp/local-session-replay   # pin a tag: …/local-session-replay#v1.0.0
```

Installing from git builds the package on install (its `prepare` script), so
the package manager must be allowed to run it:

- **npm:** recent versions list it under `allow-scripts`; run
  `npm approve-scripts local-session-replay`.
- **pnpm 10+:** blocks it by default and installs an empty package. Add it to
  `pnpm.onlyBuiltDependencies` in `package.json` (or run `pnpm approve-builds`)
  and reinstall.

The package is ES modules only, so a CommonJS test runner (e.g. Jest) needs it
transformed or mocked. Types ship with it.

### React: `<TestKit />`

```jsx
import { TestKit } from 'local-session-replay/react';

export default function App() {
  return (
    <>
      <TestKit
        study="grid-filters-v2"
        tasks={[
          { id: 'filter', prompt: 'Filter to healthcare companies' },
          { id: 'export', prompt: 'Export the current view' },
        ]}
      />
      <YourPrototype />
    </>
  );
}
```

Open the app with `?test=1`. Props are the [config](#config-reference). The
component renders nothing itself; the overlay lives in its own Shadow DOM.
React 18 and 19 are supported. `examples/react/` is a working Vite app.

- **Redirects that drop `?test=1`.** The package snapshots the `test` param
  when it's first imported, so a client-side redirect that strips it before
  `<TestKit />` mounts (a router `beforeLoad` or loader, `useLayoutEffect`, a
  redirect during render) still activates, however much later the component
  mounts on that page load. Import it in your entry module chunk if the
  redirect happens before the component's chunk loads: if the package is only
  imported from a lazily loaded chunk that evaluates after the redirect, the
  snapshot misses the param. Import a binding you use; a bare
  `import 'local-session-replay/react'` is dropped by bundlers, because the
  package is marked side-effect-free. Server-side redirects still have to keep
  the param. `?test=0`, at first import or in the current URL, always wins.
  Once a session is in progress it survives navigation without the param.
- **Configuration is read once.** The first committed `<TestKit />` on the page
  owns the configuration, even when it decides not to activate. Later prop
  changes, remounts (StrictMode, HMR), and other copies are ignored. Reload the
  page to change the configuration.
- **Activation that's only known later** (auth, feature flags): mount it
  conditionally, `{isTester && <TestKit … />}`. Don't render it with
  `activate={false}` and flip it later: that first mount already decided.
- **`activate` is not an authorization boundary.** It decides whether the
  overlay shows, not who may record: the code ships to every visitor of the
  bundle, and `?test=1` works for anyone. Gate on something real (a preview
  deploy, a feature flag) if that matters.
- **Unmounting doesn't stop a session.** Recording continues across route
  changes until the tester stops it in the overlay.
- **Next.js App Router:** the entry is marked `'use client'`, so server
  components can render it. Functions can't be passed from a server component,
  so use a boolean (`activate={process.env.NODE_ENV !== 'production'}`) or
  wrap it in your own `'use client'` component to pass a function.
- If the recorder chunk fails to load (e.g. after a redeploy), TestKit logs
  `[TestKit] failed to start` to the console and stays off until a reload.

### Other bundled apps (Vue, Svelte, vanilla): `init()`

```js
import { init } from 'local-session-replay';

init({
  study: 'grid-filters-v2',
  tasks: [{ id: 'filter', prompt: 'Filter to healthcare companies' }],
});
```

Call `init()` once, in the browser, at app startup. The same rules apply: only
the first call on the page counts, and on the server it does nothing. This
entry never imports React.

Client-side route changes are recorded automatically. Activation defaults to
`?test=1`. Passing an `activate` function replaces that check rather than
adding to it, e.g. `activate: () => import.meta.env.DEV` (Vite) or
`() => process.env.NODE_ENV !== 'production'` (webpack/Next). In both entries
the recorder is a dynamic import, so the host bundler splits it into its own
chunk.

### Also supported: plain HTML without a bundler

**Script tag from GitHub Pages:**

```html
<script src="https://joesteinkamp.github.io/local-session-replay/v1/testkit.js"></script>
<script>
  TestKit.init({
    study: 'grid-filters-v2',
    tasks: [{ id: 'filter', prompt: 'Filter to healthcare companies' }],
  });
</script>
```

Put both tags on **every page** of a multi-page prototype (a shared
`testkit-config.js` works well — see `demo/`). Pin the versioned path (`/v1/`).
The build writes to `/v<major>/` from `package.json`, so a breaking release
goes to a new path. Pages replaces the whole site on each deploy, so before
`/v2/` ships, the workflow must also build `/v1/` (e.g. from a `v1` tag) into
the same artifact.

**Self-hosted script files:** copy `testkit.js`, `testkit-core.js` and
`testkit-player-source.js` into one folder of the host app's static files
(they're in `public/v1/` after `npm run build`, or
`node_modules/local-session-replay/dist/script/` after an npm install) and
load `testkit.js` as above. The loader fetches `testkit-core.js` from its
own folder, and the first export fetches `testkit-player-source.js` (the replay
player inlined into every file) from the same folder. If the host injects `testkit.js` without a `<script src>`, pass
`baseUrl` to say where that folder is, as an absolute URL or a root-relative
path (`/testkit/v1/`). A plain relative path resolves against each page.

Use one install per page: if the component, `init()`, and the script tag are
mixed, the first one to run wins.

## Config reference

| Option | Default | Notes |
| :-- | :-- | :-- |
| `study` | `'untitled-study'` | Used in the export filename and header. |
| `activate` | `'query'` | `'query'` = show with `?test=1`; `true`/`false`; or a function returning a boolean. Evaluated once, at the first mount or `init()`; in query mode, a `?test=1` present when the package was first imported still counts after a client-side redirect drops it. `?test=0` always disables. An in-progress session stays active across navigation without the query param. Not an access control. |
| `audio` | `{ enabled: true, bitrate: 32000 }` | `audio: false` disables the mic entirely. ~15 MB/hour at 32 kbps. |
| `mask` | `{ inputs: true }` | Masks typed values in the replay and the interaction log. |
| `checkoutEveryNms` | `60000` | Periodic full DOM snapshots, so seeking stays fast. |
| `inlineImages` | `true` | Embeds `<img>` content in the recording so replays survive redeploys. Turn off for image-heavy prototypes (large files) or prototypes with cross-origin images whose servers don't send CORS headers — rrweb retries those with `crossOrigin` set, which can break them on the live page. |
| `baseUrl` | folder of `testkit.js` | Script-tag installs only: where to fetch `testkit-core.js` from. Absolute or root-relative. |
| `commitSha` | `<meta name="testkit:commit">` | Recorded in the export metadata. In CI, template the commit SHA (e.g. `$GITHUB_SHA`) into the meta tag. |
| `tasks[]` | `[]` | `{ id, prompt, successHint?, timeLimit?, followUp? }`. `timeLimit` is seconds (a gentle nudge, never auto-advances). `followUp` asks a question after the task. `successHint` is shown behind a disclosure and in the summary as "Expected". |

## Running a session (facilitator checklist)

1. Use desktop Chrome, Firefox, or Safari. Close unrelated tabs.
2. Open the prototype with `?test=1`. Click the TestKit bubble → **Start test session**.
3. Pre-flight: read the consent line aloud, tick consent, allow the mic, and
   say something until the level check passes. (Or continue without audio.)
4. Give the tester control. They read the task, think aloud, and click
   **Next task** when done, or **Skip task** to give up on one (the export
   shows it as Skipped, not Completed). Works moderated or unmoderated:
   whoever has the keyboard advances.
5. **Pause** for interruptions, **Mute** for side conversations.
6. After the last task (or **Stop**), click **Download session file**. Then
   **Discard** to clear the data from the browser, or **Start new session**
   for the next participant: a downloaded session is cleared from the browser
   when the next one starts; if it hasn't been downloaded, TestKit asks you to
   download or discard it first.

Reloads, crashes, and page navigations resume the same session automatically.
Expect 1–2 s of silence in the audio at each page load (marked on the timeline).
A session left idle for more than 30 minutes is not resumed: it is stopped and
stays available to download from `?test=1`.

## The export

Open the downloaded `.html` file in any browser, offline. The file blocks all
network requests, so anything the recording didn't embed (remote fonts, CSS
background images, images with inlining off) shows up missing in the replay
rather than loading from the prototype's server.

- Replay with task markers, pause spans, audio gaps, and error ticks on a
  scrubbable timeline (keyboard: ←/→ 5 s, PgUp/PgDn 30 s, Home/End, Space).
- Think-aloud audio synced to the replay, including speed changes.
- **Copy agent summary** — per-task markdown: duration, selector-level
  interaction trail, errors, and signals (rage clicks, backtracking, long
  idle, time limit exceeded). Paste it into an AI agent alongside the
  prototype's code.
- **Download raw JSON** — every rrweb event, log entry, and metadata field.

## Development

```sh
npm install
npm test          # node:test unit tests
npm run build     # → public/v1/ + public/demo/ (Pages) and dist/ (the package)
npm run serve     # build, then serve public/ on :8080 → /demo/index.html?test=1
npm run example:react   # build, install examples/react, serve it on :5181 → /?test=1
npm run check:package   # pack the tarball; install it into scratch apps (React 18/19, no React); import and type-check both entries
```

`examples/react/` has its own install (not a workspace, so a GitHub install of
the package never pulls Vite). It links this package with `file:../..`, which
doesn't run `prepare`, so `example:react` builds first; Vite's
`resolve.dedupe` keeps the app and the package on one React.

Module boundaries and data formats are in `docs/CONTRACTS.md`.
`scripts/fixture-export.mjs` writes a synthetic export for working on the player.
GitHub Actions (`.github/workflows/pages.yml`) tests every push and PR, and
publishes `public/` to GitHub Pages from `main`. Enable it once under the
repo's Settings → Pages → Source: GitHub Actions.

## Known limitations

- Cross-origin iframes and WebGL don't record well; canvas isn't recorded.
- Assets loaded from relative paths (fonts especially) are the most common
  replay-fidelity gap. Stylesheets and same-origin images are inlined;
  check a replay per prototype.
- Safari, and Firefox by default, may re-prompt for mic permission on each page
  load of a multi-page prototype. If the tester declines, recording continues without audio.
  Audio-heavy studies are smoother on single-page prototypes.
- Desktop browsers are the primary target.
- Transcription (in-browser Whisper) is planned for v1.5.

## License

MIT. See `LICENSE`.
