'use strict';

// Tests that need no npm dependencies: validation, real FFmpeg/FFprobe, and the job lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createFfmpeg } = require('../src/ffmpeg');
const { JobManager } = require('../src/jobs');
const v = require('../src/validate');
const { silent, haveFfmpeg, tmpDir, makeSample, waitFor } = require('./helpers');

const HAS_FFMPEG = haveFfmpeg();
const skipNoFfmpeg = HAS_FFMPEG ? false : 'ffmpeg/ffprobe not installed';

function setup(envOverrides = {}) {
  const dataDir = tmpDir('sm-data-');
  const cfg = loadConfig({ DATA_DIR: dataDir, ...envOverrides });
  const ffmpeg = createFfmpeg(cfg);
  const jobs = new JobManager(cfg, ffmpeg, silent);
  return { dataDir, cfg, ffmpeg, jobs };
}

const infoFor = (d) => ({ durationSec: d, width: 640, height: 360, formatName: 'mov,mp4,m4a,3gp,3g2,mj2' });
const finished = (jobs, job) => waitFor(() => job.status === 'completed' || job.status === 'failed');

// ---------- validation (pure) ----------
test('upload meta: accepts mp4/mov/webm, rejects everything else', () => {
  assert.equal(v.checkUploadMeta('a.MP4', 'video/mp4'), '.mp4');
  assert.equal(v.checkUploadMeta('a.mov', 'video/quicktime'), '.mov');
  assert.equal(v.checkUploadMeta('a.webm', 'video/webm'), '.webm');
  assert.equal(v.checkUploadMeta('a.mov', 'application/octet-stream'), '.mov');
  assert.throws(() => v.checkUploadMeta('a.exe', 'video/mp4'), { code: 'UNSUPPORTED_FORMAT' });
  assert.throws(() => v.checkUploadMeta('a.mp4.exe', 'video/mp4'), { code: 'UNSUPPORTED_FORMAT' });
  assert.throws(() => v.checkUploadMeta('a.mp4', 'text/html'), { code: 'UNSUPPORTED_MIME' });
  assert.throws(() => v.checkUploadMeta('../../etc/passwd', 'video/mp4'), { code: 'UNSUPPORTED_FORMAT' });
});

test('process options: defaults match the Stage 1 frontend (duration only)', () => {
  const cfg = loadConfig({});
  const p = v.parseProcessOptions({ duration: '30' }, infoFor(120), cfg);
  assert.equal(p.mode, 'interval-basic');
  assert.deepEqual(p.options, { aspect: '9:16', resolution: '720p', width: 720, height: 1280 });
  assert.deepEqual(p.clips, [{ startSec: 0, durationSec: 30 }]);
});

test('process options: rejects bad values', () => {
  const cfg = loadConfig({});
  const bad = (body, code) => assert.throws(() => v.parseProcessOptions(body, infoFor(120), cfg), { code });
  bad({ duration: '20' }, 'INVALID_DURATION');
  bad({ duration: 'abc' }, 'INVALID_FIELD');
  bad({ duration: ['15', '30'] }, 'INVALID_FIELD');
  bad({ clipCount: '0' }, 'INVALID_CLIP_COUNT');
  bad({ clipCount: '99' }, 'INVALID_CLIP_COUNT');
  bad({ clipCount: '1.5' }, 'INVALID_CLIP_COUNT');
  bad({ aspect: '4:3' }, 'INVALID_FIELD');
  bad({ resolution: '4k' }, 'INVALID_FIELD');
  bad({ start: '-1' }, 'INVALID_START');
  bad({ start: '500' }, 'INVALID_START');
});

test('process options: clips are spread evenly and never overlap', () => {
  const cfg = loadConfig({});
  const p = v.parseProcessOptions({ duration: '15', clipCount: '3' }, infoFor(120), cfg);
  assert.equal(p.clips.length, 3);
  assert.equal(p.clips[0].startSec, 0);
  assert.equal(p.clips[2].startSec, 105);
  for (let i = 1; i < p.clips.length; i++) {
    assert.ok(p.clips[i].startSec >= p.clips[i - 1].startSec + p.clips[i - 1].durationSec);
  }
});

