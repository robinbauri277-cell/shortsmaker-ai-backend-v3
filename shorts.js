'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { ValidationError } = require('../errors');
const { checkUploadMeta, assertSource, parseProcessOptions, parseTrimOptions, ALLOWED_EXT } = require('../validate');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function tokenFrom(req) {
  const h = req.get('X-Job-Token');
  if (typeof h === 'string' && h) return h;
  return typeof req.query.token === 'string' ? req.query.token : '';
}

function createShortsRouter({ config, ffmpeg, jobs }) {
  const router = express.Router();

  const uploadLimiter = rateLimit({
    windowMs: config.rateLimit.uploadWindowMs,
    limit: config.rateLimit.uploadMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many uploads. Please wait before trying again.', code: 'RATE_LIMITED' }
  });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, jobs.uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, crypto.randomUUID() + (ALLOWED_EXT.has(ext) ? ext : '.bin')); // client filename is never used on disk
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20, fieldSize: 1024, parts: 25 },
    fileFilter: (req, file, cb) => {
      try {
        checkUploadMeta(file.originalname, file.mimetype);
        cb(null, true);
      } catch (e) {
        cb(e);
      }
    }
  }).single('video');

  function handleUpload(req, res, next) {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ValidationError('FILE_TOO_LARGE', `File is too large. Maximum is ${Math.round(config.maxUploadBytes / 1048576)} MB.`, 413));
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(new ValidationError('WRONG_FIELD_NAME', 'The video file must be sent in a form field named "video".', 400));
        }
        return next(new ValidationError('BAD_UPLOAD', 'The upload was malformed.', 400));
      }
      return next(err);
    });
  }

  const baseUrl = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  async function createFromUpload(req, res, parse) {
    const file = req.file;
    if (!file) {
      throw new ValidationError('NO_FILE', 'No video uploaded. Send multipart/form-data with a file field named "video".', 400);
    }
    try {
      const source = await ffmpeg.probe(file.path);
      assertSource(source, config);
      const plan = parse(req.body, source, config);
      const job = await jobs.createJob({ inputPath: file.path, source, ...plan });
      const base = baseUrl(req);
      res.status(202).json({
        jobId: job.id,
        accessToken: job.token,
        status: job.status,
        mode: job.mode,
        ai: false,
        clipCount: job.clips.length,
        warnings: job.warnings,
        statusUrl: `${base}/api/shorts/status/${job.id}`,
        resultUrl: `${base}/api/shorts/result/${job.id}`
      });
    } catch (e) {
      await fs.promises.rm(file.path, { force: true }).catch(() => {});
      throw e;
    }
  }

  router.post('/process', uploadLimiter, handleUpload, wrap((req, res) => createFromUpload(req, res, parseProcessOptions)));
  router.post('/trim', uploadLimiter, handleUpload, wrap((req, res) => createFromUpload(req, res, parseTrimOptions)));

  router.get('/status/:jobId', (req, res, next) => {
    try {
      const job = jobs.getAuthorized(req.params.jobId, tokenFrom(req));
      res.set('Cache-Control', 'no-store').json(jobs.statusView(job));
    } catch (e) { next(e); }
  });

  router.get('/result/:jobId', (req, res, next) => {
    try {
      const job = jobs.getAuthorized(req.params.jobId, tokenFrom(req));
      res.set('Cache-Control', 'no-store');
      if (job.status === 'completed') return res.json(jobs.resultView(job, baseUrl(req)));
      if (job.status === 'failed') {
        return res.status(422).json({ error: job.error, code: 'JOB_FAILED', status: 'failed', errorCode: job.errorCode });
      }
      return res.status(409).json({ error: 'The job is not finished yet.', code: 'JOB_NOT_READY', status: job.status, progress: job.progress });
    } catch (e) { next(e); }
  });

  router.get('/download/:jobId/:index', (req, res, next) => {
    try {
      const job = jobs.getAuthorized(req.params.jobId, tokenFrom(req));
      if (job.status !== 'completed') throw new ValidationError('JOB_NOT_READY', 'The job is not finished yet.', 409);
      if (!/^\d{1,3}$/.test(req.params.index)) throw new ValidationError('NOT_FOUND', 'Clip not found.', 404);
      const index = Number(req.params.index);
      const { root, name } = jobs.fileFor(job, index);
      const download = req.query.download === '1';
      res.sendFile(name, {
        root,
        dotfiles: 'deny',
        acceptRanges: true,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': download ? `attachment; filename="shortsmaker-clip-${index}.mp4"` : 'inline',
          'Cache-Control': 'private, max-age=300'
        }
      }, (err) => {
        if (err && !res.headersSent) next(new ValidationError('NOT_FOUND', 'Clip not found or expired.', 404));
      });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createShortsRouter };
