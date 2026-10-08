// Decides whether TestKit records on this page load. Shared by the script-tag
// loader (src/loader.js) and the package entries (src/boot.js), so it must stay
// tiny: casual viewers download it.

// Per-study pointer `{ id, study, lastActivityAt }` written by testkit-core's
// store.js. Study normalization must match normalizeConfig() in
// src/core/config.js, and STALE_MS must match session.js.
const ACTIVE_PREFIX = 'testkit:active:';
const STALE_MS = 30 * 60 * 1000;

// Shared by every TestKit copy on the page (package + script tag), so only the
// first init() call anywhere starts a recorder.
export function claimInit() {
  if (window.__TestKitInitialized) return false;
  window.__TestKitInitialized = true;
  return true;
}

export const studyOf = (config) => String(config.study || 'untitled-study');

// A session idle for longer than STALE_MS (tab closed, browser crashed) must
// not silently restart screen and mic recording on a later visit.
function hasFreshSession(study) {
  try {
    const pointer = JSON.parse(localStorage.getItem(ACTIVE_PREFIX + study) || 'null');
    return !!pointer?.id && Date.now() - Number(pointer.lastActivityAt) < STALE_MS;
  } catch {
    return false;
  }
}

// The `test` param as it was when this module was first evaluated. A client
// router can redirect `/?test=1` to a route without the param before the
// React component's effect (or a late init()) reads the URL; the snapshot
// still counts it. One page load = one claim, so a snapshot taken on this page
// load stays valid however much later TestKit mounts. Null on the server.
const testParam = (search) => new URLSearchParams(search).get('test');
function snapshotTestParam() {
  try {
    return typeof window === 'undefined' || typeof location === 'undefined' ? null : testParam(location.search);
  } catch {
    return null;
  }
}
const initialTest = snapshotTestParam();

export function isActivated(config) {
  const activate = config.activate ?? 'query';
  const live = testParam(location.search);
  // An explicit ?test=0, now or at first import, always wins.
  if (live === '0' || initialTest === '0') return false;
  if (hasFreshSession(studyOf(config))) return true; // this study has a session in progress: survive navigation
  if (typeof activate === 'function') {
    // A throwing predicate must not abort the host's TestKit.init() call.
    try {
      return !!activate();
    } catch {
      return false;
    }
  }
  if (typeof activate === 'boolean') return activate;
  return live === '1' || (live === null && initialTest === '1');
}
