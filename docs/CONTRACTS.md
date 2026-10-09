# TestKit module contracts

Source of truth for the interfaces between modules. Spec: `testkit-plan.md` (kept
in the integration checkout). If you need to change a contract, change this file
in the same edit and say so in your report.

## Ground rules

- Vanilla ES modules, no framework, no TypeScript. Browser targets: current
  Chrome, Firefox, Safari (desktop). The one exception is `src/react/`, which
  imports the host's React (plain `.js`, no JSX).
- **No network egress.** No `fetch`/XHR/beacon/WebSocket to anything, ever. The
  only network activity TestKit causes is loading its own code from its own
  origin: the loader injecting `testkit-core.js`, and the core loading the
  replay player: `testkit-player-source.js` from the same folder (script build)
  or the player chunk via the host's bundler (package build). The player is
  **prefetched** once an active session records (successful `start()`, a
  restored recording/paused session, `resume()`) and kept in memory for the
  page (`prefetchPlayer()` in exporter.js), so a tester who goes offline later
  can still download; a failed prefetch is silent and the export loads it again
  (and reports `Export failed: …` if that fails too). Idle pages and casual
  viewers never load it. **Package build:** Chrome caches a failed dynamic
  `import()` for the life of the page (an in-page retry makes no request), so
  the package's `loadPlayerJs()` rejects with `{ name: 'PlayerLoadError',
  reloadToRetry: true }`; `exportSession()` then sets `state.exportNeedsReload`
  and `state.error` to *The replay player couldn’t load. Reload and download
  again — your session is saved.*, and the overlay's download button becomes
  **Reload and retry**: it reloads the current URL with `test=1` set, and the
  stopped session restores from `testkit:last`. The script build keeps the
  in-page retry (a re-injected script is fetched again).
- **One time base:** every timestamp is wall-clock `Date.now()` milliseconds —
  the same clock rrweb stamps events with.
- Bundled by esbuild (`scripts/build.mjs`). Import packages by name (`rrweb`,
  `rrweb-player`). Do not add dependencies without saying so. The player's
  fonts (`@fontsource-variable/inter-tight`, `@fontsource-variable/geist-mono`,
  OFL) are dev dependencies inlined as base64 woff2 (`.woff2` loader), since
  the export's CSP only allows `data:` fonts.

## Layout & ownership

```
src/loader.js              → public/v1/testkit.js        (lead)
src/index.js, index.d.ts   → dist/index.js (package entry `.`) (lead)
src/react/index.js, react/TestKit.js, react.d.ts
                           → dist/react.js (package entry `./react`) (lead)
