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

- Mute choice survives navigation: `stateFromSession` restores `muted`, and
  `acquireMic` applies it before any segment starts (`src/core/session.js`). No
  test covers this yet.
- Same-page pause stops the audio segment (`stopSegment`) but does **not**
  release the microphone stream; release happens when restoring a paused session
  after navigation or bfcache (`resumeSession`). Pause copy must stay honest about
  the browser mic indicator (see §3).
- Pauses are already separated from missing audio: `audioGaps` subtracts paused
  spans from uncovered time, and the player uses it (`src/export/summary.js`).
- Stop, Discard, and canceled setup already discard a late permission grant via
  the `generation` guards in `audio.js` and `session.js`.
- Two re-acquire paths exist today (`resume()` and `restartAudioAfterNavigation`).
  They differ in gap accounting and whether they persist `enabled: false`. This
  increment extracts one shared Retry primitive rather than routing UI through
  either path as-is.

### Decisions required before Recovery UI

1. **SessionRecord / controller audio model.** Split intent to record, stop-asking,
   and "has persisted segments." Today `session.audio.enabled = false` on
   persistent denial makes `audioGaps` return nothing and summary say "Audio: not
   recorded" even when segments exist. Update `docs/CONTRACTS.md` to one meaning.
2. **When status becomes `live`.** After first successful `appendAudio` (preferred
   for "never Recording while the active segment is not appending"), or demote on
   write failure / stop segment. Mute remains an intentional exception.
3. **Controller surface for Retry.** One method (e.g. `retryMic`) that awaits
   `stopSegment()`, respects `generation`, and does not clear saved segments on
   denial.
4. **Pause mic policy.** Document hold-vs-release: same-page pause holds the
   stream; Stop/Discard/skip release it. User-facing copy must match.
5. **Supported max session length** and exact quota / export-size failure strings
   (IndexedDB vs HTML/base64 encode).

## Planned work

### 0. Schema and contracts

Separate:

| Concern | Proposed field / rule |
| --- | --- |
| Tester chose voice at Start | intent / `enabled` stays true when segments may exist |
| Stop re-prompting (denial, skip mic) | `audio.stopAsking` (or equivalent); do not erase segments |
| Saved-audio reporting | Based only on persisted segments after grouping |

Player and summary must not say "not recorded" when segments exist. CONTRACTS
must stop contradicting controller vs SessionRecord meanings of `enabled`.

### 1. Complete setup

Preserve consent, permission, and the microphone level check. Keep **Continue
without audio** available even after the microphone check passes (it is currently
removed on pass, `src/overlay/overlay.js`).

**Consent rules**

- Consent is collected once at Start for the capture modes actually enabled.
- If the tester selects **Continue without audio** after a passed check, start
  with screen-only consent text and do not capture audio later in that session
  unless they choose **Use microphone**, re-confirm the voice consent checkbox,
  and pass or skip the mic check again.
- Mid-session **Retry microphone** after earlier voice consent does **not**
  re-show the consent checkbox. A denial sets stop-asking and must not clear
  already-stored segments.

### 2. Recover from capture failures

Treat failure classes explicitly. v1 ships hard handling for the first three;
device `mute` / `devicechange` are observational until the browser matrix says
otherwise.

| Class | Signals | Handled today | v1 disposition |
| --- | --- | --- | --- |
| Device ended | track `ended` | Yes | Status → Audio stopped; Retry |
| Recorder | `MediaRecorder` `error` | Yes | Status → Audio stopped; Retry |
| Persistence | `store.appendAudio` rejection | Generic `state.error`; status can stay `live` | Demote audio status; stop segment; Retry or continue without mic |
| Device mute | track `mute` lasting more than a few seconds | No | Observe in matrix; do not equate silence with unsaved |
| Device change | `devicechange` | No | Offer/emphasize Retry only — never auto-`getUserMedia` |

When a recoverable failure occurs, keep visual recording running.

**Recoverable (Audio stopped)**  
Notice: **Audio stopped — screen is still recording.**  
Primary: **Retry microphone.**

**Blocked permission (Microphone blocked)**  
Notice: **Microphone blocked — screen is still recording.**  
Primary: **How to allow microphone** (short site-settings hint).  
Secondary: **Continue without microphone** (sets stop-asking; keeps saved audio).

Retry uses the shared primitive from §0 / Decisions (not a raw call into
`resume()` or `restartAudioAfterNavigation`), waits for the failed segment's
`stopSegment()` to settle, then starts a new segment. Preserve saved audio,
indicate reconnection progress, and let the gap be derived from segment coverage,
with the logged `audio-gap` supplying the reason. A failed retry must leave the
session usable without audio.

