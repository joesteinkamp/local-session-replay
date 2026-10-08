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
src/index.js, index.d.ts   → dist/index.js (package entry) (lead)
src/activation.js          — shared by loader.js and index.js (lead)
src/core/index.js          → public/v1/testkit-core.js   (lead: wiring/boot)
src/core/config.js                                       (lead)
src/core/store.js, session.js, recorder.js,
src/core/interaction-log.js, selector.js, audio.js       (data/recorder agent)
src/overlay/**                                           (overlay agent)
src/export/**, src/player/** → public/v1/testkit-player.js (export/player agent)
demo/**, scripts/**, .github/**, README.md              (lead)
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
  audio: { enabled, mime|null, stopAsking },  // see "Audio state" below
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
`appendAudio(sessionId, chunk)`, `loadSessionData(id) → { session, events, log, audio, audioDropped }`
(events flattened and sorted by `timestamp`; log sorted by `ts`; audio grouped by
`groupAudioChunksReport`: `[{ audioSegmentId, startTs, endTs, mime, blob, seqGaps? }]` with
chunks concatenated in `seq` order; a segment without `seq` 0 is unplayable and moves to
`audioDropped: [{ audioSegmentId, startTs, endTs, mime, chunks, reason: 'missing-first-chunk' }]`;
missing middle `seq` numbers are listed in `seqGaps` and nothing is trimmed — see
`docs/audio-matrix.md`), `loadAudioReport(id) → { session, log, audio, audioDropped }`
(same grouping, no events; feeds the pre-download line), `deleteSession(id)`.
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
  audio: {
    enabled, stopAsking,        // see "Audio state"
    status: 'off'|'pending'|'reconnecting'|'live'|'muted'|'denied'|'error',
    error|null,
    deviceChanged?, trackMuted?, // observational only (devicechange / track mute)
  },
  savedAudio: { kind: 'recorded'|'gaps'|'none', label, gaps, gapMs, segments, unreliable, dropped } | null,
                                // stopped only: the pre-download verdict (audioReport)
  exportWithoutAudio,           // true after the audio could not be encoded into the file
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
controller.retryMic() → Promise<{ ok, error?, persistent?, stale? }>  // recording/paused; not queued (see Audio state)
controller.continueWithoutMic()            // stopAsking = true, releases the mic, keeps saved audio
controller.stop()                          // → stopped
controller.exportSession({ withoutAudio? }) → Promise<{ filename, bytes, withoutAudio }>   // stopped → exporting → stopped; triggers download; rejects on failure (and sets state.error)
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
confirmed `denied` permission sets `stopAsking`, so the session stops asking.

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
`createAudioCapture({ bitrate, onChunk, onProblem, onObserve })`: `onProblem('ended')`
fires once per stream on track `ended`, on a recorder that stopped without
`stopSegment()`, or when a ~500 ms watch sees no live track while recording (a
locally stopped track never fires `ended`); `onProblem('error', err)` on recorder
`error`. `onObserve('track-mute'|'track-unmute'|'device-change')` is observational.
`acquire()` tears down a dead stream before asking again.

### Audio state (decisions for the recovery increment, 2026-10-08)

1. **Three separate facts.** `SessionRecord.audio.enabled` = the tester chose voice
   at Start (intent; never cleared later). `audio.stopAsking` = don't prompt again
   (confirmed denial, or **Continue without microphone**); Retry clears it. *Saved
   audio* is derived only from persisted segments after grouping — never from
   `enabled`. Records written before `stopAsking` existed: `stopAsking` defaults to
   `enabled === false` (they cleared `enabled` on denial), and reporting ignores
   `enabled` whenever segments exist. The controller asks for the mic only when
   `config.audio.enabled && enabled && !stopAsking`.
2. **`live` means appending.** During a session, `status` is `pending` (first
   acquire / new segment) or `reconnecting` (Retry) until the active segment's
   first chunk is persisted, then `live`. Any failure demotes it to `error` and
   stops the segment: track ended / recorder error / `appendAudio` rejection
   (late failures of an already-stopped segment are ignored). Pause demotes
   `live` → `pending` (segment stopped). Mute is the exception: `muted` shows as
   soon as a segment runs. In preflight a granted mic is `live` (level check only).
3. **One re-acquire primitive** (`reconnectAudio` in session.js) serves
   `retryMic()`, `resume()` after a released stream, and the restart after a
   navigation: await the failed segment's `stopSegment()`, acquire with a
   `generation` staleness check (a stale grant is released), start a segment if
   recording (paused: `resume()` starts it), and log `audio-gap` — `gapMs` on
   success, `null` + `message` on failure. The gap shown to people comes from
   segment coverage; the log entry only supplies the reason. A denial never
   touches saved segments; a confirmed one sets `stopAsking`. `retryMic()` always
   releases the current stream first (after a `devicechange` the old one is
   still live but bound to the previous device), is not
   queued (the prompt can stay open; Stop/Discard bump `generation` and win),
   never re-shows consent, and is a no-op if the tester declined voice at Start.
4. **Pause policy.** Same-page pause stops the segment but holds the stream (no
   re-prompt on resume; the browser's mic indicator stays on). A pause restored
   after navigation/bfcache releases it. Stop, Discard, cancelled setup, Continue
   without audio and Continue without microphone release it, including when a
   permission request resolves afterwards.
5. **Limits and failure copy.** Supported session length: **60 minutes** (about
   14 MB of audio at the default 32 kbps; well inside IndexedDB quota and the
   export's string limits). Exact strings (exported from session.js / payload.js):
   - audio chunk hit IndexedDB quota: *Browser storage is full, so audio stopped
     saving. The screen is still recording; stop and download the session soon.*
   - other audio write failure: *Audio could not be saved: <message>*
   - events/log hit quota (`store.onError`): *Browser storage is full. Stop and
     download the session now; new activity may not be saved.*
   - audio could not be encoded into the export (base64 / string / memory limit):
     *The session file is too large to include the audio. Download the visual
     replay without audio instead.* — `state.exportWithoutAudio` turns on and
     `exportSession({ withoutAudio: true })` builds the visual-only file (payload
     `audioOmitted: true`, summary notes the omission).

Edge cases: Retry while paused re-acquires but starts no segment until Resume;
Retry while a Stop/Discard confirm is open is allowed and is made stale if the
tester then stops or discards; a tab that doesn't own the session ignores Retry
(`otherTab`); laptop sleep or OS revocation that ends tracks surfaces as `ended`
via the watch; SPA route changes never re-acquire automatically (no page load),
so recovery there is Retry only; after a full navigation the restart retries a
failed-but-not-denied mic automatically.

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
startTs, endTs, mime, seqGaps?, dataUrl }], audioDropped, audioOmitted, summaryMarkdown }`. Filename:
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
`audioReport({ session, log, events, audio, dropped }) → { kind, label, gaps, … }`
is the single saved-audio verdict — **Audio recorded** / **Audio recorded with
gaps** / **No audio recorded** — used by the summary (`- Audio saved:` line), the
player header and the overlay's pre-download line, so they share inputs.

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
4. `src/index.js` → `dist/index.js` (ESM, code-split: the dynamic import of
   `src/core/index.js` becomes `dist/chunks/core-*.js`, which exports
   `start(config)`). `src/index.d.ts` and the three `public/v1/` files are
   copied to `dist/`.
5. `demo/` copied to `public/demo/`.

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
