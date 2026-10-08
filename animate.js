'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const jobs = new Map();

function id() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeAspect(value) {
  return ['16:9', '9:16'].includes(value) ? value : '9:16';
}

function buildPrompt(prompt, style) {
  const styles = {
    '2d-cartoon':
      '2D animated cartoon style, expressive characters, smooth animation, colorful professional visuals.',

    '3d-animation':
      'high-quality 3D animated film style, polished characters, cinematic lighting, smooth motion.',

    'anime':
      'high-quality anime animation style, expressive characters, detailed backgrounds, smooth cinematic motion.',

    'storybook':
      'beautiful storybook animation, hand-painted look, gentle character motion, rich illustrated backgrounds.',

    'cinematic':
      'cinematic animated film style, dramatic composition, smooth camera movement, polished visuals.'
  };

  return [
    String(prompt).trim(),
    styles[style] || styles['3d-animation'],
    'Create one coherent short animated scene.',
    'Keep character appearance and environment consistent throughout the video.',
    'No subtitles, no captions, no logos, no watermarks.'
  ].join('\n\n');
}

async function startGeneration({
  apiKey,
  model,
  prompt,
  aspectRatio
}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: 'POST',

      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        instances: [
          {
            prompt
          }
        ],

        parameters: {
          aspectRatio,
          resolution: '720p',
          numberOfVideos: 1
        }
      })
    }
  );

  const body = await response.text();

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      `Video API returned invalid JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok || !data.name) {
    throw new Error(
      data?.error?.message ||
      `Video generation request failed (HTTP ${response.status})`
    );
  }

  return data.name;
}

async function pollGeneration({
  apiKey,
  operationName,
  onProgress
}) {
  for (let i = 0; i < 180; i++) {

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${operationName}`,
      {
        headers: {
          'x-goog-api-key': apiKey
        }
      }
    );

    const body = await response.text();

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(
        'Video API returned invalid status JSON'
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        `Video status failed (HTTP ${response.status})`
      );
    }

    if (data.done) {

      if (data.error) {
        throw new Error(
          data.error.message ||
          'Video generation failed'
        );
      }

      const sample =
        data.response?.generateVideoResponse
          ?.generatedSamples?.[0] ||
        data.response?.generatedVideos?.[0];

      const uri =
        sample?.video?.uri;

      const base64 =
        sample?.video?.inlineData?.data ||
        sample?.video?.videoBytes;

      if (!uri && !base64) {
        throw new Error(
          'Video generation completed but no video was returned'
        );
      }

      return {
        uri,
        base64
      };
    }

    const percent = Number(
      data.metadata?.progressPercent ??
      data.metadata?.progress_percent ??
      0
    );

    onProgress(
      Math.max(
        5,
        Math.min(
          94,
          percent || 5
        )
      )
    );

    await sleep(10000);
  }

  throw new Error(
    'Video generation timed out'
  );
}

