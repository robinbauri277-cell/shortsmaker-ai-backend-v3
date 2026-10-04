'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ValidationError } = require('./errors');

const fsp = fs.promises;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERROR_TEXT = {
  TIMEOUT: 'Processing took too long and was stopped. Try a shorter clip or a smaller video.',
  BINARY_MISSING: 'The video processor is not available on the server.',
  FFMPEG_FAILED: 'The video could not be converted. The file may be damaged or use an unsupported codec.',
  OUTPUT_INVALID: 'The generated clip failed validation and was discarded.'
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
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
    this.uploadsDir = path.join(cfg.dataDir, 'uploads');
    this.jobsDir = path.join(cfg.dataDir, 'jobs');
    this.timer = null;
  }

  /** Jobs live in memory, so anything left on disk from a previous run is stale. */
  async init() {
    await fsp.rm(this.uploadsDir, { recursive: true, force: true });
    await fsp.rm(this.jobsDir, { recursive: true, force: true });
    await fsp.mkdir(this.uploadsDir, { recursive: true });
    await fsp.mkdir(this.jobsDir, { recursive: true });
  }

  startCleanupTimer() {
    this.timer = setInterval(() => {
      this.cleanup().catch((e) => this.log.error('[cleanup] failed:', e.message));
    }, this.cfg.cleanupIntervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  stats() {
    return { running: this.running, queued: this.queue.length };
  }

  async createJob({ inputPath, mode, options, clips, warnings, source }) {
    const cap = this.cfg.maxConcurrentJobs + this.cfg.maxQueuedJobs;
    if (this.running + this.queue.length + this.reserved >= cap) {
      throw new ValidationError('SERVER_BUSY', 'The server is busy. Please try again in a few minutes.', 503);
    }
    this.reserved++;
    const id = crypto.randomUUID();
    const dir = path.join(this.jobsDir, id);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const input = path.join(dir, 'input' + path.extname(inputPath));
      await fsp.rename(inputPath, input);

      const now = Date.now();
      const job = {
        id,
        token: crypto.randomBytes(24).toString('base64url'),
        status: 'queued',
        stage: 'queued',
        progress: 0,
        currentClip: 0,
        mode,
        options,
        clips: clips.map((c, i) => ({ index: i + 1, startSec: c.startSec, durationSec: c.durationSec })),
        outputs: [],
        warnings: warnings || [],
        source: { durationSec: Math.round(source.durationSec * 100) / 100, width: source.width, height: source.height },
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
        errorCode: null,
        dir,
        inputPath: input
      };
      this.jobs.set(id, job);
      this.queue.push(id);
      setImmediate(() => this.pump());
      return job;
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this.reserved--;
    }
  }

  pump() {
    while (this.running < this.cfg.maxConcurrentJobs && this.queue.length) {
      const job = this.jobs.get(this.queue.shift());
      if (!job) continue;
      this.running++;
      this.run(job)
        .catch((e) => this.log.error('[job] unexpected:', e && e.message))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  async run(job) {
    const deadline = Date.now() + this.cfg.processTimeoutMs;
    const total = job.clips.length;
    job.status = 'processing';
    job.stage = 'encoding';
    job.updatedAt = Date.now();
    try {
      for (const clip of job.clips) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const e = new Error('timeout');
          e.code = 'TIMEOUT';
          throw e;
        }
        job.currentClip = clip.index;
        const name = `clip-${clip.index}.mp4`;
        const result = await this.ffmpeg.transcodeClip({
          input: job.inputPath,
          output: path.join(job.dir, name),
          startSec: clip.startSec,
          durationSec: clip.durationSec,
          width: job.options.width,
          height: job.options.height,
          timeoutMs: remaining,
          onProgress: (frac) => {
            const p = Math.min(99, Math.round(((clip.index - 1 + frac) / total) * 100));
            if (p > job.progress) job.progress = p;
            job.updatedAt = Date.now();
          }
        });
        job.outputs.push({ index: clip.index, file: name, startSec: clip.startSec, ...result });
      }
      job.status = 'completed';
      job.stage = 'done';
      job.progress = 100;
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
    } catch (e) {
      await this.fail(job, e);
    } finally {
      await fsp.rm(job.inputPath, { force: true }).catch(() => {});
    }
  }

  async fail(job, e) {
    this.log.error(`[job ${job.id}] failed: ${e && e.code} ${e && e.message} ${e && e.detail ? '| ' + String(e.detail).slice(-400) : ''}`);
    const code = e && ERROR_TEXT[e.code] ? e.code : 'PROCESSING_FAILED';
    job.status = 'failed';
    job.stage = 'failed';
    job.errorCode = code;
    job.error = ERROR_TEXT[code] || 'Video processing failed unexpectedly.';
    job.outputs = [];
    job.finishedAt = Date.now();
    job.updatedAt = job.finishedAt;
    const files = await fsp.readdir(job.dir).catch(() => []);
    await Promise.all(files.filter((f) => f.startsWith('clip-')).map((f) => fsp.rm(path.join(job.dir, f), { force: true }).catch(() => {})));
  }

  /** 401 without a token; 404 for unknown job OR wrong token, so job IDs cannot be probed. */
  getAuthorized(id, token) {
    if (!UUID_RE.test(String(id))) throw new ValidationError('NOT_FOUND', 'Job not found.', 404);
    if (!token || typeof token !== 'string') {
      throw new ValidationError('TOKEN_REQUIRED', 'A job token is required (X-Job-Token header or ?token=).', 401);
    }
    const job = this.jobs.get(id);
    if (!job || !safeEqual(job.token, token)) throw new ValidationError('NOT_FOUND', 'Job not found.', 404);
    return job;
  }

  statusView(job) {
    const view = {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      currentClip: job.currentClip,
      clipCount: job.clips.length,
      mode: job.mode,
      ai: false,
      source: job.source,
      warnings: job.warnings,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      expiresAt: job.finishedAt ? new Date(job.finishedAt + this.cfg.jobTtlMs).toISOString() : null
    };
    if (job.status === 'queued') view.queuePosition = this.queue.indexOf(job.id) + 1;
    if (job.status === 'failed') {
      view.error = job.error;
      view.errorCode = job.errorCode;
    }
    return view;
  }

  resultView(job, baseUrl) {
    const q = `token=${encodeURIComponent(job.token)}`;
    return {
      jobId: job.id,
      status: 'completed',
      mode: job.mode,
      ai: false,
      warnings: job.warnings,
      expiresAt: new Date(job.finishedAt + this.cfg.jobTtlMs).toISOString(),
      clips: job.outputs.map((o) => ({
        index: o.index,
        startSec: o.startSec,
        endSec: Math.round((o.startSec + o.durationSec) * 100) / 100,
        durationSec: o.durationSec,
        width: o.width,
        height: o.height,
        sizeBytes: o.sizeBytes,
        previewUrl: `${baseUrl}/api/shorts/download/${job.id}/${o.index}?${q}`,
        downloadUrl: `${baseUrl}/api/shorts/download/${job.id}/${o.index}?${q}&download=1`
      }))
    };
  }

  /** Returns { root, name } for res.sendFile, so absolute paths never reach clients. */
  fileFor(job, index) {
    const out = job.outputs.find((o) => o.index === index);
    if (!out) throw new ValidationError('NOT_FOUND', 'Clip not found.', 404);
    return { root: job.dir, name: out.file };
  }

  async cleanup(now = Date.now()) {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now >= job.finishedAt + this.cfg.jobTtlMs) {
        this.jobs.delete(id);
        await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
    // Orphans: abandoned uploads and job folders that no longer belong to a job.
    const orphanAge = 10 * 60 * 1000;
    for (const f of await fsp.readdir(this.uploadsDir).catch(() => [])) {
      const p = path.join(this.uploadsDir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > 60 * 60 * 1000) { await fsp.rm(p, { force: true }).catch(() => {}); removed++; }
    }
    for (const d of await fsp.readdir(this.jobsDir).catch(() => [])) {
      if (this.jobs.has(d)) continue;
      const p = path.join(this.jobsDir, d);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > orphanAge) { await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); removed++; }
    }
    return removed;
  }
}

module.exports = { JobManager };
