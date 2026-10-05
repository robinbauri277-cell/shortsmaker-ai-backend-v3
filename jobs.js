'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ValidationError } = require('./errors');
const { createAIHighlights } = require('./ai-highlights');

const fsp = fs.promises;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERROR_TEXT = {
  TIMEOUT:
    'Processing took too long and was stopped. Try a shorter clip or a smaller video.',

  BINARY_MISSING:
    'The video processor is not available on the server.',

  FFMPEG_FAILED:
    'The video could not be converted. The file may be damaged or use an unsupported codec.',

  OUTPUT_INVALID:
    'The generated clip failed validation and was discarded.',

  AI_FAILED:
    'AI highlight detection failed. Please try again or disable AI mode.'
};

/*
 * Chunk upload defaults.
 *
 * 8 MB chunks are small enough for mobile connections while
 * keeping the number of requests reasonable for a 500 MB file.
 */
const CHUNK_SIZE = 8 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
  );
}

function safeFilename(name) {
  const base = path.basename(String(name || 'video.mp4'));

  const ext = path.extname(base).toLowerCase();

  return (
    /^[a-z0-9._-]+$/i.test(base)
      ? base
      : `upload${ext || '.mp4'}`
  );
}

class JobManager {
  constructor(cfg, ffmpeg, logger = console) {
    this.cfg = cfg;
    this.ffmpeg = ffmpeg;
    this.log = logger;

    this.jobs = new Map();
    this.queue = [];

    this.running = 0;
    this.reserved = 0;

    /*
     * Resumable upload sessions.
     */
    this.uploadSessions = new Map();

    this.uploadsDir = path.join(
      cfg.dataDir,
      'uploads'
    );

    this.jobsDir = path.join(
      cfg.dataDir,
      'jobs'
    );

    this.sessionsDir = path.join(
      this.uploadsDir,
      'sessions'
    );

    this.timer = null;
    this.ai = null;

    if (
      cfg.aiHighlights &&
      cfg.geminiApiKey
    ) {
      try {
        this.ai = createAIHighlights(
          cfg,
          logger
        );

        this.log.log(
          '[ai] Gemini highlight analyzer enabled'
        );
      } catch (e) {
        this.log.error(
          '[ai] Failed to initialize:',
          e.message
        );
      }
    }
  }

  async init() {
    await fsp.rm(
      this.uploadsDir,
      {
        recursive: true,
        force: true
      }
    );

    await fsp.rm(
      this.jobsDir,
      {
        recursive: true,
        force: true
      }
    );

    await fsp.mkdir(
      this.uploadsDir,
      {
        recursive: true
      }
    );

    await fsp.mkdir(
      this.jobsDir,
      {
        recursive: true
      }
    );

    await fsp.mkdir(
      this.sessionsDir,
      {
        recursive: true
      }
    );

    this.uploadSessions.clear();
  }

