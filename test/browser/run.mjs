// Real-browser audio harness (audio-recording-plan.md §6, delivery stages 1–3).
//
//   npm run test:browser            build, then run every scenario in Chrome
//   node test/browser/run.mjs A E   run only some scenarios (after a build)
//
// Drives the installed Google Chrome through playwright-core with a fake
// microphone (--use-fake-device-for-media-stream + a generated WAV), records
// sessions on the demo prototype served from public/ on port 8091, exports
// them, and checks the exported HTML offline. Device loss is simulated with
// track.stop() (no 'ended' event: the capture's watch must notice), denial by
// stubbing getUserMedia/permissions in the page. Results go to
// $TMPDIR/testkit-audio-harness/results.json; docs/audio-matrix.md records
// what they mean. What this cannot cover (real microphones, unplugging,
// Safari) is listed there as pending manual.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { audioReport } from '../../src/export/summary.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(root, 'public');
const outDir = path.join(os.tmpdir(), 'testkit-audio-harness');
const PORT = 8091;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEMO = `${ORIGIN}/demo`;
const SYNC_BUDGET_MS = 300; // the player's DRIFT_TOLERANCE_S
const only = process.argv.slice(2);

const results = { startedAt: new Date().toISOString(), browser: null, scenarios: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture: 10 s of speech-like audio (three partials, 4 Hz syllable envelope),
// loud enough to pass the mic check after Chrome's noise suppression.

function speechWav(seconds = 10, rate = 48000) {
  const n = seconds * rate;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = 0.35 + 0.65 * Math.max(0, Math.sin(2 * Math.PI * 4 * t));
    const pitch = 1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t);
    const v = env * (0.5 * Math.sin(2 * Math.PI * 180 * pitch * t) + 0.3 * Math.sin(2 * Math.PI * 360 * pitch * t) + 0.15 * Math.sin(2 * Math.PI * 720 * pitch * t));
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * 0.8)) * 32767), 44 + i * 2);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Static server for public/ (built by scripts/build.mjs).

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, ORIGIN);
      let file = path.join(publicDir, decodeURIComponent(url.pathname));
      if (!file.startsWith(publicDir)) throw new Error('outside');
      if (file.endsWith('/')) file += 'index.html';
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// In-page instrumentation, installed before any page script runs.
//  - counts getUserMedia calls and keeps the streams (to stop tracks / check release)
//  - localStorage 'harness:deny' = '1': getUserMedia rejects NotAllowedError and
//    the Permissions API reports 'denied' (a real, persistent denial)
//  - localStorage 'harness:gumDelay' = ms: holds the grant (late-grant tests)
//  - localStorage 'harness:synth' = '1': the mic is a WebAudio graph that beeps
//    every 2 s; each beep's wall time goes to localStorage 'harness:beeps'

const INSTRUMENT = () => {
  const md = navigator.mediaDevices;
  const realGum = md.getUserMedia.bind(md);
  const realQuery = navigator.permissions?.query?.bind(navigator.permissions);
  const h = (window.__harness = { gum: 0, streams: [] });
  const ls = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  if (realQuery) {
    navigator.permissions.query = (desc) =>
      desc?.name === 'microphone' && ls('harness:deny') === '1' ? Promise.resolve({ state: 'denied', onchange: null }) : realQuery(desc);
  }
  function synthStream() {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    const beeps = JSON.parse(ls('harness:beeps') || '[]');
    const beep = () => {
      if (ctx.state !== 'running') ctx.resume();
      const at = ctx.currentTime + 0.05;
      gain.gain.setValueAtTime(0.9, at);
      gain.gain.setValueAtTime(0, at + 0.08);
      // contextTime → performance time → wall clock (the recorder's time base).
      const ts = ctx.getOutputTimestamp();
      const perfAt = ts.performanceTime + (at - ts.contextTime) * 1000;
      const wall = performance.timeOrigin + perfAt;
      beeps.push(wall);
      localStorage.setItem('harness:beeps', JSON.stringify(beeps));
      // Visual marker at the same instant: a DOM change rrweb records.
      setTimeout(() => {
        let el = document.getElementById('harness-marker');
        if (!el) {
          el = document.createElement('div');
          el.id = 'harness-marker';
          document.body.append(el);
        }
        el.textContent = `beep ${beeps.length}`;
      }, Math.max(0, wall - Date.now()));
    };
    const timer = setInterval(beep, 2000);
    const stream = dest.stream;
    stream.getAudioTracks()[0].addEventListener('ended', () => clearInterval(timer));
    const stopAll = stream.getAudioTracks()[0].stop.bind(stream.getAudioTracks()[0]);
    stream.getAudioTracks()[0].stop = () => {
      clearInterval(timer);
      stopAll();
    };
    return stream;
  }
  md.getUserMedia = async (constraints) => {
    h.gum++;
    const delay = Number(ls('harness:gumDelay') || 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (ls('harness:deny') === '1') throw new DOMException('Permission denied', 'NotAllowedError');
    const stream = ls('harness:synth') === '1' ? synthStream() : await realGum(constraints);
    h.streams.push(stream);
    return stream;
  };
};

// ---------------------------------------------------------------------------
// Page helpers

const state = (page) => page.evaluate(() => window.TestKit?.controller?.getState() ?? null);

async function waitFor(page, fn, arg, { timeout = 10_000, what = 'condition' } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 50 });
  } catch (err) {
    const s = await state(page).catch(() => null);
    throw new Error(`timed out waiting for ${what}; state=${JSON.stringify(s && { phase: s.phase, audio: s.audio, error: s.error })}`, { cause: err });
  }
}

const waitPhase = (page, phase) =>
  waitFor(page, (p) => window.TestKit?.controller?.getState().phase === p, phase, { what: `phase ${phase}` });
const waitAudio = (page, status, timeout = 10_000) =>
  waitFor(page, (s) => window.TestKit?.controller?.getState().audio.status === s, status, { timeout, what: `audio ${status}` });

async function openPanel(page) {
  if (await page.locator('.tk-panel:not([hidden])').count()) return;
  await page.locator('.tk-bubble').click();
  await page.locator('.tk-panel:not([hidden])').waitFor();
}

const fid = (page, id) => page.locator(`[data-fid="${id}"]`);

async function startWithMic(page, { url = `${DEMO}/index.html?test=1` } = {}) {
  await page.goto(url);
  await page.locator('#testkit-root').waitFor({ state: 'attached' });
  await openPanel(page);
  await fid(page, 'start').click();
  await fid(page, 'consent').check();
  await fid(page, 'test-mic').click();
  await page.locator('.tk-notice.is-ok', { hasText: 'We can hear you' }).waitFor({ timeout: 15_000 });
}

// Records every (time, phase, audio status) the controller emits on this page.
const traceStatus = (page) =>
  page.evaluate(() => {
    window.__trace = [];
    window.__traceStart = Date.now();
    window.TestKit.controller.subscribe((s) => window.__trace.push([Date.now(), s.phase, s.audio.status]));
  });

// "live" must never be shown before the active segment has a saved chunk:
// the first recording-phase 'live' since the trace began comes after the
// earliest chunk saved since then (i.e. of the segment that action started).
async function assertLiveAfterFirstChunk(page, label) {
  const { firstLive, chunks } = await page.evaluate(async () => {
    const live = window.__trace.find(([, phase, status]) => phase === 'recording' && status === 'live');
    const since = window.__traceStart;
    const id = window.TestKit.controller.getState().sessionId;
    const db = await new Promise((res) => {
      const q = indexedDB.open('testkit');
      q.onsuccess = () => res(q.result);
    });
    const rows = await new Promise((res) => {
      const q = db.transaction('audio').objectStore('audio').index('sessionId').getAll(IDBKeyRange.only(id));
      q.onsuccess = () => res(q.result.map(({ audioSegmentId, seq, ts }) => ({ audioSegmentId, seq, ts })));
    });
    db.close();
    // Only chunks saved after the action (Start / Retry) belong to its segment.
    return { firstLive: live?.[0] ?? null, chunks: rows.filter((c) => c.ts >= since) };
  });
  assert.ok(firstLive, `${label}: went live`);
  const before = chunks.filter((c) => c.ts <= firstLive);
  assert.ok(before.length > 0, `${label}: 'live' at ${firstLive} before any chunk was saved (${JSON.stringify(chunks.slice(0, 3))})`);
  return { msFirstChunkToLive: firstLive - Math.min(...before.map((c) => c.ts)) };
}

