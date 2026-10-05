'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ValidationError } = require('./errors');

// FIX: shorts.js root folder में है, routes/ के अंदर नहीं
const { createShortsRouter } = require('./shorts');

function createApp({ config, ffmpeg, jobs }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: {
        policy: 'cross-origin'
      }
    })
  );

  const allowed =
    new Set(
      config.corsOrigins || []
    );

  app.use(
    cors({
      origin: (origin, cb) => {
        cb(
          null,
          !origin ||
            allowed.has(origin)
        );
      },

      methods: [
        'GET',
        'POST',
        'OPTIONS'
      ],

      allowedHeaders: [
        'Content-Type',
        'X-Job-Token'
      ],

      maxAge: 600
    })
  );

  app.use(
    (req, res, next) => {
      const origin =
        req.get('Origin');

      if (
        origin &&
        !allowed.has(origin)
      ) {
        return res
          .status(403)
          .json({
            error:
              'This origin is not allowed.',

            code:
              'CORS_FORBIDDEN'
          });
      }

      next();
    }
  );

  app.get(
    '/',
    (req, res) => {
      res.json({
        name:
          'ShortsMaker AI backend',

        health:
          '/api/health'
      });
    }
  );

  let cached = {
    at: 0,
    bins: null
  };

  app.get(
    '/api/health',
    async (req, res, next) => {
      try {
        if (
          !cached.bins ||
          Date.now() -
            cached.at >
            60000
        ) {
          cached = {
            at: Date.now(),

            bins:
              await ffmpeg
                .checkBinaries()
          };
        }

        const ok =
          cached.bins.ffmpeg &&
          cached.bins.ffprobe;

        /*
         * AI is available only when:
         * 1. AI_HIGHLIGHTS=true
         * 2. GEMINI_API_KEY exists
         */
        const aiReady =
          Boolean(
            config.aiHighlights &&
            config.geminiApiKey
          );

        res
          .set(
            'Cache-Control',
            'no-store'
          )
          .status(
            ok ? 200 : 503
          )
          .json({
            status:
              ok
                ? 'ok'
                : 'degraded',

            ffmpeg:
              cached.bins.ffmpeg,

            ffprobe:
              cached.bins.ffprobe,

            features: {
              basicTrim:
                ok,

              intervalClips:
                ok,

              aiHighlights:
                aiReady && ok,

              speechToText:
                false
            },

            ai: {
              enabled:
                Boolean(
                  config.aiHighlights
                ),

              configured:
                Boolean(
                  config.geminiApiKey
                ),

              ready:
                aiReady && ok,

              model:
                config.geminiModel
            },

            limits: {
              maxUploadMb:
                Math.round(
                  config
                    .maxUploadBytes /
                    1048576
                ),

              maxVideoSeconds:
                config.maxVideoSeconds,

              maxClipSeconds:
                config.maxClipSeconds,

              maxClipCount:
                config.maxClipCount
            },

            queue:
              jobs.stats(),

            uptimeSec:
              Math.round(
                process.uptime()
              )
          });
      } catch (e) {
        next(e);
      }
    }
  );

  app.use(
    '/api',
    rateLimit({
      windowMs:
        config.rateLimit
          .windowMs,

      limit:
        config.rateLimit.max,

      standardHeaders:
        'draft-7',

      legacyHeaders:
        false,

      message: {
        error:
          'Too many requests. Please slow down.',

        code:
          'RATE_LIMITED'
      }
    })
  );

  app.use(
    '/api/shorts',
    createShortsRouter({
      config,
      ffmpeg,
      jobs
    })
  );

  app.use(
    (req, res) => {
      res
        .status(404)
        .json({
          error:
            'Not found.',

          code:
            'NOT_FOUND'
        });
    }
  );

  app.use(
    (
      err,
      req,
      res,
      next
    ) => {
      if (
        res.headersSent
      ) {
        return next(err);
      }

      if (
        err instanceof
        ValidationError
      ) {
        return res
          .status(err.status)
          .json({
            error:
              err.message,

            code:
              err.code
          });
      }

      console.error(
        '[error]',
        err &&
          err.code,
        err &&
          err.message
      );

      res
        .status(500)
        .json({
          error:
            'Internal server error.',

          code:
            'INTERNAL'
        });
    }
  );

  return app;
}

module.exports = {
  createApp
};
