# Plan: Agentation-style React install

**Status:** Agreed (grill-me, 2026-10-07); revised after review (2026-10-07, Claude). See "Revision notes" at the end.
**Branch / worktree:** `ai/cursor` → `../local-session-replay-cursor` (original); this revision on `ai/claude-react-plan`
**Supersedes (narrative):** `testkit-plan.md` Phase 6 framing TestKit as its own Pages project, and the "Later → Optional React adapter" bullet as a thin afterthought.

## Problem

The original plan treated TestKit as a **separate hosted script** (own GitLab/GitHub Pages project) that prototypes load with `<script src="…/testkit.js">`. The desired model is **Agentation / DialKit-style**: install the package into the app under test, mount a React component, and let the host bundler own the code.

The repo already supports `npm i` from GitHub and `import { init } from 'local-session-replay'` with a dynamic import of the recorder. What's missing is the **React component as the primary public API** and making **in-app install the primary story**.

## Decisions (locked)

| Topic | Choice |
| :-- | :-- |
| Public API | `<TestKit />` is the primary, documented-first API — no controller/state hook in v1 |
| `init()` | **Stays public** on the root entry as the non-React path (Vue, Svelte, vanilla bundled apps); documented second |
| Install model | npm into the host app (like Agentation), not a remote toolkit host |
| Package shape | **Single package, two entries**: `local-session-replay/react` (component) and `local-session-replay` (`init`, `version`) |
| Core loading | Keep today's **dynamic `import()`** of core so the host splits a chunk; casual viewers who never mount/activate don't pay for rrweb |
| Script-tag / Pages | **Secondary** for plain HTML multi-page demos; keep working, demote in docs |
| Config lifecycle | **Mount-once**; first props win; later prop updates are ignored (no runtime warning in v1) |
| Async activation | Gate by **conditional mount** (`{isTester && <TestKit … />}`), not by flipping `activate` after mount |
| Unmount | Does **not** stop or tear down a session — sessions survive navigation; documented |
| Example | README + **`examples/react/`** Vite app; keep HTML `demo/` for script-tag |
| React | `peerDependencies`: `react` and `react-dom` `^18.0.0 \|\| ^19.0.0`, marked **optional** via `peerDependenciesMeta` (non-React hosts import only the root); never bundled |
| Version | Stays `1.x` — adding a subpath is additive, so no major bump and the Pages `/v1/` path is unchanged |

### Rejected alternatives

- Controller `useTestKit()` hook — not needed until apps drive session UI/flow themselves.
- Remote loader / required `src` URL — wrong distribution model for React apps.
- Bundling core into the main chunk with no split — taxes every visitor; dynamic import already matches Agentation install while preserving cost.
- Dual packages (`@testkit/core` + `@testkit/react`) — extra moving parts for one consumer shape; a subpath gives the same separation in one package.
- Removing script-tag / Pages entirely — still useful for no-bundler HTML prototypes.
- Re-init on prop changes — unsafe mid-session; mount-once matches today's `claimInit`.
- Replacing HTML `demo/` with React only — keep both paths proven.
- **Making `init()` internal / React-only root** (the original decision) — it would drop the documented npm path for non-React bundled apps, force `react` to resolve just to import `version`, and be a breaking change at 1.0.0 (a major bump would also move the Pages `/v1/` URL, `scripts/build.mjs:11-13`).
- **"Activate-once" (re-evaluate `activate` until true, then lock)** — changes `claimInit` semantics for both entries; conditional mount solves the async case with zero new semantics.
- **Dev-only "props changed" `console.warn`** — esbuild defines `process.env.NODE_ENV` as `"production"` under `minify` (`scripts/build.mjs:20`), so a `NODE_ENV`-gated warning is stripped from `dist/` and can never fire; reference comparison would also fire every render for inline `tasks={[…]}`.
- **JSX source for the component** — it renders `null`; JSX would add a `.jsx` file Node's test runner can't import (`ERR_UNKNOWN_FILE_EXTENSION`) and a JSX-mode build setting, for no benefit.

## Goal

A React app can:

```sh
npm i -D github:joesteinkamp/local-session-replay
```

```jsx
import { TestKit } from 'local-session-replay/react';

export default function App() {
  return (
    <>
      <TestKit
        study="grid-filters-v2"
        tasks={[
          { id: 'filter', prompt: 'Filter to healthcare companies' },
        ]}
      />
      <YourPrototype />
    </>
  );
}
```

