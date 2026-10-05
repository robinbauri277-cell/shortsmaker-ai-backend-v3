'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const { ValidationError } = require('./errors');

const {
  checkUploadMeta,
  assertSource,
  parseProcessOptions,
  parseTrimOptions,
  ALLOWED_EXT
} = require('./validate');

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function tokenFrom(req) {
  const headerToken = req.get('X-Job-Token');

  if (
    typeof headerToken === 'string' &&
    headerToken
  ) {
    return headerToken;
  }

  return typeof req.query.token === 'string'
    ? req.query.token
    : '';
}

function uploadTokenFrom(req) {
  const headerToken =
    req.get('X-Upload-Token');

  if (
    typeof headerToken === 'string' &&
    headerToken
  ) {
    return headerToken;
  }

  if (
    typeof req.query.token === 'string' &&
    req.query.token
  ) {
    return req.query.token;
  }

  return '';
}

function parseJsonBody(req) {
  if (
    req.body &&
    typeof req.body === 'object' &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  if (
    Buffer.isBuffer(req.body)
  ) {
    if (!req.body.length) {
      return {};
    }

    try {
      return JSON.parse(
        req.body.toString('utf8')
      );
    } catch (e) {
      throw new ValidationError(
        'BAD_JSON',
        'Invalid JSON request body.',
        400
      );
    }
  }

  return {};
}

function createShortsRouter({
  config,
  ffmpeg,
  jobs
}) {
  const router =
    express.Router();

  /*
   * ==========================================================
   * RATE LIMITING
   * ==========================================================
   */

  const uploadLimiter =
    rateLimit({
      windowMs:
        config.rateLimit.uploadWindowMs,

      limit:
        config.rateLimit.uploadMax,

      standardHeaders:
        'draft-7',

      legacyHeaders:
        false,

      message: {
        error:
          'Too many uploads. Please wait before trying again.',

        code:
          'RATE_LIMITED'
      }
    });

  /*
   * Chunk uploads need a little more request frequency
   * than the old single-file endpoint.
   *
   * The actual file-size protection is still enforced
   * by the upload session.
   */

  const chunkLimiter =
    rateLimit({
      windowMs:
        config.rateLimit.uploadWindowMs,

      limit:
        Math.max(
          config.rateLimit.uploadMax * 100,
          1000
        ),

      standardHeaders:
        'draft-7',

      legacyHeaders:
        false,

      message: {
        error:
          'Too many upload chunks. Please slow down.',

        code:
          'RATE_LIMITED'
      }
    });

  /*
   * ==========================================================
   * OLD MULTIPART UPLOAD
   * ==========================================================
   *
   * Existing /process and /trim remain supported.
   */

  const storage =
    multer.diskStorage({
      destination: (
        req,
        file,
        cb
      ) => {
        cb(
          null,
          jobs.uploadsDir
        );
      },

      filename: (
        req,
        file,
        cb
      ) => {
        const ext =
          path.extname(
            file.originalname || ''
          ).toLowerCase();

        const safeExt =
          ALLOWED_EXT.has(ext)
            ? ext
            : '.bin';

        cb(
          null,
          crypto.randomUUID() +
            safeExt
        );
      }
    });

  const upload =
    multer({
      storage,

      limits: {
        fileSize:
          config.maxUploadBytes,

        files: 1,

        fields: 20,

        fieldSize:
          1024,

        parts: 25
      },

      fileFilter: (
        req,
        file,
        cb
      ) => {
        try {
          checkUploadMeta(
            file.originalname,
            file.mimetype
          );

          cb(null, true);
        } catch (error) {
          cb(error);
        }
      }
    }).single('video');

  function handleUpload(
    req,
    res,
    next
  ) {
    upload(
      req,
      res,
      (error) => {
        if (!error) {
          return next();
        }

        if (
          error instanceof
          multer.MulterError
        ) {
          if (
            error.code ===
            'LIMIT_FILE_SIZE'
          ) {
            return next(
              new ValidationError(
                'FILE_TOO_LARGE',

                `File is too large. Maximum is ${Math.round(
                  config.maxUploadBytes /
                    1048576
                )} MB.`,

                413
              )
            );
          }

          if (
            error.code ===
            'LIMIT_UNEXPECTED_FILE'
          ) {
            return next(
              new ValidationError(
                'WRONG_FIELD_NAME',

                'The video field must be named "video".',

                400
              )
            );
          }

          return next(
            new ValidationError(
              'BAD_UPLOAD',

              'The upload was malformed.',

              400
            )
          );
        }

        next(error);
      }
    );
  }

  const baseUrl =
    (req) =>
      config.publicBaseUrl ||
      `${req.protocol}://${req.get('host')}`;

  /*
   * ==========================================================
   * COMMON JOB CREATION
   * ==========================================================
   */

  async function createFromUpload(
    req,
    res,
    parse,
    allowAI
  ) {
    const file =
      req.file;

    if (!file) {
      throw new ValidationError(
        'NO_FILE',

        'No video uploaded. Send multipart/form-data with a field named "video".',

        400
      );
    }

    try {
      const source =
        await ffmpeg.probe(
          file.path
        );

      assertSource(
        source,
        config
      );

      const plan =
        parse(
          req.body,
          source,
          config
        );

      const aiRequested =
        Boolean(
          allowAI &&
          config.aiHighlights &&
          config.geminiApiKey
        );

      const job =
        await jobs.createJob({
          inputPath:
            file.path,

          source,

          ...plan,

          aiRequested
        });

      const base =
        baseUrl(req);

      res.status(202).json({
        jobId:
          job.id,

        accessToken:
          job.token,

        status:
          job.status,

        mode:
          aiRequested
            ? 'ai-highlights'
            : job.mode,

        ai:
          aiRequested,

        clipCount:
          aiRequested
            ? 0
            : job.clips.length,

        warnings: [
          ...(job.warnings || []),

          ...(allowAI &&
          config.aiHighlights &&
          !config.geminiApiKey
            ? [
                'AI highlights are enabled but GEMINI_API_KEY is not configured. Falling back to basic clips.'
              ]
            : [])
        ],

        statusUrl:
          `${base}/api/shorts/status/${job.id}`,

        resultUrl:
          `${base}/api/shorts/result/${job.id}`
      });
    } catch (error) {
      await fs.promises
        .rm(
          file.path,
          {
            force: true
          }
        )
        .catch(() => {});

      throw error;
    }
  }

  /*
   * ==========================================================
   * RESUMABLE / CHUNKED UPLOAD
   * ==========================================================
   */

  /*
   * 1. CREATE UPLOAD SESSION
   *
   * POST /api/shorts/upload/init
   *
   * JSON:
   * {
   *   "filename": "video.mp4",
   *   "size": 12345678,
   *   "mimeType": "video/mp4"
   * }
   */

  router.post(
    '/upload/init',
    uploadLimiter,

    express.json({
      limit: '32kb'
    }),

    wrap(
      async (
        req,
        res
      ) => {
        const body =
          parseJsonBody(req);

        const filename =
          String(
            body.filename || ''
          ).trim();

        const size =
          Number(
            body.size
          );

        const mimeType =
          String(
            body.mimeType ||
              'application/octet-stream'
          );

        if (!filename) {
          throw new ValidationError(
            'BAD_FILENAME',
            'Video filename is required.',
            400
          );
        }

        if (
          !Number.isSafeInteger(
            size
          ) ||
          size <= 0
        ) {
          throw new ValidationError(
            'BAD_UPLOAD_SIZE',
            'Invalid video file size.',
            400
          );
        }

        /*
         * Validate the filename/mime pair
         * before creating a session.
         */
        checkUploadMeta(
          filename,
          mimeType
        );

        const session =
          await jobs.createUploadSession({
            filename,
            size,
            mimeType
          });

        res.status(201).json({
          uploadId:
            session.uploadId,

          uploadToken:
            session.uploadToken,

          chunkSize:
            session.chunkSize,

          totalChunks:
            session.totalChunks,

          size:
            session.size,

          status:
            'created'
        });
      }
    )
  );

  /*
   * 2. UPLOAD ONE CHUNK
   *
   * PUT /api/shorts/upload/chunk
   *
   * Headers:
   * X-Upload-Id
   * X-Upload-Token
   * X-Chunk-Index
   *
   * Body:
   * raw binary chunk
   */

  router.put(
    '/upload/chunk',

    chunkLimiter,

    express.raw({
      type:
        () => true,

      limit:
        '9mb'
    }),

    wrap(
      async (
        req,
        res
      ) => {
        const uploadId =
          req.get(
            'X-Upload-Id'
          ) ||
          (
            typeof req.query.uploadId ===
            'string'
              ? req.query.uploadId
              : ''
          );

        const uploadToken =
          uploadTokenFrom(req);

        const indexHeader =
          req.get(
            'X-Chunk-Index'
          );

        const index =
          Number(
            indexHeader
          );

        if (!uploadId) {
          throw new ValidationError(
            'UPLOAD_ID_REQUIRED',
            'Upload ID is required.',
            400
          );
        }

        if (!uploadToken) {
          throw new ValidationError(
            'UPLOAD_TOKEN_REQUIRED',
            'Upload token is required.',
            401
          );
        }

        if (
          indexHeader === null ||
          !Number.isInteger(index)
        ) {
          throw new ValidationError(
            'BAD_CHUNK_INDEX',
            'Chunk index is required.',
            400
          );
        }

        const buffer =
          Buffer.isBuffer(
            req.body
          )
            ? req.body
            : Buffer.from([]);

        const result =
          await jobs.saveUploadChunk({
            uploadId,
            uploadToken,
            index,
            buffer
          });

        res.status(200).json({
          ...result,

          status:
            'chunk-received'
        });
      }
    )
  );

  /*
   * 3. COMPLETE UPLOAD
   *
   * POST /api/shorts/upload/complete
   *
   * JSON:
   * {
   *   uploadId,
   *   uploadToken,
   *   mode: "process",
   *   duration: "60",
   *   aspectRatio: "9:16",
   *   clipCount: "3",
   *   startTime: "0",
   *   hook: "",
   *   instructions: ""
   * }
   */

  router.post(
    '/upload/complete',

    uploadLimiter,

    express.json({
      limit: '32kb'
    }),

    wrap(
      async (
        req,
        res
      ) => {
        const body =
          parseJsonBody(req);

        const uploadId =
          String(
            body.uploadId || ''
          ).trim();

        const uploadToken =
          String(
            body.uploadToken || ''
          ).trim();

        if (!uploadId) {
          throw new ValidationError(
            'UPLOAD_ID_REQUIRED',
            'Upload ID is required.',
            400
          );
        }

        if (!uploadToken) {
          throw new ValidationError(
            'UPLOAD_TOKEN_REQUIRED',
            'Upload token is required.',
            401
          );
        }

        const mode =
          String(
            body.mode ||
              'process'
          ).toLowerCase();

        if (
          mode !== 'process' &&
          mode !== 'trim'
        ) {
          throw new ValidationError(
            'BAD_MODE',
            'Mode must be "process" or "trim".',
            400
          );
        }

        /*
         * Assemble the chunks.
         */
        const completed =
          await jobs.completeUpload(
            uploadId,
            uploadToken
          );

        const file = {
          path:
            completed.path,

          originalname:
            completed.filename,

          mimetype:
            'video/mp4',

          size:
            completed.size
        };

        try {
          /*
           * Probe the completed video.
           */
          const source =
            await ffmpeg.probe(
              file.path
            );

          assertSource(
            source,
            config
          );

          /*
           * Convert body to the same shape
           * used by the old /process endpoint.
           */
          const processBody = {
            duration:
              body.duration,

            aspectRatio:
              body.aspectRatio,

            clipCount:
              body.clipCount,

            startTime:
              body.startTime,

            hook:
              body.hook,

            instructions:
              body.instructions
          };

          const parse =
            mode === 'trim'
              ? parseTrimOptions
              : parseProcessOptions;

          const plan =
            parse(
              processBody,
              source,
              config
            );

          const allowAI =
            mode ===
            'process';

          const aiRequested =
            Boolean(
              allowAI &&
              config.aiHighlights &&
              config.geminiApiKey
            );

          const job =
            await jobs.createJob({
              inputPath:
                file.path,

              source,

              ...plan,

              aiRequested
            });

          const base =
            baseUrl(req);

          res.status(202).json({
            uploadId,

            jobId:
              job.id,

            accessToken:
              job.token,

            status:
              job.status,

            mode:
              aiRequested
                ? 'ai-highlights'
                : job.mode,

            ai:
              aiRequested,

            clipCount:
              aiRequested
                ? 0
                : job.clips.length,

            warnings:
              job.warnings || [],

            statusUrl:
              `${base}/api/shorts/status/${job.id}`,

            resultUrl:
              `${base}/api/shorts/result/${job.id}`
          });
        } catch (error) {
          await fs.promises
            .rm(
              file.path,
              {
                force: true
              }
            )
            .catch(() => {});

          throw error;
        }
      }
    )
  );

  /*
   * Optional upload cancellation.
   *
   * DELETE /api/shorts/upload/:uploadId
   */

  router.delete(
    '/upload/:uploadId',

    wrap(
      async (
        req,
        res
      ) => {
        const uploadId =
          req.params.uploadId;

        const uploadToken =
          uploadTokenFrom(req);

        const result =
          await jobs.cancelUpload(
            uploadId,
            uploadToken
          );

        res.json(
          result
        );
      }
    )
  );

  /*
   * ==========================================================
   * EXISTING PROCESS ENDPOINT
   * ==========================================================
   */

  router.post(
    '/process',

    uploadLimiter,

    handleUpload,

    wrap(
      (
        req,
        res
      ) =>
        createFromUpload(
          req,
          res,
          parseProcessOptions,
          true
        )
    )
  );

  /*
   * ==========================================================
   * EXISTING TRIM ENDPOINT
   * ==========================================================
   */

  router.post(
    '/trim',

    uploadLimiter,

    handleUpload,

    wrap(
      (
        req,
        res
      ) =>
        createFromUpload(
          req,
          res,
          parseTrimOptions,
          false
        )
    )
  );

  /*
   * ==========================================================
   * JOB STATUS
   * ==========================================================
   */

  router.get(
    '/status/:jobId',

    (
      req,
      res,
      next
    ) => {
      try {
        const job =
          jobs.getAuthorized(
            req.params.jobId,
            tokenFrom(req)
          );

        res.set(
          'Cache-Control',
          'no-store'
        );

        res.json(
          jobs.statusView(
            job
          )
        );
      } catch (error) {
        next(error);
      }
    }
  );

  /*
   * ==========================================================
   * JOB RESULT
   * ==========================================================
   */

  router.get(
    '/result/:jobId',

    (
      req,
      res,
      next
    ) => {
      try {
        const job =
          jobs.getAuthorized(
            req.params.jobId,
            tokenFrom(req)
          );

        res.set(
          'Cache-Control',
          'no-store'
        );

        if (
          job.status ===
          'completed'
        ) {
          return res.json(
            jobs.resultView(
              job,
              baseUrl(req)
            )
          );
        }

        if (
          job.status ===
          'failed'
        ) {
          return res.status(
            422
          ).json({
            error:
              job.error,

            code:
              'JOB_FAILED',

            status:
              'failed',

            errorCode:
              job.errorCode
          });
        }

        return res.status(
          409
        ).json({
          error:
            'The job is not finished yet.',

          code:
            'JOB_NOT_READY',

          status:
            job.status,

          progress:
            job.progress
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /*
   * ==========================================================
   * DOWNLOAD
   * ==========================================================
   */

  router.get(
    '/download/:jobId/:index',

    (
      req,
      res,
      next
    ) => {
      try {
        const job =
          jobs.getAuthorized(
            req.params.jobId,
            tokenFrom(req)
          );

        if (
          job.status !==
          'completed'
        ) {
          throw new ValidationError(
            'JOB_NOT_READY',
            'The job is not finished yet.',
            409
          );
        }

        if (
          !/^\d{1,3}$/.test(
            req.params.index
          )
        ) {
          throw new ValidationError(
            'NOT_FOUND',
            'Clip not found.',
            404
          );
        }

        const index =
          Number(
            req.params.index
          );

        const {
          root,
          name
        } =
          jobs.fileFor(
            job,
            index
          );

        const download =
          req.query.download ===
          '1';

        res.sendFile(
          name,
          {
            root,

            dotfiles:
              'deny',

            acceptRanges:
              true,

            headers: {
              'Content-Type':
                'video/mp4',

              'Content-Disposition':
                download
                  ? `attachment; filename="shortsmaker-clip-${index}.mp4"`
                  : 'inline',

              'Cache-Control':
                'private, max-age=300'
            }
          },

          (
            error
          ) => {
            if (
              error &&
              !res.headersSent
            ) {
              next(
                new ValidationError(
                  'NOT_FOUND',
                  'Clip not found or expired.',
                  404
                )
              );
            }
          }
        );
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createShortsRouter
};
