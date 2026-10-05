'use strict';

const fs = require('fs');
const path = require('path');

const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} = require('@google/genai');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const map = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.m4v': 'video/x-m4v'
  };

  return map[ext] || 'video/mp4';
}

function parseJson(text) {
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    const cleaned = String(text)
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (_) {
      throw new Error('Gemini returned invalid JSON.');
    }
  }
}

function normalizeHighlights(
  value,
  durationSec,
  requestedCount,
  requestedDuration
) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(value?.highlights)
      ? value.highlights
      : [];

  const cleaned = [];

  for (const item of list) {
    let start = Number(item.startSec);
    let duration = Number(item.durationSec);
    let score = Number(item.score);

    if (!Number.isFinite(start)) {
      continue;
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      duration = requestedDuration;
    }

    if (!Number.isFinite(score)) {
      score = 0.5;
    }

    start = clamp(
      start,
      0,
      Math.max(0, durationSec - 1)
    );

    duration = clamp(
      duration,
      1,
      Math.min(
        requestedDuration,
        durationSec - start
      )
    );

    if (
      duration < 1 ||
      start >= durationSec
    ) {
      continue;
    }

    cleaned.push({
      startSec: Math.round(start * 100) / 100,

      durationSec: Math.round(
        duration * 100
      ) / 100,

      score: Math.round(
        clamp(score, 0, 1) * 100
      ) / 100,

      reason: String(
        item.reason || 'Strong highlight'
      ).slice(0, 300)
    });
  }

  cleaned.sort(
    (a, b) => b.score - a.score
  );

  const selected = [];

  for (const clip of cleaned) {
    const clipStart = clip.startSec;

    const clipEnd =
      clip.startSec +
      clip.durationSec;

    let overlaps = false;

    for (const existing of selected) {
      const existingStart =
        existing.startSec;

      const existingEnd =
        existing.startSec +
        existing.durationSec;

      const intersection = Math.max(
        0,
        Math.min(
          clipEnd,
          existingEnd
        ) -
        Math.max(
          clipStart,
          existingStart
        )
      );

      const shorter = Math.min(
        clip.durationSec,
        existing.durationSec
      );

      if (
        shorter > 0 &&
        intersection / shorter > 0.55
      ) {
        overlaps = true;
        break;
      }
    }

    if (!overlaps) {
      selected.push(clip);
    }

    if (
      selected.length >= requestedCount
    ) {
      break;
    }
  }

  if (
    selected.length < requestedCount
  ) {
    for (const clip of cleaned) {
      if (
        selected.length >= requestedCount
      ) {
        break;
      }

      if (!selected.includes(clip)) {
        selected.push(clip);
      }
    }
  }

  selected.sort(
    (a, b) => a.startSec - b.startSec
  );

  return selected.slice(
    0,
    requestedCount
  );
}

