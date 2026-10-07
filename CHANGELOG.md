# Change Log

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