test('process options: reduces clip count and length with a warning when the video is short', () => {
  const cfg = loadConfig({});
  const p = v.parseProcessOptions({ duration: '60', clipCount: '4' }, infoFor(100), cfg);
  assert.equal(p.clips.length, 1);
  assert.ok(p.warnings.length >= 1);
  const q = v.parseProcessOptions({ duration: '30' }, infoFor(10), cfg);
  assert.equal(q.clips[0].durationSec, 10);
  assert.ok(q.warnings[0].includes('shorter'));
});

test('trim options: validates ranges', () => {
  const cfg = loadConfig({});
  const ok = v.parseTrimOptions({ start: '2', end: '10', aspect: '1:1', resolution: '1080p' }, infoFor(60), cfg);
  assert.equal(ok.mode, 'manual-trim');
  assert.deepEqual(ok.clips, [{ startSec: 2, durationSec: 8 }]);
  assert.equal(ok.options.width, 1080);
  const bad = (body, code) => assert.throws(() => v.parseTrimOptions(body, infoFor(60), cfg), { code });
  bad({}, 'MISSING_FIELD');
  bad({ start: '5' }, 'MISSING_FIELD');
  bad({ start: '10', end: '5' }, 'INVALID_RANGE');
  bad({ start: '-1', end: '5' }, 'INVALID_RANGE');
  bad({ start: '0', end: '61' }, 'INVALID_RANGE');
  bad({ start: '0', end: '0.5' }, 'INVALID_RANGE');
  assert.equal(v.parseTrimOptions({ start: '0', end: '59' }, infoFor(60), cfg).clips[0].durationSec, 59);
});

test('trim options: range longer than MAX_CLIP_SECONDS is rejected', () => {
  const cfg = loadConfig({ MAX_CLIP_SECONDS: '20' });
  assert.throws(() => v.parseTrimOptions({ start: '0', end: '30' }, infoFor(60), cfg), { code: 'INVALID_RANGE' });
});

test('source check: rejects wrong container and too-long video', () => {
  const cfg = loadConfig({ MAX_VIDEO_SECONDS: '60' });
  assert.throws(() => v.assertSource({ ...infoFor(10), formatName: 'avi' }, cfg), { code: 'UNSUPPORTED_CONTAINER' });
  assert.throws(() => v.assertSource(infoFor(120), cfg), { code: 'VIDEO_TOO_LONG' });
  assert.throws(() => v.assertSource(infoFor(0.2), cfg), { code: 'VIDEO_TOO_SHORT' });
  v.assertSource(infoFor(30), cfg);
});

test('config: CORS origins are normalised', () => {
  const cfg = loadConfig({ CORS_ORIGINS: 'https://a.example/, https://b.example' });
  assert.deepEqual(cfg.corsOrigins, ['https://a.example', 'https://b.example']);
  assert.ok(loadConfig({}).corsOrigins.includes('https://shortsmakerhub.blogspot.com'));
});

// ---------- real FFmpeg ----------
test('ffmpeg: binaries are detected', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg } = setup();
  const b = await ffmpeg.checkBinaries();
  assert.equal(b.ffmpeg, true);
  assert.equal(b.ffprobe, true);
});

test('ffmpeg: missing binary is reported, not crashed', async () => {
  const { ffmpeg } = setup({ FFMPEG_PATH: '/nonexistent/ffmpeg', FFPROBE_PATH: '/nonexistent/ffprobe' });
  const b = await ffmpeg.checkBinaries();
  assert.equal(b.ffmpeg, false);
  assert.equal(b.ffprobe, false);
});

