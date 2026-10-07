// Turns loadSessionData() output into one self-contained replay HTML file.
// The controller performs the download; see docs/CONTRACTS.md (Export).
// The file is assembled as a Blob from parts, never as one string, so long
// sessions don't hit engine string limits or multiply memory.
import PLAYER_JS from 'virtual:player-bundle';
import { buildPayload } from './payload.js';
import { buildFilename, buildHtmlBlob } from './html.js';

const VERSION = typeof __TESTKIT_VERSION__ === 'string' ? __TESTKIT_VERSION__ : null;

export async function exportSession(data) {
  const payload = await buildPayload(data, { testkitVersion: VERSION });
  const { blob } = buildHtmlBlob({ payload, playerJs: PLAYER_JS });
  return { filename: buildFilename(data.session), blob, bytes: blob.size };
}