  startCleanupTimer() {
    this.timer = setInterval(
      () => {
        this.cleanup().catch(
          (e) =>
            this.log.error(
              '[cleanup] failed:',
              e.message
            )
        );
      },
      this.cfg.cleanupIntervalMs
    );

    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats() {
    return {
      running: this.running,
      queued: this.queue.length,
      uploads: this.uploadSessions.size
    };
  }

  /*
   * ==========================================================
   * RESUMABLE UPLOAD SESSION
   * ==========================================================
   */

  async createUploadSession({
    filename,
    size,
    mimeType
  }) {
    const totalSize =
      Number(size);

    if (
      !Number.isSafeInteger(totalSize) ||
      totalSize <= 0
    ) {
      throw new ValidationError(
        'BAD_UPLOAD_SIZE',
        'Invalid upload file size.',
        400
      );
    }

    if (
      totalSize >
      this.cfg.maxUploadBytes
    ) {
      throw new ValidationError(
        'FILE_TOO_LARGE',
        `File is too large. Maximum is ${Math.round(
          this.cfg.maxUploadBytes / 1048576
        )} MB.`,
        413
      );
    }

    const id =
      crypto.randomUUID();

    const token =
      crypto
        .randomBytes(32)
        .toString('base64url');

    const dir =
      path.join(
        this.sessionsDir,
        id
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    const totalChunks =
      Math.ceil(
        totalSize /
          CHUNK_SIZE
      );

    const session = {
      id,

      token,

      filename:
        safeFilename(filename),

      mimeType:
        String(mimeType || 'application/octet-stream'),

      size:
        totalSize,

      chunkSize:
        CHUNK_SIZE,

      totalChunks,

      received:
        new Set(),

      createdAt:
        Date.now(),

      updatedAt:
        Date.now(),

      dir,

      completePath:
        null,

      completed:
        false
    };

    this.uploadSessions.set(
      id,
      session
    );

    return {
      uploadId: id,
      uploadToken: token,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      size: totalSize
    };
  }

  getUploadSession(
    id,
    token
  ) {
    if (
      !UUID_RE.test(
        String(id)
      )
    ) {
      throw new ValidationError(
        'UPLOAD_NOT_FOUND',
        'Upload session not found.',
        404
      );
    }

    const session =
      this.uploadSessions.get(
        String(id)
      );

    if (!session) {
      throw new ValidationError(
        'UPLOAD_NOT_FOUND',
        'Upload session not found or expired.',
        404
      );
    }

    if (
      !token
    ) {
      throw new ValidationError(
        'UPLOAD_TOKEN_REQUIRED',
        'Upload token is required.',
        401
      );
    }

    if (
      !safeEqual(
        session.token,
        token
      )
    ) {
      throw new ValidationError(
        'UPLOAD_NOT_FOUND',
        'Upload session not found.',
        404
      );
    }

    return session;
  }

  async saveUploadChunk({
    uploadId,
    uploadToken,
    index,
    buffer
  }) {
    const session =
      this.getUploadSession(
        uploadId,
        uploadToken
      );

    if (
      session.completed
    ) {
      throw new ValidationError(
        'UPLOAD_COMPLETED',
        'This upload has already been completed.',
        409
      );
    }

    const chunkIndex =
      Number(index);

    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= session.totalChunks
    ) {
      throw new ValidationError(
        'BAD_CHUNK_INDEX',
        'Invalid upload chunk index.',
        400
      );
    }

    if (
      !Buffer.isBuffer(buffer) ||
      buffer.length === 0
    ) {
      throw new ValidationError(
        'EMPTY_CHUNK',
        'The upload chunk is empty.',
        400
      );
    }

    const expectedSize =
      chunkIndex ===
      session.totalChunks - 1
        ? session.size -
          (
            session.chunkSize *
            chunkIndex
          )
        : session.chunkSize;

    if (
      buffer.length !==
      expectedSize
    ) {
      throw new ValidationError(
        'BAD_CHUNK_SIZE',
        'Upload chunk size does not match the expected size.',
        400
      );
    }

    const chunkPath =
      path.join(
        session.dir,
        `chunk-${String(chunkIndex).padStart(8, '0')}`
      );

    /*
     * Re-uploading the same chunk is allowed.
     * This makes retrying a failed request safe.
     */
    await fsp.writeFile(
      chunkPath,
      buffer
    );

    session.received.add(
      chunkIndex
    );

    session.updatedAt =
      Date.now();

    return {
      uploadId:
        session.id,

      chunk:
        chunkIndex,

      received:
        session.received.size,

      totalChunks:
        session.totalChunks,

      progress:
        Math.round(
          (
            session.received.size /
            session.totalChunks
          ) *
          100
        )
    };
  }

  async completeUpload(
    uploadId,
    uploadToken
  ) {
    const session =
      this.getUploadSession(
        uploadId,
        uploadToken
      );

    if (
      session.completed &&
      session.completePath
    ) {
      return {
        uploadId:
          session.id,

        path:
          session.completePath,

        size:
          session.size
      };
    }

    if (
      session.received.size !==
      session.totalChunks
    ) {
      throw new ValidationError(
        'UPLOAD_INCOMPLETE',
        `Upload is incomplete. Received ${session.received.size} of ${session.totalChunks} chunks.`,
        409
      );
    }

    const finalPath =
      path.join(
        this.uploadsDir,
        `${session.id}-${session.filename}`
      );

    const handle =
      await fsp.open(
        finalPath,
        'w'
      );

    try {
      let totalWritten = 0;

      for (
        let i = 0;
        i < session.totalChunks;
        i++
      ) {
        const chunkPath =
          path.join(
            session.dir,
            `chunk-${String(i).padStart(8, '0')}`
          );

        const data =
          await fsp.readFile(
            chunkPath
          );

        await handle.write(
          data
        );

        totalWritten +=
          data.length;
      }

      if (
        totalWritten !==
        session.size
      ) {
        throw new ValidationError(
          'UPLOAD_SIZE_MISMATCH',
          'The completed upload size does not match the original file.',
          400
        );
      }

      session.completed =
        true;

      session.completePath =
        finalPath;

      session.updatedAt =
        Date.now();

      /*
       * Chunks are no longer needed after
       * the final file has been assembled.
       */
      await fsp.rm(
        session.dir,
        {
          recursive: true,
          force: true
        }
      );

      return {
        uploadId:
          session.id,

        path:
          finalPath,

        size:
          totalWritten,

        filename:
          session.filename
      };
    } finally {
      await handle.close();
    }
  }

  async cancelUpload(
    uploadId,
    uploadToken
  ) {
    const session =
      this.getUploadSession(
        uploadId,
        uploadToken
      );

    await fsp.rm(
      session.dir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});

    if (
      session.completePath
    ) {
      await fsp.rm(
        session.completePath,
        {
          force: true
        }
      ).catch(() => {});
    }

    this.uploadSessions.delete(
      session.id
    );

    return {
      uploadId:
        session.id,

      cancelled:
        true
    };
  }

