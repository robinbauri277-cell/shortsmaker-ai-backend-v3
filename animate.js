'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const jobs = new Map();

const DATA_DIR =
  path.join(process.cwd(), 'data', 'animate');

fs.mkdirSync(DATA_DIR, {
  recursive: true
});


/*
 * Veo 3.1:
 *
 * Initial generation = 8 seconds
 * Each extension = +7 seconds
 * Maximum extension count = 20
 * Maximum final duration = 148 seconds
 *
 * User requirement:
 * Minimum = 60 seconds
 */

const INITIAL_DURATION = 8;
const EXTENSION_SECONDS = 7;
const MAX_EXTENSIONS = 20;
const MAX_DURATION = 148;
const MIN_DURATION = 60;


/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}


function safeText(value, fallback = '') {
  const text =
    String(value ?? fallback).trim();

  return text || fallback;
}


function makeToken() {
  return crypto
    .randomBytes(32)
    .toString('hex');
}


function clamp(value, min, max) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(
    min,
    Math.min(max, number)
  );
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


function tokenFrom(req) {

  return safeText(
    req.headers['x-job-token'] ||
    req.query.token ||
    ''
  );
}


function isAuthorized(job, req) {

  const token =
    tokenFrom(req);

  if (!job || !token) {
    return false;
  }

  const a =
    Buffer.from(String(job.token));

  const b =
    Buffer.from(String(token));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}


function updateJob(job, patch) {

  Object.assign(
    job,
    patch,
    {
      updatedAt:
        new Date().toISOString()
    }
  );
}


/*
 * ============================================================
 * PUBLIC JOB RESPONSE
 * ============================================================
 */

function publicJob(job, req) {

  const base =
    baseUrl(req);

  const videoUrl =
    `${base}/api/animate/video/` +
    `${encodeURIComponent(job.id)}` +
    `?token=${encodeURIComponent(job.token)}`;

  const statusUrl =
    `${base}/api/animate/status/` +
    `${encodeURIComponent(job.id)}` +
    `?token=${encodeURIComponent(job.token)}`;

  return {

    jobId: job.id,

    status:
      job.status,

    stage:
      job.stage,

    progress:
      job.progress,

    prompt:
      job.prompt,

    style:
      job.style,

    aspectRatio:
      job.aspectRatio,

    durationSec:
      job.durationSec,

    generatedDurationSec:
      job.generatedDurationSec || 0,

    extensionCount:
      job.extensionCount || 0,

    totalExtensions:
      job.totalExtensions || 0,

    createdAt:
      job.createdAt,

    updatedAt:
      job.updatedAt,

    /*
     * IMPORTANT:
     * Frontend receives this immediately.
     */
    videoUrl,

    statusUrl,

    error:
      job.error || null
  };
}


/*
 * ============================================================
 * API KEY / MODEL
 * ============================================================
 */

function getApiKey(config) {

  return safeText(
    config?.geminiApiKey ||
    process.env.GEMINI_API_KEY ||
    ''
  );
}


function getModel(config) {

  return safeText(
    config?.veoModel ||
    process.env.VEO_MODEL ||
    'veo-3.1-generate-preview'
  );
}


/*
 * ============================================================
 * GEMINI / VEO API
 * ============================================================
 */

const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta';


function generationEndpoint(model) {

  return (
    `${GEMINI_BASE}/models/` +
    `${encodeURIComponent(model)}` +
    ':predictLongRunning'
  );
}


/*
 * ============================================================
 * READ JSON RESPONSE
 * ============================================================
 */