Mount `<TestKit />` **first** (before the prototype) so its effect reads `?test=1` before any sibling effect — e.g. a router redirect — can strip the query string.

Open with `?test=1` (or a custom `activate` prop), run the session, download the same self-contained HTML export. No separate TestKit Pages project required for this path.

Non-React bundled apps keep today's path unchanged: `import { init } from 'local-session-replay'`.

## Scope

### 1. `<TestKit />` component

- Plain `.js` (no JSX): `useEffect(() => { boot(props) }, [])` and `return null`. Overlay remains Shadow DOM.
- Props = current `TestKitConfig` (`study`, `tasks`, `activate`, `audio`, `mask`, and the rest of the config reference).
- Entry module starts with `'use client'` so Next App Router server files can import it. esbuild preserves the directive **only at the top of an entry file**, so it lives in `src/react/index.js`, not only in a module it imports.
- Respect existing activation (`?test=1`, `?test=0`, fresh in-progress session, `activate` function/boolean), evaluated **once, at mount**.
- Async activation (auth, feature flags): document `{isTester && <TestKit … />}`. A boolean `activate` that is `false` on first commit consumes the one-per-page claim and never activates.
- Next App Router: functions can't be passed from a Server Component to a Client Component, so docs show a boolean (`activate={process.env.NODE_ENV !== 'production'}`) or a user-side `'use client'` wrapper for function `activate`.
- Mount-once: StrictMode's double-mount and HMR remounts are absorbed by `claimInit`. Later prop changes are ignored silently (documented).
- Unmount: no teardown — recording continues until the session is stopped; documented.
- SSR-safe: effects don't run on the server; the boot keeps its `typeof window === 'undefined'` guard.

### 2. Package surface

- `local-session-replay` → `{ init, version }` (unchanged; no React import).
- `local-session-replay/react` → `{ TestKit, version }`.
- Shared internal boot module holds today's `init()` body. Both entries call it; `src/index.js` re-exports it as `init`.
- Boot keeps setting `window.TestKit = { init, version }` so `src/core/index.js:19` still attaches `.controller` for debugging and automated checks.
- `package.json`:
  - `exports["./react"]` → `{ types: "./dist/react.d.ts", default: "./dist/react.js" }`.
  - `peerDependencies` `react` / `react-dom` with `peerDependenciesMeta: { react: { optional: true }, "react-dom": { optional: true } }`.
  - `devDependencies` `react`, `react-dom` (for tests and the example).
- Types: `src/react.d.ts` declares `export function TestKit(props: TestKitConfig): null;` and imports `TestKitConfig` from the root types. No `@types/react` dependency for consumers.

### 3. Build (`scripts/build.mjs`)

- Add `src/react/index.js` as a second entry to the existing ESM package build (same `splitting: true`), so both entries share one core chunk.
- `external: ['react', 'react-dom']` on that ESM build only (subpaths such as `react/jsx-runtime` are covered automatically). Without it the build fails with `Could not resolve "react"`.
- Copy `src/react.d.ts` → `dist/react.d.ts` alongside `index.d.ts`.
- The host does **not** re-run TestKit's CSS/player bundling steps — `prepare` emits everything into `dist/`.

### 4. Docs and plan correction

- **README:** Agentation-style `npm i` + `<TestKit />` first (with the mount-first, conditional-mount, Next, and unmount notes); `init()` for non-React bundled apps second; script-tag + Pages under "also supported."
- **`testkit-plan.md`:** Phase 6 / Later — distribution is **in-app npm**; React component is the primary integration, not an optional afterthought. Pages is a secondary distribution for HTML-only hosts. *Precondition:* this file is untracked in the primary checkout and absent from the worktrees — commit it to `main` (or move it under `docs/`) before this step.
- **`docs/CONTRACTS.md`:** layout/ownership for `src/react/index.js` and the shared boot module; both public export contracts; the `window.TestKit` global; mount-once and unmount semantics.

### 5. `examples/react/`

