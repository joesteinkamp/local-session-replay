// Turns loadSessionData() output into one self-contained replay HTML file.
// The controller performs the download; see docs/CONTRACTS.md (Export).
// The file is assembled as a Blob from parts, never as one string, so long
// sessions don't hit engine string limits or multiply memory.
import PLAYER_JS from 'virtual:player-bundle';
import { AudioExportError, buildPayload } from './payload.js';
import { buildFilename, buildHtmlBlob } from './html.js';

const VERSION = typeof __TESTKIT_VERSION__ === 'string' ? __TESTKIT_VERSION__ : null;

// `withoutAudio` builds the visual-only fallback offered after an
// AudioExportError. A RangeError while assembling the file (string or memory
// limit) with audio is reported as an AudioExportError too, so the caller can
// offer that fallback.
export async function exportSession(data, { withoutAudio = false } = {}) {
  const payload = await buildPayload(data, { testkitVersion: VERSION, withoutAudio });
  let blob;
  try {
    ({ blob } = buildHtmlBlob({ payload, playerJs: PLAYER_JS }));
  } catch (err) {
    if (!withoutAudio && payload.audio.length && err instanceof RangeError) throw new AudioExportError(err);
    throw err;
  }
  return { filename: buildFilename(data.session), blob, bytes: blob.size };
}
