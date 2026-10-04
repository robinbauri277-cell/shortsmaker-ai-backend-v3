'use strict';

const path = require('path');
const { ValidationError } = require('./errors');

const ALLOWED_EXT = new Set(['.mp4', '.mov', '.webm']);
// Some mobile browsers send application/octet-stream for MOV files.
// ffprobe is the real format check; this is only a cheap first filter.
const ALLOWED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'application/octet-stream']);
const SOURCE_FORMATS = ['mov', 'mp4', 'matroska', 'webm'];

const DURATIONS = [15, 30, 45, 60];
const ASPECTS = ['9:16', '16:9', '1:1'];
const RESOLUTIONS = { '720p': 720, '1080p': 1080 };

function checkUploadMeta(originalName, mimeType) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new ValidationError('UNSUPPORTED_FORMAT', 'Unsupported file type. Use MP4, MOV or WebM.', 415);
  }
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new ValidationError('UNSUPPORTED_MIME', 'Unsupported file type. Use MP4, MOV or WebM.', 415);
  }
  return ext;
}

/** Checks the result of ffprobe on the uploaded file. */
function assertSource(info, cfg) {
  const names = String(info.formatName || '').split(',');
  if (!names.some((n) => SOURCE_FORMATS.includes(n))) {
    throw new ValidationError('UNSUPPORTED_CONTAINER', 'Unsupported video container. Use MP4, MOV or WebM.', 415);
  }
  if (!info.width || !info.height || info.width > 7680 || info.height > 7680) {
    throw new ValidationError('UNSUPPORTED_RESOLUTION', 'Video resolution is not supported.', 422);
  }
  if (info.durationSec < 1) {
    throw new ValidationError('VIDEO_TOO_SHORT', 'Video must be at least 1 second long.', 422);
  }
  if (info.durationSec > cfg.maxVideoSeconds) {
    throw new ValidationError(
      'VIDEO_TOO_LONG',
      `Video is too long. Maximum is ${Math.floor(cfg.maxVideoSeconds / 60)} minutes.`,
      422
    );
  }
}

function field(body, name) {
  const v = body ? body[name] : undefined;
  if (Array.isArray(v)) {
    throw new ValidationError('INVALID_FIELD', `"${name}" must be sent only once.`);
  }
  return v;
}

function num(body, name, { required = false, def } = {}) {
  const v = field(body, name);
  if (v === undefined || v === '') {
    if (required) throw new ValidationError('MISSING_FIELD', `"${name}" is required.`);
    return def;
  }
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new ValidationError('INVALID_FIELD', `"${name}" must be a number.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new ValidationError('INVALID_FIELD', `"${name}" must be a number.`);
  }
  return n;
}

function choice(body, name, allowed, def) {
  const v = field(body, name);
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new ValidationError('INVALID_FIELD', `"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return v;
}

function outputSize(aspect, resolution) {
  const s = RESOLUTIONS[resolution];
  if (aspect === '9:16') return { width: s, height: Math.round((s * 16) / 9) };
  if (aspect === '16:9') return { width: Math.round((s * 16) / 9), height: s };
  return { width: s, height: s };
}

function floor2(x) {
  return Math.floor(x * 100 + 1e-6) / 100;
}

function commonOptions(body) {
  const aspect = choice(body, 'aspect', ASPECTS, '9:16');
  const resolution = choice(body, 'resolution', Object.keys(RESOLUTIONS), '720p');
  return { aspect, resolution, ...outputSize(aspect, resolution) };
}

/**
 * Basic interval clips (NOT AI). Fields: duration (15|30|45|60), clipCount, start,
 * aspect, resolution. Clips are spread evenly from `start` to the end of the video.
 */
function parseProcessOptions(body, info, cfg) {
  const duration = num(body, 'duration', { def: 30 });
  if (!DURATIONS.includes(duration)) {
    throw new ValidationError('INVALID_DURATION', `"duration" must be one of: ${DURATIONS.join(', ')}.`);
  }
  const clipCount = num(body, 'clipCount', { def: 1 });
  if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > cfg.maxClipCount) {
    throw new ValidationError('INVALID_CLIP_COUNT', `"clipCount" must be a whole number from 1 to ${cfg.maxClipCount}.`);
  }
  const start = num(body, 'start', { def: 0 });
  if (start < 0 || start > info.durationSec - 1) {
    throw new ValidationError('INVALID_START', '"start" must be inside the video.');
  }
  const options = commonOptions(body);
  const warnings = [];

  const available = info.durationSec - start;
  const length = floor2(Math.min(duration, available));
  if (length < 1) throw new ValidationError('INVALID_START', 'Not enough video left after "start".');
  if (length < duration) {
    warnings.push(`The video is shorter than ${duration}s from the start point; the clip is ${length.toFixed(1)}s.`);
  }

  let n = clipCount;
  const fit = Math.max(1, Math.floor(available / length + 1e-9));
  if (n > fit) {
    warnings.push(`Only ${fit} non-overlapping clip(s) fit; reduced from ${n}.`);
    n = fit;
  }
  const clips = [];
  for (let i = 0; i < n; i++) {
    const s = n === 1 ? start : start + (i * (available - length)) / (n - 1);
    clips.push({ startSec: floor2(s), durationSec: length });
  }
  return { mode: 'interval-basic', options, clips, warnings };
}

/** Manual trim. Fields: start, end (seconds), aspect, resolution. */
function parseTrimOptions(body, info, cfg) {
  const start = num(body, 'start', { required: true });
  const end = num(body, 'end', { required: true });
  if (start < 0) throw new ValidationError('INVALID_RANGE', '"start" cannot be negative.');
  if (end <= start) throw new ValidationError('INVALID_RANGE', '"end" must be greater than "start".');
  if (end > info.durationSec + 0.05) {
    throw new ValidationError('INVALID_RANGE', `"end" is beyond the video length (${info.durationSec.toFixed(1)}s).`);
  }
  const length = floor2(Math.min(end, info.durationSec) - start);
  if (length < 1) throw new ValidationError('INVALID_RANGE', 'The selected range must be at least 1 second.');
  if (length > cfg.maxClipSeconds) {
    throw new ValidationError('INVALID_RANGE', `The selected range cannot be longer than ${cfg.maxClipSeconds} seconds.`);
  }
  return {
    mode: 'manual-trim',
    options: commonOptions(body),
    clips: [{ startSec: floor2(start), durationSec: length }],
    warnings: []
  };
}

module.exports = {
  ALLOWED_EXT, DURATIONS, ASPECTS, RESOLUTIONS,
  checkUploadMeta, assertSource, parseProcessOptions, parseTrimOptions, outputSize
};
