#!/usr/bin/env node
// Verifies every endpoint of a RUNNING backend. Needs Node 18+ and (optionally) ffmpeg to create a sample.
// Usage: node scripts/verify.mjs https://your-backend.onrender.com [path/to/video.mp4]
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) { console.error('Usage: node scripts/verify.mjs <backend-url> [video.mp4]'); process.exit(2); }
let videoPath = process.argv[3];
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

if (!videoPath) {
  const dir = mkdtempSync(join(tmpdir(), 'sm-verify-'));
  videoPath = join(dir, 'sample.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath]);
  if (r.status !== 0) { console.error('ffmpeg not available locally: pass a video file as the 2nd argument.'); process.exit(2); }
}
const video = readFileSync(videoPath);
const form = (fields, name = 'video', data = video, filename = 'sample.mp4') => {
  const fd = new FormData();
  fd.append(name, new Blob([data], { type: 'video/mp4' }), filename);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

console.log(`Checking ${base} (a Render free instance may need up to ~60 s to wake up)\n`);
let health;
for (let i = 0; i < 12; i++) {
  try { health = await j(await fetch(base + '/api/health')); if (health.status) break; } catch { /* waking up */ }
  await new Promise((r) => setTimeout(r, 5000));
}
check('GET /api/health -> 200 {status:"ok"}', health?.status === 200 && health.body.status === 'ok', JSON.stringify(health?.body?.features || {}));
check('ffmpeg + ffprobe available on server', health?.body?.ffmpeg === true && health?.body?.ffprobe === true);

let r = await j(await fetch(base + '/api/shorts/process', { method: 'POST', body: form({}, 'file') }));
check('wrong field name rejected (400)', r.status === 400, r.body.code);
r = await j(await fetch(base + '/api/shorts/process', { method: 'POST', body: form({}, 'video', Buffer.from('not a video')) }));
check('fake video rejected (422)', r.status === 422, r.body.code);
r = await j(await fetch(base + '/api/shorts/process', { method: 'POST', body: form({ duration: '20' }) }));
check('invalid duration rejected (400)', r.status === 400, r.body.code);
r = await j(await fetch(base + '/api/shorts/trim', { method: 'POST', body: form({ start: '9', end: '3' }) }));
check('invalid trim range rejected (400)', r.status === 400, r.body.code);

const created = await j(await fetch(base + '/api/shorts/process', { method: 'POST', body: form({ duration: '15' }) }));
check('POST /api/shorts/process -> 202 with jobId + accessToken', created.status === 202 && !!created.body.jobId && !!created.body.accessToken);
if (created.status === 202) {
  const { jobId, accessToken } = created.body;
  const q = `?token=${encodeURIComponent(accessToken)}`;
  r = await j(await fetch(`${base}/api/shorts/status/${jobId}`));
  check('status without token -> 401', r.status === 401);
  let s;
  for (let i = 0; i < 120; i++) {
    s = await j(await fetch(`${base}/api/shorts/status/${jobId}${q}`));
    if (s.status !== 200 || ['completed', 'failed'].includes(s.body.status)) break;
    await new Promise((x) => setTimeout(x, 2000));
  }
  check('GET /api/shorts/status/:jobId -> completed', s?.body?.status === 'completed', `progress=${s?.body?.progress} ${s?.body?.error || ''}`);
  const res = await j(await fetch(`${base}/api/shorts/result/${jobId}${q}`));
  check('GET /api/shorts/result/:jobId -> 200 with clips', res.status === 200 && res.body.clips?.length >= 1);
  if (res.status === 200) {
    const dl = await fetch(res.body.clips[0].downloadUrl);
    const buf = Buffer.from(await dl.arrayBuffer());
    check('download returns an MP4 (ftyp header)', dl.status === 200 && buf.subarray(4, 8).toString() === 'ftyp', `${buf.length} bytes`);
  }
}
const t = await j(await fetch(base + '/api/shorts/trim', { method: 'POST', body: form({ start: '1', end: '4', aspect: '1:1' }) }));
check('POST /api/shorts/trim -> 202', t.status === 202, t.body.code || '');
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