  /*
   * ==========================================================
   * JOB SYSTEM
   * ==========================================================
   */

  async createJob({
    inputPath,
    mode,
    options,
    clips,
    warnings,
    source,
    aiRequested = false
  }) {
    const cap =
      this.cfg.maxConcurrentJobs +
      this.cfg.maxQueuedJobs;

    if (
      this.running +
        this.queue.length +
        this.reserved >=
      cap
    ) {
      throw new ValidationError(
        'SERVER_BUSY',
        'The server is busy. Please try again in a few minutes.',
        503
      );
    }

    this.reserved++;

    const id =
      crypto.randomUUID();

    const dir =
      path.join(
        this.jobsDir,
        id
      );

    try {
      await fsp.mkdir(
        dir,
        {
          recursive: true
        }
      );

      const input =
        path.join(
          dir,
          'input' +
            path.extname(
              inputPath
            )
        );

      await fsp.rename(
        inputPath,
        input
      );

      const now =
        Date.now();

      const job = {
        id,

        token:
          crypto
            .randomBytes(24)
            .toString('base64url'),

        status: 'queued',
        stage: 'queued',
        progress: 0,
        currentClip: 0,

        mode,
        options,

        aiRequested:
          Boolean(aiRequested),

        aiUsed: false,
        aiAnalysis: null,

        clips:
          (clips || []).map(
            (c, i) => ({
              index: i + 1,
              startSec: c.startSec,
              durationSec:
                c.durationSec
            })
          ),

        outputs: [],

        warnings:
          warnings || [],

        source: {
          durationSec:
            Math.round(
              source.durationSec * 100
            ) / 100,

          width: source.width,
          height: source.height
        },

        createdAt: now,
        updatedAt: now,
        finishedAt: null,

        error: null,
        errorCode: null,

        dir,
        inputPath: input
      };

      this.jobs.set(
        id,
        job
      );

      this.queue.push(id);

      setImmediate(
        () => this.pump()
      );

      return job;
    } catch (e) {
      await fsp.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});

