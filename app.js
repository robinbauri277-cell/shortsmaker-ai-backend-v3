'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ValidationError } = require('./errors');
const { createShortsRouter } = require('./routes/shorts');

function createApp({ config, ffmpeg, jobs }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of the app

  // crossOriginResourcePolicy must be cross-origin or the Blogger page cannot play the clips.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const allowed = new Set(config.corsOrigins);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Job-Token'],
    maxAge: 600
  }));
  // Browsers from other sites get a clear refusal instead of silently consuming bandwidth.
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !allowed.has(origin)) {
      return res.status(403).json({ error: 'This origin is not allowed.', code: 'CORS_FORBIDDEN' });
    }
    next();
  });

  app.get('/', (req, res) => res.json({ name: 'ShortsMaker AI backend', health: '/api/health' }));

  // Health is registered before the rate limiter so Render's checks are never throttled.
  let cached = { at: 0, bins: null };
  app.get('/api/health', async (req, res, next) => {
    try {
      if (!cached.bins || Date.now() - cached.at > 60000) {
        cached = { at: Date.now(), bins: await ffmpeg.checkBinaries() };
      }
      const ok = cached.bins.ffmpeg && cached.bins.ffprobe;
      res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        ffmpeg: cached.bins.ffmpeg,
        ffprobe: cached.bins.ffprobe,
        features: { basicTrim: ok, intervalClips: ok, aiHighlights: false, speechToText: false },
        limits: {
          maxUploadMb: Math.round(config.maxUploadBytes / 1048576),
          maxVideoSeconds: config.maxVideoSeconds,
          maxClipSeconds: config.maxClipSeconds,
          maxClipCount: config.maxClipCount
        },
        queue: jobs.stats(),
        uptimeSec: Math.round(process.uptime())
      });
    } catch (e) { next(e); }
  });

  app.use('/api', rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' }
  }));

  app.use('/api/shorts', createShortsRouter({ config, ffmpeg, jobs }));

  app.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[error]', err && err.code, err && err.message);
    res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL' });
  });

  return app;
}

module.exports = { createApp };
