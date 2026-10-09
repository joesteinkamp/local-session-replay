# Change Log

## Hide page errors from the summary and replay (2026-10-08, Claude)

- **What:** the agent summary and the replay player no longer show the prototype's JS errors or promise rejections: no trail lines, Errors sections or counts, timeline ticks, legend item or task badges. The errors are still logged and kept in the raw JSON.
- **Ask:** an export listed React "Maximum update depth" errors under two tasks. TestKit runs usability tests, so code errors distract from what the tester did.
- **Why this approach:** hide them, don't stop capturing them. The raw data stays complete for developers, while every view a researcher sees is about behavior.
- **Rejected:** a setting to show or hide errors. Nobody asked for it, and it would add configuration for a view this tool shouldn't have.

## React adapter, audio recovery, and real-app hardening (2026-10-08, Claude)

- **What:** `<TestKit />` on a `local-session-replay/react` subpath (`init()` stays for non-React apps); microphone recovery (Retry, blocked/stopped notices, Continue without microphone) with status that only reads "Microphone on" while audio is being saved, and one saved-audio verdict shared by overlay, summary and player; Skip task; Start new session after Stop; `?test=1` captured at first import so router redirects can't drop it; replay player split out of the core (559 → 285 kB) and prefetched at start so export works offline; same-millisecond log order fixed; host focus traps no longer steal overlay focus; a Chrome browser harness and a browser × scenario matrix.
- **Ask:** run `react-adapter-plan.md` and `audio-recording-plan.md`, then prove it with real recordings in channel-checks and a plain non-React app.
- **Why this approach:** a subpath keeps the root entry free of React with no major version bump. Separating "chose voice" from "stop asking" stops a denial erasing evidence of saved audio. One retry path closes the pause race. The real-app runs surfaced the skip, redirect, new-session, ordering and chunk-size gaps that unit tests missed.
- **Rejected:** a React-only root (a breaking change); an npm workspace for the example (it added ~30 MB to every GitHub install); trimming audio at a missing middle chunk (Chrome plays through it); keeping several stopped sessions side by side (orphaned sessions would fill the quota); an in-page retry after a failed player import in bundled apps (Chrome caches the failure for the life of the page).

## Installable package for other web apps, hosted on GitHub (2026-10-07, Claude)

- **What:** renamed to `local-session-replay`. Added an ES module entry point (`init()`) that loads the recorder only when needed, plus types. It installs from GitHub and builds on install. Added a `baseUrl` option for the script tag, replaced GitLab CI with GitHub Actions + Pages, and licensed it MIT.
- **Ask:** a clean way to bring TestKit into another web app, as a standalone project on GitHub rather than under the AlphaSense npm scope.
- **Why this approach:** loading the recorder only on demand keeps "casual viewers pay ~1 KB", now inside the host app's bundle too. Installing from GitHub needs no registry or account. Shipping the built code avoids host bundlers having to handle the CSS and player-bundling steps in this build.
- **Rejected:** shipping source files for the host to bundle (they need this build's custom steps); publishing to npm for now (not needed yet, and the name `testkit` is taken); committing `dist/` instead of building on install (built files in git); the company npm scope (you want it standalone).

## TestKit v1: local session replay and think-aloud toolkit (2026-10-06, Claude)

- **What:** a drop-in `<script>` that records the page with rrweb, keeps a log of clicks and inputs by selector, and records think-aloud audio. It stores everything in the browser across page changes and shows a Shadow DOM overlay for running tasks. It exports one offline HTML file with a replay player, task timeline, synced audio and a per-task summary for AI agents.
- **Ask:** build `testkit-plan.md` phases 1–6.
- **Why this approach:**
  - rrweb is the recording layer the hosted platforms (PostHog, OpenReplay) are built on, and it needs no backend.
  - A ~1 KB loader keeps casual viewers from downloading the recorder.
  - Tab storage and a synchronous copy in local storage protect data at page changes, because browsers can abandon database writes when a page unloads.
  - Exported files block everything external, because the plan promises nothing leaves the machine.
- **Rejected:**
  - Hosted platforms, which need infrastructure.
  - Agentation's code, because of its licence.
  - The Web Speech API, which sends audio to Google.
  - Building the export as one string, which ran out of memory on large sessions.
  - Letting exported files load remote assets: better-looking replays, but opening the file contacts the prototype's server.
