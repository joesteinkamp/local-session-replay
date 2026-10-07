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
| `audio` | autoInc | `sessionId` | `{ sessionId, audioSegmentId, seq, ts, mime, blob }` |

`localStorage['testkit:active']` = id of the in-progress session (absent when none).
The loader reads it synchronously to stay active across navigation without `?test=1`.

```js
SessionRecord = {
  id, study, createdAt, startedAt|null, endedAt|null,
  phase: 'preflight'|'recording'|'paused'|'stopped',
  taskIndex,                       // -1 before first task
  tasks,                           // config.tasks snapshot
  config,                          // normalized config snapshot
  meta: { prototypeUrl, commitSha, userAgent, viewport:{w,h}, consentAt },
  segments: [{ segmentId, url, startedAt }],   // one per page load
  audio: { enabled, mime|null },
  muted: boolean,
}
```

Store API (all async):
`openStore()`, `createSession(rec)`, `getSession(id)`, `updateSession(id, patch)`,
`appendEvents(sessionId, segmentId, events[])`, `appendLog(sessionId, entry)`,
`appendAudio(sessionId, chunk)`, `loadSessionData(id) → { session, events, log, audio }`
(events flattened and sorted by `timestamp`; log sorted by `ts`; audio grouped:
`[{ audioSegmentId, startTs, endTs, mime, blob }]` with chunks concatenated in `seq` order),
`deleteSession(id)`.

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
}
type ∈ 'click'|'input'|'change'|'submit'|'nav'|'error'|'rejection'|
       'session-start'|'session-resume'|'task-start'|'task-end'|'followup'|
       'pause'|'resume'|'mute'|'unmute'|'audio-gap'|'session-end'
```

Events originating inside the overlay (its shadow host carries class
`testkit-block`) are never logged.

## rrweb custom events

Every task boundary/control is also written with `rrweb.record.addCustomEvent(tag, payload)`
so it appears in the replay stream. Tags: `testkit:task-start {taskId,index,prompt}`,
`testkit:task-end {taskId,index}`, `testkit:pause`, `testkit:resume`,
`testkit:mute`, `testkit:unmute`, `testkit:session-end`.

## Controller (`src/core/session.js` → `createController({ config, store })`)

The overlay talks only to this object.

```js
controller.getState() → {
  phase: 'idle'|'preflight'|'recording'|'paused'|'stopped'|'exporting',
  sessionId|null, study, tasks, taskIndex, startedAt|null,
  elapsedMs,                    // recording time, excluding paused time
  taskStartedAt|null,           // for timeLimit countdown
  muted,
  audio: { enabled, status: 'off'|'pending'|'live'|'muted'|'denied'|'error', error|null },
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
controller.exportSession() → Promise<{ filename, bytes }>   // stopped → exporting → stopped; triggers download
controller.discard()                       // deletes session data → idle
```

On boot, if `localStorage['testkit:active']` names a session in
`recording`/`paused`, the controller resumes it automatically (new segment,
rrweb restarts with a fresh full snapshot, audio restarts — logging
`audio-gap` with the gap duration, or `denied` status if mic access fails).

## Audio (`src/core/audio.js`)

MediaRecorder with `timeslice` ≈ 3000 ms, mime chosen via `isTypeSupported()`
(prefer `audio/webm;codecs=opus`, then `audio/mp4`, then `audio/ogg;codecs=opus`),
`audioBitsPerSecond` = `config.audio.bitrate`. `getUserMedia({ audio: {
echoCancellation: true, noiseSuppression: true } })`. Each MediaRecorder
start/stop span is one **audio segment** (`audioSegmentId`); chunks stored with
`seq` and `ts`; the segment's `startTs` is `Date.now()` at the recorder's
`start` event. Mute = `track.enabled = false` (recorder keeps running, so the
audio clock stays aligned). Pause = stop the segment; resume = new segment.

## Export (`src/export/exporter.js` → `exportSession(data) → { filename, html, bytes }`)

`data` = `loadSessionData()` output. Produces one self-contained HTML string:
inlined player bundle (`PLAYER_JS`, imported as text — see build), and a
`<script type="application/json" id="testkit-data">` payload (with `<` escaped
as `<`) holding `{ version: 1, session, events, log, audio: [{ audioSegmentId,
startTs, endTs, mime, dataUrl }], summaryMarkdown }`. The controller performs the
download (`Blob` + object URL + `<a download>`). Filename:
`testkit-<study>-<YYYYMMDD-HHmm>.html`.

`src/export/summary.js` → `buildSummary({ session, log, events }) → markdown`:
per task: duration, selector-level trail, errors, signals (rage clicks: ≥3
clicks on the same selector within 1 s; backtracking: navigating back to a
previously visited URL or `popstate`; long idle: ≥20 s without log entries
while recording).

The player bundle (`src/player/player.js`) runs inside the exported file: reads
`#testkit-data`, mounts rrweb-player (`skipInactive: false` when audio exists),
renders task markers on a timeline, syncs `<audio>` to the replayer (seek,
play/pause, speed), marks audio gaps, and offers "Download raw JSON" and
"Copy agent summary".

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
