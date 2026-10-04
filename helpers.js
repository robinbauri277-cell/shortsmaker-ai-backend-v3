'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const silent = { log() {}, error() {} };

function haveFfmpeg() {
  return spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
}

function tmpDir(prefix = 'sm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Generates a real test video with FFmpeg (video + audio). Returns the file path. */
function makeSample(dir, name, seconds, { size = '640x360', extra } = {}) {
  const out = path.join(dir, name);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest'];
  if (name.endsWith('.webm')) args.push('-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libvorbis');
  else args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
  if (extra) args.push(...extra);
  args.push(out);
  const r = spawnSync('ffmpeg', args);
  if (r.status !== 0) throw new Error('sample generation failed: ' + String(r.stderr).slice(-300));
  return out;
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { silent, haveFfmpeg, tmpDir, makeSample, waitFor };