// Preflight's level check also reports 'live', so wait for the session first.
async function beginRecording(page) {
  await traceStatus(page);
  await fid(page, 'start-session').click();
  await waitPhase(page, 'recording');
  await waitAudio(page, 'live');
}

async function idbAudio(page) {
  return page.evaluate(async () => {
    const id = window.TestKit.controller.getState().sessionId;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('testkit');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise((res, rej) => {
      const r = db.transaction('audio').objectStore('audio').index('sessionId').getAll(IDBKeyRange.only(id));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return rows.map(({ audioSegmentId, seq, ts, startTs, mime, blob }) => ({ audioSegmentId, seq, ts, startTs, mime, size: blob.size }));
  });
}

async function stopAndDownload(page, name) {
  await openPanel(page);
  await fid(page, 'stop').click();
  await fid(page, 'confirm-yes').click();
  await waitPhase(page, 'stopped');
  await waitFor(page, () => !!window.TestKit.controller.getState().savedAudio, null, { what: 'savedAudio' });
  const line = await page.locator('[data-saved-audio]').textContent();
  const savedAudio = (await state(page)).savedAudio;
  const [download] = await Promise.all([page.waitForEvent('download'), fid(page, 'download').click()]);
  const file = path.join(outDir, `${name}.html`);
  await download.saveAs(file);
  return { file, line, savedAudio };
}

async function readExport(file) {
  const html = await readFile(file, 'utf8');
  const open = '<script type="application/json" id="testkit-data">';
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}

const reportOf = (payload) =>
  audioReport({ session: payload.session, log: payload.log, events: payload.events, audio: payload.audio, dropped: payload.audioDropped });

// Opens an export offline and checks every segment decodes and indexes.
async function openPlayer(context, file) {
  // The export's CSP (default-src 'none') blocks fetch(), even of data: URLs.
  await context.addInitScript(() => {
    window.__buf = (dataUrl) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0)).buffer;
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => !!window.TestKitPlayer, null, { timeout: 15_000 });
  return page;
}

async function decodeSmoke(page) {
  return page.evaluate(async () => {
    const els = [...document.querySelectorAll('audio')];
    const deadline = Date.now() + 15_000;
    // The player indexes MediaRecorder WebM (no duration) by seeking far once.
    while (Date.now() < deadline && els.some((el) => !el.error && !(Number.isFinite(el.duration) && el.readyState >= 1))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const segs = window.TestKitPlayer.data.audio;
    const out = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const seg = segs[i];
      let decoded = null;
      try {
        const buf = window.__buf(seg.dataUrl);
        const ac = new OfflineAudioContext(1, 1, 48000);
        decoded = (await ac.decodeAudioData(buf)).duration;
      } catch (err) {
        decoded = `error: ${err.name}`;
      }
      out.push({ index: i, error: el.error?.code ?? null, duration: el.duration, wallSeconds: (seg.endTs - seg.startTs) / 1000, decoded });
    }
    return out;
  });
}

// Player alignment: with the replayer as clock, the active <audio> should sit
// at (wall - startTs). Measured after playback settles (1 s) at each speed,
// at the beginning, middle and end of each segment.
async function playerAlignment(page, speeds = [1, 2, 4]) {
  return page.evaluate(async (speeds) => {
    const tk = window.TestKitPlayer;
    const replayer = tk.player.getReplayer();
    const t0 = tk.data.events[0].timestamp;
    const segs = tk.data.audio;
    const els = [...document.querySelectorAll('audio')];
    const rows = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const speed of speeds) {
      tk.player.setSpeed(speed);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const len = seg.endTs - seg.startTs;
        for (const [where, frac] of [['begin', 0.1], ['middle', 0.5], ['end', 0.8]]) {
          // Leave room for the 1 s settle plus a sample before the segment ends.
          const playMs = 1000 * speed + 400 * speed;
          const at = Math.min(seg.startTs + len * frac, seg.endTs - playMs - 200);
          if (at < seg.startTs) continue;
          tk.seekToWall(at);
          tk.player.play();
          await sleep(1000);
          const el = els[i];
          const wall = t0 + replayer.getCurrentTime();
          const target = (wall - seg.startTs) / 1000;
          rows.push({ speed, segment: i, where, playing: !el.paused, driftMs: Math.round((el.currentTime - target) * 1000) });
          tk.player.pause();
        }
      }
    }
    tk.player.setSpeed(1);
    return rows;
  }, speeds);
}

// ---------------------------------------------------------------------------
// Scenarios

const scenarios = {};