async function readJsonResponse(response) {

  const text =
    await response.text();

  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch (error) {

    throw new Error(
      `Google API returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {

    const message =
      data?.error?.message ||
      data?.message ||
      `Google API request failed (${response.status}).`;

    throw new Error(message);
  }

  return data;
}


/*
 * ============================================================
 * START INITIAL VEO GENERATION
 * ============================================================
 */

async function startInitialGeneration(
  job,
  config
) {

  const apiKey =
    getApiKey(config);

  const model =
    getModel(config);

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured.'
    );
  }


  const endpoint =
    generationEndpoint(model);


  const prompt =
    buildInitialPrompt(job);


  updateJob(job, {

    stage:
      'Sending prompt to Veo',

    progress:
      5
  });


  /*
   * Veo 3.1 initial generation.
   *
   * Always 8 seconds because this video will
   * be used as the source for extension.
   */

  const body = {

    instances: [

      {
        prompt
      }

    ],

    parameters: {

      aspectRatio:
        job.aspectRatio,

      durationSeconds:
        '8',

      resolution:
        '720p',

      numberOfVideos:
        1
    }

  };


  const response =
    await fetch(
      endpoint,
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/json',

          'x-goog-api-key':
            apiKey
        },

        body:
          JSON.stringify(body)
      }
    );


  const data =
    await readJsonResponse(response);


  const operationName =
    data?.name;


  if (!operationName) {

    throw new Error(
      'Veo did not return an operation name.'
    );
  }


  updateJob(job, {

    operationName,

    stage:
      'AI is generating the first scene',

    progress:
      10
  });


  return operationName;
}


/*
 * ============================================================
 * POLL VEO OPERATION
 * ============================================================
 */

async function pollOperation(
  operationName,
  apiKey,
  job,
  progressStart,
  progressEnd,
  stage
) {

  const pollUrl =
    `${GEMINI_BASE}/` +
    operationName.replace(/^\/+/, '');


  const startedAt =
    Date.now();


  /*
   * Long-running generation can take time.
   * Allow up to 20 minutes per Veo operation.
   */

  const MAX_WAIT =
    20 * 60 * 1000;


  while (true) {

    if (
      Date.now() - startedAt >
      MAX_WAIT
    ) {

      throw new Error(
        'Veo generation timed out.'
      );
    }


    await sleep(8000);


    const response =
      await fetch(
        pollUrl,
        {

          method:
            'GET',

          headers: {

            'x-goog-api-key':
              apiKey
          }
        }
      );


    const data =
      await readJsonResponse(response);


    if (data.done === true) {

      if (data.error) {

        throw new Error(
          data.error.message ||
          'Veo generation failed.'
        );
      }


      return data;
    }


    /*
     * Smooth approximate progress.
     */

    const elapsed =
      Date.now() - startedAt;


    const ratio =
      Math.min(
        elapsed / (8 * 60 * 1000),
        1
      );


    const progress =
      Math.round(
        progressStart +
        (
          (progressEnd - progressStart) *
          ratio
        )
      );


    updateJob(job, {

      stage,

      progress
    });
  }
}


/*
 * ============================================================
 * EXTRACT VIDEO URI
 * ============================================================
 */

function extractVideoUri(operation) {

  /*
   * Current REST response format.
   */

  const uri =
    operation
      ?.response
      ?.generateVideoResponse
      ?.generatedSamples?.[0]
      ?.video
      ?.uri;


  if (uri) {
    return uri;
  }


  /*
   * Compatibility with alternate response shape.
   */

  const alternate =
    operation
      ?.response
      ?.generatedVideos?.[0]
      ?.video
      ?.uri;


  return alternate || '';
}


/*
 * ============================================================
 * DOWNLOAD VEO VIDEO
 * ============================================================
 */

async function downloadVideo(
  uri,
  apiKey,
  outputPath
) {

  if (!uri) {

    throw new Error(
      'Veo did not return a video URL.'
    );
  }


  const response =
    await fetch(
      uri,
      {

        method:
          'GET',

        headers: {

          'x-goog-api-key':
            apiKey
        }
      }
    );


  if (!response.ok) {

    const text =
      await response.text()
        .catch(() => '');

    throw new Error(
      `Video download failed (${response.status})` +
      (text ? `: ${text.slice(0, 300)}` : '')
    );
  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  if (!buffer.length) {

    throw new Error(
      'Downloaded Veo video is empty.'
    );
  }


  fs.writeFileSync(
    outputPath,
    buffer
  );


  return outputPath;
}


/*
 * ============================================================
 * BUILD INITIAL PROMPT
 * ============================================================
 */

function buildInitialPrompt(job) {

  const style =
    job.style ||
    '3D Animation';


  const ratioInstruction =
    job.aspectRatio === '9:16'
      ? 'portrait vertical 9:16 composition'
      : 'landscape horizontal 16:9 composition';


  return [

    `Create the opening 8-second segment of a longer animated story.`,

    `Style: ${style}.`,

    `Format: ${ratioInstruction}.`,

    `The story must be visually coherent and suitable for continuation.`,

    `Keep characters, clothing, environment, lighting, colors and objects consistent.`,

    `Use smooth cinematic camera movement and natural motion.`,

    `Do not end the story abruptly.`,

    `Create a visually clear ending moment that can naturally continue into the next segment.`,

    `Story / user request:`,

    job.prompt

  ].join(' ');
}


/*
 * ============================================================
 * BUILD EXTENSION PROMPT
 * ============================================================
 */

function buildExtensionPrompt(job) {

  const style =
    job.style ||
    '3D Animation';


  return [

    `Continue this existing animated video seamlessly.`,

    `Style: ${style}.`,

    `Continue directly from the final moment of the input video.`,

    `Do not restart the story.`,

    `Do not introduce an unrelated scene.`,

    `Maintain exactly the same main characters, appearance, clothing, environment, lighting, color palette and visual style.`,

    `Keep camera movement natural and cinematic.`,

    `Continue the story and action smoothly for the next 7 seconds.`,

    `The final result should feel like one continuous long video.`,

    `Original story:`,

    job.prompt

  ].join(' ');
}


/*
 * ============================================================
 * EXTEND CURRENT VIDEO
 * ============================================================
 */

async function extendVideo(
  currentVideoPath,
  job,
  config,
  extensionNumber
) {

  const apiKey =
    getApiKey(config);

  const model =
    getModel(config);


  /*
   * IMPORTANT:
   *
   * We send the exact bytes from the previous
   * Veo generation.
   *
   * We do NOT run FFmpeg between extensions.
   */

  const videoBuffer =
    fs.readFileSync(
      currentVideoPath
    );


  if (!videoBuffer.length) {

    throw new Error(
      'Current Veo video is empty.'
    );
  }


  const base64 =
    videoBuffer.toString('base64');


  const prompt =
    buildExtensionPrompt(job);


  const body = {

    instances: [

      {

        prompt,

        video: {

          inlineData: {

            mimeType:
              'video/mp4',

            data:
              base64
          }

        }

      }

    ],

    parameters: {

      numberOfVideos:
        1,

      resolution:
        '720p',

      /*
       * Extension must use 8 seconds.
       * The API adds approximately 7 seconds
       * to the existing video.
       */

      durationSeconds:
        '8'
    }

  };


  const response =
    await fetch(
      generationEndpoint(model),
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/json',

          'x-goog-api-key':
            apiKey
        },

        body:
          JSON.stringify(body)
      }
    );


  const data =
    await readJsonResponse(response);


  const operationName =
    data?.name;


  if (!operationName) {

    throw new Error(
      `Veo extension ${extensionNumber} did not return an operation name.`
    );
  }


  updateJob(job, {

    operationName,

    stage:
      `Extending video ${extensionNumber}/${job.totalExtensions}`,

    progress:
      calculateExtensionProgress(
        extensionNumber,
        job.totalExtensions,
        25,
        85
      )
  });


  const operation =
    await pollOperation(

      operationName,

      apiKey,

      job,

      calculateExtensionProgress(
        extensionNumber,
        job.totalExtensions,
        25,
        75
      ),

      calculateExtensionProgress(
        extensionNumber,
        job.totalExtensions,
        25,
        85
      ),

      `AI is extending video ${extensionNumber}/${job.totalExtensions}`
    );


  const videoUri =
    extractVideoUri(operation);


  if (!videoUri) {

    throw new Error(
      `Veo extension ${extensionNumber} completed without a video.`
    );
  }


  const nextPath =
    path.join(
      DATA_DIR,
      `${job.id}-extension-${extensionNumber}.mp4`
    );


  await downloadVideo(
    videoUri,
    apiKey,
    nextPath
  );


  /*
   * Remove previous temporary file.
   */

  if (
    currentVideoPath &&
    currentVideoPath !== nextPath &&
    fs.existsSync(currentVideoPath)
  ) {

    try {
      fs.unlinkSync(
        currentVideoPath
      );
    } catch (_) {}

  }


  return nextPath;
}


/*
 * ============================================================
 * PROGRESS CALCULATION
 * ============================================================
 */

function calculateExtensionProgress(
  number,
  total,
  start,
  end
) {

  if (!total) {
    return end;
  }


  const ratio =
    number / total;


  return Math.round(
    start +
    (
      (end - start) *
      ratio
    )
  );
}


/*
 * ============================================================
 * FINAL FFMPEG TRIM
 * ============================================================
 */

async function finalizeVideo(
  inputPath,
  outputPath,
  durationSec,
  job
) {

  updateJob(job, {

    stage:
      'Finalizing video',

    progress:
      90
  });


  /*
   * Re-encode final file so the output duration
   * is properly cut to the requested length.
   *
   * Audio is preserved.
   */

  const args = [

    '-y',

    '-i',
    inputPath,

    '-t',
    String(durationSec),

    '-map',
    '0:v:0',

    '-map',
    '0:a:0?',

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-crf',
    '20',

    '-pix_fmt',
    'yuv420p',

    '-c:a',
    'aac',

    '-b:a',
    '128k',

    '-movflags',
    '+faststart',

    outputPath
  ];


  try {

    await execFileAsync(
      'ffmpeg',
      args,
      {
        maxBuffer:
          10 * 1024 * 1024
      }
    );

  } catch (error) {

    const stderr =
      error?.stderr ||
      error?.message ||
      'FFmpeg finalization failed.';

    throw new Error(
      stderr.slice(-1500)
    );
  }


  if (
    !fs.existsSync(outputPath)
  ) {

    throw new Error(
      'Final video was not created.'
    );
  }


  const stat =
    fs.statSync(outputPath);


  if (stat.size < 1000) {

    throw new Error(
      'Final video file is invalid.'
    );
  }


  /*
   * Remove temporary Veo file.
   */

  if (
    inputPath !== outputPath &&
    fs.existsSync(inputPath)
  ) {

    try {
      fs.unlinkSync(inputPath);
    } catch (_) {}

  }


  updateJob(job, {

    stage:
      'Video ready',

    progress:
      100,

    outputPath,

    fileSize:
      stat.size,

    generatedDurationSec:
      durationSec
  });


  return outputPath;
}


/*
 * ============================================================
 * CALCULATE REQUIRED EXTENSIONS
 * ============================================================
 */

function calculateExtensions(
  durationSec
) {

  if (
    durationSec <=
    INITIAL_DURATION
  ) {

    return 0;
  }


  return Math.ceil(
    (
      durationSec -
      INITIAL_DURATION
    ) /
    EXTENSION_SECONDS
  );
}


/*
 * ============================================================
 * COMPLETE VIDEO GENERATION
 * ============================================================
 */

async function processAnimation(
  job,
  config
) {

  const apiKey =
    getApiKey(config);


  if (!apiKey) {

    throw new Error(
      'GEMINI_API_KEY is not configured on Render.'
    );
  }


  /*
   * 1. Initial 8-second video
   */

  const initialOperation =
    await startInitialGeneration(
      job,
      config
    );


  const initialResult =
    await pollOperation(

      initialOperation,

      apiKey,

      job,

      10,

      22,

      'AI is generating the first scene'
    );


  const initialUri =
    extractVideoUri(
      initialResult
    );


  if (!initialUri) {

    throw new Error(
      'Initial Veo generation completed without a video.'
    );
  }


  let currentPath =
    path.join(
      DATA_DIR,
      `${job.id}-initial.mp4`
    );


  await downloadVideo(
    initialUri,
    apiKey,
    currentPath
  );


  /*
   * Initial generated duration.
   */

  job.generatedDurationSec =
    INITIAL_DURATION;


  updateJob(job, {

    stage:
      'First scene ready',

    progress:
      22
  });


  /*
   * 2. Extend until enough duration exists.
   */

  for (
    let i = 1;
    i <= job.totalExtensions;
    i++
  ) {

    currentPath =
      await extendVideo(
        currentPath,
        job,
        config,
        i
      );


    /*
     * Each extension adds approximately 7 seconds.
     */

    job.extensionCount =
      i;


    job.generatedDurationSec =
      INITIAL_DURATION +
      (
        i *
        EXTENSION_SECONDS
      );


    updateJob(job, {

      stage:
        `Extended to approximately ${job.generatedDurationSec}s`,

      progress:
        calculateExtensionProgress(
          i,
          job.totalExtensions,
          25,
          85
        )
    });
  }


  /*
   * 3. Final exact-duration file.
   */

  const finalPath =
    path.join(
      DATA_DIR,
      `${job.id}.mp4`
    );


  await finalizeVideo(

    currentPath,

    finalPath,

    job.durationSec,

    job
  );
}


/*
 * ============================================================
 * ROUTER
 * ============================================================
 */

function createAnimateRouter({ config }) {

  const router =
    express.Router();


  /*
   * ==========================================================
   * POST /api/animate/generate
   * ==========================================================
   */

  router.post(
    '/generate',
    express.json({
      limit: '64kb'
    }),
    async (req, res) => {

      try {

        const prompt =
          safeText(
            req.body?.prompt
          );


        const style =
          safeText(
            req.body?.style,
            '3D Animation'
          );


        const aspectRatio =
          safeText(
            req.body?.aspectRatio,
            '9:16'
          );


        /*
         * Minimum 60 seconds.
         *
         * Frontend normally sends:
         * 60 / 90 / 120
         *
         * Backend supports 60-148.
         */

        let durationSec =
          Number(
            req.body?.durationSec
          );


        if (
          !Number.isFinite(durationSec)
        ) {

          durationSec =
            60;
        }


        durationSec =
          Math.round(
            durationSec
          );


        if (
          durationSec < MIN_DURATION
        ) {

          return res.status(400).json({

            error:
              `Minimum video duration is ${MIN_DURATION} seconds.`

          });
        }


        if (
          durationSec > MAX_DURATION
        ) {

          return res.status(400).json({

            error:
              `Maximum supported duration is ${MAX_DURATION} seconds.`

          });
        }


        if (!prompt) {

          return res.status(400).json({

            error:
              'Prompt is required.'

          });
        }


        if (
          prompt.length > 2000
        ) {

          return res.status(400).json({

            error:
              'Prompt is too long. Maximum 2000 characters.'

          });
        }


        if (
          !['9:16', '16:9']
            .includes(aspectRatio)
        ) {

          return res.status(400).json({

            error:
              'Invalid aspect ratio.'

          });
        }


        const allowedStyles = [

          '3D Animation',

          '2D Cartoon',

          'Anime',

          'Storybook',

          'Cinematic'

        ];


        const safeStyle =
          allowedStyles.includes(style)
            ? style
            : '3D Animation';


        const totalExtensions =
          calculateExtensions(
            durationSec
          );


        if (
          totalExtensions >
          MAX_EXTENSIONS
        ) {

          return res.status(400).json({

            error:
              'Requested duration requires too many Veo extensions.'

          });
        }


        /*
         * Create job.
         */

        const id =
          `${Date.now().toString(36)}-` +
          `${crypto.randomBytes(8).toString('hex')}`;


        const token =
          makeToken();


        const job = {

          id,

          token,

          status:
            'queued',

          stage:
            'Starting AI',

          progress:
            1,

          prompt,

          style:
            safeStyle,

          aspectRatio,

          durationSec,

          generatedDurationSec:
            0,

          extensionCount:
            0,

          totalExtensions,

          operationName:
            null,

          outputPath:
            null,

          fileSize:
            0,

          error:
            null,

          createdAt:
            new Date().toISOString(),

          updatedAt:
            new Date().toISOString()

        };


        jobs.set(
          id,
          job
        );


        /*
         * Start in background.
         */

        processAnimation(
          job,
          config
        )
          .then(() => {

            updateJob(job, {

              status:
                'completed',

              stage:
                'Video ready',

              progress:
                100

            });

          })
          .catch(error => {

            console.error(
              `[ANIMATE] Job ${job.id} failed:`,
              error
            );


            updateJob(job, {

              status:
                'failed',

              stage:
                'Generation failed',

              progress:
                100,

              error:
                error?.message ||
                'Video generation failed.'

            });

          });


        /*
         * Return immediately.
         *
         * IMPORTANT:
         * videoUrl is present from the beginning
         * so the Blogger frontend can obtain token.
         */

        return res.status(202).json(
          publicJob(
            job,
            req
          )
        );


      } catch (error) {

        console.error(
          '[ANIMATE] Generate error:',
          error
        );


        return res.status(500).json({

          error:
            error?.message ||
            'Unable to start video generation.'

        });

      }

    }
  );


  /*
   * ==========================================================
   * GET /api/animate/status/:jobId
   * ==========================================================
   */

  router.get(
    '/status/:jobId',
    (req, res) => {

      const job =
        jobs.get(
          req.params.jobId
        );


      if (!job) {

        return res.status(404).json({

          error:
            'Animation job not found.'

        });
      }


      if (
        !isAuthorized(
          job,
          req
        )
      ) {

        return res.status(403).json({

          error:
            'Invalid job token.'

        });
      }


      return res.json(
        publicJob(
          job,
          req
        )
      );

    }
  );


  /*
   * ==========================================================
   * GET /api/animate/video/:jobId
   * ==========================================================
   */

  router.get(
    '/video/:jobId',
    (req, res) => {

      const job =
        jobs.get(
          req.params.jobId
        );


      if (!job) {

        return res.status(404).json({

          error:
            'Animation job not found.'

        });
      }


      if (
        !isAuthorized(
          job,
          req
        )
      ) {

        return res.status(403).json({

          error:
            'Invalid job token.'

        });
      }


      if (
        job.status !== 'completed' ||
        !job.outputPath
      ) {

        return res.status(409).json({

          error:
            'Video is not ready yet.',

          status:
            job.status,

          stage:
            job.stage,

          progress:
            job.progress

        });
      }


      if (
        !fs.existsSync(
          job.outputPath
        )
      ) {

        return res.status(404).json({

          error:
            'Generated video file is no longer available.'

        });
      }


      res.setHeader(
        'Content-Type',
        'video/mp4'
      );


      res.setHeader(
        'Content-Disposition',
        `inline; filename="animato-${job.durationSec}s-${job.id}.mp4"`
      );


      res.setHeader(
        'Cache-Control',
        'private, max-age=3600'
      );


      return res.sendFile(
        path.resolve(
          job.outputPath
        )
      );

    }
  );


  /*
   * ==========================================================
   * GET /api/animate/health
   * ==========================================================
   */

  router.get(
    '/health',
    (req, res) => {

      return res.json({

        status:
          'ok',

        feature:
          'prompt-animation',

        model:
          getModel(config),

        minimumDuration:
          MIN_DURATION,

        maximumDuration:
          MAX_DURATION,

        initialClipSeconds:
          INITIAL_DURATION,

        extensionSeconds:
          EXTENSION_SECONDS,

        maxExtensions:
          MAX_EXTENSIONS,

        jobs:
          jobs.size

      });

    }
  );


  return router;
}


/*
 * ============================================================
 * EXPORT
 * ============================================================
 */

module.exports = {
  createAnimateRouter
};