Announce status changes via the existing live region when the panel is collapsed
so think-aloud sessions notice mic death without opening the panel.

Edge cases to specify in implementation notes: Retry while paused or while a
Stop/Discard confirm is open; another tab owns the recording; laptop sleep /
background ending tracks; SPA routes that never hit `restartAudioAfterNavigation`.

### 3. Make recording state clear

User-facing audio status is exactly one of:

| State | Source | Notes |
| --- | --- | --- |
| Microphone on | `audio.status: 'live'` | Only when the active segment is appending (or muted — see below) |
| Muted | `audio.status: 'muted'` | Intentional silence still saved; not a failure |
| Paused | session `phase: 'paused'` | Session phase owns the badge; mic badge secondary |
| Reconnecting… | new `reconnecting`, or `pending` + reason | Distinct from first-acquire pending |
| Microphone blocked | `denied` (stop-asking) | Site-settings CTA; no automatic re-prompt |
| Audio stopped | recoverable `error` / ended / persist fail | **Retry microphone** |

Mute saves silence; pause stops capturing the session. Pause copy:

> Session paused — prototype interaction and voice are not saved.  
> Your browser may still show the microphone as in use until you stop the session.

### 4. Show what was saved

Before download, show exactly one of:

- **Audio recorded** — persisted segments exist; no uncovered capture ≥
  `AUDIO_GAP_MIN_MS` (500 ms) outside pause spans
- **Audio recorded with gaps** — same threshold; copy must say gaps mean missing
  capture, not unintelligible speech
- **No audio recorded** — no persisted segments

Compute with the same `audioGaps` function the player uses, on the same
post-grouping segments, so overlay, summary, and replay cannot disagree on inputs.
Preserve download retry and explicit discard. Offline open must still surface
**Enable audio** when autoplay is blocked.

### 5. Make export honest about lost chunks

`groupAudioChunks` concatenates chunks by `seq` without checking for missing ones,
and `audioGaps` treats each segment as covered from `startTs` to `endTs` (wall
clock of chunk arrival — not media duration). A missing `seq` 0 (container header)
likely makes a segment unplayable; a missing middle chunk may cause a decode error
after that point.

**Policy for this increment**