// A: baseline — pass mic check, Continue-without-audio still offered, mute,
// pause, two navigations (mute carried across one), forced track.stop() →
// Audio stopped (announced while collapsed) → Retry, Stop, export, decode,
// gap list, alignment at 1×/2×/4×, 8× mute, seek across segments.
scenarios.A = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', e.message));

  await startWithMic(page);
  r.continueWithoutAudioAfterPass = await fid(page, 'skip-audio').isVisible();
  assert.ok(r.continueWithoutAudioAfterPass, 'Continue without audio stays after a passed check');
  await traceStatus(page);
  await fid(page, 'start-session').click();
  await waitPhase(page, 'recording');
  const t = Date.now();
  await waitAudio(page, 'live');
  r.msToLive = Date.now() - t;
  r.liveAfterChunk = await assertLiveAfterFirstChunk(page, 'A start');

  await sleep(3000);
  await fid(page, 'mute').click();
  await waitAudio(page, 'muted');
  const muteAt = Date.now();
  await sleep(3000);
  await fid(page, 'mute').click();
  const unmuteAt = Date.now();
  await waitAudio(page, 'live');
  await sleep(2000);
  await fid(page, 'pause').click();
  await waitPhase(page, 'paused');
  const pauseAt = Date.now();
  r.pausedBadgeNotLive = (await state(page)).audio.status !== 'live';
  r.pauseCopy = await page.locator('.tk-notice.is-warn').first().textContent();
  await sleep(2500);
  await fid(page, 'pause').click(); // Resume
  const resumeAt = Date.now();
  await waitAudio(page, 'live');
  await sleep(2500);

  // Navigation 1 → about.html (loader stays active via the active pointer).
  await page.locator('header a[href="about.html"]').click();
  await page.waitForURL(/about\.html/);
  await waitPhase(page, 'recording');
  await waitAudio(page, 'live');
  await sleep(3000);
  // Mute here and carry it across navigation 2.
  await openPanel(page);
  await fid(page, 'mute').click();
  await waitAudio(page, 'muted');
  await page.goto(`${DEMO}/company.html?name=Meridian%20Health`);
  await waitPhase(page, 'recording');
  await waitAudio(page, 'muted');
  r.muteSurvivedNavigation = (await state(page)).muted === true;
  await sleep(1500);
  await openPanel(page);
  await fid(page, 'mute').click();
  await waitAudio(page, 'live');
  await sleep(3000);

  // Device loss: stop the track locally (fires no 'ended'), panel collapsed.
  await fid(page, 'collapse').click();
  const killAt = Date.now();
  await page.evaluate(() => window.__harness.streams.at(-1).getAudioTracks().forEach((tr) => tr.stop()));
  await waitAudio(page, 'error', 5000);
  r.msToAudioStopped = Date.now() - killAt;
  await sleep(200);
  r.announcedCollapsed = await page.locator('.tk-layer > .tk-sr[role="status"]').textContent();
  r.visualStillRecording = (await state(page)).phase === 'recording';
  await sleep(3000);
  await openPanel(page);
  r.stoppedNotice = await page.locator('.tk-notice.is-error').first().textContent();
  const retryAt = Date.now();
  await traceStatus(page);
  await fid(page, 'mic-retry').click();
  await waitAudio(page, 'live');
  r.msRetryToLive = Date.now() - retryAt;
  r.retryTrace = await page.evaluate(() => window.__trace.map(([, , s]) => s).filter((s, i, a) => s !== a[i - 1]));
  assert.deepEqual(r.retryTrace.slice(-2), ['reconnecting', 'live'], `retry status sequence ${r.retryTrace}`);
  r.retryLiveAfterChunk = await assertLiveAfterFirstChunk(page, 'A retry');
  await sleep(3000);

  const raw = await idbAudio(page);
  const { file, line, savedAudio } = await stopAndDownload(page, 'A-baseline');
  r.preDownloadLine = line;
  const payload = await readExport(file);
  const report = reportOf(payload);
  r.segments = payload.audio.length;
  r.gaps = report.gaps.map((g) => ({ startS: +((g.start - payload.session.startedAt) / 1000).toFixed(2), ms: g.durationMs, reason: g.reason }));
  r.verdict = report.label;
  r.summaryLine = payload.summaryMarkdown.split('\n').find((l) => l.startsWith('- Audio saved:'));
  r.seqGaps = payload.audio.filter((a) => a.seqGaps).length + payload.audioDropped.length;
  r.chunksDuringPause = raw.filter((c) => c.ts > pauseAt + 300 && c.ts < resumeAt).length;
  r.mutedSpan = { startS: (muteAt - payload.session.startedAt) / 1000, endS: (unmuteAt - payload.session.startedAt) / 1000 };

  // Five segments: page 1 before/after pause, page 2, page 3 before the kill, after Retry.
  assert.equal(r.segments, 5, 'segment count');
  assert.equal(line.split(' (')[0], report.label, 'overlay line = export verdict');
  assert.equal(savedAudio.gaps, report.gaps.length, 'overlay and export see the same gaps');
  assert.equal(r.summaryLine.replace('- Audio saved: ', '').split(' (')[0], report.label, 'summary = export verdict');
  const killGap = report.gaps.find((g) => g.start <= retryAt && g.end >= killAt);
  assert.ok(killGap && killGap.durationMs >= 2500, `a gap covers track.stop → Retry (${JSON.stringify(r.gaps)})`);
  assert.equal(killGap.reason, 'Microphone disconnected');
  assert.ok(!report.gaps.some((g) => g.start < resumeAt - 600 && g.end > pauseAt + 600), 'pause is not an audio gap');
  assert.equal(r.chunksDuringPause, 0, 'no chunks while paused');
  assert.ok(r.msToAudioStopped <= 2000, `Audio stopped within 2 s (${r.msToAudioStopped} ms)`);
  assert.equal(r.announcedCollapsed, 'Audio stopped — screen is still recording.');
  assert.ok(r.muteSurvivedNavigation);
  assert.ok(r.pausedBadgeNotLive);

  // Visual-only fallback: the player must still report what was saved.
  const [visualDl] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.TestKit.controller.exportSession({ withoutAudio: true })),
  ]);
  const visualFile = path.join(outDir, 'A-without-audio.html');
  await visualDl.saveAs(visualFile);

  // Offline player: decode, alignment, 8×, seek across a boundary and a gap.
  const offline = await browser.newContext({ offline: true });
  const player = await openPlayer(offline, file);
  r.decode = await decodeSmoke(player);
  assert.ok(r.decode.every((d) => d.error === null && Number.isFinite(d.duration)), `every segment decodes: ${JSON.stringify(r.decode)}`);
  r.alignment = await playerAlignment(player);
  r.maxAbsDriftMs = Math.max(...r.alignment.map((a) => Math.abs(a.driftMs)));
  r.mutedSpanRms = await mutedRms(player, payload, muteAt, unmuteAt);
  r.fast = await player.evaluate(async () => {
    const tk = window.TestKitPlayer;
    const segs = tk.data.audio;
    const i = segs.reduce((best, s, k) => (s.endTs - s.startTs > segs[best].endTs - segs[best].startTs ? k : best), 0);
    const seg = segs[i];
    const el = document.querySelectorAll('audio')[i];
    tk.seekToWall(seg.startTs + 500);
    tk.player.setSpeed(8);
    tk.player.play();
    await new Promise((r) => setTimeout(r, 350));
    const status8 = document.querySelector('.tk-audio-status').textContent;
    const anyPlaying = [...document.querySelectorAll('audio')].some((a) => !a.paused);
    tk.player.setSpeed(1);
    await new Promise((r) => setTimeout(r, 1000));
    const wall = tk.data.events[0].timestamp + tk.player.getReplayer().getCurrentTime();
    const inside = wall < seg.endTs;
    const drift = Math.round((el.currentTime - (wall - seg.startTs) / 1000) * 1000);
    const playingAfter = !el.paused;
    tk.player.pause();
    return { status8, anyPlayingAt8: anyPlaying, inside, resyncDriftMs: drift, playingAfter };
  });
  r.seekAcross = await player.evaluate(async (gap) => {
    const tk = window.TestKitPlayer;
    const status = () => document.querySelector('.tk-audio-status').textContent;
    tk.player.setSpeed(1);
    tk.seekToWall(gap.start + 200);
    tk.player.play();
    await new Promise((r) => setTimeout(r, 300));
    const inGap = status();
    await new Promise((r) => setTimeout(r, gap.end - gap.start + 1200));
    const after = status();
    const playing = [...document.querySelectorAll('audio')].filter((el) => !el.paused).length;
    tk.player.pause();
    return { inGap, after, playingElements: playing };
  }, killGap);
  assert.match(r.seekAcross.inGap, /No audio at this point/);
  assert.match(r.seekAcross.after, /Playing segment/);
  assert.equal(r.fast.anyPlayingAt8, false, 'audio paused above 4×');
  assert.ok(r.fast.inside && r.fast.playingAfter && Math.abs(r.fast.resyncDriftMs) <= SYNC_BUDGET_MS, `8× → 1× resync ${JSON.stringify(r.fast)}`);
  const visual = await openPlayer(offline, visualFile);
  r.withoutAudio = await visual.evaluate(() => ({
    header: [...document.querySelectorAll('.tk-meta div')].find((d) => d.querySelector('dt')?.textContent === 'Audio')?.querySelector('dd').textContent,
    gapMarks: document.querySelectorAll('.tk-gap').length,
    status: document.querySelector('.tk-audio-status')?.textContent,
    elements: document.querySelectorAll('audio').length,
  }));
  assert.equal(r.withoutAudio.header, `${report.label} — left out of this file (too large to export)`);
  assert.equal(r.withoutAudio.gapMarks, report.gaps.length, 'gap marks kept');
  assert.equal(r.withoutAudio.elements, 0);
  await offline.close();
  await context.close();
  return r;
};

// RMS of the muted vs unmuted span in the first segment (decoded offline).
async function mutedRms(page, payload, muteAt, unmuteAt) {
  return page.evaluate(async ({ muteAt, unmuteAt }) => {
    const seg = window.TestKitPlayer.data.audio[0];
    const buf = window.__buf(seg.dataUrl);
    const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const rms = (a, b) => {
      const from = Math.max(0, Math.floor(((a - seg.startTs) / 1000) * audio.sampleRate));
      const to = Math.min(ch.length, Math.floor(((b - seg.startTs) / 1000) * audio.sampleRate));
      let sum = 0;
      for (let i = from; i < to; i++) sum += ch[i] * ch[i];
      return to > from ? +Math.sqrt(sum / (to - from)).toFixed(5) : null;
    };
    return { muted: rms(muteAt + 400, unmuteAt - 400), unmuted: rms(seg.startTs + 1000, muteAt - 400) };
  }, { muteAt, unmuteAt });
}

