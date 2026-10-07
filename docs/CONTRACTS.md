# TestKit module contracts

Source of truth for the interfaces between modules. Spec: `testkit-plan.md` (kept
in the integration checkout). If you need to change a contract, change this file
in the same edit and say so in your report.

## Ground rules

- Vanilla ES modules, no framework, no TypeScript. Browser targets: current
  Chrome, Firefox, Safari (desktop).
- **No network egress.** No `fetch`/XHR/beacon/WebSocket to anything, ever. The
  only network activity TestKit causes is the loader injecting
  `testkit-core.js` from its own base URL.
- **One time base:** every timestamp is wall-clock `Date.now()` milliseconds —
  the same clock rrweb stamps events with.
- Bundled by esbuild (`scripts/build.mjs`). Import packages by name (`rrweb`,
  `rrweb-player`). Do not add dependencies without saying so.

## Layout & ownership

```
src/loader.js              → public/v1/testkit.js        (lead)
src/core/index.js          → public/v1/testkit-core.js   (lead: wiring/boot)
src/core/config.js                                       (lead)
src/core/store.js, session.js, recorder.js,
src/core/interaction-log.js, selector.js, audio.js       (data/recorder agent)
src/overlay/**                                           (overlay agent)
src/export/**, src/player/** → public/v1/testkit-player.js (export/player agent)
demo/**, scripts/**, .gitlab-ci.yml, README.md           (lead)
test/<module>.test.js     — each agent owns tests for its own modules (node:test)
```

## Config (`src/core/config.js` → `normalizeConfig(userConfig)`)

```js
{
  study: string,                     // required-ish; default 'untitled-study'
  activate: 'query' | boolean | () => boolean,   // default 'query' (?test=1)
  audio: { enabled: boolean, bitrate: number },  // default { true, 32000 }
  mask: { inputs: boolean },                     // default { true }
  checkoutEveryNms: number,                      // default 60000
  inlineImages: boolean,                         // default true; false for cross-origin images without CORS (rrweb reloads them with crossOrigin)
  commitSha: string | null,          // default: <meta name="testkit:commit">, else null
  tasks: [{ id, prompt, successHint?, timeLimit? /*seconds*/, followUp? /*string*/ }],
}
```

## IndexedDB (`src/core/store.js`)

DB `testkit`, version 1. Object stores:

