'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { ValidationError } = require('./errors');

const {
  createShortsRouter
} = require('./shorts');

const {
  createAnimateRouter
} = require('./animate');


function createApp({
  config,
  ffmpeg,
  jobs
}) {

  const app = express();

  app.disable('x-powered-by');

  app.set(
    'trust proxy',
    1
  );


  // ==========================================
  // SECURITY
  // ==========================================

  app.use(
    helmet({
      crossOriginResourcePolicy: {
        policy: 'cross-origin'
      }
    })
  );


  // ==========================================
  // CORS
  // ==========================================

  const allowed =
    new Set(
      config.corsOrigins || []
    );


  app.use(
    cors({

      origin: (
        origin,
        cb
      ) => {

        cb(
          null,
          !origin ||
          allowed.has(origin)
        );

      },

      methods: [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS'
      ],

      allowedHeaders: [
        'Content-Type',
        'X-Job-Token',
        'X-Upload-Id',
        'X-Upload-Token',
        'X-Chunk-Index'
      ],

      exposedHeaders: [
        'Content-Length'
      ],

      maxAge: 600
    })
  );


  // ==========================================
  // EXTRA ORIGIN PROTECTION
  // ==========================================

  app.use(
    (
      req,
      res,
      next
    ) => {

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


  // ==========================================
  // ROOT
  // ==========================================

  app.get(
    '/',
    (
      req,
      res
    ) => {

      res.json({

        name:
          'ShortsMaker AI backend',

        health:
          '/api/health',

        animation:
          '/api/animate'

      });

    }
  );


  // ==========================================
  // HEALTH
  // ==========================================

  let cached = {
    at: 0,
    bins: null
  };


  app.get(
    '/api/health',

    async (
      req,
      res,
      next
    ) => {

      try {

        if (
          !cached.bins ||
          Date.now() -
          cached.at >
          60000
        ) {

          cached = {

            at:
              Date.now(),

            bins:
              await ffmpeg
                .checkBinaries()

          };

        }


        const ok =
          cached.bins.ffmpeg &&
          cached.bins.ffprobe;


        const aiReady =
          Boolean(
            config.aiHighlights &&
            config.geminiApiKey
          );


        const animationReady =
          Boolean(
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
                false,

              promptAnimation:
                animationReady

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


            animation: {

              enabled:
                animationReady,

              model:
                config.veoModel ||
                'veo-3.1-generate-preview'

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


  // ==========================================
  // GLOBAL API RATE LIMIT
  // ==========================================

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


  // ==========================================
  // SHORTS API
  // ==========================================

  app.use(
    '/api/shorts',

    createShortsRouter({

      config,

      ffmpeg,

      jobs

    })
  );


  // ==========================================
  // PROMPT → ANIMATED VIDEO API
  // ==========================================

  app.use(
    '/api/animate',

    createAnimateRouter({

      config

    })
  );


  // ==========================================
  // 404
  // ==========================================

  app.use(
    (
      req,
      res
    ) => {

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


  // ==========================================
  // ERROR HANDLER
  // ==========================================

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
          .status(
            err.status
          )
          .json({

            error:
              err.message,

            code:
              err.code

          });

      }


      console.error(
        '[error]',
        err && err.code,
        err && err.message
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