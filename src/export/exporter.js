// Turns loadSessionData() output into one self-contained replay HTML file.
// The controller performs the download; see docs/CONTRACTS.md (Export).
import PLAYER_JS from 'virtual:player-bundle';
import { buildPayload } from './payload.js';
import { buildFilename, buildHtml, byteLength } from './html.js';

const VERSION = typeof __TESTKIT_VERSION__ === 'string' ? __TESTKIT_VERSION__ : null;

export async function exportSession(data) {
  const payload = await buildPayload(data, { testkitVersion: VERSION });
  const html = buildHtml({ payload, playerJs: PLAYER_JS });
  return { filename: buildFilename(data.session), html, bytes: byteLength(html) };
}