| store | key | indexes | value |
| :-- | :-- | :-- | :-- |
| `sessions` | `id` | — | `SessionRecord` |
| `events` | autoInc | `sessionId` | `{ sessionId, segmentId, ts, events: rrwebEvent[] }` (chunk) |
| `log` | autoInc | `sessionId` | `LogEntry & { sessionId }` |
| `audio` | autoInc | `sessionId` | `{ sessionId, audioSegmentId, seq, ts, startTs, mime, blob }` (`ts` = chunk arrival; `startTs` = its segment's start) |

Pointers are scoped **per study** (`<study>` = normalized `config.study`), so
several prototypes on one origin never resume each other's sessions:

- `localStorage['testkit:active:<study>']` = JSON `{ id, study, lastActivityAt }` for
  the in-progress session (absent when none), refreshed on every controller update
  and every 15 s while recording/paused. The loader parses it synchronously to stay
  active across navigation without `?test=1`, **only if `lastActivityAt` is under
  30 min old** (`STALE_MS`, shared by loader and controller). A page whose study
  differs ignores it and never touches it. A stale session is never resumed: if
  the page is activated anyway (`?test=1`), boot marks it `stopped` at
  `lastActivityAt` (logging `task-end {completed:false, reason:'stale'}` and
  `session-end {reason:'stale'}`) and moves it to `testkit:last:<study>`.
- `localStorage['testkit:last:<study>']` = id of the most recent *stopped* session
  that hasn't been discarded, so a reload (with `?test=1`) can still export it.
- `localStorage['testkit:mirror:<sessionId>']` = `{ id, rev, fields }`: a synchronous
  copy of the session's phase/task/pause/mute fields, written on every controller
  update. IndexedDB writes still in flight at unload are aborted, so when restoring,
  the controller applies the mirror if its `rev` is newer than `SessionRecord.rev`.
  Cleared on stop (after the final write lands) and on discard.
- `sessionStorage['testkit:spill:<sessionId>']` = `{ events: [chunk], log: [entry] }`:
  on pagehide, rows of every unfinished write batch are copied here synchronously
  (log-only if events exceed the quota) and imported into IndexedDB by the next
  boot before anything else, then removed. Every event chunk and log row carries
  a deterministic string key `id` (`<batchId>:e<n>` / `<batchId>:l<n>`) and is
  written with `put`, so a row that also committed from pagehide is imported idempotently.

```js
SessionRecord = {
  id, study, createdAt, startedAt|null, endedAt|null,
  phase: 'preflight'|'recording'|'paused'|'stopped',
  taskIndex,                       // -1 before first task
  tasks,                           // config.tasks snapshot
  config,                          // normalized config snapshot
  meta: { prototypeUrl, commitSha, userAgent, viewport:{w,h}, consentAt },
  segments: [{ segmentId, url, startedAt }],   // one per page load
  audio: { enabled, mime|null },  // enabled = mic actually in use (false if declined/denied)
  muted: boolean,
  pausedMs,                        // accumulated paused time (survives reloads)
  pausedAt|null,                   // start of the current pause
  taskStartedAt|null,              // current task start, shifted forward by pauses
  tasksCompleted,                  // tasks ended via nextTask()
  rev,                             // bumped on every controller update (see testkit:mirror)
  lastActivityAt,                  // refreshed on every controller update and ~15 s heartbeat
}
```
`phase: 'preflight'` is never persisted — preflight is in-memory only.

Store API (all async):
`openStore()`, `createSession(rec)`, `getSession(id)`, `updateSession(id, patch)`,
`appendEvents(sessionId, segmentId, events[])`, `appendLog(sessionId, entry)`,
`appendAudio(sessionId, chunk)`, `loadSessionData(id) → { session, events, log, audio }`
(events flattened and sorted by `timestamp`; log sorted by `ts`; audio grouped:
`[{ audioSegmentId, startTs, endTs, mime, blob }]` with chunks concatenated in `seq` order),
`deleteSession(id)`.
Also: `flush()` (write buffered events/log now; never rejects), `onError(fn) → off`
(write failures given up on after retries), `lastAudioChunk(sessionId)`,
`getActivePointer(study) → { id, study, lastActivityAt } | null`, `getActiveSessionId(study)`,
`setActiveSessionId(study, id, lastActivityAt = now)`, `clearActiveSessionId(study)`,
`spill()` (sync, pagehide) and `importSpill() → rowsImported`,
the same three for `LastSessionId`, `get/set/clearSessionMirror(id | mirror)`, and the
pure helper `elapsedMsFor(sessionRecord, now)`. `appendEvents`/`appendLog` buffer in
memory and resolve once written (≤2 s, immediately after a full snapshot, and on
pagehide / visibilitychange→hidden); they never reject. `flush()` resolves only
after every batch — including earlier ones waiting on a retry — has landed or
been given up on; `deleteSession(id)` tombstones the id so pending retries can't
re-create its rows.

## Log entry (`src/core/interaction-log.js`)

```js
LogEntry = {
  ts, type, url, taskId|null,
  selector?, text?,          // element selector & trimmed visible label (<=80 chars)
  x?, y?,                    // viewport coords for clicks
  value?,                    // inputs: '***' when masked, otherwise value (<=200 chars)
  message?, stack?,          // errors
  from?, to?, navType?,      // navigation: 'load'|'pushState'|'replaceState'|'popstate'|'hashchange'|'beforeunload'
  answer?,                   // followUp
  source?,                   // error/rejection: 'window'|'resource'|'console'|'promise'
  gapStart?, gapMs?,         // audio-gap: last stored audio chunk ts (else previous page's start, else session start), gap length (null if mic unavailable)
  completed?,                // task-end: true when ended via nextTask(), false when the session was stopped mid-task
  reason?,                   // task-end/session-end: 'stale' when boot stopped an abandoned session
}
type ∈ 'click'|'input'|'change'|'submit'|'nav'|'error'|'rejection'|
       'session-start'|'session-resume'|'task-start'|'task-end'|'followup'|
       'pause'|'resume'|'mute'|'unmute'|'audio-gap'|'session-end'
```

Events originating inside the overlay (its shadow host carries class
`testkit-block`) are never logged. Input values: `'***'` when masked and
non-empty, `''` when empty; passwords always masked; checkbox/radio log
`'true'`/`'false'` even when masking (as rrweb records checked state).
`console.error` calls are logged as `error` with `source: 'console'`; only the
first argument is kept (string or Error message, clipped to 200 chars; objects
become a type label such as `[Object]`), since prototypes often log form state.
Nothing is logged after `session-end`. In rrweb, hidden inputs are always
masked; password always; all other inputs when `mask.inputs`.

## rrweb custom events

Every task boundary/control is also written with `rrweb.record.addCustomEvent(tag, payload)`
so it appears in the replay stream. Tags: `testkit:task-start {taskId,index,prompt}`,
`testkit:task-end {taskId,index,completed}`, `testkit:pause`, `testkit:resume`,
`testkit:mute`, `testkit:unmute`, `testkit:session-end`.

## Controller (`src/core/session.js` → `createController({ config, store, deps? })`)

`deps` optionally replaces `{ createRecorder, createInteractionLog, createAudioCapture }`
(tests inject fakes); it defaults to the real modules.

The overlay talks only to this object.

```js
controller.getState() → {
  phase: 'idle'|'preflight'|'recording'|'paused'|'stopped'|'exporting',
  sessionId|null, study, tasks, taskIndex, startedAt|null,
  elapsedMs,                    // recording time, excluding paused time
  taskStartedAt|null,           // for timeLimit countdown
  muted,
  audio: { enabled, status: 'off'|'pending'|'live'|'muted'|'denied'|'error', error|null },
  otherTab,                     // true when another tab is capturing this session (read-only here)
  error|null,
}
controller.subscribe(fn) → unsubscribe     // fn(state) on every change
controller.beginPreflight()                // idle → preflight
controller.cancelPreflight()               // preflight → idle (releases mic)
controller.requestMic() → Promise<{ ok, error? }>   // preflight mic test
controller.getMicLevel() → number 0..1     // RMS level, poll from rAF for the meter
controller.start({ consent: true, audio: boolean }) // preflight → recording, task 0 begins
controller.nextTask({ followUpAnswer? })   // ends current task; after last task → stop()
controller.pause() / controller.resume()
controller.toggleMute()
controller.stop()                          // → stopped
controller.exportSession() → Promise<{ filename, bytes }>   // stopped → exporting → stopped; triggers download; rejects on failure (and sets state.error)
controller.discard()                       // deletes session data → idle
```

All methods return promises and are serialized; calls in the wrong phase are
no-ops. `beginPreflight()` is also allowed from `stopped` (the stopped session's
data is kept until discarded). `start()` without `consent: true` sets `error`.
On boot the controller may also land in `stopped` (restored from `testkit:last`).
`getState()` also returns `tasksCompleted` (tasks ended via `nextTask()`, persisted)
and `taskElapsedMs` (current task time excluding paused time) — implementing the
overlay requests below.
`state.audio.enabled` reflects the tester's choice, so a denied mic shows as
`{ enabled: true, status: 'denied' }`. A *dismissed* prompt (Permissions API
reports `prompt` after `NotAllowedError`) shows as `denied` with error
'Microphone prompt was dismissed' and is retried on the next page; only a
confirmed `denied` permission stops the session from asking again.

On boot, if `localStorage['testkit:active:<study>']` names a session of this study in
`recording`/`paused`, the controller resumes it automatically (new segment,
rrweb restarts with a fresh full snapshot, audio restarts — logging
`audio-gap` with the gap duration, or `denied` status if mic access fails).
Capture always uses the session's **saved** `config` (masking, audio, bitrate,
`checkoutEveryNms`, `inlineImages`), never the resuming page's local config.