src/boot.js                — shared boot behind both package entries (lead)
src/activation.js          — shared by loader.js and boot.js (lead)
src/core/index.js          → public/v1/testkit-core.js   (lead: wiring/boot)
src/core/config.js                                       (lead)
src/core/store.js, session.js, recorder.js,
src/core/interaction-log.js, selector.js, audio.js       (data/recorder agent)
src/overlay/**                                           (overlay agent)
src/export/**, src/player/** → public/v1/testkit-player.js (export/player agent)
demo/**, examples/**, scripts/**, .github/**, README.md (lead)
test/<module>.test.js     — each agent owns tests for its own modules (node:test)
```

## Package entries (`local-session-replay`)

In-app npm install is the primary distribution; the script tag (below, Build
step 3) serves plain HTML pages.

```js
import { init, version } from 'local-session-replay';         // src/index.js
import { TestKit, version } from 'local-session-replay/react'; // src/react/index.js
```

- `init(config?) → Promise<void>` is `boot()` from `src/boot.js`: no-op on the
  server; otherwise takes the page-wide claim (`claimInit()`), sets
  `window.TestKit = { init, version }` if absent, and, when `isActivated(config)`,
  dynamically imports `src/core/index.js` and calls `start(config)`. A failed
  chunk import rejects; the claim is not released (reload to retry).
- `<TestKit {...config} />` calls `boot(props)` once from a mount effect
  (`[]` deps) and renders `null`. Boot rejections are caught and logged as
  `[TestKit] failed to start`. Props are `TestKitConfig`.
- **Mount-once.** One claim per page, shared by both entries and the script-tag
  loader: the first committed mount or `init()` call owns the configuration
  even if it doesn't activate; later calls, prop changes, StrictMode/HMR
  remounts, and other copies are ignored. Async activation = conditional mount.
- **Unmount** never stops or tears down a session.
- **`?test` snapshot.** `src/activation.js` reads the `test` param once, when
  it is first evaluated (`typeof window`/`location` guarded; `null` on the
  server). In query mode `isActivated()` is true when the live URL has
  `test=1`, or has no `test` param and the snapshot was `1`, so a client
  router redirect that drops the param before the mount (or a late `init()`)
  still activates; one page load = one claim, however late the mount. `test=0`
  in either the live URL or the snapshot always wins. The snapshot does not
  affect `activate: true|false|fn`. Limit: if the package is first evaluated
  in a lazily loaded chunk after the redirect, the snapshot has nothing to see.
- `window.TestKit` is the debugging/automation global; `src/core/index.js`
  attaches `.controller` to it after boot.
- The root entry never imports React. `./react` starts with `'use client'`
  (must stay the first statement of `src/react/index.js`) and imports `react`
  as a bare specifier; `react`/`react-dom` are optional peers (`^18 || ^19`).
- `src/react.d.ts` imports `TestKitConfig` from `./index.js` and needs no
  `@types/react`.

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
| `events` | autoInc | `sessionId` | `{ sessionId, segmentId, ts, page, seq, events: rrwebEvent[] }` (chunk) |
| `log` | autoInc | `sessionId` | `LogEntry & { sessionId, page, seq }` |
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
  It is the only pointer to a stopped session: the store has no session
  listing, so a stopped session the pointer no longer names can't be reached
  from the overlay (see "Start new session" under Controller).
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
  tasksSkipped,                    // tasks ended via skipTask() (absent on older records = 0)
  exportedAt?,                     // set when exportSession() handed a full file (with all saved audio) to the browser
  exportedWithoutAudioAt?,         // set by a visual-only export ({ withoutAudio: true }) of a session that has audio
  rev,                             // bumped on every controller update (see testkit:mirror)
  lastActivityAt,                  // refreshed on every controller update and ~15 s heartbeat
}
```
`phase: 'preflight'` is never persisted — preflight is in-memory only.

Store API (all async):
`openStore()`, `createSession(rec)`, `getSession(id)`, `updateSession(id, patch)`,
`appendEvents(sessionId, segmentId, events[])`, `appendLog(sessionId, entry)`,
`appendAudio(sessionId, chunk)`, `loadSessionData(id) → { session, events, log, audio, audioDropped }`
(events flattened and sorted by `timestamp`; log sorted by `ts`; ties keep write
order: every log row and event chunk carries `page` (the writing page's
`performance.timeOrigin`, so a later page load sorts after an earlier one) and
`seq` (append order on that page), and sorting is by `(ts, page, seq)` — row keys
can't be used, since `<random batchId>:l<n>` compares as a string (l10 < l2,
batches in random order). Rows written before `page`/`seq` existed fall back to
the key's index within their batch; `page`/`seq` are stripped from `log` output; audio grouped by
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
  completed?,                // task-end: true when ended via nextTask(), false when skipped or the session was stopped mid-task
  reason?,                   // task-end: 'skipped' (skipTask()); task-end/session-end: 'stale' when boot stopped an abandoned session
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
`testkit:task-end {taskId,index,completed,reason?}` (`reason: 'skipped'` from skipTask()), `testkit:pause`, `testkit:resume`,
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
  exportNeedsReload,            // package build: the player chunk failed to load; only a reload can retry
  downloaded,                   // stopped only: SessionRecord.exportedAt is set (persisted, survives reloads)
  downloadedWithoutAudio,       // stopped only: exportedWithoutAudioAt is set (the audio exists only in IndexedDB)
  previousDownloadedAt,         // preflight only: exportedAt of the stopped session this setup replaces, else null
  otherTab,                     // true when another tab is capturing this session (read-only here)
  error|null,
}
controller.subscribe(fn) → unsubscribe     // fn(state) on every change
controller.beginPreflight()                // idle → preflight
controller.cancelPreflight()               // preflight → idle (releases mic)
controller.requestMic() → Promise<{ ok, error? }>   // preflight mic test
controller.getMicLevel() → number 0..1     // RMS level, poll from rAF for the meter
controller.start({ consent: true, audio: boolean }) // preflight → recording, task 0 begins
controller.nextTask({ followUpAnswer?, taskIndex? })   // ends current task; after last task → stop()
controller.skipTask({ taskIndex? })        // like nextTask(), but task-end {completed:false, reason:'skipped'}, counts tasksSkipped, no follow-up
                                           // taskIndex = the task the click was for; a call whose taskIndex is no longer current is a no-op (double click)
                                           // both are no-ops without a current task (free exploration, tasks: []): Finish there is stop()
controller.pause() / controller.resume()
controller.toggleMute()
controller.retryMic() → Promise<{ ok, error?, persistent?, stale? }>  // recording/paused; not queued (see Audio state)
controller.continueWithoutMic()            // stopAsking = true, releases the mic, keeps saved audio
controller.stop()                          // → stopped
controller.exportSession({ withoutAudio? }) → Promise<{ filename, bytes, withoutAudio }>   // stopped → exporting → stopped; triggers download; rejects on failure (and sets state.error)
controller.discard()                       // deletes session data → idle
```

All methods return promises and are serialized; calls in the wrong phase are
no-ops. `start()` without `consent: true` sets `error`.
On boot the controller may also land in `stopped` (restored from `testkit:last`).
`getState()` also returns `tasksCompleted` (tasks ended via `nextTask()`, persisted),
`tasksSkipped` (tasks ended via `skipTask()`, persisted, mirrored) and
`taskElapsedMs` (current task time excluding paused time) — implementing the
overlay requests below.

**Start new session (from `stopped`, decided 2026-10-08).** `beginPreflight()` is
also allowed from `stopped`. The stopped session stays in IndexedDB and stays
named by `testkit:last` throughout setup (a reload during setup shows it again);
`cancelPreflight()` returns to it (re-read from the store) instead of `idle`.
Once `start()` has created the new session, the previous one is **deleted if it
was downloaded** (`exportedAt` set: it would only fill storage, unreachable;
a without-audio export does not count, since the file lacks the audio),
and **left in IndexedDB otherwise** (never deleted without a download or an
explicit `discard()`; `start()` still clears `testkit:last`, so it is reachable
only through IndexedDB). The happy-path overlay (2026-10-09) no longer
offers Start new session from `stopped`: the tester downloads, then Discards
(see Overlay), so this path is reachable only through the controller. Rejected: keeping several stopped sessions
reachable (needs a session listing in store.js and a picker in the overlay), and
"Start anyway (it stays saved)", which would promise data the overlay can't
show again. The active pointer and stale logic are untouched: they only ever
name a `recording`/`paused` session. `exportedAt` is written with
`store.updateSession()` directly, not `persist()`, so a stopped session never
regains a mirror.

**"Downloaded" is best-effort.** `exportedAt` means `download()` handed the file
to the browser (`<a download>` click). A blocked download, a cancelled Save
dialog or a full disk is invisible to the page, so it still counts. Mitigation:
setup started from a downloaded session gets `state.previousDownloadedAt`
(the happy-path overlay doesn't show it, since it never starts setup from
`stopped`). Cancel returns to that session; it is deleted only when the new
session starts.
(Rejected for now: holding the old session until the new one has recorded
something meaningful, which needs a definition of "meaningful" and leaves two
sessions in storage.)
`state.audio.enabled` reflects the tester's choice, so a denied mic shows as
`{ enabled: true, status: 'denied' }`. A *dismissed* prompt (Permissions API
reports `prompt` after `NotAllowedError`) shows as `denied` with error
'Microphone prompt was dismissed'. Inside a session (including Start) **any**
`NotAllowedError` sets `stopAsking`, whatever the Permissions API says: Firefox
and Safari don't remember a one-off "Block", so otherwise every navigation would
re-prompt. The tester re-opens it with Retry. (This replaces the earlier
"retry a dismissed prompt on the next page" rule.)

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

MediaRecorder with `timeslice` ≈ 1000 ms (plus `requestData()` when the page is hidden,
on `beforeunload`, and on a link click or form submit, so a full navigation loses less of
the last timeslice: harness scenario M measured the mean tail lost at a navigation
dropping from ~493 ms to ~215 ms; the worst case is unchanged at ~850 ms, when the
chunk's IndexedDB write loses the race with unload), mime chosen via `isTypeSupported()`
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
   recording (paused: `resume()` starts it; status leaves `reconnecting` for
   `pending`/`muted`), and log `audio-gap` — `gapMs` on
   success, `null` + `message` on failure. The gap shown to people comes from
   segment coverage; the log entry only supplies the reason. A denial never
   touches saved segments; any `NotAllowedError` sets `stopAsking`. Callers
   outside the serial queue (Retry, the post-navigation restart) queue the
   post-acquire segment start, so a grant that lands while `pause()` is
   persisting can't start a segment that runs through the pause. `retryMic()` always
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
`<a download>`). Contents: inlined player bundle (its source text from
`loadPlayerJs()` of `virtual:player-bundle`, loaded only at export — see Build), and a `<script type="application/json" id="testkit-data">`
payload (every `<` escaped as `\u003c`, plus U+2028/2029) holding `{ version: 1,
testkitVersion, exportedAt, session, events, log, audio: [{ audioSegmentId,
startTs, endTs, mime, seqGaps?, dataUrl }], audioDropped, audioOmitted, omittedAudio, summaryMarkdown }`
(`omittedAudio` = segment metadata without data in a without-audio export, so the
player shows the same verdict and gap marks as the summary). Filename:
`testkit-<study>-<YYYYMMDD-HHmm>.html` (local time of `startedAt`).

The file's CSP is default-deny (`default-src 'none'`; inline script/style;
`data:`/`blob:` images, fonts, media). Remote assets the recording did not
inline do not load in the replay (local-only over fidelity); the player shows
how many were blocked.

`src/export/summary.js` → `buildSummary({ session, log, events, audio? }) → markdown`:
per task: status (**Skipped** when `task-end.reason === 'skipped'`; Completed only
when `task-end.completed` is true; falls back to `session.tasksCompleted`; the
header line reads `- Tasks completed: 2 of 3, 1 skipped`, the `, N skipped` part
only when N > 0; the player header shows `2 of 3 completed, 1 skipped` and a
Skipped badge — both via `taskCounts()`), duration, selector-level trail, signals
(rage clicks: ≥3 clicks on the same selector within 1 s; backtracking:
navigating back to a previously visited URL or `popstate`; long idle: ≥20 s
without log entries while recording; time limit; audio gaps). Audio gaps are
recording time outside pauses not covered by any audio segment (≥0.5 s),
computed from `audio` when given, else from `audio-gap` log entries. With none,
the line reads `- Audio gaps: none of 0.5s or more`; a trail `audio-gap` entry
shorter than that is suffixed `(under 0.5s, not counted as a gap)`.
`- Pages visited:` (`pagesVisited()`) lists unique pages in visit order,
starting with the session's first page (`meta.prototypeUrl`, else the first
segment's URL); a `replaceState` that changes only the query/hash of the page
just listed updates that entry instead of adding one.
`audioReport({ session, log, events, audio, dropped }) → { kind, label, gaps, … }`
is the single saved-audio verdict — **Audio recorded** / **Audio recorded with
gaps** / **No audio recorded** — used by the summary (`- Audio saved:` line), the
player header and the overlay's pre-download line, so they share inputs.

The player bundle (`src/player/player.js`) runs inside the exported file: reads
`#testkit-data`, mounts rrweb-player (`skipInactive: false` when audio exists),
renders task markers on a timeline, syncs `<audio>` to the replayer (seek,
play/pause, speed; paused above 4×), marks audio gaps, and offers "Download raw
JSON" (on the agent summary bar) and "Copy agent summary" (inside it). Its
look is `ui.pen` › P2: `--lab-*` color tokens with light and dark values, picked
by a Light / Dark / System switch (stored in `localStorage` as
`testkit:replay-theme`; System follows `prefers-color-scheme`). It exposes `window.TestKitPlayer = { player,
data, seekToWall, getOffset }` for automated checks.

## Build

`scripts/build.mjs` builds, in order:
1. `src/player/player.js` → `public/v1/testkit-player.js` (IIFE, minified, CSS
   injected by the bundle itself — import CSS files as text and append a `<style>`).
2. `public/v1/testkit-player-source.js` = `window.__TestKitPlayerSource="<step 1's
   output as a string>";`, then `src/core/index.js` → `public/v1/testkit-core.js`.
   The exporter imports `{ loadPlayerJs } from 'virtual:player-bundle'`
   (`() → Promise<string>`, the player's source). Here it resolves to
   `src/export/player-script.js`, which injects `testkit-player-source.js` from
   the folder `testkit-core.js` was loaded from (captured from
   `document.currentScript` while the core evaluates, so SPA navigation can't
   change it) on the first export, and caches it. The player is ~270 kB, so the
   core stays under Vite's 500 kB chunk warning.
   **Unhashed within `/v1/`:** `testkit-player-source.js` (like
   `testkit-core.js`) has a fixed name per major version, so a page whose
   core loaded before a deploy can fetch the player from after it (and a
   host's HTTP cache can pair them the other way round). Within a major
   version, every core must therefore produce a payload every player can read,
   and every player must read every payload an older core of that major
   writes: additive, optional fields only. A change that breaks this is a new
   major version (`/v2/`). (The package build has no such skew: its player
   chunk name is content-hashed and imported by the core that references it.)
3. `src/loader.js` → `public/v1/testkit.js`.
4. `src/index.js` → `dist/index.js` and `src/react/index.js` → `dist/react.js`
   (one ESM build, code-split: both entries share the boot chunk, and its
   dynamic import of `src/core/index.js` becomes `dist/chunks/core-*.js`, which
   exports `start(config)`; `react`/`react-dom` are external). Here
   `virtual:player-bundle`'s `loadPlayerJs()` is a dynamic `import()` of the
   player text, split into `dist/chunks/testkit-player-*.js` (resolved relative
   to the core chunk by the host bundler, never the page URL).
   `src/index.d.ts`, `src/react.d.ts`, and the three `public/v1/` files are
   copied to `dist/`. `test/package-build.test.js` checks the output;
   `npm run check:package` checks the packed tarball in scratch consumers.
5. `demo/` copied to `public/demo/`.

## Overlay (`src/overlay/overlay.js` → `mountOverlay(controller) → { destroy }`)

Called once per page load after `document.body` exists and after
`createController()` resolves (so an auto-resumed session is already in
`recording`/`paused`). Creates a shadow host `<div class="testkit-block"
id="testkit-root">` appended to `<html>` (not `<body>`, so prototype body
re-renders can't remove it). Everything inside the shadow root is excluded from
rrweb (`blockClass: 'testkit-block'`) and from the interaction log.

**Happy path only (decided 2026-10-09, ui.pen → 07 · C · Happy path).** The
overlay has three views and nothing else:

- **Setup card** (idle/preflight, opened from the bubble): **Agree and start**
  (`data-fid="start"`) or **Screen only** (`screen-only`, shown only when audio
  is enabled). Pressing either is the consent: it calls `beginPreflight()` then
  `start({ consent: true, audio })`, and `start()` asks for the mic itself.
  There is no consent checkbox and no mic level check.
- **Recording bar** (recording/paused) in place of the bubble: REC, the step
  (`step`, "1/3", toggles the task card), **Next** / **Finish** (`next`,
  `nextTask()`; free exploration: Finish = `stop()`), and a Stop square (`stop`,
  `stop()`, no confirm). The dark task card beside it shows the prompt and the
  `timeLimit` countdown; it reopens on every new task. A session restored as
  paused shows **Resume** (`resume`) in place of Next. Mic status, elapsed time,
  pause, mute, skip, follow-up questions and success hints are not shown; mic
  changes are still announced through the live region.
- **Finish card** (stopped/exporting): **Download session** (`download`; reads
  Download again, Try again, or Reload and retry as the export state changes),
  **Download without audio** (`download-visual`, only when
  `exportWithoutAudio`), and **Discard** (`discard`, `discard()`; an undownloaded
  session asks once more: "Discard without downloading?").

Another tab's lock shows a card with no controls. Next advances at most once
per click: the second click of a double click (`event.detail > 1`) is ignored, a
press while the previous call is in flight is ignored (the guard lets go after
10 s if a call never settles), and the call carries `taskIndex` so the
controller drops a stale one. `pause()`, `resume()`, `toggleMute()`,
`skipTask()`, `retryMic()`, `continueWithoutMic()`, `requestMic()` and
`cancelPreflight()` stay in the controller (tests and the browser harness use
them) but no overlay control calls them.

Overlay-owned storage: `localStorage['testkit:overlay-pos']` = `{ side: 'left'|'right', y }`
(bubble position, survives navigation); `sessionStorage['testkit:overlay-open']` =
`'1'|'0'` (setup/finish card open, per tab; the recording bar is always shown). Key events inside the overlay stop at the shadow
root so prototype shortcuts never fire while typing in it (in fact at window
capture). `focusin`/`focusout` whose target is inside the overlay stop there too,
so a host focus trap (MUI's FocusTrap: a document `focusin` listener that refocuses
its dialog when `document.activeElement`, i.e. our shadow host, is outside it)
doesn't pull focus out of the overlay; the host's own focus events are untouched.
Limits: window capture listeners registered before TestKit loaded still see them;
with a modal host dialog open, Tab from the host can't reach the overlay (click
the bubble), and Tab past the overlay's first/last control leaves it.

## Requests from overlay

None open. `tasksCompleted` and `taskElapsedMs` (requested 2026-10-06) are now part
of the Controller contract above; the overlay prefers them and keeps its local
fallbacks only for older controllers.