// B: audio on pages 1–2, persistent denial on page 3, page 4 must not prompt.
scenarios.B = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await startWithMic(page);
  await beginRecording(page);
  r.liveAfterChunk = await assertLiveAfterFirstChunk(page, 'B start');
  await sleep(3000);
  await page.locator('header a[href="about.html"]').click();
  await page.waitForURL(/about\.html/);
  await waitAudio(page, 'live');
  await sleep(3000);
  await page.evaluate(() => localStorage.setItem('harness:deny', '1'));
  await page.goto(`${DEMO}/company.html?name=Arcwise`);
  await waitPhase(page, 'recording');
  await waitAudio(page, 'denied');
  const s3 = await state(page);
  r.page3 = { status: s3.audio.status, stopAsking: s3.audio.stopAsking, gum: await page.evaluate(() => window.__harness.gum) };
  await openPanel(page);
  r.blockedNotice = await page.locator('.tk-notice.is-error').first().textContent();
  r.blockedPrimary = await fid(page, 'mic-help').textContent();
  await sleep(2000);
  await page.goto(`${DEMO}/index.html`);
  await waitPhase(page, 'recording');
  await sleep(1500);
  r.page4 = { gum: await page.evaluate(() => window.__harness.gum), status: (await state(page)).audio.status };
  assert.equal(r.page4.status, 'denied', 'a remembered denial still reads as blocked');
  const { file, line } = await stopAndDownload(page, 'B-denied-page3');
  r.preDownloadLine = line;
  const payload = await readExport(file);
  const report = reportOf(payload);
  r.segments = payload.audio.length;
  r.verdict = report.label;
  r.summaryHasNotRecorded = /not recorded/i.test(payload.summaryMarkdown);
  r.sessionAudio = payload.session.audio;
  assert.equal(r.page3.stopAsking, true);
  assert.equal(r.page4.gum, 0, 'no permission request on page 4');
  assert.equal(r.segments, 2);
  assert.equal(r.verdict, 'Audio recorded with gaps');
  assert.equal(line.split(' (')[0], r.verdict);
  assert.equal(r.summaryHasNotRecorded, false);
  const offline = await browser.newContext({ offline: true });
  const player = await openPlayer(offline, file);
  r.decode = await decodeSmoke(player);
  r.playerHeaderAudio = await player.locator('.tk-meta div', { hasText: 'Audio' }).locator('dd').textContent();
  assert.ok(r.decode.every((d) => d.error === null));
  await offline.close();
  await context.close();
  return r;
};

// C: Continue without audio after a passed check → screen-only consent, no
// capture, mic released, "No audio recorded", zero segments.
scenarios.C = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await startWithMic(page);
  await fid(page, 'skip-audio').click();
  r.consentText = await page.locator('#tk-consent-text').textContent();
  r.checkboxLabel = await page.locator('.tk-check span').textContent();
  await fid(page, 'start-session').click();
  await waitPhase(page, 'recording');
  await sleep(1000);
  r.micReleased = await page.evaluate(() => window.__harness.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
  await sleep(1500);
  await page.locator('header a[href="about.html"]').click();
  await page.waitForURL(/about\.html/);
  await waitPhase(page, 'recording');
  await sleep(1500);
  r.gumAfterNavigation = await page.evaluate(() => window.__harness.gum);
  const { file, line } = await stopAndDownload(page, 'C-no-audio');
  r.preDownloadLine = line;
  const payload = await readExport(file);
  r.segments = payload.audio.length;
  r.verdict = reportOf(payload).label;
  assert.match(r.consentText, /screen activity on this device only/);
  assert.ok(!/microphone/i.test(r.consentText));
  assert.ok(r.micReleased);
  assert.equal(r.gumAfterNavigation, 0);
  assert.equal(r.segments, 0);
  assert.equal(line, 'No audio recorded');
  await context.close();
  return r;
};

// D: Cancel / Stop / Discard release the mic even when the grant lands later.
scenarios.D = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const allEnded = (page) => page.evaluate(() => window.__harness.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));

  // Cancelled setup with the permission request still open.
  let page = await context.newPage();
  await page.goto(`${DEMO}/index.html?test=1`);
  await page.evaluate(() => localStorage.setItem('harness:gumDelay', '1500'));
  await openPanel(page);
  await fid(page, 'start').click();
  await fid(page, 'test-mic').click();
  await fid(page, 'cancel').click();
  await waitPhase(page, 'idle');
  await sleep(2200);
  r.cancelLateGrant = { streams: await page.evaluate(() => window.__harness.streams.length), released: await allEnded(page) };

  // Stop and Discard while a Retry's request is still open.
  for (const action of ['stop', 'discard']) {
    await page.evaluate(() => localStorage.removeItem('harness:gumDelay'));
    await startWithMic(page);
    await beginRecording(page);
    await page.evaluate(() => window.__harness.streams.at(-1).getAudioTracks().forEach((tr) => tr.stop()));
    await waitAudio(page, 'error', 5000);
    await page.evaluate(() => localStorage.setItem('harness:gumDelay', '1500'));
    await page.evaluate(() => {
      window.__retry = window.TestKit.controller.retryMic();
    });
    await sleep(200);
    await page.evaluate((a) => window.TestKit.controller[a](), action);
    await sleep(2200);
    r[`${action}LateGrant`] = {
      retry: await page.evaluate(() => window.__retry),
      status: (await state(page)).audio.status,
      released: await allEnded(page),
    };
    if (action === 'stop') await page.evaluate(() => window.TestKit.controller.discard());
    await page.evaluate(() => localStorage.removeItem('harness:gumDelay'));
  }
  assert.ok(r.cancelLateGrant.released);
  assert.ok(r.stopLateGrant.released && r.discardLateGrant.released);
  await context.close();
  return r;
};

// E: end-to-end sync with an injected tick. The mic is a WebAudio graph that
// beeps every 2 s (wall time recorded); a DOM marker changes at each beep. The
// export is played at 1×, 2×, 4× and each detected beep onset is compared with
// the replayer's clock (recording-timeline time). Echo cancellation is
// bypassed, so no speaker→mic loopback is involved.
scenarios.E = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await page.goto(`${DEMO}/index.html?test=1`);
  await page.evaluate(() => {
    localStorage.setItem('harness:synth', '1');
    localStorage.removeItem('harness:beeps');
  });
  await openPanel(page);
  await fid(page, 'start').click();
  await fid(page, 'consent').check();
  await fid(page, 'test-mic').click();
  // Beeps are 80 ms every 2 s: too sparse for the level check, so skip it via
  // the controller (the mic check UI is covered by scenario A).
  await sleep(500);
  await page.evaluate(() => window.TestKit.controller.start({ consent: true, audio: true }));
  await waitAudio(page, 'live');
  await sleep(11_000);
  await page.locator('header a[href="about.html"]').click();
  await page.waitForURL(/about\.html/);
  await waitAudio(page, 'live');
  await sleep(11_000);
  const beeps = await page.evaluate(() => JSON.parse(localStorage.getItem('harness:beeps') || '[]'));
  const { file } = await stopAndDownload(page, 'E-sync');
  await page.evaluate(() => localStorage.removeItem('harness:synth'));
  const payload = await readExport(file);
  r.beeps = beeps.length;
  r.segments = payload.audio.length;

  const offline = await browser.newContext({ offline: true });
  const player = await openPlayer(offline, file);
  // Capture offset: where each beep sits in its segment's media vs its wall time.
  r.capture = await player.evaluate(async (beeps) => {
    const out = [];
    for (const seg of window.TestKitPlayer.data.audio) {
      const buf = window.__buf(seg.dataUrl);
      const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const win = Math.round(audio.sampleRate * 0.002);
      let last = -1;
      for (let i = 0; i + win < ch.length; i += win) {
        let peak = 0;
        for (let j = i; j < i + win; j++) peak = Math.max(peak, Math.abs(ch[j]));
        if (peak > 0.2 && i - last > audio.sampleRate) {
          last = i;
          const wallFromMedia = seg.startTs + (i / audio.sampleRate) * 1000;
          const nearest = beeps.reduce((a, b) => (Math.abs(b - wallFromMedia) < Math.abs(a - wallFromMedia) ? b : a), Infinity);
          out.push({ segment: seg.audioSegmentId.slice(0, 6), mediaS: +(i / audio.sampleRate).toFixed(3), offsetMs: Math.round(wallFromMedia - nearest) });
        }
      }
    }
    return out;
  }, beeps);
  // Playback: detect onsets from the playing element against the replayer clock.
  r.playback = await player.evaluate(async (beeps) => {
    const tk = window.TestKitPlayer;
    const t0 = tk.data.events[0].timestamp;
    const replayer = tk.player.getReplayer();
    const els = [...document.querySelectorAll('audio')];
    const ac = new AudioContext();
    await ac.resume();
    const analysers = els.map((el) => {
      const src = ac.createMediaStreamSource(el.captureStream());
      const an = ac.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      return an;
    });
    const buf = new Float32Array(256);
    const rows = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const speed of [1, 2, 4]) {
      tk.player.setSpeed(speed);
      tk.seekToWall(tk.data.audio[0].startTs + 200);
      tk.player.play();
      const settleUntil = performance.now() + 1000;
      let lastOnset = -Infinity;
      const end = tk.data.audio.at(-1).endTs;
      while (t0 + replayer.getCurrentTime() < end - 300) {
        await new Promise((r) => requestAnimationFrame(r));
        let peak = 0;
        for (const an of analysers) {
          an.getFloatTimeDomainData(buf);
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
        }
        const wall = t0 + replayer.getCurrentTime();
        if (peak > 0.2 && wall - lastOnset > 1000) {
          lastOnset = wall;
          const nearest = beeps.reduce((a, b) => (Math.abs(b - wall) < Math.abs(a - wall) ? b : a), Infinity);
          rows.push({ speed, settled: performance.now() > settleUntil, errorMs: Math.round(wall - nearest), atS: +((wall - t0) / 1000).toFixed(1) });
        }
        if (performance.now() - settleUntil > 40_000) break;
      }
      tk.player.pause();
      await sleep(300);
    }
    tk.player.setSpeed(1);
    return rows;
  }, beeps);
  const settled = r.playback.filter((p) => p.settled);
  r.syncBySpeed = Object.fromEntries([1, 2, 4].map((sp) => {
    const rows = settled.filter((p) => p.speed === sp);
    return [sp, { n: rows.length, maxAbsErrorMs: rows.length ? Math.max(...rows.map((p) => Math.abs(p.errorMs))) : null }];
  }));
  r.captureMaxAbsOffsetMs = Math.max(...r.capture.map((c) => Math.abs(c.offsetMs)));
  for (const sp of [1, 2, 4]) {
    assert.ok(r.syncBySpeed[sp].n >= 3, `${sp}×: enough settled beeps (${r.syncBySpeed[sp].n})`);
    assert.ok(r.syncBySpeed[sp].maxAbsErrorMs <= SYNC_BUDGET_MS, `${sp}×: ${r.syncBySpeed[sp].maxAbsErrorMs} ms > ${SYNC_BUDGET_MS} ms`);
  }
  await offline.close();
  await context.close();
  return r;
};