**One capturing tab per session.** Before resuming, the controller asks
`BroadcastChannel('testkit')` whether another page is capturing the session
(`{type:'ping', id, nonce}` → `{type:'pong', id, nonce}`, 150 ms timeout). If one
answers, this tab stays passive: `state.otherTab = true`,
`state.error = 'Recording is active in another tab'`, phase mirrors the session,
and every mutating method is a no-op. A passive tab re-checks when it becomes
visible and takes over if the owner is gone.

## Audio (`src/core/audio.js`)

MediaRecorder with `timeslice` ≈ 1000 ms (plus `requestData()` when the page is hidden), mime chosen via `isTypeSupported()`
(prefer `audio/webm;codecs=opus`, then `audio/mp4`, then `audio/ogg;codecs=opus`),
`audioBitsPerSecond` = `config.audio.bitrate`. `getUserMedia({ audio: {
echoCancellation: true, noiseSuppression: true } })`. Each MediaRecorder
start/stop span is one **audio segment** (`audioSegmentId`); chunks stored with
`seq` and `ts`; the segment's `startTs` is `Date.now()` at the recorder's
`start` event. Mute = `track.enabled = false` (recorder keeps running, so the
audio clock stays aligned). Pause = stop the segment; resume = new segment.

## Export (`src/export/exporter.js` → `exportSession(data) → Promise<{ filename, blob, bytes }>`)

