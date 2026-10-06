'use strict';

const os = require('os');
const path = require('path');

function int(value, def, min, max) {
  const n = Number.parseInt(value, 10);

  if (!Number.isFinite(n)) {
    return def;
  }

  return Math.min(
    max === undefined ? n : max,
    Math.max(min === undefined ? n : min, n)
  );
}

function bool(value, def) {
  if (value === undefined || value === '') {
    return def;
  }

  return ![
    'false',
    '0',
    'no',
    'off'
  ].includes(
    String(value).toLowerCase()
  );
}

function tryRequire(name, pick) {
  try {
    const m = require(name);

    return pick
      ? pick(m)
      : m;

  } catch (e) {
    return null;
  }
}

const DEFAULT_ORIGINS = [
  'https://shortsmakerhub.blogspot.com',
  'https://shortsmakerhub.blogspot.in'
];

function loadConfig(env = process.env) {
  const corsOrigins = (
    env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',')
      : DEFAULT_ORIGINS
  )
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return {
    // Server
    port: int(env.PORT, 10000, 1, 65535),
    nodeEnv: env.NODE_ENV || 'production',

    // Storage
    dataDir: path.resolve(
      env.DATA_DIR ||
      path.join(os.tmpdir(), 'shortsmaker-data')
    ),

    // CORS
    corsOrigins,

    publicBaseUrl: (env.PUBLIC_BASE_URL || '')
      .trim()
      .replace(/\/+$/, ''),

    // Upload limits
    maxUploadBytes:
      int(
        env.MAX_UPLOAD_MB,
        500,
        1,
        2048
      ) * 1024 * 1024,

    maxVideoSeconds:
      int(
        env.MAX_VIDEO_SECONDS,
        3600,
        5
      ),

    // Clip limits
    maxClipSeconds:
      int(
        env.MAX_CLIP_SECONDS,
        120,
        1
      ),

    // IMPORTANT:
    // Maximum clips = 10
    maxClipCount:
      int(
        env.MAX_CLIP_COUNT,
        10,
        1,
        10
      ),

    // Processing
    processTimeoutMs:
      int(
        env.PROCESS_TIMEOUT_SECONDS,
        600,
        1
      ) * 1000,

    // YouTube download timeout
    youtubeDownloadTimeoutMs:
      int(
        env.YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS,
        1200,
        60,
        3600
      ) * 1000,

    probeTimeoutMs:
      30 * 1000,

    // Queue
    maxConcurrentJobs:
      int(
        env.MAX_CONCURRENT_JOBS,
        1,
        1,
        8
      ),

    maxQueuedJobs:
      int(
        env.MAX_QUEUED_JOBS,
        20,
        0,
        100
      ),

    // Job cleanup
    jobTtlMs:
      int(
        env.JOB_TTL_MINUTES,
        60,
        0
      ) * 60 * 1000,

    cleanupIntervalMs:
      5 * 60 * 1000,

    // Rate limiting
    rateLimit: {
      windowMs: int(
        env.RATE_LIMIT_WINDOW_MS,
        15 * 60 * 1000,
        1000
      ),

      max: int(
        env.RATE_LIMIT_MAX,
        60,
        1,
        1000
      )
    },

    // FFmpeg
    ffmpegPath:
      env.FFMPEG_PATH ||
      tryRequire('ffmpeg-static') ||
      'ffmpeg',

    ffprobePath:
      env.FFPROBE_PATH ||
      tryRequire(
        '@ffprobe-installer/ffprobe',
        (m) => m.path
      ) ||
      'ffprobe',

    ffmpegThreads:
      int(
        env.FFMPEG_THREADS,
        0,
        0,
        16
      ),

    ffmpegPreset:
      env.FFMPEG_PRESET ||
      'veryfast',

    ffmpegCrf:
      int(
        env.FFMPEG_CRF,
        20,
        16,
        30
      ),

    // Verification
    verifyDecode:
      bool(
        env.VERIFY_DECODE,
        false
      ),

    // Gemini
    geminiApiKey:
      (env.GEMINI_API_KEY || '').trim(),

    geminiModel:
      (
        env.GEMINI_MODEL ||
        'gemini-3.8-flash'
      ).trim(),

    aiHighlights:
      bool(
        env.AI_HIGHLIGHTS,
        false
      )
  };
}

module.exports = {
  loadConfig
};