// F: how a stitched segment with a missing chunk decodes (drives the §5
// trim-vs-soft policy). Records 8 s with timeslice 1000 in-page, then plays
// the full blob, one missing a middle chunk, and one missing seq 0.
scenarios.F = async (browser) => {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  const page = await context.newPage();
  await page.goto(`${DEMO}/about.html`);
  const r = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(1000);
    await new Promise((r) => setTimeout(r, 8200));
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    async function probe(parts) {
      const blob = new Blob(parts, { type: mime });
      let decoded;
      try {
        decoded = +(await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await blob.arrayBuffer())).duration.toFixed(2);
      } catch (err) {
        decoded = `error: ${err.name}`;
      }
      const el = new Audio(URL.createObjectURL(blob));
      const meta = await new Promise((resolve) => {
        el.onloadedmetadata = () => resolve('ok');
        el.onerror = () => resolve(`error ${el.error?.code}`);
        setTimeout(() => resolve('timeout'), 4000);
      });
      if (meta !== 'ok') return { decoded, element: meta };
      if (el.duration === Infinity) {
        await new Promise((resolve) => {
          el.ondurationchange = () => Number.isFinite(el.duration) && resolve();
          el.currentTime = 1e7;
          setTimeout(resolve, 3000);
        });
        el.currentTime = 0;
      }
      const duration = +el.duration.toFixed(2);
      el.playbackRate = 4;
      el.muted = true;
      let errorAt = null;
      el.onerror = () => (errorAt = el.currentTime);
      await el.play().catch(() => {});
      await new Promise((resolve) => {
        el.onended = resolve;
        setTimeout(resolve, 5000);
      });
      const played = { ended: el.ended, reached: +el.currentTime.toFixed(2), errorAt, error: el.error?.code ?? null };
      // Seek past the hole too.
      let seekPastHole = null;
      try {
        el.currentTime = Math.min(duration - 0.5, 5.5);
        await new Promise((resolve) => {
          el.onseeked = resolve;
          setTimeout(resolve, 1500);
        });
        seekPastHole = { currentTime: +el.currentTime.toFixed(2), error: el.error?.code ?? null };
      } catch (err) {
        seekPastHole = `throws ${err.name}`;
      }
      return { decoded, element: 'ok', duration, played, seekPastHole };
    }
    return {
      mime,
      chunks: chunks.length,
      full: await probe(chunks),
      missingMiddle: await probe(chunks.filter((_, i) => i !== 3)),
      missingFirst: await probe(chunks.slice(1)),
    };
  });
  await context.close();
  // What the policy rests on (Chrome): a hole keeps timing and plays through;
  // no seq 0 is undecodable.
  assert.equal(r.full.played.ended, true);
  assert.equal(r.missingMiddle.element, 'ok');
  assert.equal(r.missingMiddle.played.error, null, 'missing middle chunk: no media error');
  assert.equal(r.missingMiddle.played.ended, true, 'missing middle chunk: plays to the end');
  assert.ok(Math.abs(r.missingMiddle.duration - r.full.duration) < 0.1, 'missing middle chunk: timestamps kept');
  assert.equal(r.missingMiddle.seekPastHole.error, null);
  assert.match(r.missingFirst.element, /^error/, 'missing seq 0: element fails');
  assert.match(String(r.missingFirst.decoded), /^error/, 'missing seq 0: decode fails');

  // Through TestKit itself: two segments, then seq 0 of one and seq 2 of the
  // other are deleted from IndexedDB before export.
  r.pipeline = await seqGapPipeline(browser);
  return r;
};

async function seqGapPipeline(browser) {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await startWithMic(page);
  await beginRecording(page);
  await sleep(4500);
  await fid(page, 'pause').click();
  await waitPhase(page, 'paused');
  await fid(page, 'pause').click();
  await waitAudio(page, 'live');
  await sleep(5000);
  await openPanel(page);
  await fid(page, 'stop').click();
  await fid(page, 'confirm-yes').click();
  await waitPhase(page, 'stopped');
  r.deleted = await page.evaluate(async () => {
    const id = window.TestKit.controller.getState().sessionId;
    const db = await new Promise((res) => {
      const q = indexedDB.open('testkit');
      q.onsuccess = () => res(q.result);
    });
    const tx = db.transaction('audio', 'readwrite');
    const store = tx.objectStore('audio');
    const rows = await new Promise((res) => {
      const q = store.index('sessionId').getAll(IDBKeyRange.only(id));
      q.onsuccess = () => res(q.result);
    });
    const segs = [...new Set(rows.sort((a, b) => a.ts - b.ts).map((x) => x.audioSegmentId))];
    const victims = [rows.find((x) => x.audioSegmentId === segs[0] && x.seq === 0), rows.find((x) => x.audioSegmentId === segs[1] && x.seq === 2)];
    for (const v of victims) store.delete(v.id);
    await new Promise((res) => (tx.oncomplete = res));
    db.close();
    return { segments: segs.length, chunks: segs.map((sg) => rows.filter((x) => x.audioSegmentId === sg).length) };
  });
  const [download] = await Promise.all([page.waitForEvent('download'), fid(page, 'download').click()]);
  const file = path.join(outDir, 'F-seq-gaps.html');
  await download.saveAs(file);
  const payload = await readExport(file);
  r.audio = payload.audio.map((a) => ({ seqGaps: a.seqGaps ?? null }));
  r.dropped = payload.audioDropped.map((d) => d.reason);
  r.summary = payload.summaryMarkdown.split('\n').filter((l) => /Lost audio|Unreliable audio|Audio saved/.test(l));
  r.lostGap = reportOf(payload).gaps.find((g) => /Audio segment lost/.test(g.reason || '')) ? true : false;
  const offline = await browser.newContext({ offline: true });
  const player = await openPlayer(offline, file);
  r.decode = await decodeSmoke(player);
  await offline.close();
  await context.close();
  assert.equal(r.deleted.segments, 2);
  assert.deepEqual(r.dropped, ['missing-first-chunk'], 'segment without seq 0 dropped');
  assert.deepEqual(r.audio, [{ seqGaps: [2] }], 'middle hole kept and reported');
  assert.ok(r.summary.some((l) => l.startsWith('- Lost audio segments: 1')), r.summary.join(' | '));
  assert.ok(r.summary.some((l) => l.startsWith('- Unreliable audio segments: 1')), r.summary.join(' | '));
  assert.ok(r.lostGap, 'the dropped segment shows as a gap with its reason');
  assert.equal(r.decode[0].error, null, 'segment with a hole still plays');
  return r;
}

