# TestKit

Local session replay and think-aloud recording for GitLab Pages prototypes.
Add one `<script>` tag, open the prototype with `?test=1`, run through scripted
tasks while thinking aloud, and download **one self-contained HTML file** with
the replay, synced audio, and an agent-ready summary.

No backend, no third-party services. Nothing leaves the tester's machine until
they download the file.

## Setup

```html
<script src="https://<group>.gitlab.io/testkit/v1/testkit.js"></script>
<script>
  TestKit.init({
    study: 'grid-filters-v2',
    tasks: [
      { id: 'filter', prompt: 'Filter to healthcare companies' },
      { id: 'export', prompt: 'Export the current view' },
    ],
  });
</script>
```

Put both tags on **every page** of a multi-page prototype (a shared
`testkit-config.js` works well — see `demo/`). Pin the versioned path (`/v1/`);
breaking changes ship under a new version so existing prototypes keep working.

`testkit.js` is a ~1 KB loader. The recorder (`testkit-core.js`) is only
fetched when testing is active, so casual viewers pay nothing.

## Config reference

| Option | Default | Notes |
| :-- | :-- | :-- |
| `study` | `'untitled-study'` | Used in the export filename and header. |
| `activate` | `'query'` | `'query'` = show with `?test=1`; `true`/`false`; or a function returning a boolean. `?test=0` always disables. An in-progress session stays active across navigation without the query param. |
| `audio` | `{ enabled: true, bitrate: 32000 }` | `audio: false` disables the mic entirely. ~15 MB/hour at 32 kbps. |
| `mask` | `{ inputs: true }` | Masks typed values in the replay and the interaction log. |
| `checkoutEveryNms` | `60000` | Periodic full DOM snapshots, so seeking stays fast. |
| `commitSha` | `<meta name="testkit:commit">` | Recorded in the export metadata. In CI, template `$CI_COMMIT_SHA` into the meta tag. |
| `tasks[]` | `[]` | `{ id, prompt, successHint?, timeLimit?, followUp? }`. `timeLimit` is seconds (a gentle nudge, never auto-advances). `followUp` asks a question after the task. `successHint` is shown behind a disclosure and in the summary as "Expected". |

## Running a session (facilitator checklist)

1. Use desktop Chrome, Firefox, or Safari. Close unrelated tabs.
2. Open the prototype with `?test=1`. Click the TestKit bubble → **Start test session**.
3. Pre-flight: read the consent line aloud, tick consent, allow the mic, and
   say something until the level check passes. (Or continue without audio.)
4. Give the tester control. They read the task, think aloud, and click
   **Next task** when done. Works moderated or unmoderated: whoever has the
   keyboard advances.
5. **Pause** for interruptions, **Mute** for side conversations.
6. After the last task (or **Stop**), click **Download session file**. Then
   **Discard** to clear the data from the browser.

Reloads, crashes, and page navigations resume the same session automatically.
Expect 1–2 s of silence in the audio at each page load (marked on the timeline).

## The export

Open the downloaded `.html` file in any browser, offline:

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
npm run build     # → public/v1/{testkit,testkit-core,testkit-player}.js + public/demo/
npm run serve     # build, then serve public/ on :8080 → /demo/index.html?test=1
```

Module boundaries and data formats are in `docs/CONTRACTS.md`.
`scripts/fixture-export.mjs` writes a synthetic export for working on the player.
GitLab CI (`.gitlab-ci.yml`) tests, builds, and publishes `public/` to Pages on the
default branch.

## Known limitations

- Cross-origin iframes and WebGL don't record well; canvas isn't recorded.
- Assets loaded from relative paths (fonts especially) are the most common
  replay-fidelity gap. Stylesheets and same-origin images are inlined;
  check a replay per prototype.
- Safari may re-prompt for mic permission on each page load of a multi-page
  prototype. If the tester declines, recording continues without audio.
  Audio-heavy studies are smoother on single-page prototypes.
- Desktop browsers are the primary target.
- Transcription (in-browser Whisper) is planned for v1.5.