test('probe: reads a real sample and rejects garbage', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg } = setup();
  const dir = tmpDir();
  const sample = makeSample(dir, 'in.mp4', 4);
  const info = await ffmpeg.probe(sample);
  assert.ok(Math.abs(info.durationSec - 4) < 0.5);
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.hasAudio, true);
  assert.equal(info.videoCodec, 'h264');

  const fake = path.join(dir, 'fake.mp4');
  fs.writeFileSync(fake, 'this is not a video, just text pretending to be mp4');
  await assert.rejects(ffmpeg.probe(fake), { code: 'INVALID_VIDEO' });

  const empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(empty, '');
  await assert.rejects(ffmpeg.probe(empty), { code: 'INVALID_VIDEO' });
});

test('probe: audio-only file has no video stream', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg } = setup();
  const dir = tmpDir();
  const audio = path.join(dir, 'a.mp4');
  const { spawnSync } = require('child_process');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', audio]);
  assert.equal(r.status, 0);
  await assert.rejects(ffmpeg.probe(audio), { code: 'NO_VIDEO_STREAM' });
});

// ---------- job lifecycle with real FFmpeg ----------
test('job: interval clip (9:16, 720p) completes with a verified playable MP4', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg, jobs } = setup();
  await jobs.init();
  const dir = tmpDir();
  const sample = makeSample(dir, 'in.mp4', 8);
  const source = await ffmpeg.probe(sample);
  const plan = v.parseProcessOptions({ duration: '15' }, source, loadConfig({}));
  const job = await jobs.createJob({ inputPath: sample, source, ...plan });

  assert.equal(job.status, 'queued');
  assert.ok(!fs.existsSync(sample), 'upload was moved into the job folder');

  const seen = new Set();
  await waitFor(() => { seen.add(job.status); return job.status === 'completed' || job.status === 'failed'; });
  assert.equal(job.status, 'completed', job.error || '');
  assert.equal(job.progress, 100);
  assert.equal(job.outputs.length, 1);

  const { root, name } = jobs.fileFor(job, 1);
  const out = path.join(root, name);
  const info = await ffmpeg.probe(out);
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);
  assert.equal(info.hasAudio, true);
  assert.ok(info.durationSec > 6 && info.durationSec < 9);
  assert.ok(fs.statSync(out).size > 1000);
  assert.ok(!fs.existsSync(job.inputPath), 'input file removed after processing');
  assert.ok(job.warnings.length >= 1, 'short video produces an honest warning');

  const result = jobs.resultView(job, 'https://example.test');
  assert.equal(result.ai, false);
  assert.equal(result.mode, 'interval-basic');
  assert.ok(result.clips[0].downloadUrl.startsWith('https://example.test/api/shorts/download/' + job.id + '/1?token='));
  assert.ok(!JSON.stringify(result).includes(job.dir), 'no server paths in responses');
});

test('job: manual trim to 1:1 / 3 s, and 16:9 output sizes', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg, jobs } = setup();
  await jobs.init();
  const dir = tmpDir();
  for (const [aspect, w, h] of [['1:1', 720, 720], ['16:9', 1280, 720]]) {
    const sample = makeSample(dir, `in-${w}.mp4`, 8);
    const source = await ffmpeg.probe(sample);
    const plan = v.parseTrimOptions({ start: '2', end: '5', aspect }, source, loadConfig({}));
    const job = await jobs.createJob({ inputPath: sample, source, ...plan });
    await finished(jobs, job);
    assert.equal(job.status, 'completed', job.error || '');
    const { root, name } = jobs.fileFor(job, 1);
    const info = await ffmpeg.probe(path.join(root, name));
    assert.equal(info.width, w);
    assert.equal(info.height, h);
    assert.ok(Math.abs(info.durationSec - 3) < 0.5, 'duration ' + info.durationSec);
  }
});

test('job: MOV and WebM inputs are accepted', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg, jobs } = setup();
  await jobs.init();
  const dir = tmpDir();
  const samples = [makeSample(dir, 'in.mov', 4, { extra: ['-f', 'mov'] })];
  try { samples.push(makeSample(dir, 'in.webm', 4)); } catch (e) { /* libvpx may be missing */ }
  for (const sample of samples) {
    const source = await ffmpeg.probe(sample);
    v.assertSource(source, loadConfig({}));
    const plan = v.parseTrimOptions({ start: '0', end: '3' }, source, loadConfig({}));
    const job = await jobs.createJob({ inputPath: sample, source, ...plan });
    await finished(jobs, job);
    assert.equal(job.status, 'completed', `${path.basename(sample)}: ${job.error || ''}`);
  }
});