// H: 60 minutes' worth of audio (the supported maximum) through export.
// Real time is impractical here, so a short real session gets 3600 extra 1 s
// chunks (≈ 32 kbps) written straight into IndexedDB as one more segment;
// this measures storage, the export's encode/assembly and the player parse,
// not hour-long capture (pending manual in docs/audio-matrix.md).
scenarios.H = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await startWithMic(page);
  await beginRecording(page);
  await sleep(3000);
  r.injected = await page.evaluate(async () => {
    const s = window.TestKit.controller.getState();
    const db = await new Promise((res) => {
      const q = indexedDB.open('testkit');
      q.onsuccess = () => res(q.result);
    });
    const chunk = new Blob([new Uint8Array(4000).map((_, i) => (i * 31) & 255)], { type: 'audio/webm;codecs=opus' });
    const start = s.startedAt - 3_600_000;
    const tx = db.transaction('audio', 'readwrite');
    for (let seq = 0; seq < 3600; seq++) {
      tx.objectStore('audio').add({ sessionId: s.sessionId, audioSegmentId: 'synthetic-60min', seq, ts: start + (seq + 1) * 1000, startTs: start, mime: 'audio/webm;codecs=opus', blob: chunk });
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onabort = () => rej(tx.error);
    });
    db.close();
    const est = await navigator.storage.estimate();
    return { chunks: 3600, bytes: 3600 * 4000, usageMB: +(est.usage / 1e6).toFixed(1), quotaMB: +(est.quota / 1e6).toFixed(0) };
  });
  const t = Date.now();
  const { file } = await stopAndDownload(page, 'H-60min-volume');
  r.exportMs = Date.now() - t;
  const html = await readFile(file);
  r.fileMB = +(html.length / 1e6).toFixed(1);
  const offline = await browser.newContext({ offline: true });
  const player = await openPlayer(offline, file);
  r.playerSegments = await player.evaluate(() => window.TestKitPlayer.data.audio.length);
  r.exportError = (await state(page)).error;
  assert.equal(r.exportError, null);
  assert.equal(r.playerSegments, 2);
  await offline.close();
  await context.close();
  return r;
};

// G: autoplay blocked → "Enable audio" appears; a click plays. Headless
// Chrome did not block audible autoplay even with
// --autoplay-policy=document-user-activation-required, so the policy is
// simulated: play() rejects with NotAllowedError until the page has seen a
// trusted pointer/key event (what Chrome/Safari do for unmuted media).
scenarios.G = async (browser) => {
  const r = {};
  const file = path.join(outDir, 'A-baseline.html');
  if (!existsSync(file)) return { skipped: 'needs scenario A output' };
  const context = await browser.newContext({ offline: true });
  // navigator.userActivation already reads as active under automation, so a
  // trusted pointer/key event is what counts as the gesture here.
  await context.addInitScript(() => {
    let gesture = false;
    for (const type of ['pointerdown', 'keydown']) addEventListener(type, (e) => e.isTrusted && (gesture = true), true);
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      if (!gesture) return Promise.reject(new DOMException('autoplay blocked (simulated)', 'NotAllowedError'));
      return realPlay.call(this);
    };
  });
  const page = await openPlayer(context, file);
  await page.evaluate(() => {
    const tk = window.TestKitPlayer;
    tk.seekToWall(tk.data.audio[0].startTs + 500);
    tk.player.play(); // not a user gesture
  });
  await sleep(1500);
  r.enableVisible = await page.getByRole('button', { name: 'Enable audio' }).isVisible();
  r.statusBlocked = await page.locator('.tk-audio-status').textContent();
  if (r.enableVisible) {
    await page.getByRole('button', { name: 'Enable audio' }).click();
    await sleep(1200);
    r.playingAfterClick = await page.evaluate(() => [...document.querySelectorAll('audio')].some((el) => !el.paused));
    r.statusAfterClick = await page.locator('.tk-audio-status').textContent();
  }
  await page.evaluate(() => window.TestKitPlayer.player.pause());
  assert.ok(r.enableVisible, 'Enable audio shown when autoplay is blocked');
  assert.ok(r.playingAfterClick, 'audio plays after Enable audio');
  await context.close();
  return r;
};