function createAIHighlights(
  cfg,
  logger = console
) {
  if (!cfg || !cfg.geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured.'
    );
  }

  const ai = new GoogleGenAI({
    apiKey: cfg.geminiApiKey
  });

  const model =
    cfg.geminiModel ||
    'gemini-3.7-flash';

  async function analyzeVideo({
    inputPath,
    durationSec,
    clipCount = 3,
    clipDurationSec = 30
  }) {
    if (
      !inputPath ||
      !fs.existsSync(inputPath)
    ) {
      throw new Error(
        'Input video file not found.'
      );
    }

    const requestedCount = clamp(
      Number(clipCount) || 3,
      1,
      10
    );

    const requestedDuration = clamp(
      Number(clipDurationSec) || 30,
      5,
      60
    );

    logger.log(
      `[ai] Uploading video to Gemini: ${path.basename(inputPath)}`
    );

    const file =
      await ai.files.upload({
        file: inputPath,
        config: {
          mimeType:
            getMimeType(inputPath)
        }
      });

    if (!file || !file.uri) {
      throw new Error(
        'Gemini file upload failed.'
      );
    }

    logger.log(
      `[ai] Gemini file uploaded: ${
        file.name || file.uri
      }`
    );

    let currentFile = file;

    /*
     * Gemini video processing check.
     * Faster polling: every 2 seconds.
     */
    for (
      let attempt = 0;
      attempt < 60;
      attempt++
    ) {
      const state =
        currentFile.state;

      const stateName =
        typeof state === 'string'
          ? state
          : state?.name;

      if (stateName === 'ACTIVE') {
        break;
      }

      if (
        stateName === 'FAILED' ||
        stateName === 'ERROR'
      ) {
        throw new Error(
          'Gemini failed to process the uploaded video.'
        );
      }

      logger.log(
        `[ai] Waiting for Gemini video processing... state=${
          stateName || 'PROCESSING'
        }`
      );

      // Faster polling
      await sleep(2000);

      currentFile =
        await ai.files.get({
          name: currentFile.name
        });
    }

    const finalState =
      currentFile.state;

    const finalStateName =
      typeof finalState === 'string'
        ? finalState
        : finalState?.name;

    if (
      finalStateName !== 'ACTIVE'
    ) {
      throw new Error(
        'Gemini video processing timed out.'
      );
    }

    const prompt = `
You are the highlight-selection engine for ShortsMaker AI.

Analyze the uploaded video and select the strongest moments that can work as short-form vertical videos.

Video duration:
${durationSec} seconds.

Select up to ${requestedCount} independent highlights.

Target duration for each highlight:
${requestedDuration} seconds.

Selection priorities:

1. Strong hook or attention-grabbing opening.
2. Interesting, emotional, surprising, useful, funny, dramatic, or highly engaging moment.
3. Clear context so the clip makes sense by itself.
4. Avoid dead air, silence, greetings, repetitive sections, advertisements, long introductions, and weak moments.
5. Avoid selecting the same moment more than once.
6. Prefer moments that could perform well as YouTube Shorts, Instagram Reels, or TikTok.
7. Keep every highlight inside the actual video duration.
8. Do not invent events that are not present in the video.
9. Prefer natural beginning and ending points.
10. Prioritize audience retention potential.

For every selected highlight return:

- startSec: exact starting time in seconds
- durationSec: clip duration in seconds
- score: quality/viral potential from 0 to 1
- reason: short explanation of why the moment is strong

Return ONLY the requested JSON structure.
`;

    /*
     * Detect temporary Gemini errors.
     */
    function isRetryableGeminiError(error) {
      const status = Number(
        error?.status ||
        error?.code ||
        error?.error?.code
      );

      const message = String(
        error?.message ||
        error?.error?.message ||
        error
      ).toLowerCase();

      return (
        status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        message.includes('high demand') ||
        message.includes('temporarily unavailable') ||
        message.includes('unavailable') ||
        message.includes('rate limit') ||
        message.includes('resource exhausted')
      );
    }

    /*
     * IMPORTANT:
     * No long retry delays.
     *
     * If Gemini returns a temporary 503/429/etc.,
     * immediately let the fallback model handle it.
     */
    async function requestHighlights(
      activeModel
    ) {
      logger.log(
        `[ai] Asking ${activeModel} to find highlights`
      );

      try {
        const response =
          await ai.models.generateContent({
            model: activeModel,

            contents:
              createUserContent([
                createPartFromUri(
                  currentFile.uri,
                  currentFile.mimeType ||
                    getMimeType(inputPath)
                ),

                prompt
              ]),

            config: {
              responseMimeType:
                'application/json',

              responseSchema: {
                type: 'array',

                items: {
                  type: 'object',

                  properties: {
                    startSec: {
                      type: 'number'
                    },

                    durationSec: {
                      type: 'number'
                    },

                    score: {
                      type: 'number'
                    },

                    reason: {
                      type: 'string'
                    }
                  },

                  required: [
                    'startSec',
                    'durationSec',
                    'score',
                    'reason'
                  ]
                }
              },

              temperature: 0.2
            }
          });

        return response;

      } catch (error) {
        logger.error(
          `[ai] Gemini error on ${activeModel}: ${
            error?.message || error
          }`
        );

        /*
         * Do NOT wait here.
         * The caller will immediately switch
         * to the fallback model.
         */
        if (
          isRetryableGeminiError(error)
        ) {
          logger.warn(
            `[ai] ${activeModel} temporarily unavailable. Switching to fallback immediately.`
          );
        }

        throw error;
      }
    }

    let response;

    try {
      response =
        await requestHighlights(model);

    } catch (primaryError) {
      const fallbackModel =
        process.env.GEMINI_FALLBACK_MODEL ||
        'gemini-3.5-flash-lite';

      if (
        fallbackModel &&
        fallbackModel !== model &&
        isRetryableGeminiError(
          primaryError
        )
      ) {
        logger.warn(
          `[ai] Trying fallback model immediately: ${fallbackModel}`
        );

        response =
          await requestHighlights(
            fallbackModel
          );

      } else {
        throw primaryError;
      }
    }

    const raw =
      response.text;

    const parsed =
      parseJson(raw);

    const highlights =
      normalizeHighlights(
        parsed,
        Number(durationSec),
        requestedCount,
        requestedDuration
      );

    if (!highlights.length) {
      throw new Error(
        'Gemini did not return usable highlights.'
      );
    }

    logger.log(
      `[ai] Selected ${highlights.length} highlight(s)`
    );

    return highlights;
  }

  return {
    analyzeVideo
  };
}

module.exports = {
  createAIHighlights
};
