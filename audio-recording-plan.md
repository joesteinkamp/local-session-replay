# Audio recording support plan

## Objective

Finish and validate TestKit's existing microphone recording support so testers can
think aloud, recover from microphone failures, and download a session with reliable
offline audio playback synchronized to the visual replay.

## Scope and starting point

- Optional microphone audio, stored locally and included in the session HTML.
- Existing implementation includes consent, microphone permission and level check,
  capture, mute, pause/resume, local persistence, export, and synchronized playback.
- This increment focuses on recovery, clear recording status, and end-to-end
  validation. Existing implementation is not evidence of browser-level reliability.
- Transcription and tab/system audio are separate future increments.

### Already in place — needs tests, not code

- Mute and pause survive navigation: `stateFromSession` restores `muted`,
  `acquireMic` applies it before any segment starts, and a paused page releases
  the microphone (`src/core/session.js`). No test covers this yet.
- Pauses are already separated from missing audio: `audioGaps` subtracts paused
  spans from uncovered time, and the player uses it (`src/export/summary.js`).
- Stop, Discard, and canceled setup already discard a late permission grant via
  the `generation` guards in `audio.js` and `session.js`.
- Two retry paths exist: `resume()` re-acquires a missing microphone, and every
  navigation re-acquires and logs the gap (`restartAudioAfterNavigation`).

## Planned work

### 1. Complete setup

Preserve consent, permission, and the microphone level check. Keep **Continue
without audio** available even after the microphone check passes (it is currently
removed on pass, `src/overlay/overlay.js`).

### 2. Recover from capture failures

Treat three failure classes, not only the microphone:

| Class | Signals | Handled today |
| --- | --- | --- |
| Device | track `ended`; track `mute` lasting more than a few seconds; `devicechange` | `ended` only |
| Recorder | `MediaRecorder` `error` | Yes |
| Persistence | `store.appendAudio` rejection (quota, IndexedDB failure) | Generic error notice only; status stays `live` |

When any of these occur, keep visual recording running. Show **Audio isn't
recording** with a **Retry microphone** button. Retry reuses the existing
re-acquire path used by `resume()` and navigation rather than adding a third one,
and waits for the failed segment's `stopSegment()` to settle before starting a new
segment. Use `devicechange` to offer Retry when a microphone reappears. Preserve
saved audio, indicate reconnection progress, and let the gap be derived from
segment coverage, with the logged `audio-gap` supplying the reason. A failed retry
must leave the session usable without audio.

A persistent denial on a later page must stop re-prompting without erasing earlier
audio. Today `session.audio.enabled = false` makes the summary report "Audio: not
recorded" and `audioGaps` return nothing even though earlier segments exist.
Separate the intent to record from the decision to stop asking (for example,
`audio.stopAsking`), and base saved-audio reporting on persisted segments.

### 3. Make recording state clear

Map the user-facing states onto the existing model:

| State | Source | Change |
| --- | --- | --- |
| Recording | `audio.status: 'live'` | Keep |
| Muted | `audio.status: 'muted'` | Keep |
| Paused | session `phase: 'paused'` | Badge reads the phase; not an audio status |
| Reconnecting | currently `pending`, shared with first acquire | Add `reconnecting`, or tag `pending` with a reason |
| Unavailable | `denied` / `error` | Same badge; retry copy differs (site settings vs. Retry) |

Mute saves silence; pause stops capturing the session. Pausing does not
necessarily release the microphone stream or remove the browser's microphone
indicator.

### 4. Show what was saved

Before download, show **Audio recorded**, **Audio recorded with gaps**, or **No
audio recorded**, based on persisted audio. Compute this with the same `audioGaps`
function the player uses so the overlay and the replay cannot disagree. This
confirms capture exists without claiming the speech is intelligible. Preserve
download retry and explicit discard.

### 5. Make export honest about lost chunks

`groupAudioChunks` concatenates chunks by `seq` without checking for missing ones,
and `audioGaps` treats each segment as covered from `startTs` to `endTs`. A missing
first chunk (the container header) likely makes a segment unplayable; a missing
middle chunk likely causes a decode error after that point. At export, cut each
segment at its first `seq` gap and treat the remainder as a gap; treat a missing
`seq` 0 as a lost segment.

