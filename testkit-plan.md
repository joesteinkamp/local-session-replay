# TestKit: Local Session Replay & Think-Aloud Toolkit for Prototypes

**Status:** Draft plan
**Owner:** TBD (Design Engineering)
**Working name:** TestKit

## Goal

A drop-in toolkit for GitLab Pages prototypes that overlays a lightweight testing UI. A facilitator or tester starts a session, works through scripted tasks while thinking aloud, and stops. The browser downloads a single self-contained file containing the session replay, audio, and an agent-ready summary. No backend, no third-party services, and no data leaves the machine.

## Why rrweb (and not PostHog or OpenReplay)

PostHog and OpenReplay are full platforms built around backend ingestion and storage. PostHog's replay is itself built on rrweb. Both would mean running infrastructure just to get back to a local file.

rrweb is the recording primitive. It emits a JSON event stream (a full DOM snapshot plus incremental mutations and input events) that can be held in memory, persisted locally, and replayed with rrweb-player. This is a direct fit for static GitLab Pages hosting.

## Inspiration

**Agentation** (benjitaylor/agentation)
- Drop-in, single-mount toolbar that stays out of the way until activated.
- Captures selectors and element positions so output maps to real code. TestKit adopts this for its interaction log.
- Structured, copyable output aimed at AI agents.
- *Caveats:* React-only, and licensed under PolyForm Shield. Use it as inspiration only, not code.

**DialKit** (joshpuckett/dialkit)
- Framework-neutral core with thin per-framework adapters.
- Hidden in production by default, with explicit opt-in.
- Draggable collapsed bubble that snaps to the nearest side when opened.
- Declarative config object as the primary API.
- Timeline dock with a scrubbable overview, a reference for the replay player's task-marker timeline.
- "Copy" produces agent-ready instructions. TestKit's summary export follows the same idea.

## Architecture

```
prototype page
 ├─ <script src=".../testkit/v1/testkit.js">
 └─ TestKit
     ├─ Overlay UI (Shadow DOM, excluded from recording)
     ├─ DOM recorder (rrweb)
     ├─ Interaction log (selectors, inputs, nav, errors)
     ├─ Audio recorder (MediaRecorder)
     ├─ Session store (IndexedDB; survives navigation & reloads)
     └─ Exporter → single self-contained .html
```

## Phases

### Phase 1: Recorder core

- Vanilla JS, framework-agnostic, with a pinned rrweb version.
- rrweb `record()` defaults:
  - `maskAllInputs: true` (configurable)
  - `checkoutEveryNms` for periodic full snapshots
  - Inline stylesheets and images so replays survive prototype redeploys
- **Interaction log** in parallel with rrweb: clicks, inputs (masked), navigation, console errors, and unhandled rejections, each with a generated selector and timestamp. rrweb references internal node IDs, so this log is what makes the output human-readable and agent-readable.
- **Session continuity:** persist session ID, events, and log to IndexedDB in chunks. Resume automatically on the next page load and stitch segments at export. This covers multi-page prototypes, crashes, and accidental reloads.

### Phase 2: Overlay UI

- Rendered in a Shadow DOM for style isolation, and excluded via `blockSelector`.
- Draggable collapsed bubble that snaps to the nearest side when opened.
- States: Idle → Pre-flight → Recording (task N of M) → Stopped / Exporting.
- Controls: Start, Next task, Pause, Mute mic, Stop.
- Always-visible indicators: recording (screen + mic) and elapsed time.
- Shows the current task prompt.
- Activated only via `?test=1` or an explicit flag. Never visible to casual viewers.

### Phase 3: Declarative test config

```js
TestKit.init({
  study: 'grid-filters-v2',
  activate: 'query',            // ?test=1
  audio: { enabled: true, bitrate: 32000 },
  mask: { inputs: true },
  tasks: [
    { id: 'filter', prompt: 'Filter to healthcare companies' },
    { id: 'export', prompt: 'Export the current view' },
  ],
});
```

