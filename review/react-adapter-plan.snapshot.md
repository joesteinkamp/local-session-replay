# Plan: Agentation-style React install

**Status:** Agreed (grill-me, 2026-10-07)
**Branch / worktree:** `ai/cursor` → `../local-session-replay-cursor`
**Supersedes (narrative):** `testkit-plan.md` Phase 6 framing TestKit as its own Pages project, and the "Later → Optional React adapter" bullet as a thin afterthought.

## Problem

The original plan treated TestKit as a **separate hosted script** (own GitLab/GitHub Pages project) that prototypes load with `<script src="…/testkit.js">`. The desired model is **Agentation / DialKit-style**: install the package into the app under test, mount a React component, and let the host bundler own the code.

The repo already supports `npm i` from GitHub and `import { init } from 'local-session-replay'` with a dynamic import of the recorder. What's missing is the **React component as the public API** and making **in-app install the primary story**.

## Decisions (locked)

| Topic | Choice |
| :-- | :-- |
| Public API | `<TestKit />` only — no controller/state hook in v1 |
| `init()` | Becomes **internal**; not part of the public export / docs |
| Install model | npm into the host app (like Agentation), not a remote toolkit host |
| Package shape | **Single package**; React component is the public API |
| Core loading | Keep today's **dynamic `import()`** of core so the host splits a chunk; casual viewers who never mount/activate don't pay for rrweb |
| Script-tag / Pages | **Secondary** for plain HTML multi-page demos; keep working, demote in docs |
| Config lifecycle | **Mount-once**; first props win; ignore later prop updates |
| Example | README + **`examples/react/`** Vite app; keep HTML `demo/` for script-tag |
| React | `peerDependencies`: `react` and `react-dom` `^18.0.0 \|\| ^19.0.0` (do not bundle React) |

### Rejected alternatives

- Controller `useTestKit()` hook — not needed until apps drive session UI/flow themselves.
- Remote loader / required `src` URL — wrong distribution model for React apps.
- Bundling core into the main chunk with no split — taxes every visitor; dynamic import already matches Agentation install while preserving cost.
- Dual packages (`@testkit/core` + `@testkit/react`) — extra moving parts for one consumer shape.
- Removing script-tag / Pages entirely — still useful for no-bundler HTML prototypes.
- Re-init on prop changes — unsafe mid-session; mount-once matches today's `claimInit`.
- Replacing HTML `demo/` with React only — keep both paths proven.

## Goal

A React app can:

```sh
npm i -D github:joesteinkamp/local-session-replay
```

```jsx
import { TestKit } from 'local-session-replay';

export default function App() {
  return (
    <>
      <YourPrototype />
      <TestKit
        study="grid-filters-v2"
        tasks={[
          { id: 'filter', prompt: 'Filter to healthcare companies' },
        ]}
      />
    </>
  );
}
```

Open with `?test=1` (or a custom `activate` prop), run the session, download the same self-contained HTML export. No separate TestKit Pages project required for this path.

## Scope

### 1. `<TestKit />` component

- Props = current `TestKitConfig` (`study`, `tasks`, `activate`, `audio`, `mask`, and the rest of the config reference).
- Client-only: `useEffect` calls internal boot once; component renders `null` (overlay remains Shadow DOM).
- Respect existing activation (`?test=1`, `?test=0`, fresh in-progress session, `activate` function/boolean).
- Stable placement at the app root; ignore prop updates after mount (optional `console.warn` in development).
- SSR-safe: no-op when `typeof window === 'undefined'` (same guard as today's package entry).

### 2. Package surface

- Public export: `{ TestKit, version }` (plus TypeScript types).
- `init` is not exported from the package entry, `.d.ts`, or README.
- Internal boot module holds today's `init()` logic for the component and, if needed, the script-tag path's shared activation/boot helpers.
- Build emits the compiled component into `dist/` via existing `prepare` / `scripts/build.mjs` (host does **not** re-run TestKit's CSS/player bundling steps).
- Add `react` / `react-dom` peerDependencies as above.

### 3. Docs and plan correction

- **README:** Agentation-style `npm i` + `<TestKit />` first; script-tag + Pages under "also supported."
- **`testkit-plan.md`:** Phase 6 / Later — distribution is **in-app npm**; React component is the primary integration, not an optional afterthought. Pages is a secondary distribution for HTML-only hosts.
- **`docs/CONTRACTS.md`:** layout/ownership for the React entry; public export contract; note `init` is internal.

### 4. `examples/react/`

- Minimal Vite + React app depending on the local package (workspace / `file:` / relative install).
- Mount `<TestKit study tasks … />` beside a tiny prototype UI.
- Documented run path (e.g. `npm run example:react` or `cd examples/react && npm i && npm run dev`).

### 5. Tests

- Component wrapper: boots once; second mount no-ops; safe without `window`.
- Prefer the smallest harness that fits the repo (`node:test` if viable; otherwise a focused runner only where needed).
- Existing core/unit tests and HTML `demo/` / script-tag path remain green.

## Out of scope

- Controller / session-state React hook
- Removing GitHub Pages or the script-tag loader
- Publishing to the npm registry (stay on GitHub install unless decided later)
- In-session flagging, Whisper transcription, React-specific annotate APIs

## Implementation sketch

```
src/react/TestKit.jsx    # public component
src/boot.js              # today's init() body; not exported
src/index.js             # export { TestKit, version }
src/index.d.ts           # TestKit props + version
examples/react/          # Vite + React proof app
scripts/build.mjs        # emit React entry into dist/
```

Script-tag loader (`src/loader.js` → `public/v1/testkit.js`) keeps using internal `start` / `__TestKitCore` unchanged.

## Done when

1. A React app installs the package and uses **only** `<TestKit … />` (no public `init`).
2. `examples/react/` can run a full session with `?test=1`.
3. README, `testkit-plan.md`, and `docs/CONTRACTS.md` describe in-app install as primary.
4. Existing unit tests pass; HTML script-tag demo still works.

## Implementation order

1. Extract internal boot from the current public `init()`.
2. Add `<TestKit />` + types; switch package exports.
3. Wire `scripts/build.mjs` / peers / `files` as needed.
4. Add `examples/react/` and README primary path.
5. Update contracts + `testkit-plan.md` distribution narrative.
6. Tests for mount-once / SSR no-op; regression on existing suite.