### 6. Validate capture through offline playback

Test real media in desktop Chrome, Firefox, and Safari, then fix demonstrated
failures in capture, persistence, export, or playback. Reopen exported HTML offline
and test seeking, segment boundaries, playback speed changes, and the recording's
end. Measure synchronization using audible and visual markers rather than assuming
chunk timestamps prove alignment.

- **Automation (regressions):** Chrome with `--use-fake-device-for-media-stream
  --use-file-for-fake-audio-capture=<beeps.wav>` and Firefox with
  `media.navigator.streams.fake`. These exercise the real MediaRecorder, IndexedDB,
  export, and decode, but use simulated input and cannot simulate device loss or
  track `mute`.
- **Acceptance (manual):** real microphones, physical disconnects, and all of
  Safari, which has no fake-device automation.
- **Sync measurement:** the demo page shows a large on-screen counter and plays a
  beep every 10 s through the speakers, picked up by the microphone. The reviewer
  compares beep onset with the counter change in the export and records the deltas.

Browser chunk delivery is not precisely timed; navigation capture is best effort
and can contain gaps. See the [MediaRecorder timing documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event).

## Proposed acceptance criteria

- A 15-minute session across three same-origin prototype pages exports playable
  audio before and after each navigation, with missing intervals visibly marked.
- Speech during mute and pause is absent from exported audio; speech resumes after
  unmute/resume. These choices survive navigation.
- Permission denial and microphone disconnection leave visual recording and export
  usable; an explicit retry can restore microphone capture when available.
- A persistent denial on page 3 still exports, plays, and labels the audio from
  pages 1–2.
- A persistence failure or a silent device (track `mute`) changes the status to
  **Audio isn't recording**; the badge never shows live while nothing is saved.
- A segment with a missing chunk is trimmed at the gap, and the remainder appears as
  a gap in the timeline rather than as covered audio.
- Stop, Discard, and canceled setup release the microphone, including when a
  permission request resolves after the action.
- Exported HTML plays offline and supports seeking across audio segments.
- At 1×, 2×, and 4×, audio and visual markers stay within a proposed 500 ms of each
  other in recording-timeline time after playback settles. Measure at the beginning,
  middle, and end, and after seeks and navigation; assess transition gaps separately.
  At 8×, audio is muted with a visible status and resyncs after returning to 1×.
- A 60-minute session (or a stated supported maximum) records and exports within
  storage quota, or fails with a clear message.
- Run the supported desktop-browser matrix with real recorded media. Existing unit
  tests and simulated audio alone do not establish these criteria.

## Implementation areas

- `src/core/audio.js`: microphone lifecycle, track `mute` and `devicechange`
  handling, and capture behavior.
- `src/core/session.js`: retry, state transitions, persistence-failure status,
  denial handling, and gap tracking.
- `src/core/store.js`: `seq`-gap detection when grouping chunks.
- `src/export/summary.js` and `src/export/payload.js`: gap and saved-audio reporting
  from persisted segments.
- `src/overlay/overlay.js`: setup choices, reconnect controls, and saved-audio status.
- `src/player/player.js`: playback and synchronization fixes demonstrated by testing.
- Unit tests for mute/pause across navigation, failure classes, `groupAudioChunks`,
  and `audioGaps`, plus browser-level recording/export/playback coverage.

## Delivery order

1. **Baseline.** Done when a Chrome fake-audio script records, navigates twice,
   exports, and asserts the segment count and gap list (e.g. `npm run test:browser`).
2. **Recovery and status.** Done when unit tests for the three failure classes,
   denial handling, and `seq`-gap trimming pass, and the baseline script covers a
   forced `track.stop()`.
3. **Acceptance.** Done when the browser × scenario matrix (pass, fail, or
   documented limitation) is filled in and committed with the results.

Open questions that need real hardware: how each browser plays a stitched segment
with a missing chunk, and which browsers fire track `mute` instead of `ended` when
another application takes the microphone.

This document is a plan; implementation and acceptance testing have not been
completed as part of writing it.
