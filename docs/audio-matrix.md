# Audio: browser × scenario matrix

Evidence for `audio-recording-plan.md` (§5, §6, acceptance criteria). Automated
rows come from `npm run test:browser` (`test/browser/run.mjs`). Raw numbers
are written to `$TMPDIR/testkit-audio-harness/results.json`, and the exports
it produced sit next to that file.

**Legend:** **pass** = measured and met · **fail** = measured and not met ·
**limitation** = measured, documented behaviour we accept · **pending manual** =
needs a real microphone, a physical device change, or a browser the harness
can't drive. Pending items are **not** passes.

Run on 2026-10-08 (Claude): macOS, Google Chrome 155.0.8059.40, headless, driven by
playwright-core. The fake microphone is `--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<generated speech-like WAV>` (and a WebAudio
beep graph for sync). Firefox is not installed on this machine and Playwright's
Firefox wasn't downloaded. Safari can't be driven here.

## Scenario matrix

| # | Scenario (acceptance criterion) | Chrome (fake device) | Firefox | Safari |
| --- | --- | --- | --- | --- |
| C | **Continue without audio** after a passed mic check: screen-only consent, no capture, mic released, line **No audio recorded**, 0 segments | **pass**: consent text and checkbox switch to screen only, every track ended after Start, no `getUserMedia` on the next page, 0 segments | not run | pending manual |
| A | Recording across 3 same-origin pages, 2 navigations; export plays before/after each navigation | **pass** (short run): 5 segments as expected; every segment decodes in `<audio>` and `decodeAudioData`; element duration within 70 ms of wall span. The 15-minute run is **pending manual**. | not run | pending manual |
| A | Gaps ≥ 500 ms outside pauses marked in the timeline = pre-download line = summary (same `audioReport`) | **pass**: overlay line, `savedAudio.gaps`, summary `- Audio saved:` and player header all say **Audio recorded with gaps**, with the same 2 gaps | not run | pending manual |
| A | Mute: near-silent, timeline covered (not a gap); survives navigation | **pass**: muted-span RMS 0.0000 vs 0.158 unmuted; no gap over the muted span; `muted` and status `muted` restored on page 3 and applied before the segment started | not run | pending manual |
| A | Pause: no chunks, not a gap; copy matches plan §3 | **pass**: 0 chunks stored during the 2.5 s pause; no gap over it; the pause copy is shown verbatim (unit test covers pause across navigation) | not run | pending manual |
| A | Device loss (`track.stop()`; it fires no `ended`) → **Audio stopped** within 2 s, visual continues, announced while collapsed; **Retry** → new segment; gap ≥ 500 ms | **pass**: `error` after 53–56 ms (faster than the 500 ms watch, so most likely the recorder stopping on its own, which the capture now reports; which signal fired isn't instrumented), phase stayed `recording`, live region read "Audio stopped — screen is still recording." with the panel collapsed, Retry → `live` in ~1.4 s, gap 3.6 s with reason "Microphone disconnected" | not run | pending manual (real unplug) |
| B | Deny on page 3 after audio on pages 1–2: no more prompts; **Audio recorded with gaps**; pages 1–2 play; summary never says "not recorded" | **pass**: page 3 `denied` + `stopAsking`; page 4 made 0 `getUserMedia` calls and showed **Microphone blocked** (Permissions API, no prompt); 2 segments decode; no "not recorded" anywhere. Denial is simulated with a `getUserMedia` / Permissions API stub. | not run | pending manual (real prompt) |
| unit + A/B | Persistence failure → status never `live` while not appending | **pass**. Unit: an `appendAudio` rejection or quota error → `error`, segment stopped, exact copy. Browser (A start, A Retry, B start): every emitted status is traced, and the first `live` comes after the earliest saved chunk of the running segment (~1.0 s after Start); Retry goes `reconnecting` → `live`. Mutation check: setting `live` at segment start fails this assertion and two unit tests. | — | — |
| unit | Retry grant landing during `pause()` | **pass (unit)**: with a slow `updateSession`, the grant can't start a segment through the pause (the start is queued and re-checks the phase); status ends `pending`. Mutation check: un-queuing the start fails the test. | — | — |
| F | `seq` discontinuities detected; missing `seq` 0 drops the segment | **pass**: raw probe asserted (below). Through TestKit: a 2-segment session with seq 0 of one and seq 2 of the other deleted from IndexedDB exports `audioDropped: [missing-first-chunk]`, one segment with `seqGaps: [2]` that still plays, summary "Lost audio segments: 1" and "Unreliable audio segments: 1", and the lost span as a gap with reason "Audio segment lost" | not run | pending manual |
| D | Stop, Discard and cancelled setup release the mic, including a grant that lands later | **pass**: cancelled setup with a 1.5 s pending grant; Stop and Discard during a pending Retry. Every track ended, Retry resolved `stale`, status `off` | not run | pending manual |
| G | Offline export: autoplay blocked → **Enable audio**; click plays | **pass (simulated policy)**: headless Chrome didn't block audible autoplay even with `--autoplay-policy=document-user-activation-required`, so `play()` is stubbed to reject until a trusted pointer or key event. The button appeared and one click played. | not run | pending manual |
| A | Seek across segment boundaries and gap → audio at 1×/2×/4× | **pass**: seeking into the 3.6 s gap shows "No audio at this point"; playback continues into the next segment ("Playing segment 5 of 5"); alignment rows below cover seeks at each speed | not run | pending manual |
| A | 8×: audio muted with visible status; back to 1× resyncs ≤ 300 ms | **pass**: no element playing at 8×; status "Muted above 4× (segment 1 of 5)"; −42 ms drift 1 s after returning to 1× | not run | pending manual |
| A | Without-audio export (fallback) | **pass**: player header reads "<verdict> — left out of this file (too large to export)"; gap marks equal the summary's gaps; no `<audio>` elements | not run | pending manual |
| unit | Denial at Start or a one-off "Block" (permission state `prompt`) → no re-prompt on later pages | **pass (unit, Chrome semantics)**: any `NotAllowedError` in a session sets `stopAsking`. **Unverified in Firefox and Safari**, which this rule targets (they don't remember a one-off block) | — | pending manual |
| H | 60-minute audio volume (3,600 one-second chunks, 14.4 MB) → export | **pass (synthetic volume)**: 16 MB IndexedDB usage of a 10.7 GB quota; export in 0.5 s, 19.5 MB file; player parses both segments. A real 60-minute capture is **pending manual**. | not run | pending manual |
| — | Track `mute` vs `ended` when another app takes the mic | can't be simulated (fake device) | — | **pending manual** (all browsers) |
| — | `devicechange` (plug in a headset) | can't be simulated | — | **pending manual**. The overlay offers Retry and never calls `getUserMedia` on its own. |
| — | Laptop sleep / OS mic revocation | can't be simulated | — | **pending manual** |

## Sync (scenario E): injected tick, no speaker→mic loopback

The microphone is a WebAudio graph that beeps (80 ms, 1 kHz) every 2 s and
records each beep's wall time. A DOM marker changes at the same instant, so
rrweb records the visual marker on the same clock. The session spans one
navigation. In the offline export, each beep onset is detected from the
playing `<audio>` (via `captureStream()` and an analyser) and compared with the
replayer clock (recording-timeline time). Readings taken in the first second
after a seek or rate change don't count (plan: "after playback settles ≤ 1 s").

| Speed | Settled beeps per run | Max abs error (2 full runs) | Budget 300 ms |
| --- | --- | --- | --- |
| 1× | 10 | 68–69 ms | **pass** |
| 2× | 9 | 114–136 ms | **pass** |
| 4× | 7–8 | 196–207 ms | **pass** |

Breakdown:

- **Capture offset:** a constant +36 ms. A segment's `startTs` (the recorder's
  `start` event) lands about 36 ms after its media time 0. This was the same in
  both segments, before and after the navigation.
- **Play-start latency (demonstrated failure, fixed):** before the fix, 1×
  errors sat at about 270 ms through the whole first segment. `play()` takes a
  moment to start, the replayer keeps going meanwhile, and the 300 ms
  steady-state tolerance never corrected it. The player now makes one tighter
  correction (80 ms) 250 ms after the element starts `playing`
  (`SETTLE_TOLERANCE_S`). That brought 1× down to ≤ 68 ms. The 2× and 4×
  errors scale with speed for the same reason. They stay inside the budget.
- **`currentTime` alignment** (scenario A, 5 segments, begin/middle/end at
  1×/2×/4×): max |drift| 230–249 ms across runs, mostly −40…−60 ms at 1×,
  −100…−140 ms at 2× and −180…−260 ms at 4×.

### Navigation and transition gaps (not scored against the 300 ms budget)

| Transition | Uncovered audio | Notes |
| --- | --- | --- |
| index → about (link click), Chrome | 818–838 ms | page unload + load + `getUserMedia` + recorder start; shown as an audio gap (≥ 500 ms) with no reason |
| about → company (`goto`, muted) | < 500 ms | not reported |
| page 1 → page 2, sync run | 2.0 s between segments (media starts ≈ 2 s into the page) | best effort, see plan §6 |

The navigation gap makes the A run's verdict **Audio recorded with gaps**. That's
honest by definition: speech during a page load isn't captured.

## Seq gaps (§5): trim vs soft. **Decision: soft**

Scenario F records 8 s with `timeslice` 1000 (9 chunks) and plays three
stitched blobs in Chrome:

| Blob | `<audio>` | `decodeAudioData` |
| --- | --- | --- |
| all chunks | duration 8.1 s, plays to the end | 8.16 s |
| chunk 3 missing | duration 8.1 s (cluster timestamps kept), **plays to the end, no error**, seek past the hole works | 7.14 s (the hole is closed up) |
| chunk 0 missing | `MEDIA_ERR_SRC_NOT_SUPPORTED` | `EncodingError` |

So: a missing `seq` 0 drops the segment. It goes to `audioDropped`, and its
time shows as a gap with the reason "Audio segment lost". A missing middle
chunk keeps every chunk (no trim). The segment carries `seqGaps` and the
summary says "Unreliable audio segments". In Chrome, `<audio>` keeps
wall-clock alignment after the hole because WebM cluster timestamps survive.
**Firefox and Safari (MP4 fragments) are unmeasured.** If either stops at the
hole, the player already reports the segment as unplayable from that point. If
either closes the hole up the way `decodeAudioData` does, audio after the hole
would drift, and coverage would need to come from media duration (plan's
longer-term item).

## Pending manual checklist (not passes)

1. **Safari, real mic** (required before Recovery is marked done, plan
   delivery stage 2): start with voice, check the level, navigate twice, mute,
   pause/resume, Retry after revoking the mic in Safari's site settings, Stop,
   download. Open the file offline in Safari: Enable audio, seek across a
   segment boundary, 1×/2×/4×.
2. **Real unplug** of a USB or Bluetooth mic mid-session, in Chrome, Firefox and
   Safari. Record whether `ended` or `mute` fires and how long until
   **Audio stopped** shows.
3. **Another app takes the mic** (e.g. a call app): record `mute` vs `ended`
   per browser. Today `mute` is only observed (`state.audio.trackMuted`).
4. **15-minute** three-page session with real speech, and one **60-minute**
   session. Check that export completes and that IndexedDB usage matches
   `navigator.storage.estimate()`.
5. **Firefox** rows above. The harness is Chrome-only. Firefox needs
   Playwright's Firefox build with `media.navigator.streams.fake`, which wasn't
   installed here.
6. **Seq-gap decode** in Firefox and Safari (the scenario F probe).
