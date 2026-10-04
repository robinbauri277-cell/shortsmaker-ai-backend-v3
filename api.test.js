'use strict';

// HTTP-level tests. They need `npm install` (express, multer, ...) and ffmpeg.
// Without the dependencies the whole file is reported as SKIPPED, never as passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { silent, haveFfmpeg, tmpDir, makeSample, waitFor } = require('./helpers');

let deps = true;
try { ['express', 'multer', 'cors', 'helmet', 'express-rate-limit'].forEach((m) => require.resolve(m)); } catch (e) { deps = false; }
const skip = !deps ? 'npm dependencies not installed' : (!haveFfmpeg() ? 'ffmpeg not installed' : false);

const ORIGIN = 'https://shortsmakerhub.blogspot.com';

async function start(env = {}) {
  const { loadConfig } = require('../src/config');
  const { createFfmpeg } = require('../src/ffmpeg');
  const { JobManager } = require('../src/jobs');
  const { createApp } = require('../src/app');
  const config = loadConfig({ DATA_DIR: tmpDir('sm-api-'), UPLOAD_RATE_LIMIT_MAX: '1000', ...env });
  const ffmpeg = createFfmpeg(config);
  const jobs = new JobManager(config, ffmpeg, silent);
  await jobs.init();
  const server = createApp({ config, ffmpeg, jobs }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, server, jobs, ffmpeg, config };
}

function form(fields, file) {
  const fd = new FormData();
  if (file) fd.append(file.field || 'video', new Blob([file.data], { type: file.type || 'video/mp4' }), file.name || 'clip.mp4');
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  return fd;
}
const post = (base, route, fields, file, headers = {}) => fetch(base + route, { method: 'POST', body: form(fields, file), headers });
const json = async (r) => ({ status: r.status, body: await r.json() });