      throw e;
    } finally {
      this.reserved--;
    }
  }

  pump() {
    while (
      this.running <
        this.cfg.maxConcurrentJobs &&
      this.queue.length
    ) {
      const id =
        this.queue.shift();

      const job =
        this.jobs.get(id);

      if (!job) continue;

      this.running++;

      this.run(job)
        .catch(
          (e) =>
            this.log.error(
              '[job] unexpected:',
              e && e.message
            )
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  async run(job) {
    const deadline =
      Date.now() +
      this.cfg.processTimeoutMs;

    job.status = 'processing';

    job.stage =
      job.aiRequested
        ? 'ai-analysis'
        : 'encoding';

    job.progress = 1;
    job.updatedAt = Date.now();

    try {
      /*
       * ==============================
       * AI HIGHLIGHT DETECTION
       * ==============================
       */

      if (
        job.aiRequested &&
        this.ai
      ) {
        const remaining =
          deadline - Date.now();

        if (remaining <= 0) {
          const e =
            new Error('timeout');

          e.code = 'TIMEOUT';

          throw e;
        }

        this.log.log(
          `[job ${job.id}] starting AI highlight analysis`
        );

        try {
          const highlights =
            await this.ai.analyzeVideo({
              inputPath:
                job.inputPath,

              durationSec:
                job.source.durationSec,

              clipCount:
                job.options.clipCount ||
                job.clips.length ||
                3,

              clipDurationSec:
                job.options.durationSec ||
                30
            });

          if (
            !Array.isArray(highlights) ||
            !highlights.length
          ) {
            throw new Error(
              'Gemini returned no usable highlights.'
            );
          }

          job.clips =
            highlights.map(
              (h, i) => ({
                index: i + 1,
                startSec: h.startSec,
                durationSec:
                  h.durationSec,
                score: h.score,
                reason: h.reason
              })
            );

          job.aiAnalysis = {
            count:
              job.clips.length,

            highlights:
              job.clips.map(
                (c) => ({
                  index: c.index,
                  startSec:
                    c.startSec,
                  durationSec:
                    c.durationSec,
                  score:
                    c.score,
                  reason:
                    c.reason
                })
              )
          };

          job.aiUsed = true;
          job.mode =
            'ai-highlights';

          job.stage = 'encoding';
          job.progress = 5;
          job.updatedAt =
            Date.now();

          this.log.log(
            `[job ${job.id}] AI selected ${job.clips.length} highlights`
          );
        } catch (aiError) {
          this.log.error(
            `[job ${job.id}] AI analysis failed:`,
            aiError &&
              aiError.message
          );

          job.aiUsed = false;
          job.aiAnalysis = null;

          job.warnings.push(
            'AI highlight detection was unavailable. Basic interval clips were generated instead.'
          );

          job.mode =
            'interval-basic';

          job.stage =
            'encoding';

          job.progress = 2;
          job.updatedAt =
            Date.now();
        }
      }

      /*
       * ==============================
       * FFMPEG CLIP GENERATION
       * ==============================
       */

      const total =
        job.clips.length;

      if (!total) {
        const e =
          new Error(
            'No clips were selected.'
          );

        e.code =
          'FFMPEG_FAILED';

        throw e;
      }

      for (
        const clip of job.clips
      ) {
        const remaining =
          deadline - Date.now();

        if (remaining <= 0) {
          const e =
            new Error('timeout');

          e.code = 'TIMEOUT';

          throw e;
        }

        job.currentClip =
          clip.index;

        job.stage =
          'encoding';

        job.updatedAt =
          Date.now();

        const name =
          `clip-${clip.index}.mp4`;

        const result =
          await this.ffmpeg.transcodeClip({
            input:
              job.inputPath,

            output:
              path.join(
                job.dir,
                name
              ),

            startSec:
              clip.startSec,

            durationSec:
              clip.durationSec,

            width:
              job.options.width,

            height:
              job.options.height,

            timeoutMs:
              remaining,

            onProgress:
              (frac) => {
                const p =
                  Math.min(
                    99,
                    Math.round(
                      (
                        (
                          clip.index -
                          1 +
                          frac
                        ) /
                        total
                      ) *
                        94 +
                        5
                    )
                  );

                if (
                  p >
                  job.progress
                ) {
                  job.progress = p;
                }

                job.updatedAt =
                  Date.now();
              }
          });

        job.outputs.push({
          index:
            clip.index,

          file: name,

          startSec:
            clip.startSec,

          score:
            clip.score,

          reason:
            clip.reason,

          ...result
        });
      }

      job.status =
        'completed';

      job.stage =
        'done';

      job.progress = 100;

      job.finishedAt =
        Date.now();

      job.updatedAt =
        job.finishedAt;
    } catch (e) {
      await this.fail(job, e);
    } finally {
      await fsp.rm(
        job.inputPath,
        {
          force: true
        }
      ).catch(() => {});
    }
  }

  async fail(job, e) {
    this.log.error(
      `[job ${job.id}] failed: ${
        e && e.code
      } ${
        e && e.message
      }`
    );

    const code =
      e &&
      ERROR_TEXT[e.code]
        ? e.code
        : 'PROCESSING_FAILED';

    job.status = 'failed';
    jo
