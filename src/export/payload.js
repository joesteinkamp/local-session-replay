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
    out.push({ audioSegmentId: seg.audioSegmentId, startTs: seg.startTs, endTs: seg.endTs, mime: seg.mime || null, dataUrl });
  }
  return out.sort((a, b) => a.startTs - b.startTs);
}

export async function buildPayload({ session = {}, events = [], log = [], audio = [] }, { testkitVersion = null, now = Date.now() } = {}) {
  return {
    version: PAYLOAD_VERSION,
    testkitVersion,
    exportedAt: now,
    session,
    events,
    log,
    audio: await encodeAudio(audio),
    summaryMarkdown: buildSummary({ session, log, events, audio }),
  };
}