test('job: multiple clips are produced and progress never goes backwards', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg, jobs } = setup();
  await jobs.init();
  const dir = tmpDir();
  const sample = makeSample(dir, 'long.mp4', 45);
  const source = await ffmpeg.probe(sample);
  const plan = v.parseProcessOptions({ duration: '15', clipCount: '3', resolution: '720p' }, source, loadConfig({}));
  const job = await jobs.createJob({ inputPath: sample, source, ...plan });
  let last = 0;
  await waitFor(() => {
    assert.ok(job.progress >= last, 'progress is monotonic');
    last = job.progress;
    return job.status === 'completed' || job.status === 'failed';
  }, { intervalMs: 20 });
  assert.equal(job.status, 'completed', job.error || '');
  assert.equal(job.outputs.length, 3);
  assert.equal(jobs.statusView(job).clipCount, 3);
});

// ---------- failures, limits, auth, cleanup ----------
test('job: FFmpeg failure ends as "failed" with a safe message and no leftover clips', async () => {
  const { ffmpeg, jobs, dataDir } = setup();
  await jobs.init();
  const dir = tmpDir();
  const input = path.join(dir, 'x.mp4');
  fs.writeFileSync(input, 'data');
  ffmpeg.transcodeClip = async () => {
    const e = new Error('boom');
    e.code = 'FFMPEG_FAILED';
    e.detail = `internal path ${dataDir}/secret stderr`;
    throw e;
  };
  const job = await jobs.createJob({
    inputPath: input, source: infoFor(30), mode: 'interval-basic',
    options: { width: 720, height: 1280 }, clips: [{ startSec: 0, durationSec: 10 }], warnings: []
  });
  await finished(jobs, job);
  assert.equal(job.status, 'failed');
  const view = jobs.statusView(job);
  assert.equal(view.errorCode, 'FFMPEG_FAILED');
  assert.ok(!JSON.stringify(view).includes(dataDir), 'no paths leaked');
  assert.ok(!JSON.stringify(view).includes('secret'));
  assert.equal(job.outputs.length, 0);
});

test('job: unexpected errors become PROCESSING_FAILED', async () => {
  const { ffmpeg, jobs } = setup();
  await jobs.init();
  const input = path.join(tmpDir(), 'x.mp4');
  fs.writeFileSync(input, 'data');
  ffmpeg.transcodeClip = async () => { throw new TypeError('internal detail'); };
  const job = await jobs.createJob({
    inputPath: input, source: infoFor(30), mode: 'manual-trim',
    options: { width: 720, height: 720 }, clips: [{ startSec: 0, durationSec: 5 }], warnings: []
  });
  await finished(jobs, job);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'PROCESSING_FAILED');
  assert.ok(!job.error.includes('internal detail'));
});

test('job: processing timeout fails the job', { skip: skipNoFfmpeg }, async () => {
  const { ffmpeg, jobs } = setup({ PROCESS_TIMEOUT_SECONDS: '1' });
  await jobs.init();
  const dir = tmpDir();
  const sample = makeSample(dir, 'in.mp4', 4);
  const source = await ffmpeg.probe(sample);
  // Make FFmpeg unable to finish within the 1 s budget.
  const real = ffmpeg.transcodeClip;
  ffmpeg.transcodeClip = (o) => real({ ...o, timeoutMs: 1 });
  const plan = v.parseTrimOptions({ start: '0', end: '3' }, source, loadConfig({}));
  const job = await jobs.createJob({ inputPath: sample, source, ...plan });
  await finished(jobs, job);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'TIMEOUT');
});