test('HTTP API', { skip }, async (t) => {
  const dir = tmpDir();
  const sample = fs.readFileSync(makeSample(dir, 'in.mp4', 8));
  const { base, server, jobs, ffmpeg, config } = await start();
  t.after(() => server.close());

  await t.test('health returns {status:"ok"} with ffmpeg info', async () => {
    const r = await json(await fetch(base + '/api/health'));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.ffmpeg, true);
    assert.equal(r.body.features.aiHighlights, false);
  });

  await t.test('CORS: allowed origin is echoed, other origins are refused, preflight works', async () => {
    const ok = await fetch(base + '/api/health', { headers: { Origin: ORIGIN } });
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const bad = await json(await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example' } }));
    assert.equal(bad.status, 403);
    assert.equal(bad.body.code, 'CORS_FORBIDDEN');
    const pre = await fetch(base + '/api/shorts/process', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-job-token' }
    });
    assert.ok(pre.status === 204 || pre.status === 200);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  });

  await t.test('upload without a file -> 400 NO_FILE', async () => {
    const r = await json(await post(base, '/api/shorts/process', { duration: '30' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'NO_FILE');
    assert.equal(typeof r.body.error, 'string'); // Stage 1 frontend reads j.error as a string
  });

  await t.test('wrong field name -> 400 WRONG_FIELD_NAME', async () => {
    const r = await json(await post(base, '/api/shorts/process', {}, { field: 'file', data: sample }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'WRONG_FIELD_NAME');
  });

  await t.test('unsupported extension / MIME -> 415', async () => {
    const a = await json(await post(base, '/api/shorts/process', {}, { data: sample, name: 'virus.exe' }));
    assert.equal(a.status, 415);
    const b = await json(await post(base, '/api/shorts/process', {}, { data: sample, type: 'text/html' }));
    assert.equal(b.status, 415);
  });

  await t.test('text file renamed to .mp4 -> 422 INVALID_VIDEO and nothing is left on disk', async () => {
    const r = await json(await post(base, '/api/shorts/process', {}, { data: Buffer.from('not a video at all') }));
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'INVALID_VIDEO');
    assert.deepEqual(fs.readdirSync(jobs.uploadsDir), []);
  });

  await t.test('invalid settings are rejected and the upload is deleted', async () => {
    const r = await json(await post(base, '/api/shorts/process', { duration: '20' }, { data: sample }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_DURATION');
    assert.deepEqual(fs.readdirSync(jobs.uploadsDir), []);
  });

  await t.test('trim: invalid range -> 400', async () => {
    const r = await json(await post(base, '/api/shorts/trim', { start: '5', end: '2' }, { data: sample }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_RANGE');
    const r2 = await json(await post(base, '/api/shorts/trim', { start: '0', end: '500' }, { data: sample }));
    assert.equal(r2.status, 400);
  });

  await t.test('full flow: process -> status -> result -> download (with Range)', async () => {
    const created = await json(await post(base, '/api/shorts/process', { duration: '15' }, { data: sample }));
    assert.equal(created.status, 202);
    const { jobId, accessToken } = created.body;
    assert.match(jobId, /^[0-9a-f-]{36}$/);
    assert.ok(accessToken.length >= 20);
    assert.equal(created.body.ai, false);
    assert.equal(created.body.mode, 'interval-basic');

    const noTok = await json(await fetch(`${base}/api/shorts/status/${jobId}`));
    assert.equal(noTok.status, 401);
    const wrong = await json(await fetch(`${base}/api/shorts/status/${jobId}?token=nope`));
    assert.equal(wrong.status, 404);

    const final = await waitFor(async () => {
      const s = await json(await fetch(`${base}/api/shorts/status/${jobId}`, { headers: { 'X-Job-Token': accessToken } }));
      assert.equal(s.status, 200);
      assert.ok(['queued', 'processing', 'completed', 'failed'].includes(s.body.status));
      return ['completed', 'failed'].includes(s.body.status) ? s.body : null;
    });
    assert.equal(final.status, 'completed');
    assert.equal(final.progress, 100);

    const res = await json(await fetch(`${base}/api/shorts/result/${jobId}?token=${accessToken}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.clips.length, 1);
    assert.ok(!JSON.stringify(res.body).includes(config.dataDir), 'no server paths exposed');

    const dl = await fetch(res.body.clips[0].downloadUrl);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'video/mp4');
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf.subarray(4, 8).toString(), 'ftyp');
    const file = path.join(dir, 'downloaded.mp4');
    fs.writeFileSync(file, buf);
    const info = await ffmpeg.probe(file);
    assert.equal(info.width, 720);
    assert.equal(info.height, 1280);

    const ranged = await fetch(res.body.clips[0].previewUrl, { headers: { Range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  });

  await t.test('trim endpoint produces a clip of the requested length', async () => {
    const c = await json(await post(base, '/api/shorts/trim', { start: '1', end: '4', aspect: '1:1' }, { data: sample }));
    assert.equal(c.status, 202);
    await waitFor(() => jobs.jobs.get(c.body.jobId).status !== 'queued' && jobs.jobs.get(c.body.jobId).status !== 'processing');
    const r = await json(await fetch(c.body.resultUrl + '?token=' + c.body.accessToken));
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'manual-trim');
    assert.equal(r.body.clips[0].width, 720);
    assert.equal(r.body.clips[0].height, 720);
  });

  await t.test('result before completion -> 409; failed job -> 422', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const real = ffmpeg.transcodeClip;
    ffmpeg.transcodeClip = async () => { await gate; const e = new Error('x'); e.code = 'FFMPEG_FAILED'; throw e; };
    const c = await json(await post(base, '/api/shorts/process', { duration: '15' }, { data: sample }));
    const url = `${c.body.resultUrl}?token=${c.body.accessToken}`;
    const early = await json(await fetch(url));
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'JOB_NOT_READY');
    release();
    await waitFor(() => jobs.jobs.get(c.body.jobId).status === 'failed');
    const failed = await json(await fetch(url));
    assert.equal(failed.status, 422);
    assert.equal(failed.body.code, 'JOB_FAILED');
    const st = await json(await fetch(`${base}/api/shorts/status/${c.body.jobId}?token=${c.body.accessToken}`));
    assert.equal(st.body.status, 'failed');
    assert.equal(typeof st.body.error, 'string');
    ffmpeg.transcodeClip = real;
  });

  await t.test('unknown route and unknown job -> 404 JSON', async () => {
    assert.equal((await fetch(base + '/nope')).status, 404);
    const r = await json(await fetch(`${base}/api/shorts/status/00000000-0000-4000-8000-000000000000?token=abc`));
    assert.equal(r.status, 404);
  });

  await t.test('path traversal in download path is rejected', async () => {
    const r = await fetch(`${base}/api/shorts/download/..%2F..%2Fetc/1?token=abc`);
    assert.ok([400, 404].includes(r.status));
  });
});

test('HTTP API: oversized upload -> 413', { skip }, async () => {
  const { base, server } = await start({ MAX_UPLOAD_MB: '1' });
  try {
    const r = await json(await post(base, '/api/shorts/process', {}, { data: Buffer.alloc(2 * 1024 * 1024, 1) }));
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'FILE_TOO_LARGE');
  } finally { server.close(); }
});

test('HTTP API: rate limit returns 429 JSON', { skip }, async () => {
  const { base, server } = await start({ UPLOAD_RATE_LIMIT_MAX: '2' });
  try {
    let last;
    for (let i = 0; i < 4; i++) last = await post(base, '/api/shorts/process', {}, { data: Buffer.from('x'), name: 'a.exe' });
    const r = await json(last);
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'RATE_LIMITED');
  } finally { server.close(); }
});
