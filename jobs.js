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

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
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

    this.uploadsDir = path.join(
      cfg.dataDir,
      'uploads'
    );

    this.jobsDir = path.join(
      cfg.dataDir,
      'jobs'
    );

    this.timer = null;

    /*
     * Gemini AI analyzer.
     *
     * It is created once and reused by jobs.
     */
    this.ai = null;

    if (
      cfg.aiHighlights &&
      cfg.geminiApiKey
    ) {
      try {
        this.ai =
          createAIHighlights(
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
  }

  startCleanupTimer() {
    this.timer =
      setInterval(() => {
        this.cleanup().catch(
          (e) =>
            this.log.error(
              '[cleanup] failed:',
              e.message
            )
        );
      }, this.cfg.cleanupIntervalMs);

    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  stats() {
    return {
      running: this.running,
      queued: this.queue.length
    };
  }

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
          crypto.randomBytes(
            24
          ).toString(
            'base64url'
          ),

        status: 'queued',
        stage: 'queued',
        progress: 0,
        currentClip: 0,

        mode,

        options,

        /*
         * AI requested for this job.
         */
        aiRequested:
          Boolean(
            aiRequested
          ),

        /*
         * Becomes true only after
         * Gemini successfully returns
         * usable highlights.
         */
        aiUsed: false,

        aiAnalysis: null,

        clips: (
          clips || []
        ).map(
          (c, i) => ({
            index: i + 1,
            startSec:
              c.startSec,
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
              source.durationSec *
                100
            ) / 100,

          width:
            source.width,

          height:
            source.height
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

      this.queue.push(
        id
      );

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
      const job =
        this.jobs.get(
          this.queue.shift()
        );

      if (!job) {
        continue;
      }

      this.running++;

      this.run(job)
        .catch(
          (e) =>
            this.log.error(
              '[job] unexpected:',
              e &&
                e.message
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

    job.status =
      'processing';

    job.stage =
      job.aiRequested
        ? 'ai-analysis'
        : 'encoding';

    job.progress = 1;

    job.updatedAt =
      Date.now();

    try {
      /*
       * =====================================
       * AI HIGHLIGHT DETECTION
       * =====================================
       */

      if (
        job.aiRequested &&
        this.ai
      ) {
        const remaining =
          deadline -
          Date.now();

        if (remaining <= 0) {
          const e =
            new Error(
              'timeout'
            );

          e.code =
            'TIMEOUT';

          throw e;
        }

        this.log.log(
          `[job ${job.id}] starting AI highlight analysis`
        );

        try {
          const highlights =
            await this.ai.analyzeVideo(
              {
                inputPath:
                  job.inputPath,

                durationSec:
                  job.source
                    .durationSec,

                clipCount:
                  job.options
                    .clipCount ||
                  job.clips.length ||
                  3,

                clipDurationSec:
                  job.options
                    .durationSec ||
                  30
              }
            );

          if (
            !Array.isArray(
              highlights
            ) ||
            !highlights.length
          ) {
            throw new Error(
              'Gemini returned no usable highlights.'
            );
          }

          /*
           * Replace the basic interval
           * clips with AI-selected clips.
           */
          job.clips =
            highlights.map(
              (h, i) => ({
                index:
                  i + 1,

                startSec:
                  h.startSec,

                durationSec:
                  h.durationSec,

                score:
                  h.score,

                reason:
                  h.reason
              })
            );

          job.aiAnalysis = {
            count:
              job.clips.length,

            highlights:
              job.clips.map(
                (c) => ({
                  index:
                    c.index,

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

          job.aiUsed =
            true;

          job.mode =
            'ai-highlights';

          job.stage =
            'encoding';

          job.progress = 5;

          job.updatedAt =
            Date.now();

          this.log.log(
            `[job ${job.id}] AI selected ${job.clips.length} highlights`
          );
        } catch (aiError) {
          /*
           * Do NOT destroy the user's job
           * if Gemini temporarily fails.
           *
           * Fall back to the already-created
           * basic interval clips.
           */
          this.log.error(
            `[job ${job.id}] AI analysis failed:`,
            aiError &&
              aiError.message
          );

          job.aiUsed =
            false;

          job.aiAnalysis =
            null;

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
       * =====================================
       * FFmpeg CLIP GENERATION
       * =====================================
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
          deadline -
          Date.now();

        if (
          remaining <= 0
        ) {
          const e =
            new Error(
              'timeout'
            );

          e.code =
            'TIMEOUT';

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
          await this.ffmpeg.transcodeClip(
            {
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
                    job.progress =
                      p;
                  }

                  job.updatedAt =
                    Date.now();
                }
            }
          );

        job.outputs.push(
          {
            index:
              clip.index,

            file:
              name,

            startSec:
              clip.startSec,

            score:
              clip.score,

            reason:
              clip.reason,

            ...result
          }
        );
      }

      /*
       * =====================================
       * COMPLETE
       * =====================================
       */

      job.status =
        'completed';

      job.stage =
        'done';

      job.progress =
        100;

      job.finishedAt =
        Date.now();

      job.updatedAt =
        job.finishedAt;
    } catch (e) {
      await this.fail(
        job,
        e
      );
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
      } ${
        e && e.detail
          ? '| ' +
            String(
              e.detail
            ).slice(-400)
          : ''
      }`
    );

    const code =
      e &&
      ERROR_TEXT[e.code]
        ? e.code
        : 'PROCESSING_FAILED';

    job.status =
      'failed';

    job.stage =
      'failed';

    job.errorCode =
      code;

    job.error =
      ERROR_TEXT[code] ||
      'Video processing failed unexpectedly.';

    job.outputs =
      [];

    job.finishedAt =
      Date.now();

    job.updatedAt =
      job.finishedAt;

    const files =
      await fsp.readdir(
        job.dir
      ).catch(
        () => []
      );

    await Promise.all(
      files
        .filter(
          (f) =>
            f.startsWith(
              'clip-'
            )
        )
        .map(
          (f) =>
            fsp.rm(
              path.join(
                job.dir,
                f
              ),
              {
                force: true
              }
            ).catch(
              () => {}
            )
        )
    );
  }

  getAuthorized(
    id,
    token
  ) {
    if (
      !UUID_RE.test(
        String(id)
      )
    ) {
      throw new Validation
