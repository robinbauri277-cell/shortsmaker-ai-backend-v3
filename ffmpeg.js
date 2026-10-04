'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { ValidationError } = require('./errors');

function codeError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail; // server-side logging only, never sent to clients
  return err;
}

/**
 * All binaries are started with an argument array and shell:false,
 * so no user-supplied text is ever interpreted by a shell.
 */
function createFfmpeg(cfg) {
  function run(cmd, args, { timeoutMs = 0, onStdoutLine } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        return reject(codeError('BINARY_MISSING', 'failed to start process'));
      }
      let stdout = '';
      let stderr = '';
      let lineBuf = '';
      let timedOut = false;
      let settled = false;
      const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;

      child.stdout.on('data', (d) => {
        const text = d.toString('utf8');
        if (onStdoutLine) {
          lineBuf += text;
          let i;
          while ((i = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, i).trim();
            lineBuf = lineBuf.slice(i + 1);
            if (line) onStdoutLine(line);
          }
          if (lineBuf.length > 4096) lineBuf = '';
        } else if (stdout.length < 1024 * 1024) {
          stdout += text;
        }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(codeError(e.code === 'ENOENT' ? 'BINARY_MISSING' : 'SPAWN_FAILED', 'failed to start process'));
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (timedOut) return reject(codeError('TIMEOUT', 'process timed out'));
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function checkBinaries() {
    const result = { ffmpeg: false, ffprobe: false, version: null };
    try {
      const r = await run(cfg.ffmpegPath, ['-version'], { timeoutMs: 10000 });
      result.ffmpeg = r.code === 0;
      const m = /ffmpeg version (\S+)/.exec(r.stdout);
      if (m) result.version = m[1];
    } catch (e) { /* stays false */ }
    try {
      const r = await run(cfg.ffprobePath, ['-version'], { timeoutMs: 10000 });
      result.ffprobe = r.code === 0;
    } catch (e) { /* stays false */ }
    return result;
  }

  async function probe(file) {
    const invalid = () => new ValidationError('INVALID_VIDEO', 'The file is not a valid, readable video.', 422);
    let res;
    try {
      res = await run(
        cfg.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
        { timeoutMs: cfg.probeTimeoutMs }
      );
    } catch (e) {
      if (e.code === 'TIMEOUT') throw invalid();
      throw e;
    }
    if (res.code !== 0) throw invalid();
    let data;
    try { data = JSON.parse(res.stdout); } catch (e) { throw invalid(); }

    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (!video) throw new ValidationError('NO_VIDEO_STREAM', 'The file contains no video track.', 422);
    const fmt = data.format || {};
    const durationSec = Number.parseFloat(fmt.duration || video.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new ValidationError('UNKNOWN_DURATION', 'Could not determine the video length.', 422);
    }
    return {
      formatName: String(fmt.format_name || ''),
      durationSec,
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      videoCodec: video.codec_name || '',
      hasAudio: streams.some((s) => s.codec_type === 'audio')
    };
  }

  function buildTranscodeArgs({ input, output, startSec, durationSec, width, height }) {
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
    return [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
      '-progress', 'pipe:1', '-nostats',
      '-ss', startSec.toFixed(3), '-i', input, '-t', durationSec.toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-threads', String(cfg.ffmpegThreads),
      '-f', 'mp4', output
    ];
  }

  async function verifyOutput(file, expectedSec, width, height) {
    const bad = (why) => codeError('OUTPUT_INVALID', 'output validation failed', why);
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { throw bad('output missing'); }
    if (!st.isFile() || st.size <= 0) throw bad('output empty');

    let info;
    try { info = await probe(file); } catch (e) { throw bad('output unreadable'); }
    if (info.videoCodec !== 'h264') throw bad('codec ' + info.videoCodec);
    if (info.width !== width || info.height !== height) throw bad(`size ${info.width}x${info.height}`);
    if (Math.abs(info.durationSec - expectedSec) > Math.max(1.5, expectedSec * 0.1)) {
      throw bad(`duration ${info.durationSec} vs ${expectedSec}`);
    }

    if (cfg.verifyDecode) {
      // Decode the whole clip to /dev/null: catches truncated or corrupt files.
      let r;
      try {
        r = await run(cfg.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs: 120000 });
      } catch (e) { throw bad('decode check could not run'); }
      if (r.code !== 0 || r.stderr.trim()) throw bad('decode errors: ' + r.stderr.slice(-300));
    }
    return { sizeBytes: st.size, width, height, durationSec: Math.round(info.durationSec * 100) / 100 };
  }

  async function transcodeClip({ input, output, startSec, durationSec, width, height, timeoutMs, onProgress }) {
    const args = buildTranscodeArgs({ input, output, startSec, durationSec, width, height });
    const res = await run(cfg.ffmpegPath, args, {
      timeoutMs,
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line); // both are microseconds
        if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSec));
      }
    });
    if (res.code !== 0) throw codeError('FFMPEG_FAILED', 'ffmpeg failed', res.stderr);
    return verifyOutput(output, durationSec, width, height);
  }

  return { run, checkBinaries, probe, buildTranscodeArgs, verifyOutput, transcodeClip };
}

module.exports = { createFfmpeg };