- Each task boundary is written as an rrweb custom event (`addCustomEvent`) and becomes a marker in the replay.
- Optional per-task fields to consider: `successHint`, `timeLimit`, and `followUp` (a post-task question).

### Phase 4: Think-aloud audio

**Capture**
- `getUserMedia` with `echoCancellation` and `noiseSuppression` enabled.
- `MediaRecorder` with the format detected via `isTypeSupported()`: Opus/WebM in Chrome and Firefox, AAC/MP4 in Safari.
- Explicit bitrate (~32 kbps). Don't accept browser defaults.
- **Pre-flight step** before Start: a consent line, a live mic level meter, and a "say something" check. This catches dead mics before a session is lost.
- Mute/pause toggle, with an always-visible mic indicator.

**Sync**
- Stamp each audio segment with the same wall-clock time base that rrweb uses.
- In the player, the audio element follows the replayer: seek, play, pause, and speed changes.

**Multi-page continuity**
- `MediaRecorder` stops on navigation. Record with a timeslice (chunks every few seconds) into IndexedDB, restart on the next page, and stitch by timestamp.
- Expect 1–2 seconds of silence per navigation, and mark these gaps on the timeline.
- **Risk:** some browsers (notably Safari) may re-prompt for mic permission on each page. Validate early. Audio-heavy studies may favor SPA-style prototypes.

**Size**
- ~15 MB/hour at 32 kbps. Base64 embedding adds ~33%. A 45-minute session lands around 15 MB total, which is acceptable.

### Phase 5: Export

- **One self-contained HTML file**, so there are no multiple-download prompts and no loose files.
- Contents:
  - rrweb-player with a task-marker timeline and synced audio
  - Stitched rrweb events
  - Audio segments
  - Metadata: study, prototype URL, commit SHA, browser, viewport, timestamps
  - Interaction-log summary
- In-file actions: download raw JSON, and copy the agent-ready summary.
- **Agent-ready summary** (markdown, per task): duration, selector-level interaction trail, errors, and signals such as rage clicks, backtracking, and long idle periods.

### Phase 6: Distribution

- The toolkit lives in its own GitLab Pages project.
- Prototypes include it with a single `<script>` tag.
- Versioned paths (`/v1/testkit.js`), so updates never break older prototypes.
- Short README covering setup, config reference, and a facilitator checklist.

### v1.5: Local transcription

- **Don't use the Web Speech API.** Chrome's implementation sends audio to Google's servers, which breaks the local-only guarantee.
- Run Whisper in-browser via transformers.js (WASM/WebGPU) as a post-processing step *inside the exported player*. "Transcribe" runs on the viewer's machine.
- Timestamped transcript aligned to the replay, merged into the per-task summary. The interaction trail shows what the tester did, and the transcript shows why.

### Later

- In-session flagging ("this is confusing") on an element, borrowing Agentation's annotate interaction.
- Optional React adapter, if prototypes need tighter integration.
- Optional drop into a shared Drive folder. The file format stays unchanged.

## Known limitations

- Cross-origin iframes and WebGL don't record well. Canvas requires `recordCanvas` and is heavy.
- Assets loaded from relative paths, especially fonts, are the most common replay-fidelity gap. Test inlining per prototype.
- Desktop browsers are the primary target.

## Privacy & consent

- Inputs masked by default.
- Explicit consent at pre-flight for screen and mic recording.
- All data stays in the browser until the user downloads the file. There is no network egress from the toolkit.

## Open decisions

1. **Moderated vs. unmoderated:** who advances tasks? Unmoderated needs stronger guardrails and clearer prompts.
2. **Transcript persistence:** after transcription, re-save into the HTML (one artifact) or export a separate `.md`?
3. **Safari mic re-prompting:** validate early. This may shape the guidance for multi-page prototypes.

## v1 scope

Phases 1–6. Transcription follows as v1.5.
