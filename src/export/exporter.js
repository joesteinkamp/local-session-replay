// Turns loadSessionData() output into one self-contained replay HTML file.
// The controller performs the download; see docs/CONTRACTS.md (Export).
// The file is assembled as a Blob from parts, never as one string, so long
// sessions don't hit engine string limits or multiply memory.
// The player source is loaded lazily: a dynamic import() chunk in the package
// build, testkit-player-source.js in the script build (scripts/build.mjs).
// Either way it is inlined into the file, which stays fully offline.
import { loadPlayerJs } from 'virtual:player-bundle';
import { AudioExportError, buildPayload } from './payload.js';
import { buildFilename, buildHtmlBlob } from './html.js';

const VERSION = typeof __TESTKIT_VERSION__ === 'string' ? __TESTKIT_VERSION__ : null;

// One successful load per page, kept in memory: a tester who goes offline
// after recording starts can still download. A failed load is forgotten, so
// the export tries again.
let playerSource = null;
function loadPlayer() {
  playerSource ??= loadPlayerJs().catch((err) => {
    playerSource = null;
    throw err;
  });
  return playerSource;
}

/** Starts loading the player in the background (active sessions only); never rejects. */
export function prefetchPlayer() {
  loadPlayer().catch(() => {});
}

// `withoutAudio` builds the visual-only fallback offered after an
// AudioExportError. A RangeError while assembling the file (string or memory
// limit) with audio is reported as an AudioExportError too, so the caller can
// offer that fallback.
export async function exportSession(data, { withoutAudio = false } = {}) {
  const [payload, playerJs] = await Promise.all([buildPayload(data, { testkitVersion: VERSION, withoutAudio }), loadPlayer()]);
  let blob;
  try {
    ({ blob } = buildHtmlBlob({ payload, playerJs }));
  } catch (err) {
    if (!withoutAudio && payload.audio.length && err instanceof RangeError) throw new AudioExportError(err);
    throw err;
  }
  return { filename: buildFilename(data.session), blob, bytes: blob.size };
}