// I: product gaps found in a real-app integration (no audio needed).
//  - a redirect that strips ?test=1 before init() still activates (snapshot)
//  - Skip task shows as Skipped in the stopped panel, summary and player
//  - Start new session: straight to setup once downloaded (the downloaded
//    session is deleted when the next starts); otherwise asks first
scenarios.I = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  // Like a router beforeLoad redirect: the URL loses ?test=1 between the
  // package's first evaluation and init().
  await context.route(`${DEMO}/redirect.html*`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Redirect</title>
      <link rel="stylesheet" href="styles.css">
      <script src="../v1/testkit.js"></script>
      <script>history.replaceState(null, '', 'redirect.html#signal-report');</script>
      <script src="testkit-config.js"></script></head>
      <body><main><h1>Signal report</h1></main></body></html>`,
  }));
  const page = await context.newPage();
  await page.goto(`${DEMO}/redirect.html?test=1`);
  await page.locator('#testkit-root').waitFor({ state: 'attached', timeout: 10_000 });
  r.redirectSearch = await page.evaluate(() => location.search);
  assert.equal(r.redirectSearch, '', 'the redirect dropped the param');

  const sessionsInDb = () => page.evaluate(async () => {
    const db = await new Promise((res) => {
      const q = indexedDB.open('testkit');
      q.onsuccess = () => res(q.result);
    });
    const ids = await new Promise((res) => {
      const q = db.transaction('sessions').objectStore('sessions').getAllKeys();
      q.onsuccess = () => res(q.result);
    });
    db.close();
    return ids;
  });
  const startScreenOnly = async () => {
    await fid(page, 'skip-audio').click();
    await fid(page, 'consent').check();
    await fid(page, 'start-session').click();
    await waitPhase(page, 'recording');
  };

  await openPanel(page);
  await fid(page, 'start').click();
  await startScreenOnly();
  // Double clicks advance once, including on the second-to-last task.
  await fid(page, 'skip-task').dblclick();
  await waitFor(page, () => window.TestKit.controller.getState().taskIndex === 1, null, { what: 'task 2' });
  await sleep(500);
  r.afterDblSkip = (await state(page)).taskIndex;
  await fid(page, 'next').dblclick();
  await waitFor(page, () => window.TestKit.controller.getState().taskIndex === 2, null, { what: 'task 3' });
  await sleep(500);
  r.afterDblNext = { taskIndex: (await state(page)).taskIndex, phase: (await state(page)).phase };
  assert.equal(r.afterDblSkip, 1, 'double-clicked Skip advanced once');
  assert.deepEqual(r.afterDblNext, { taskIndex: 2, phase: 'recording' }, 'double-clicked Next advanced once');
  await fid(page, 'skip-task').click(); // task 3 has a follow-up: Skip bypasses it
  await waitPhase(page, 'stopped');
  r.panelTally = await page.locator('.tk-meta dd').nth(2).textContent();
  r.panelHeading = await page.locator('.tk-h').textContent();
  const firstId = (await state(page)).sessionId;
  const [download] = await Promise.all([page.waitForEvent('download'), fid(page, 'download').click()]);
  const file = path.join(outDir, 'I-skipped.html');
  await download.saveAs(file);
  const payload = await readExport(file);
  r.summaryTasks = payload.summaryMarkdown.split('\n').find((l) => l.startsWith('- Tasks completed:'));
  r.summaryStatuses = payload.summaryMarkdown.split('\n').filter((l) => l.startsWith('- Status:'));
  const player = await openPlayer(context, file);
  r.playerTasks = await player.locator('.tk-meta').textContent();
  r.playerSkippedBadges = await player.locator('.tk-badge', { hasText: 'Skipped' }).count();
  await player.close();
  assert.equal(r.panelTally, '1 of 3 completed, 2 skipped');
  assert.equal(r.panelHeading, 'Session complete');
  assert.equal(r.summaryTasks, '- Tasks completed: 1 of 3, 2 skipped');
  assert.deepEqual(r.summaryStatuses, ['- Status: Skipped', '- Status: Completed', '- Status: Skipped']);
  assert.match(r.playerTasks, /1 of 3 completed, 2 skipped/);
  assert.equal(r.playerSkippedBadges, 2);

  // Downloaded: Start new session goes straight to setup; Cancel comes back.
  await fid(page, 'new-session').click();
  await waitPhase(page, 'preflight');
  r.previousNotice = await page.locator('[data-previous-download]').textContent();
  assert.match(r.previousNotice, /previous session’s file was downloaded at/);
  await fid(page, 'cancel').click();
  await waitPhase(page, 'stopped');
  r.backToSame = (await state(page)).sessionId === firstId;
  await fid(page, 'new-session').click();
  await waitPhase(page, 'preflight');
  await startScreenOnly();
  const secondId = (await state(page)).sessionId;
  r.afterSecondStart = await sessionsInDb();
  assert.ok(r.backToSame, 'Cancel returns to the stopped session');
  assert.deepEqual(r.afterSecondStart, [secondId], 'the downloaded session was deleted once the next one started');

  // Not downloaded: asks first; Download first, then straight to setup.
  await fid(page, 'stop').click();
  await fid(page, 'confirm-yes').click();
  await waitPhase(page, 'stopped');
  await fid(page, 'new-session').click();
  r.confirmText = await page.locator('#tk-new-q').textContent();
  r.phaseWhileAsking = (await state(page)).phase;
  await Promise.all([page.waitForEvent('download'), fid(page, 'confirm-download').click()]);
  await waitFor(page, () => window.TestKit.controller.getState().downloaded === true, null, { what: 'downloaded' });
  await fid(page, 'new-session').click();
  await waitPhase(page, 'preflight');
  assert.match(r.confirmText, /hasn’t been downloaded/);
  assert.equal(r.phaseWhileAsking, 'stopped');
  await fid(page, 'cancel').click();
  await waitPhase(page, 'stopped');
  await page.evaluate(() => window.TestKit.controller.discard());
  await context.close();
  return r;
};

// J: 14 log entries in one millisecond keep their order in the export (row
// keys `<batchId>:l<n>` alone sort l10 before l2).
scenarios.J = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const sourceRequests = [];
  page.on('request', (req) => /testkit-player-source/.test(req.url()) && sourceRequests.push(new URL(req.url()).pathname));
  await page.goto(`${DEMO}/index.html?test=1`);
  await page.locator('#testkit-root').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const c = window.TestKit.controller;
    await c.beginPreflight();
    await c.start({ consent: true, audio: false });
  });
  await sleep(2500); // the start batch flushes, so the clicks start a batch at l0
  r.clicked = await page.evaluate(() => {
    const ids = [];
    for (let i = 0; i < 14; i++) {
      const b = document.createElement('button');
      b.id = `b${String(i).padStart(2, '0')}`;
      b.textContent = b.id;
      document.querySelector('main').append(b);
      ids.push(b.id);
    }
    const t = Date.now();
    for (const id of ids) document.getElementById(id).click();
    return { ids, sameMs: Date.now() === t };
  });
  await sleep(2500);
  // SPA navigation to a deeper path: the player source must still load from
  // the folder testkit-core.js came from, not relative to the page.
  await page.evaluate(() => history.pushState(null, '', '/demo/app/deep/route'));
  await page.evaluate(() => window.TestKit.controller.stop());
  await waitPhase(page, 'stopped');
  await openPanel(page);
  const [download] = await Promise.all([page.waitForEvent('download'), fid(page, 'download').click()]);
  r.playerSourceRequests = sourceRequests;
  // Prefetched at start (before the pushState), next to testkit-core.js; the export reuses it.
  assert.deepEqual(sourceRequests, ['/v1/testkit-player-source.js'], 'loaded next to testkit-core.js, once');
  const file = path.join(outDir, 'J-order.html');
  await download.saveAs(file);
  const payload = await readExport(file);
  r.exported = payload.log.filter((e) => e.type === 'click' && /^#b\d/.test(e.selector)).map((e) => e.selector.slice(1));
  assert.deepEqual(r.exported, r.clicked.ids);
  const player = await openPlayer(context, file); // the inlined player runs offline
  r.playerLoaded = await player.evaluate(() => !!window.TestKitPlayer?.data);
  await player.close();
  assert.ok(r.playerLoaded);
  await page.evaluate(() => window.TestKit.controller.discard());
  await context.close();
  return r;
};

// K: the npm package build (dist/) in a module page: the ?test snapshot
// survives a redirect, and export loads the lazily split player chunk after
// an SPA navigation. dist/ is served under /pkg/ by request routing.
scenarios.K = async (browser) => {
  const r = {};
  const distDir = path.join(root, 'dist');
  const net = { blockPlayer: false };
  const routePackageApp = (context) => context.route(`${ORIGIN}/pkg/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (net.blockPlayer && /\/chunks\/testkit-player-/.test(pathname)) return route.abort('internetdisconnected');
    if (pathname.startsWith('/pkg/dist/')) {
      const file = path.join(distDir, pathname.slice('/pkg/dist/'.length));
      if (!file.startsWith(distDir) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Package app</title>
        <script type="module">
          import { init } from '/pkg/dist/index.js';
          history.replaceState(null, '', '/pkg/app/signal-report'); // router redirect drops ?test=1
          window.__boot = init({ study: 'pkg-study', audio: false, tasks: [{ id: 't1', prompt: 'One' }] });
        </script></head><body><main><h1>Package app</h1><button id="go">Go</button></main></body></html>`,
    });
  });
  const context = await browser.newContext({ acceptDownloads: true });
  await routePackageApp(context);
  const page = await context.newPage();
  const playerChunks = [];
  page.on('request', (req) => /testkit-player-/.test(req.url()) && playerChunks.push(new URL(req.url()).pathname));
  await page.goto(`${ORIGIN}/pkg/app/?test=1`);
  await page.locator('#testkit-root').waitFor({ state: 'attached', timeout: 15_000 });
  r.search = await page.evaluate(() => location.search);
  await page.evaluate(async () => {
    const c = window.TestKit.controller;
    await c.beginPreflight();
    await c.start({ consent: true, audio: false });
  });
  await page.locator('#go').click();
  await page.evaluate(() => history.pushState(null, '', '/pkg/app/elsewhere/deeper'));
  await page.evaluate(() => window.TestKit.controller.stop());
  await waitPhase(page, 'stopped');
  await openPanel(page);
  const [download] = await Promise.all([page.waitForEvent('download'), fid(page, 'download').click()]);
  const file = path.join(outDir, 'K-package.html');
  await download.saveAs(file);
  r.playerChunkRequests = playerChunks;
  const payload = await readExport(file);
  r.clickLogged = payload.log.some((e) => e.type === 'click' && e.selector === '#go');
  const player = await openPlayer(context, file);
  r.playerLoaded = await player.evaluate(() => !!window.TestKitPlayer?.data);
  await player.close();
  assert.equal(r.search, '');
  assert.ok(r.playerChunkRequests.length === 1 && r.playerChunkRequests[0].startsWith('/pkg/dist/chunks/'), JSON.stringify(r.playerChunkRequests));
  assert.ok(r.clickLogged);
  assert.ok(r.playerLoaded);
  await page.evaluate(() => window.TestKit.controller.discard());
  await context.close();

  // The player chunk fails (prefetch and export): Chrome caches the failed
  // import() for the page, so the retry reloads into the stopped session.
  net.blockPlayer = true;
  const ctx2 = await browser.newContext({ acceptDownloads: true });
  await routePackageApp(ctx2);
  const p2 = await ctx2.newPage();
  await p2.goto(`${ORIGIN}/pkg/app/?test=1`);
  await p2.locator('#testkit-root').waitFor({ state: 'attached', timeout: 15_000 });
  await p2.evaluate(async () => {
    const c = window.TestKit.controller;
    await c.beginPreflight();
    await c.start({ consent: true, audio: false });
  });
  await p2.evaluate(() => history.pushState(null, '', '/pkg/app/elsewhere'));
  await p2.evaluate(() => window.TestKit.controller.stop());
  await waitPhase(p2, 'stopped');
  const stoppedId = (await state(p2)).sessionId;
  await openPanel(p2);
  await fid(p2, 'download').click();
  await waitFor(p2, () => window.TestKit.controller.getState().exportNeedsReload === true, null, { what: 'exportNeedsReload' });
  r.reloadCopy = await p2.locator('.tk-notice.is-error').first().textContent();
  r.retryLabel = await fid(p2, 'download').textContent();
  net.blockPlayer = false; // back online
  // Precondition (the bug): an in-page retry still fails, with no request made.
  let retryRequests = 0;
  const countRetry = (req) => /testkit-player-/.test(req.url()) && retryRequests++;
  p2.on('request', countRetry);
  r.inPageRetry = await p2.evaluate(() => window.TestKit.controller.exportSession().then(() => 'ok', (e) => e.message));
  p2.off('request', countRetry);
  r.inPageRetryRequests = retryRequests;
  assert.notEqual(r.inPageRetry, 'ok', 'an in-page retry cannot recover (cached failed import)');
  await Promise.all([p2.waitForEvent('load'), fid(p2, 'download').click()]);
  r.reloadedUrl = await p2.evaluate(() => location.pathname + location.search);
  await p2.locator('#testkit-root').waitFor({ state: 'attached', timeout: 15_000 });
  await waitPhase(p2, 'stopped');
  r.sameSession = (await state(p2)).sessionId === stoppedId;
  await openPanel(p2);
  const [dl2] = await Promise.all([p2.waitForEvent('download'), fid(p2, 'download').click()]);
  const file2 = path.join(outDir, 'K-package-after-reload.html');
  await dl2.saveAs(file2);
  r.afterReloadSessionId = (await readExport(file2)).session.id;
  assert.equal(r.reloadCopy, 'The replay player couldn’t load. Reload and download again — your session is saved.');
  assert.equal(r.retryLabel, 'Reload and retry');
  assert.ok(r.sameSession, 'reloaded into the stopped session');
  assert.equal(r.afterReloadSessionId, stoppedId);
  await p2.evaluate(() => window.TestKit.controller.discard());
  await ctx2.close();
  return r;
};

// L: the player is prefetched when recording starts, so an export works with
// the player URL blocked afterwards (tester offline); blocked from the start,
// the export fails with a clear error. Casual viewers never fetch it.
scenarios.L = async (browser) => {
  const r = {};
  const PLAYER = '**/v1/testkit-player-source.js';
  const requests = [];
  const run = async ({ blockFromStart }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    if (blockFromStart) await context.route(PLAYER, (route) => route.abort('internetdisconnected'));
    const page = await context.newPage();
    page.on('request', (req) => /testkit-player-source/.test(req.url()) && requests.push(blockFromStart ? 'blocked-run' : 'cached-run'));
    await page.goto(`${DEMO}/index.html?test=1`);
    await page.locator('#testkit-root').waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      const c = window.TestKit.controller;
      await c.beginPreflight();
      await c.start({ consent: true, audio: false });
    });
    await sleep(1000);
    if (!blockFromStart) await context.route(PLAYER, (route) => route.abort('internetdisconnected')); // goes offline after start
    await page.evaluate(() => window.TestKit.controller.stop());
    await waitPhase(page, 'stopped');
    await openPanel(page);
    return { context, page };
  };

  // Casual viewer: no ?test=1, no player request.
  const casual = await browser.newContext();
  const viewer = await casual.newPage();
  let casualRequests = 0;
  viewer.on('request', (req) => /testkit-player|testkit-core/.test(req.url()) && casualRequests++);
  await viewer.goto(`${DEMO}/index.html`);
  await sleep(500);
  await casual.close();
  r.casualRequests = casualRequests;

  {
    const { context, page } = await run({ blockFromStart: false });
    const [download] = await Promise.all([page.waitForEvent('download'), fid(page, 'download').click()]);
    const file = path.join(outDir, 'L-offline.html');
    await download.saveAs(file);
    const player = await openPlayer(context, file);
    r.cachedExportPlays = await player.evaluate(() => !!window.TestKitPlayer?.data);
    await player.close();
    await page.evaluate(() => window.TestKit.controller.discard());
    await context.close();
  }
  {
    const { context, page } = await run({ blockFromStart: true });
    await fid(page, 'download').click();
    await page.locator('.tk-notice.is-error', { hasText: 'Export failed' }).waitFor({ timeout: 10_000 });
    r.blockedError = await page.locator('.tk-notice.is-error', { hasText: 'Export failed' }).textContent();
    r.blockedPhase = (await state(page)).phase;
    r.blockedRetryLabel = await fid(page, 'download').textContent(); // script path: in-page retry
    await page.evaluate(() => window.TestKit.controller.discard());
    await context.close();
  }
  r.requests = requests;
  assert.equal(r.casualRequests, 0);
  assert.ok(r.cachedExportPlays, 'export from the prefetched player opens');
  assert.equal(requests.filter((x) => x === 'cached-run').length, 1, 'prefetched once; the export used the cache');
  assert.match(r.blockedError, /Could not load the replay player/);
  assert.equal(r.blockedPhase, 'stopped');
  assert.equal(r.blockedRetryLabel, 'Try download again');
  assert.equal(requests.filter((x) => x === 'blocked-run').length, 2, 'prefetch failed silently and the export retried');
  return r;
};

// M: audio tail at full navigations. A segment ends with its last stored
// chunk; the time from there to the page's beforeunload is audio lost at the
// navigation (up to one 1 s timeslice). Six navigations (link clicks and
// page.goto, at varied offsets into the timeslice), then the tails are
// measured from IndexedDB rows and the log.
scenarios.M = async (browser) => {
  const r = {};
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await startWithMic(page);
  await beginRecording(page);
  const waits = [2300, 2550, 2800, 3050, 2400, 2700];
  for (let i = 0; i < waits.length; i++) {
    await sleep(waits[i]);
    if (i % 2 === 0) {
      await page.locator('header a[href="about.html"]').click();
      await page.waitForURL(/about\.html/);
    } else {
      await page.goto(`${DEMO}/index.html`);
    }
    await waitPhase(page, 'recording');
    await waitAudio(page, 'live');
  }
  await sleep(2000);
  const { file } = await stopAndDownload(page, 'M-nav-tail');
  const payload = await readExport(file);
  const unloads = payload.log.filter((e) => e.type === 'nav' && e.navType === 'beforeunload').map((e) => e.ts);
  const segs = [...payload.audio].sort((a, b) => a.startTs - b.startTs);
  r.tailsMs = unloads.map((t) => {
    const seg = segs.filter((s) => s.startTs <= t).at(-1);
    return seg ? t - seg.endTs : null;
  });
  const tails = r.tailsMs.filter((x) => x !== null);
  r.meanTailMs = Math.round(tails.reduce((a, b) => a + b, 0) / Math.max(1, tails.length));
  r.maxTailMs = Math.max(...tails);
  r.segments = segs.length;
  r.verdict = reportOf(payload).label;
  assert.equal(unloads.length, waits.length);
  // Measured 2026-10-08 (Chrome 155, localhost): mean ~493 ms without the
  // requestData() at navigation intent, ~215 ms with it; max unchanged
  // (~850 ms) when the chunk's IndexedDB write loses the race with unload.
  assert.ok(r.meanTailMs < 350, `mean audio tail at navigation ${r.meanTailMs} ms`);
  await page.evaluate(() => window.TestKit.controller.discard());
  await context.close();
  return r;
};

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(path.join(publicDir, 'v1', 'testkit-core.js'))) throw new Error('Build first: node scripts/build.mjs');
  if (!only.length) await rm(outDir, { recursive: true, force: true }); // subsets reuse earlier exports (G needs A)
  await mkdir(outDir, { recursive: true });
  const wav = path.join(outDir, 'speech.wav');
  await writeFile(wav, speechWav());
  const server = await serve();
  const launched = [];
  const launch = async (extra = []) => {
    const b = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, ...extra],
    });
    launched.push(b);
    return b;
  };
  let failed = 0;
  try {
    const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
    results.browser = `Chrome ${browser.version()}`;
    console.log(`Browser: ${results.browser}`);
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only.length && !only.includes(name)) continue;
      const t = Date.now();
      try {
        const res = await fn(browser, launch);
        results.scenarios[name] = { pass: true, ms: Date.now() - t, ...res };
        console.log(`✔ ${name} (${Date.now() - t} ms)`);
      } catch (err) {
        failed++;
        results.scenarios[name] = { pass: false, ms: Date.now() - t, error: String(err?.stack || err) };
        console.log(`✖ ${name}: ${err?.message || err}`);
      }
    }
  } finally {
    for (const b of launched) await b.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
  await writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nResults: ${path.join(outDir, 'results.json')}`);
  if (failed) process.exitCode = 1;
}

await main();