async function saveVideo({
  apiKey,
  result,
  output
}) {
  if (result.base64) {

    fs.writeFileSync(
      output,
      Buffer.from(
        result.base64,
        'base64'
      )
    );

    return;
  }

  const response = await fetch(
    result.uri,
    {
      headers: {
        'x-goog-api-key': apiKey
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Video download failed (HTTP ${response.status})`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  fs.writeFileSync(
    output,
    buffer
  );
}

function publicJob(
  job,
  baseUrl
) {
  const result = {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,

    prompt: job.prompt,
    style: job.style,
    aspectRatio: job.aspectRatio,

    durationSec: 8,

    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };

  if (job.status === 'completed') {
    result.videoUrl =
      `${baseUrl}/api/animate/video/${job.id}?token=${job.token}`;
  }

  if (job.status === 'failed') {
    result.error = job.error;
  }

  return result;
}

function createAnimateRouter({
  config
}) {
  const express =
    require('express');

  const router =
    express.Router();

  const dataDir =
    path.resolve(
      config.dataDir,
      'animate'
    );

  fs.mkdirSync(
    dataDir,
    {
      recursive: true
    }
  );

  // ------------------------------------
  // GENERATE
  // ------------------------------------

  router.post(
    '/generate',
    express.json({
      limit: '32kb'
    }),

    async (
      req,
      res
    ) => {

      const apiKey =
        config.geminiApiKey;

      if (!apiKey) {
        return res
          .status(503)
          .json({
            error:
              'Animation generation is not configured. Add GEMINI_API_KEY in Render.',

            code:
              'AI_NOT_CONFIGURED'
          });
      }

      const prompt =
        String(
          req.body?.prompt || ''
        ).trim();

      const style =
        String(
          req.body?.style ||
          '3d-animation'
        );

      const aspectRatio =
        safeAspect(
          req.body?.aspectRatio
        );

      if (prompt.length < 3) {
        return res
          .status(400)
          .json({
            error:
              'Please enter a video prompt.',

            code:
              'PROMPT_REQUIRED'
          });
      }

      if (prompt.length > 2000) {
        return res
          .status(400)
          .json({
            error:
              'Prompt is too long. Maximum 2000 characters.',

            code:
              'PROMPT_TOO_LONG'
          });
      }

      if (jobs.size >= 5) {
        return res
          .status(429)
          .json({
            error:
              'Too many animation jobs are running.',

            code:
              'ANIMATION_QUEUE_FULL'
          });
      }

      const job = {

        id:
          id(),

        token:
          token(),

        prompt,

        style,

        aspectRatio,

        status:
          'queued',

        stage:
          'queued',

        progress:
          0,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString(),

        error:
          null
      };

      jobs.set(
        job.id,
        job
      );

      const baseUrl =
        config.publicBaseUrl ||
        `${req.protocol}://${req.get('host')}`;

      res
        .status(202)
        .json(
          publicJob(
            job,
            baseUrl
          )
        );

      // Background processing
      (async () => {

        const output =
          path.join(
            dataDir,
            `${job.id}.mp4`
          );

        try {

          job.status =
            'processing';

          job.stage =
            'starting';

          job.progress =
            3;

          job.updatedAt =
            new Date().toISOString();

          const operationName =
            await startGeneration({

              apiKey,

              model:
                config.veoModel ||
                'veo-3.1-generate-preview',

              prompt:
                buildPrompt(
                  prompt,
                  style
                ),

              aspectRatio
            });

          job.stage =
            'generating';

          job.progress =
            5;

          job.operationName =
            operationName;

          job.updatedAt =
            new Date().toISOString();

          const result =
            await pollGeneration({

              apiKey,

              operationName,

              onProgress:
                progress => {

                  job.progress =
                    progress;

                  job.updatedAt =
                    new Date().toISOString();
                }
            });

          job.stage =
            'downloading';

          job.progress =
            96;

          await saveVideo({

            apiKey,

            result,

            output
          });

          job.file =
            output;

          job.stage =
            'done';

          job.status =
            'completed';

          job.progress =
            100;

          job.updatedAt =
            new Date().toISOString();

        } catch (error) {

          console.error(
            `[animate ${job.id}] failed:`,
            error.message
          );

          job.status =
            'failed';

          job.stage =
            'failed';

          job.progress =
            0;

          job.error =
            error.message;

          job.updatedAt =
            new Date().toISOString();

          try {

            if (
              fs.existsSync(output)
            ) {
              fs.unlinkSync(output);
            }

          } catch (_) {}
        }

      })();
    }
  );

  // ------------------------------------
  // STATUS
  // ------------------------------------

  router.get(
    '/status/:jobId',
    (
      req,
      res
    ) => {

      const job =
        jobs.get(
          req.params.jobId
        );

      if (
        !job ||
        req.query.token !==
        job.token
      ) {
        return res
          .status(404)
          .json({
            error:
              'Animation job not found.',

            code:
              'JOB_NOT_FOUND'
          });
      }

      res.set(
        'Cache-Control',
        'no-store'
      );

      const baseUrl =
        config.publicBaseUrl ||
        `${req.protocol}://${req.get('host')}`;

      res.json(
        publicJob(
          job,
          baseUrl
        )
      );
    }
  );

  // ------------------------------------
  // VIDEO
  // ------------------------------------

  router.get(
    '/video/:jobId',
    (
      req,
      res
    ) => {

      const job =
        jobs.get(
          req.params.jobId
        );

      if (
        !job ||
        req.query.token !==
        job.token
      ) {
        return res
          .status(404)
          .json({
            error:
              'Video not found.',

            code:
              'VIDEO_NOT_FOUND'
          });
      }

      if (
        job.status !==
          'completed' ||
        !job.file ||
        !fs.existsSync(
          job.file
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Video is not ready yet.',

            code:
              'VIDEO_NOT_READY'
          });
      }

      res.set({
        'Cache-Control':
          'private, max-age=3600',

        'Content-Type':
          'video/mp4',

        'Content-Disposition':
          'inline; filename="animated-video.mp4"'
      });

      res.sendFile(
        job.file
      );
    }
  );

  return router;
}

module.exports = {
  createAnimateRouter
};