`data` = `loadSessionData()` output. Produces one self-contained HTML file as a
**`Blob`** (`text/html;charset=utf-8`; `bytes` = `blob.size`). It is assembled
from parts and never exists as one string, so long sessions avoid engine
string limits (peak ≈ 1.6× payload, measured at 150 MB). There is no `html`
string; callers pass the Blob to the download (`URL.createObjectURL(blob)` +
`<a download>`). Contents: inlined player bundle (`PLAYER_JS`, imported as
text — see build), and a `<script type="application/json" id="testkit-data">`
payload (every `<` escaped as `\u003c`, plus U+2028/2029) holding `{ version: 1,
testkitVersion, exportedAt, session, events, log, audio: [{ audioSegmentId,
startTs, endTs, mime, dataUrl }], summaryMarkdown }`. Filename:
`testkit-<study>-<YYYYMMDD-HHmm>.html` (local time of `startedAt`).

The file's CSP is default-deny (`default-src 'none'`; inline script/style;
`data:`/`blob:` images, fonts, media). Remote assets the recording did not
inline do not load in the replay (local-only over fidelity); the player shows
how many were blocked.

`src/export/summary.js` → `buildSummary({ session, log, events, audio? }) → markdown`:
per task: status (completed only when `task-end.completed` is true; falls back
to `session.tasksCompleted`), duration, selector-level trail, errors, signals
(rage clicks: ≥3 clicks on the same selector within 1 s; backtracking:
navigating back to a previously visited URL or `popstate`; long idle: ≥20 s
without log entries while recording; time limit; audio gaps). Audio gaps are
recording time outside pauses not covered by any audio segment (≥0.5 s),
computed from `audio` when given, else from `audio-gap` log entries.

The player bundle (`src/player/player.js`) runs inside the exported file: reads
`#testkit-data`, mounts rrweb-player (`skipInactive: false` when audio exists),
renders task markers on a timeline, syncs `<audio>` to the replayer (seek,
play/pause, speed; paused above 4×), marks audio gaps, and offers "Download raw
JSON" and "Copy agent summary". It exposes `window.TestKitPlayer = { player,
data, seekToWall, getOffset }` for automated checks.

## Build

`scripts/build.mjs` builds, in order:
1. `src/player/player.js` → `public/v1/testkit-player.js` (IIFE, minified, CSS
   injected by the bundle itself — import CSS files as text and append a `<style>`).
2. `src/core/index.js` → `public/v1/testkit-core.js`; the import specifier
   `virtual:player-bundle` resolves to the text of step 1's output
   (`import PLAYER_JS from 'virtual:player-bundle'`).
3. `src/loader.js` → `public/v1/testkit.js`.
4. `demo/` copied to `public/demo/`.

## Overlay (`src/overlay/overlay.js` → `mountOverlay(controller) → { destroy }`)

Called once per page load after `document.body` exists and after
`createController()` resolves (so an auto-resumed session is already in
`recording`/`paused`). Creates a shadow host `<div class="testkit-block"
id="testkit-root">` appended to `<html>` (not `<body>`, so prototype body
re-renders can't remove it). Everything inside the shadow root is excluded from
rrweb (`blockClass: 'testkit-block'`) and from the interaction log.

Overlay-owned storage: `localStorage['testkit:overlay-pos']` = `{ side: 'left'|'right', y }`
(bubble position, survives navigation); `sessionStorage['testkit:overlay-open']` =
`'1'|'0'` (panel expanded, per tab). Key events inside the overlay stop at the shadow
root so prototype shortcuts never fire while typing in it.

## Requests from overlay

None open. `tasksCompleted` and `taskElapsedMs` (requested 2026-10-06) are now part
of the Controller contract above; the overlay prefers them and keeps its local
fallbacks only for older controllers.
