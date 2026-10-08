'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const jobs = new Map();

const DATA_DIR = path.join(process.cwd(), 'data', 'animate');
fs.mkdirSync(DATA_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function safeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function baseUrl(req) {
  const configured =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL;

  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const proto =
    req.headers['x-forwarded-proto'] ||
    req.protocol ||
    'https';

  const host =
    req.headers['x-forwarded-host'] ||
    req.get('host');

  return `${proto}://${host}`;
}

function publicJob(job, req) {
  const base = baseUrl(req);

  // IMPORTANT:
  // videoUrl is returned immediately so the current
  // Blogger frontend can extract the token from it.
  const videoUrl =
    `${base}/api/animate/video/${encodeURIComponent(job.id)}` +
    `?token=${encodeURIComponent(job.token)}`;

  const statusUrl =
    `${base}/api/animate/status/${encodeURIComponent(job.id)}` +
    `?token=${encodeURIComponent(job.token)}`;

  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    prompt: job.prompt,
    style: job.style,
    aspectRatio: job.aspectRatio,
    durationSec: job.durationSec,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,

    // Available immediately.
    videoUrl,
    statusUrl
  };
}

function tokenFrom(req) {
  return safeText(
    req.headers['x-job-token'] ||
    req.query.token ||
    ''
  );
}

function isAuthorized(job, req) {
  const token = tokenFrom(req);

  if (!job || !token) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(String(job.token)),
    Buffer.from(String(token))
  );
}

function updateJob(job, patch) {
  Object.assign(job, patch, {
    updatedAt: new Date().toISOString()
  });
}

async function startVeoJob(job, config) {
  const apiKey = safeText(
    config?.geminiApiKey ||
    process.env.GEMINI_API_KEY ||
    ''
  );

  const model = safeText(
    config?.veoModel ||
    process.env.VEO_MODEL ||
    'veo-3.1-generate-preview'
  );

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  updateJob(job, {
    status: 'processing',
    stage: 'Starting AI',
    progress: 5
  });

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:predictLongRunning`;

  /*
   * Keep the prompt useful for animation.
   */
  const finalPrompt = [
    job.style
      ? `Create this as a ${job.style} animation.`
      : '',
    job.aspectRatio === '9:16'
      ? 'Use a vertical portrait composition, 9:16.'
      : 'Use a horizontal landscape composition, 16:9.',
    'Create a coherent animated video with smooth motion, consistent characters and objects, cinematic composition, detailed visuals and natural movement.',
    job.prompt
  ]
    .filter(Boolean)
    .join(' ');

  updateJob(job, {
    stage: 'Sending prompt to Veo',
    progress: 10
  });

  const body = {
    instances: [
      {
        prompt: finalPrompt
      }
    ],
    parameters: {
      aspectRatio: job.aspectRatio,
      resolution: '720p',
      numberOfVideos: 1
    }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Veo returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `Veo API error (${response.status}).`;

    throw new Error(message);
  }

  const operationName = data?.name;

  if (!operationName) {
    throw new Error(
      'Veo did not return an operation name.'
    );
  }

  updateJob(job, {
    operationName,
    stage: 'AI is generating video',
    progress: 15
  });

  const pollUrl =
    `https://generativelanguage.googleapis.com/v1beta/` +
    operationName.replace(/^\/+/, '');

  const startedAt = Date.now();

  // Maximum ~15 minutes.
  const MAX_WAIT = 15 * 60 * 1000;

  while (true) {
    if (Date.now() - startedAt > MAX_WAIT) {
      throw new Error(
        'Video generation timed out. Please try again.'
      );
    }

    await sleep(8000);

    const pollResponse = await fetch(pollUrl, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey
      }
    });

    const pollText = await pollResponse.text();

    let operation;

    try {
      operation = JSON.parse(pollText);
    } catch {
      throw new Error(
        `Veo status response was invalid (${pollResponse.status}).`
      );
    }

    if (!pollResponse.ok) {
      const message =
        operation?.error?.message ||
        `Veo polling failed (${pollResponse.status}).`;

      throw new Error(message);
    }

    if (operation.done === true) {
      /*
       * Google Veo REST response:
       *
       * response
       *   .generateVideoResponse
       *   .generatedSamples[0]
       *   .video
       *   .uri
       */
      if (operation.error) {
        throw new Error(
          operation.error.message ||
          'Veo generation failed.'
        );
      }

      const videoUri =
        operation?.response
          ?.generateVideoResponse
          ?.generatedSamples?.[0]
          ?.video?.uri;

      if (!videoUri) {
        throw new Error(
          'Veo completed but no video URL was returned.'
        );
      }

      updateJob(job, {
        stage: 'Downloading generated video',
        progress: 90
      });

      const videoResponse = await fetch(videoUri, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey
        }
      });

      if (!videoResponse.ok) {
        throw new Error(
          `Generated video download failed (${videoResponse.status}).`
        );
      }

      const outputPath =
        path.join(DATA_DIR, `${job.id}.mp4`);

      const buffer =
        Buffer.from(await videoResponse.arrayBuffer());

      if (!buffer.length) {
        throw new Error(
          'Generated video file is empty.'
        );
      }

      fs.writeFileSync(outputPath, buffer);

      updateJob(job, {
        status: 'completed',
        stage: 'Video ready',
        progress: 100,
        outputPath,
        fileSize: buffer.length
      });

      return;
    }

    /*
     * Operation is still running.
     * Veo does not necessarily provide a precise percentage,
     * so we show a smooth approximate progress indicator.
     */
    const elapsed = Date.now() - startedAt;

    let progress = 20;

    if (elapsed > 20 * 1000) progress = 30;
    if (elapsed > 40 * 1000) progress = 40;
    if (elapsed > 60 * 1000) progress = 50;
    if (elapsed > 90 * 1000) progress = 60;
    if (elapsed > 120 * 1000) progress = 68;
    if (elapsed > 180 * 1000) progress = 75;
    if (elapsed > 240 * 1000) progress = 82;

    updateJob(job, {
      stage: 'AI is generating video',
      progress
    });
  }
}

