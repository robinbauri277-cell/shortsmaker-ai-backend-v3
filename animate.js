'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const jobs = new Map();

const DATA_DIR = path.join(
  process.cwd(),
  'data',
  'animate'
);

fs.mkdirSync(DATA_DIR, {
  recursive: true
});


/* =========================================================
   VEO SETTINGS
========================================================= */

const MIN_DURATION = 60;
const MAX_DURATION = 148;

const INITIAL_SECONDS = 8;
const EXTENSION_SECONDS = 7;
const MAX_EXTENSIONS = 20;


/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeText(value, fallback = '') {
  const v = String(value ?? '').trim();
  return v || fallback;
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
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

function authorized(job, req) {

  const token = tokenFrom(req);

  if (!job || !token) {
    return false;
  }

  const a = Buffer.from(String(job.token));
  const b = Buffer.from(String(token));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function updateJob(job, data) {

  Object.assign(job, data);

  job.updatedAt =
    new Date().toISOString();
}


/* =========================================================
   PUBLIC JOB
========================================================= */

function publicJob(job, req) {

  const base = baseUrl(req);

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

    status: job.status,

    stage: job.stage,

    progress: job.progress,

    prompt: job.prompt,

    style: job.style,

    aspectRatio: job.aspectRatio,

    durationSec: job.durationSec,

    generatedDurationSec:
      job.generatedDurationSec || 0,

    extensionCount:
      job.extensionCount || 0,

    totalExtensions:
      job.totalExtensions || 0,

    videoUrl,

    statusUrl,

    createdAt: job.createdAt,

    updatedAt: job.updatedAt,

    error: job.error || null
  };
}


/* =========================================================
   API
========================================================= */

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

const API_BASE =
  'https://generativelanguage.googleapis.com/v1beta';


/* =========================================================
   GOOGLE REQUEST
========================================================= */

async function googleJson(response) {

  const text =
    await response.text();

  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    throw new Error(
      `Google API returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {

    throw new Error(
      data?.error?.message ||
      data?.message ||
      `Google API error (${response.status}).`
    );
  }

  return data;
}


/* =========================================================
   INITIAL GENERATION
========================================================= */

async function startInitial(
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
    `${API_BASE}/models/` +
    `${encodeURIComponent(model)}` +
    ':predictLongRunning';

  const prompt = [

    'Create the first 8-second segment of a longer continuous animated story.',

    `Animation style: ${job.style}.`,

    `Aspect ratio: ${job.aspectRatio}.`,

    'Keep the main characters visually consistent.',

    'Keep clothing, environment, lighting and colors consistent.',

    'Use smooth cinematic camera movement.',

    'Do not abruptly finish the story.',

    'Make the final moment suitable for seamless video extension.',

    'User story:',

    job.prompt

  ].join(' ');


  updateJob(job, {

    stage:
      'Sending prompt to Veo',

    progress:
      5
  });


  /*
   * IMPORTANT:
   *
   * numberOfVideos REMOVED.
   *
   * durationSeconds is valid for Veo 3.1,
   * but 8 seconds is the required duration
   * for extension workflows.
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
        '720p'

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
    await googleJson(response);


  if (!data?.name) {

    throw new Error(
      'Veo did not return an operation name.'
    );
  }


  updateJob(job, {

    operationName:
      data.name,

    stage:
      'AI is generating the first scene',

    progress:
      10

  });


  return data.name;
}


/* =========================================================
   POLL OPERATION
========================================================= */

async function pollOperation(
  operationName,
  apiKey,
  job,
  startProgress,
  endProgress,
  stage
) {

  const url =
    `${API_BASE}/` +
    operationName.replace(/^\/+/, '');

  const started =
    Date.now();

  const maxWait =
    20 * 60 * 1000;


  while (true) {

    if (
      Date.now() - started >
      maxWait
    ) {

      throw new Error(
        'Veo generation timed out.'
      );
    }


    await sleep(8000);


    const response =
      await fetch(
        url,
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
      await googleJson(response);


    if (data.done === true) {

      if (data.error) {

        throw new Error(
          data.error.message ||
          'Veo generation failed.'
        );
      }

      return data;
    }


    const elapsed =
      Date.now() - started;

    const ratio =
      Math.min(
        elapsed /
        (8 * 60 * 1000),
        1
      );

    const progress =
      Math.round(
        startProgress +
        (
          (endProgress - startProgress) *
          ratio
        )
      );


    updateJob(job, {

      stage,

      progress

    });

  }
}


/* =========================================================
   EXTRACT VIDEO URI
========================================================= */

function videoUri(operation) {

  return (
    operation
      ?.response
      ?.generateVideoResponse
      ?.generatedSamples?.[0]
      ?.video
      ?.uri
  ) || '';
}


/* =========================================================
   DOWNLOAD VIDEO
========================================================= */

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

    throw new Error(
      `Video download failed (${response.status}).`
    );
  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  if (!buffer.length) {

    throw new Error(
      'Downloaded video is empty.'
    );
  }


  fs.writeFileSync(
    outputPath,
    buffer
  );


  return outputPath;
}


/* =========================================================
   EXTENSION
========================================================= */

async function extendVideo(
  currentPath,
  job,
  config,
  number
) {

  const apiKey =
    getApiKey(config);

  const model =
    getModel(config);


  const videoBuffer =
    fs.readFileSync(
      currentPath
    );


  if (!videoBuffer.length) {

    throw new Error(
      'Previous video file is empty.'
    );
  }


  const base64 =
    videoBuffer.toString('base64');


  const prompt = [

    'Continue this existing Veo-generated video seamlessly.',

    `Animation style: ${job.style}.`,

    'Continue directly from the final moment.',

    'Do not restart the story.',

    'Do not change the main characters.',

    'Keep clothing, environment, lighting and visual style consistent.',

    'Continue the action naturally.',

    'Create a smooth cinematic continuation.',

    'Original story:',

    job.prompt

  ].join(' ');


  const endpoint =
    `${API_BASE}/models/` +
    `${encodeURIComponent(model)}` +
    ':predictLongRunning';


  /*
   * IMPORTANT FIX:
   *
   * numberOfVideos REMOVED.
   *
   * durationSeconds REMOVED from extension.
   *
   * Extension uses the Veo video input and
   * 720p resolution.
   */

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

      resolution:
        '720p'

    }

  };


  updateJob(job, {

    stage:
      `Preparing extension ${number}/${job.totalExtensions}`,

    progress:
      extensionProgress(
        number,
        job.totalExtensions,
        25,
        80
      )

  });


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
    await googleJson(response);


  if (!data?.name) {

    throw new Error(
      `Veo extension ${number} did not return an operation.`
    );
  }


  const operation =
    await pollOperation(

      data.name,

      apiKey,

      job,

      extensionProgress(
        number,
        job.totalExtensions,
        25,
        60
      ),

      extensionProgress(
        number,
        job.totalExtensions,
        25,
        82
      ),

      `AI is extending video ${number}/${job.totalExtensions}`

    );


  const uri =
    videoUri(operation);


  if (!uri) {

    throw new Error(
      `Veo extension ${number} returned no video.`
    );
  }


  const nextPath =
    path.join(
      DATA_DIR,
      `${job.id}-ext-${number}.mp4`
    );


  await downloadVideo(
    uri,
    apiKey,
    nextPath
  );


  if (
    currentPath !== nextPath &&
    fs.existsSync(currentPath)
  ) {

    try {
      fs.unlinkSync(currentPath);
    } catch (_) {}

  }


  return nextPath;
}


/* =========================================================
   PROGRESS
========================================================= */

function extensionProgress(
  number,
  total,
  start,
  end
) {

  if (!total) {
    return end;
  }

  return Math.round(
    start +
    (
      (end - start) *
      (number / total)
    )
  );
}


/* =========================================================
   FINAL FFMPEG
========================================================= */

async function finalizeVideo(
  input,
  output,
  duration,
  job
) {

  updateJob(job, {

    stage:
      'Finalizing video',

    progress:
      90

  });


  const args = [

    '-y',

    '-i',
    input,

    '-t',
    String(duration),

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

    output

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

    throw new Error(
      (
        error?.stderr ||
        error?.message ||
        'FFmpeg finalization failed.'
      ).slice(-2000)
    );

  }


  if (
    !fs.existsSync(output)
  ) {

    throw new Error(
      'Final video was not created.'
    );
  }


  const stat =
    fs.statSync(output);


  if (stat.size < 1000) {

    throw new Error(
      'Final video file is invalid.'
    );
  }


  if (
    input !== output &&
    fs.existsSync(input)
  ) {

    try {
      fs.unlinkSync(input);
    } catch (_) {}

  }


  updateJob(job, {

    stage:
      'Video ready',

    progress:
      100,

    outputPath:
      output,

    fileSize:
      stat.size,

    generatedDurationSec:
      duration

  });

}


/* =========================================================
   NUMBER OF EXTENSIONS
========================================================= */

function requiredExtensions(duration) {

  if (
    duration <= INITIAL_SECONDS
  ) {

    return 0;
  }

  return Math.ceil(
    (
      duration -
      INITIAL_SECONDS
    ) /
    EXTENSION_SECONDS
  );
}


/* =========================================================
   PROCESS
========================================================= */

async function processAnimation(
  job,
  config
) {

  const apiKey =
    getApiKey(config);


  if (!apiKey) {

    throw new Error(
      'GEMINI_API_KEY is not configured.'
    );
  }


  /*
   * FIRST 8 SECOND VIDEO
   */

  const operation =
    await startInitial(
      job,
      config
    );


  const result =
    await pollOperation(

      operation,

      apiKey,

      job,

      10,

      22,

      'AI is generating the first scene'

    );


  const uri =
    videoUri(result);


  if (!uri) {

    throw new Error(
      'Initial Veo generation returned no video.'
    );
  }


  let currentPath =
    path.join(
      DATA_DIR,
      `${job.id}-initial.mp4`
    );


  await downloadVideo(
    uri,
    apiKey,
    currentPath
  );


  job.generatedDurationSec =
    INITIAL_SECONDS;


  updateJob(job, {

    stage:
      'First scene ready',

    progress:
      22

  });


  /*
   * EXTENSIONS
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


    job.extensionCount =
      i;


    job.generatedDurationSec =
      INITIAL_SECONDS +
      (
        i *
        EXTENSION_SECONDS
      );


    updateJob(job, {

      stage:
        `Extended to approximately ${job.generatedDurationSec}s`,

      progress:
        extensionProgress(
          i,
          job.totalExtensions,
          25,
          85
        )

    });

  }


  /*
   * FINAL EXACT DURATION
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


/* =========================================================
   ROUTER
========================================================= */

function createAnimateRouter({ config }) {

  const router =
    express.Router();


  /* -------------------------------------------------------
     GENERATE
  ------------------------------------------------------- */

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
              `Maximum video duration is ${MAX_DURATION} seconds.`

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


        const styles = [

          '3D Animation',
          '2D Cartoon',
          'Anime',
          'Storybook',
          'Cinematic'

        ];


        const safeStyle =
          styles.includes(style)
            ? style
            : '3D Animation';


        const totalExtensions =
          requiredExtensions(
            durationSec
          );


        if (
          totalExtensions >
          MAX_EXTENSIONS
        ) {

          return res.status(400).json({

            error:
              'Requested duration is above the supported Veo extension limit.'

          });

        }


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
            `[ANIMATE] ${job.id}:`,
            error
          );


          updateJob(job, {