- Minimal Vite + React app beside a tiny prototype UI, mounting `<TestKit study tasks … />` first.
- Depend on the local package via **npm workspaces** (hoists a single React; avoids duplicate-React "invalid hook call"). If a `file:` link is used instead, add `resolve.dedupe: ['react', 'react-dom']` to the Vite config.
- A `file:`/workspace link doesn't run `prepare`, so the run path builds first: `npm run build && npm run example:react`.

### 6. Tests

| Layer | How |
| :-- | :-- |
| Boot logic (mount-once, inactive, server no-op, global) | Existing `node:test` harness against the boot module; `test/index.test.js` stays green unchanged |
| Component SSR no-op | `node:test` + `react-dom/server` `renderToString(createElement(TestKit, …))` — no DOM needed |
| Built artifact | After `npm run build`: `dist/react.js` starts with `'use client'`, imports `react` as a bare specifier (not bundled), and core remains a separate chunk shared with `dist/index.js` |
| End-to-end (Done when #2) | `playwright-cli` against `examples/react` with `?test=1` (fake media flags for the mic): start → complete a task → stop → export downloads |
| Regression | Existing unit tests; HTML `demo/` via script tag |

## Out of scope

- Controller / session-state React hook
- Removing GitHub Pages or the script-tag loader
- Publishing to the npm registry (stay on GitHub install unless decided later)
- In-session flagging, Whisper transcription, React-specific annotate APIs
- Teardown / `destroy()` on unmount
- A runtime "props changed" warning

## Implementation sketch

```
src/boot.js              # today's init() body (claim, global, activation, dynamic import)
src/index.js             # export { init, version } — init delegates to boot; no React import
src/react/index.js       # 'use client'; export { TestKit, version }
src/react/TestKit.js     # useEffect → boot(props); return null
src/react.d.ts           # TestKit(props: TestKitConfig): null
examples/react/          # Vite + React proof app (npm workspace)
scripts/build.mjs        # second ESM entry, react externals, copy react.d.ts
```

Script-tag loader (`src/loader.js` → `public/v1/testkit.js`) keeps using internal `start` / `__TestKitCore` unchanged.

## Done when

1. A React app installs the package and uses **only** `<TestKit … />` from `local-session-replay/react`.
2. `examples/react/` runs a full session with `?test=1`, verified by a `playwright-cli` run (start → task → stop → export).
3. `dist/react.js` begins with `'use client'` and does not bundle React; `dist/index.js` does not import React.
4. README, `testkit-plan.md`, and `docs/CONTRACTS.md` describe in-app install as primary.
5. Existing unit tests pass unchanged; the new component and artifact tests pass; the HTML script-tag demo still works.

## Implementation order

1. Commit `testkit-plan.md` to `main` so later steps can edit it on a branch.
2. Extract `src/boot.js` from the current `init()`; `src/index.js` delegates to it (existing tests stay green).
3. Add `src/react/` + `react.d.ts`; add the `./react` export, optional peers, and React devDeps.
4. Wire `scripts/build.mjs` (second entry, externals, d.ts copy); add artifact tests.
5. Add the component SSR test.
6. Add `examples/react/` (workspace) and the README primary path; run the `playwright-cli` end-to-end check.
7. Update contracts + `testkit-plan.md` distribution narrative.
8. Full regression: unit suite + script-tag demo.

## Revision notes (2026-10-07, Claude)

Changes from Cursor's agreed version, from a code-grounded review (findings reproduced with esbuild 0.28.2 / Node 24 unless noted):

- **Reversed:** "`init()` internal / `<TestKit />` only" → React on a `./react` subpath, `init` stays public. Keeps non-React bundled apps working, keeps the root free of React, avoids a breaking change.
- **Fixed:** component is plain `.js` (the `.jsx` re-export broke `test/index.test.js` under Node); `react`/`react-dom` external in the build (otherwise `Could not resolve "react"`); `'use client'` at the top of the React entry.
- **Added:** conditional-mount guidance for async activation; Next function-prop limitation; mount-first placement; unmount semantics; `window.TestKit` global contract; types without `@types/react`; workspace-based example with build-first run path; a concrete test matrix and a verification method for Done-when #2; the `testkit-plan.md` commit precondition.
- **Dropped:** the dev prop-change warning (stripped by minify and noisy by reference).
- **Unverified (rests on docs):** the exact Next.js RSC error text, Vite duplicate-React behavior over `file:` links, React Router redirect timing, `prepare` behavior for `file:` deps on the installed npm.