function createAnimateRouter({ config }) {
  const router = express.Router();

  /*
   * POST /api/animate/generate
   */
  router.post('/generate', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const prompt = safeText(req.body?.prompt);

      const style =
        safeText(
          req.body?.style,
          '3D Animation'
        ) || '3D Animation';

      const aspectRatio =
        safeText(
          req.body?.aspectRatio,
          '9:16'
        ) || '9:16';

      if (!prompt) {
        return res.status(400).json({
          error: 'Prompt is required.'
        });
      }

      if (prompt.length > 2000) {
        return res.status(400).json({
          error: 'Prompt is too long. Maximum 2000 characters.'
        });
      }

      if (!['9:16', '16:9'].includes(aspectRatio)) {
        return res.status(400).json({
          error: 'Invalid aspect ratio.'
        });
      }

      const id =
        `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;

      const token = makeToken();

      const job = {
        id,
        token,

        status: 'queued',
        stage: 'Starting AI',
        progress: 1,

        prompt,
        style,
        aspectRatio,

        // Veo 3.1 generates 8-second videos.
        durationSec: 8,

        operationName: null,
        outputPath: null,
        fileSize: 0,
        error: null,

        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      jobs.set(id, job);

      /*
       * Start processing without blocking the HTTP response.
       */
      startVeoJob(job, config).catch(error => {
        console.error(
          `[ANIMATE] Job ${job.id} failed:`,
          error
        );

        updateJob(job, {
          status: 'failed',
          stage: 'Generation failed',
          progress: 100,
          error:
            error?.message ||
            'Video generation failed.'
        });
      });

      /*
       * IMPORTANT FIX:
       * Return videoUrl immediately.
       *
       * The existing Blogger frontend expects:
       * data.jobId
       * data.videoUrl
       *
       * It extracts the token from videoUrl.
       */
      return res.status(202).json(
        publicJob(job, req)
      );

    } catch (error) {
      console.error(
        '[ANIMATE] Generate request failed:',
        error
      );

      return res.status(500).json({
        error:
          error?.message ||
          'Unable to start animation generation.'
      });
    }
  });

  /*
   * GET /api/animate/status/:jobId
   */
  router.get('/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: 'Animation job not found.'
      });
    }

    if (!isAuthorized(job, req)) {
      return res.status(403).json({
        error: 'Invalid job token.'
      });
    }

    const result = publicJob(job, req);

    if (job.error) {
      result.error = job.error;
    }

    return res.json(result);
  });

  /*
   * GET /api/animate/video/:jobId
   */
  router.get('/video/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: 'Animation job not found.'
      });
    }

    if (!isAuthorized(job, req)) {
      return res.status(403).json({
        error: 'Invalid job token.'
      });
    }

    if (job.status !== 'completed' || !job.outputPath) {
      return res.status(409).json({
        error: 'Video is not ready yet.',
        status: job.status,
        stage: job.stage,
        progress: job.progress
      });
    }

    if (!fs.existsSync(job.outputPath)) {
      return res.status(404).json({
        error: 'Generated video file is no longer available.'
      });
    }

    res.setHeader(
      'Content-Type',
      'video/mp4'
    );

    res.setHeader(
      'Content-Disposition',
      `inline; filename="animato-${job.id}.mp4"`
    );

    res.setHeader(
      'Cache-Control',
      'private, max-age=3600'
    );

    return res.sendFile(
      path.resolve(job.outputPath)
    );
  });

  /*
   * GET /api/animate/health
   */
  router.get('/health', (req, res) => {
    return res.json({
      status: 'ok',
      feature: 'prompt-animation',
      model:
        safeText(
          config?.veoModel ||
          process.env.VEO_MODEL ||
          'veo-3.1-generate-preview'
        ),
      jobs: jobs.size
    });
  });

  return router;
}

module.exports = {
  createAnimateRouter
};