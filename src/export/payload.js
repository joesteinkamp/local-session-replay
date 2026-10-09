// Builds the JSON payload embedded in the export. No bundle imports, so it
// runs under node:test.
import { buildSummary } from './summary.js';

export const PAYLOAD_VERSION = 1;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked so String.fromCharCode never exceeds the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function blobToDataUrl(blob, mime) {
  const type = mime || blob.type || 'application/octet-stream';
  if (typeof FileReader !== 'undefined') {
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read audio blob'));
      reader.readAsDataURL(blob);
    });
    // FileReader uses blob.type, which can be empty for concatenated chunks.
    return url.replace(/^data:[^;,]*/, `data:${type}`);
  }
  return `data:${type};base64,${arrayBufferToBase64(await blob.arrayBuffer())}`;
}

export async function encodeAudio(audio = []) {
  const out = [];
  for (const seg of audio) {
    if (!seg) continue;
    const dataUrl = seg.dataUrl || (seg.blob ? await blobToDataUrl(seg.blob, seg.mime) : null);
    if (!dataUrl) continue;
    const item = { audioSegmentId: seg.audioSegmentId, startTs: seg.startTs, endTs: seg.endTs, mime: seg.mime || null };
    if (Array.isArray(seg.seqGaps) && seg.seqGaps.length) item.seqGaps = seg.seqGaps;
    out.push({ ...item, dataUrl });
  }
  return out.sort((a, b) => a.startTs - b.startTs);
}

// Thrown when the audio can't be encoded into the file (too large for the
// engine's string or memory limits). The visual replay can still be exported
// with `{ withoutAudio: true }`.
export const AUDIO_EXPORT_FAILED = 'The session file is too large to include the audio. Download the visual replay without audio instead.';

export class AudioExportError extends Error {
  constructor(cause) {
    super(AUDIO_EXPORT_FAILED);
    this.name = 'AudioExportError';
    this.cause = cause;
  }
}

/**
 * `withoutAudio` exports the visual replay only; the summary still reports the
 * audio that was saved (and that it was left out of this file).
 */
export async function buildPayload(
  { session = {}, events = [], log = [], audio = [], audioDropped = [] },
  { testkitVersion = null, now = Date.now(), withoutAudio = false } = {},
) {
  let encoded = [];
  if (!withoutAudio) {
    try {
      encoded = await encodeAudio(audio);
    } catch (err) {
      throw new AudioExportError(err);
    }
  }
  const summary = buildSummary({ session, log, events, audio, audioDropped });
  return {
    version: PAYLOAD_VERSION,
    testkitVersion,
    exportedAt: now,
    session,
    events,
    log,
    audio: encoded,
    audioDropped,
    audioOmitted: withoutAudio && audio.length > 0,
    // What was saved but left out (no data), so the player reports the same
    // verdict and gaps as the summary.
    omittedAudio: withoutAudio ? audio.map(({ audioSegmentId, startTs, endTs, mime, seqGaps }) => ({ audioSegmentId, startTs, endTs, mime: mime || null, ...(seqGaps?.length ? { seqGaps } : {}) })) : [],
    summaryMarkdown: withoutAudio && audio.length
      ? `${summary}\n> Audio (${audio.length} segment${audio.length === 1 ? '' : 's'}) was left out of this file because it was too large to export.\n`
      : summary,
  };
}