test('queue: rejects new jobs when the server is full', async () => {
  const { ffmpeg, jobs } = setup({ MAX_CONCURRENT_JOBS: '1', MAX_QUEUED_JOBS: '1' });
  await jobs.init();
  let release;
  const gate = new Promise((r) => { release = r; });
  ffmpeg.transcodeClip = async () => { await gate; return { sizeBytes: 1, width: 720, height: 1280, durationSec: 5 }; };
  const mk = () => {
    const p = path.join(tmpDir(), 'x.mp4');
    fs.writeFileSync(p, 'data');
    return jobs.createJob({
      inputPath: p, source: infoFor(30), mode: 'manual-trim',
      options: { width: 720, height: 1280 }, clips: [{ startSec: 0, durationSec: 5 }], warnings: []
    });
  };
  const a = await mk();
  const b = await mk();
  await assert.rejects(mk(), { code: 'SERVER_BUSY', status: 503 });
  await waitFor(() => a.status === 'processing');
  assert.equal(jobs.statusView(b).queuePosition, 1);
  release();
  await waitFor(() => a.status === 'completed' && b.status === 'completed');
});

test('auth: token required, wrong token and unknown id are both 404', async () => {
  const { jobs } = setup();
  await jobs.init();
  const p = path.join(tmpDir(), 'x.mp4');
  fs.writeFileSync(p, 'data');
  const { ffmpeg } = { ffmpeg: jobs.ffmpeg };
  ffmpeg.transcodeClip = async () => ({ sizeBytes: 1, width: 720, height: 1280, durationSec: 5 });
  const job = await jobs.createJob({
    inputPath: p, source: infoFor(30), mode: 'manual-trim',
    options: { width: 720, height: 1280 }, clips: [{ startSec: 0, durationSec: 5 }], warnings: []
  });
  assert.throws(() => jobs.getAuthorized(job.id, ''), { status: 401, code: 'TOKEN_REQUIRED' });
  assert.throws(() => jobs.getAuthorized(job.id, 'wrong'), { status: 404 });
  assert.throws(() => jobs.getAuthorized('00000000-0000-4000-8000-000000000000', job.token), { status: 404 });
  assert.throws(() => jobs.getAuthorized('../../etc/passwd', job.token), { status: 404 });
  assert.equal(jobs.getAuthorized(job.id, job.token).id, job.id);
});

test('cleanup: expired jobs and their files are removed', async () => {
  const { ffmpeg, jobs } = setup({ JOB_TTL_MINUTES: '0' });
  await jobs.init();
  const p = path.join(tmpDir(), 'x.mp4');
  fs.writeFileSync(p, 'data');
  ffmpeg.transcodeClip = async () => ({ sizeBytes: 1, width: 720, height: 1280, durationSec: 5 });
  const job = await jobs.createJob({
    inputPath: p, source: infoFor(30), mode: 'manual-trim',
    options: { width: 720, height: 1280 }, clips: [{ startSec: 0, durationSec: 5 }], warnings: []
  });
  await finished(jobs, job);
  assert.ok(fs.existsSync(job.dir));
  const removed = await jobs.cleanup(Date.now() + 1000);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(job.dir), false);
  assert.equal(jobs.jobs.has(job.id), false);
});

test('cleanup: unfinished jobs are never deleted', async () => {
  const { ffmpeg, jobs } = setup({ JOB_TTL_MINUTES: '0' });
  await jobs.init();
  let release;
  const gate = new Promise((r) => { release = r; });
  ffmpeg.transcodeClip = async () => { await gate; return { sizeBytes: 1, width: 720, height: 1280, durationSec: 5 }; };
  const p = path.join(tmpDir(), 'x.mp4');
  fs.writeFileSync(p, 'data');
  const job = await jobs.createJob({
    inputPath: p, source: infoFor(30), mode: 'manual-trim',
    options: { width: 720, height: 1280 }, clips: [{ startSec: 0, durationSec: 5 }], warnings: []
  });
  await waitFor(() => job.status === 'processing');
  await jobs.cleanup(Date.now() + 10 * 3600 * 1000);
  assert.ok(jobs.jobs.has(job.id));
  release();
  await finished(jobs, job);
});