1. Detect `seq` discontinuities and surface them (summary / gap list / "unreliable
   segment").
2. Treat a missing `seq` 0 as a lost segment.
3. Do **not** irreversibly trim trailing chunks at the first middle gap until the
   browser matrix records how Chrome, Firefox, and Safari decode stitched segments
   with holes. Then choose trim-at-first-hole vs play-until-error and document it.

Longer term (out of scope unless testing forces it): derive playable coverage from
decoded/blob duration rather than chunk wall timestamps alone.

### 6. Validate capture through offline playback

Test real media in desktop Chrome, Firefox, and Safari, then fix demonstrated
failures in capture, persistence, export, or playback. Reopen exported HTML offline
and test seeking, segment boundaries, playback speed changes, and the recording's
end. Measure synchronization with a fixture that does **not** rely on speaker→mic
loopback: capture already requests `echoCancellation: true`, which commonly removes
loudspeaker audio from the mic path.

- **Automation (regressions):** add a real browser harness (e.g. `npm run
  test:browser` — **does not exist yet**; Baseline builds it). Chrome with
  `--use-fake-device-for-media-stream
  --use-file-for-fake-audio-capture=<fixture.wav>` and Firefox with
  `media.navigator.streams.fake`. These exercise MediaRecorder, IndexedDB, export,
  and decode, but cannot simulate device loss or track `mute`.
- **Acceptance (manual):** real microphones, physical disconnects, and all of
  Safari. One Safari real-mic smoke and offline seek/decode check land before
  Recovery is marked done.
- **Sync measurement:** prefer an injected tick in the recording graph, or a
  demo fixture with echo cancellation off for the harness. Speaker→mic beep +
  on-screen counter is documented as optional / headphone N/A, not the pass gate.
  Align the acceptance budget with the player's existing `DRIFT_TOLERANCE_S`
  (300 ms) unless testing justifies a different number; define "after playback
  settles" as ≤ 1 s or until the next marker.

Browser chunk delivery is not precisely timed; navigation capture is best effort
and can contain gaps. See the [MediaRecorder timing documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event).

## Proposed acceptance criteria

- After Start with audio, **Continue without audio** remains available on a passed
  mic check; starting that path exports with download line **No audio recorded**
  and no audio segments.
- A 15-minute session across three same-origin prototype pages exports playable
  audio before and after each navigation. Missing intervals ≥ 500 ms outside pause
  spans are marked in the player timeline and match the pre-download line (and
  summary) from the same `audioGaps` result.
- Mute: exported audio is near-silent for muted spans but the timeline stays
  covered (not an audio gap). Pause: no new audio chunks; paused spans are not
  labeled as audio gaps. Both choices survive in-app navigation.
- Unplug mic (or `track.stop`) mid-session: visual recording continues; badge/notice
  enter **Audio stopped** within 2 s; **Retry** after reconnect produces a new
  segment; player shows a gap for the uncovered interval ≥ 500 ms.
- Deny mic on page 3 after audio on pages 1–2: no further permission prompts;
  download line **Audio recorded with gaps** (or **Audio recorded** if uncovered
  < 500 ms); player plays pages 1–2 audio; summary must not say audio was not
  recorded.
- Persistence failure demotes status so the badge never shows **Microphone on** /
  `live` while the active segment is not successfully appending (Mute excepted).
  Track `mute` / silent-device behavior is matrix-dependent, not a v1 hard gate.
- Seq discontinuities are detected and reported; missing `seq` 0 drops the segment.
  Middle-gap trim-or-soft policy matches the committed matrix decision.
- Stop, Discard, and canceled setup release the microphone, including when a
  permission request resolves after the action.
- Exported HTML plays offline: if autoplay is blocked, **Enable audio** appears;
  after click, seek across segment boundaries and gap→audio at 1× / 2× / 4×.
- Sync: at 1×, 2×, and 4×, audio and visual markers stay within **300 ms**
  (recording-timeline time) after playback settles, measured at beginning, middle,
  and end, and after seeks. Navigation/transition gaps are scored in a separate
  table, not against the 300 ms budget. At 8×, audio is muted with a visible
  status; returning to 1× resyncs within 300 ms after settle. (Player already
  mutes above 4×.)
- State a supported max session length (target 60 minutes). Either complete
  export under IndexedDB quota and export-size limits, or show the documented
  failure string with visual (and any audio so far) still downloadable when
  possible.
- Commit a desktop browser × scenario matrix (pass / fail / documented limitation)
  with real recorded media. Existing unit tests and simulated audio alone do not
  establish these criteria.

## Implementation areas

- `docs/CONTRACTS.md`: `enabled` vs stop-asking vs has-segments.
- `src/core/audio.js`: microphone lifecycle; `ended` / recorder error; observe
  `mute` / `devicechange` for the matrix.
- `src/core/session.js`: shared Retry primitive, state transitions,
  persistence-failure status, denial / stop-asking, gap tracking.
- `src/core/store.js`: `seq`-gap detection when grouping chunks (report first;
  trim policy after matrix).
- `src/export/summary.js` and `src/export/payload.js`: gap and saved-audio
  reporting from persisted segments; export-size failure path.
- `src/overlay/overlay.js`: setup choices, blocked vs recoverable copy, Retry /
  stop-asking controls, collapsed-bubble announcements, saved-audio status.
- `src/player/player.js`: playback and synchronization fixes demonstrated by
  testing (8× mute already present).
- Unit tests for mute/pause across navigation, failure classes, `groupAudioChunks`
  continuity detection, and `audioGaps`, plus the new browser harness.

## Delivery order

0. **Schema.** Done when `enabled` / stop-asking / has-segments are specified in
   CONTRACTS and session persistence rules, and summary/player no longer treat
   `enabled: false` as "no segments."
1. **Baseline harness.** Done when a real browser script (add `test:browser` or
   equivalent) records with Chrome fake audio, navigates twice, exports, and
   asserts segment count, gap list, and a decode/seek smoke. Include `seq`
   discontinuity detection (report only).
2. **Recovery and status.** Done when unit tests pass for ended / recorder /
   persistence → status ≠ live, denial/stop-asking, and Retry; the baseline script
   covers a forced `track.stop()`; one Safari real-mic + offline seek smoke has
   run.
3. **Acceptance.** Done when the browser × scenario matrix is filled in and
   committed (including sync fixture results, mute-vs-ended observations, and the
   seq-gap trim-or-soft decision).

## Open questions

- How each browser plays a stitched segment with a missing middle chunk (drives
  §5 trim vs soft).
- Which browsers fire track `mute` instead of `ended` when another application
  takes the microphone.
- Whether media-duration-based coverage should replace wall-clock `endTs` in a
  follow-up.
- Exact supported max duration and quota / export OOM copy.

This document is a plan; implementation and acceptance testing have not been
completed as part of writing it.
