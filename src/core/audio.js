// Think-aloud microphone capture. See "Audio" in docs/CONTRACTS.md.
//
// One MediaStream is held for the page's lifetime (preflight test → recording)
// so the browser prompts at most once per page. Each MediaRecorder start/stop
// span is an audio segment; chunks arrive every TIMESLICE_MS so a navigation
// loses at most about one chunk (data emitted after pagehide rarely persists).

const TIMESLICE_MS = 1000;
const STOP_TIMEOUT_MS = 2000;
const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
// Level meter maps RMS in dBFS onto 0..1: room noise ≈ 0–0.15, normal speech
// (−35…−15 dBFS) ≈ 0.5–0.9.
const FLOOR_DB = -60;
const CEIL_DB = -10;

export function pickMimeType(MR = globalThis.MediaRecorder) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return (
    MIME_PREFERENCE.find((type) => {
      try {
        return MR.isTypeSupported(type);
      } catch {
        return false;
      }
    }) || ''
  );
}

export function rmsToLevel(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
}

/** Maps a getUserMedia/MediaRecorder failure to a controller audio status. */
export function micErrorStatus(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { status: 'denied', error: 'Microphone access was denied' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { status: 'error', error: 'No microphone found' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { status: 'error', error: 'Microphone is in use by another application' };
  }
  return { status: 'error', error: err?.message || 'Microphone unavailable' };
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {object} opts
 * @param {number} opts.bitrate                 audioBitsPerSecond
 * @param {(chunk) => void} opts.onChunk        { audioSegmentId, seq, ts, startTs, mime, blob }
 * @param {(kind, err?) => void} [opts.onProblem]  'ended' (track lost) | 'error' (recorder failed)
 */
export function createAudioCapture({ bitrate, onChunk, onProblem = () => {} }) {
  let stream = null;
  let acquiring = null;
  let generation = 0; // bumped by release() so a late getUserMedia result is discarded
  let muted = false;
  let recorder = null;
  let segment = null;
  let ctx = null;
  let analyser = null;
  let samples = null;

  const tracks = () => (stream ? stream.getAudioTracks() : []);
  const isLive = () => tracks().some((t) => t.readyState === 'live');

  function setupMeter() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      // Not connected to the destination: metering only, no playback.
      ctx.createMediaStreamSource(stream).connect(analyser);
      ctx.resume?.().catch(() => {});
    } catch {
      ctx = null;
      analyser = null;
    }
  }

  /** Gets (or reuses) the mic stream. Rejects with the getUserMedia error. */
  function acquire() {
    if (isLive()) return Promise.resolve(stream);
    if (acquiring) return acquiring;
    const gen = generation;
    acquiring = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error('Microphone capture is not supported in this browser'), { name: 'NotSupportedError' });
      }
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (gen !== generation) {
        // Released (e.g. preflight cancelled) while the prompt was open.
        s.getTracks().forEach((t) => t.stop());
        throw Object.assign(new Error('Microphone request cancelled'), { name: 'AbortError' });
      }
      stream = s;
      for (const t of tracks()) {
        t.enabled = !muted;
        t.addEventListener('ended', () => onProblem('ended'));
      }
      setupMeter();
      return stream;
    })().finally(() => {
      acquiring = null;
    });
    return acquiring;
  }

  /** Starts a new audio segment on the live stream. Returns its id, or null. */
  function startSegment() {
    if (!isLive() || recorder) return null;
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not supported in this browser');
    const mimeType = pickMimeType();
    const options = { audioBitsPerSecond: bitrate };
    if (mimeType) options.mimeType = mimeType;
    const rec = new MediaRecorder(stream, options);
    const seg = { audioSegmentId: newId(), seq: 0, requestedAt: Date.now(), startTs: null, mime: null };
    seg.stopped = new Promise((resolve) => {
      rec.addEventListener('stop', () => {
        if (recorder === rec) {
          recorder = null;
          segment = null;
        }
        resolve();
      });
    });
    rec.addEventListener('start', () => {
      seg.startTs = Date.now();
    });
    rec.addEventListener('dataavailable', (e) => {
      if (!e.data || !e.data.size) return;
      // Safari may only report the container type once data flows.
      seg.mime ||= e.data.type || rec.mimeType || mimeType || 'audio/webm';
      try {
        onChunk({
          audioSegmentId: seg.audioSegmentId,
          seq: seg.seq++,
          ts: Date.now(),
          startTs: seg.startTs ?? seg.requestedAt,
          mime: seg.mime,
          blob: e.data,
        });
      } catch {
        // Persisting is the caller's concern; keep recording.
      }
    });
    rec.addEventListener('error', (e) => onProblem('error', e.error || e));
    rec.start(TIMESLICE_MS);
    recorder = rec;
    segment = seg;
    return seg.audioSegmentId;
  }

  /** Stops the current segment; resolves after its final chunk was emitted. */
  function stopSegment() {
    const rec = recorder;
    const seg = segment;
    if (!rec || !seg) return Promise.resolve();
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch {
      // Already stopping.
    }
    recorder = null;
    segment = null;
    return Promise.race([seg.stopped, new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS))]);
  }

  /** Asks the recorder to emit buffered audio now (best effort, e.g. when hidden). */
  function requestData() {
    try {
      if (recorder?.state === 'recording') recorder.requestData();
    } catch {
      // Not supported or already stopping.
    }
  }

  /** Mute keeps the recorder running (silence) so the audio clock stays aligned. */
  function setMuted(value) {
    muted = !!value;
    for (const t of tracks()) t.enabled = !muted;
  }

  function getLevel() {
    if (!analyser || muted || !isLive()) return 0;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      return rmsToLevel(Math.sqrt(sum / samples.length));
    } catch {
      return 0;
    }
  }

  /** Stops recording and releases the mic (the browser's indicator goes away). */
  async function release() {
    generation++;
    await stopSegment();
    for (const t of stream ? stream.getTracks() : []) t.stop();
    stream = null;
    try {
      await ctx?.close();
    } catch {
      // Already closed.
    }
    ctx = null;
    analyser = null;
  }

  return {
    acquire,
    startSegment,
    stopSegment,
    requestData,
    setMuted,
    getLevel,
    release,
    isLive,
    isRecording: () => !!recorder,
  };
}
