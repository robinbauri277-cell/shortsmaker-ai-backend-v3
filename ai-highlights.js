'use strict';

const path = require('path');

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function cleanJson(text) {
  let value = String(text || '').trim();

  if (value.startsWith('```')) {
    value = value
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  return value;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function createAIHighlights(cfg, logger = console) {
  let clientPromise = null;

  async function getClient() {
    if (!cfg.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }

    if (!clientPromise) {
      clientPromise = import('@google/genai').then(
        ({ GoogleGenAI }) =>
          new GoogleGenAI({
            apiKey: cfg.geminiApiKey
          })
      );
    }

    return clientPromise;
  }

  async function analyzeVideo({
    inputPath,
    durationSec,
    clipCount,
    clipDurationSec
  }) {
    const ai = await getClient();

    logger.log(
      '[ai] uploading video for highlight analysis'
    );

    let file = await ai.files.upload({
      file: inputPath,
      config: {
        mimeType: mimeFromPath(inputPath)
      }
    });

    try {
      const maxWaitMs = 8 * 60 * 1000;
      const started = Date.now();

      while (
        !file.state ||
        String(file.state) !== 'ACTIVE'
      ) {
        if (
          Date.now() - started >
          maxWaitMs
        ) {
          throw new Error(
            'Gemini video processing timed out.'
          );
        }

        if (
          String(file.state) === 'FAILED'
        ) {
          throw new Error(
            'Gemini failed to process the video.'
          );
        }

        await sleep(4000);

        file = await ai.files.get({
          name: file.name
        });
      }

      const maxClips = clamp(
        Number(clipCount) || 3,
        1,
        5
      );

      /*
       * User requested duration.
       * Allowed:
       * 15 - 60 seconds
       */
      const targetDuration = clamp(
        Number(clipDurationSec) || 30,
        15,
        60
      );

      /*
       * Actual source video duration.
       */
      const sourceDuration = Math.max(
        1,
        Number(durationSec) || 1
      );

      /*
       * If source video is shorter than requested duration,
       * we can only use the available video duration.
       *
       * Example:
       * Video = 40 sec
       * User = 60 sec
       * Actual = 40 sec
       */
      const actualTargetDuration = Math.min(
        targetDuration,
        sourceDuration
      );

      logger.log(
        `[ai] requested duration: ${targetDuration}s`
      );

      logger.log(
        `[ai] source duration: ${sourceDuration.toFixed(2)}s`
      );

      logger.log(
        `[ai] final target duration: ${actualTargetDuration}s`
      );

      const schema = {
        type: 'object',

        properties: {
          highlights: {
            type: 'array',

            items: {
              type: 'object',

              properties: {
                startSec: {
                  type: 'number'
                },

                endSec: {
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
                'endSec',
                'score',
                'reason'
              ]
            }
          }
        },

        required: [
          'highlights'
        ]
      };

      const prompt = `
You are an expert short-form video editor.

Analyze the uploaded video and identify the best moments
that could become viral YouTube Shorts / Instagram Reels.

Video duration:
${sourceDuration.toFixed(2)} seconds.

Return up to ${maxClips} strong highlights.

Requested final clip duration:
${targetDuration} seconds.

Each highlight should:

- have a strong hook
- contain useful, surprising, emotional, funny,
  informative or highly engaging content
- avoid boring introductions
- avoid long silence
- avoid duplicate moments
- identify the strongest possible moment
- provide an accurate start timestamp

IMPORTANT:

- startSec MUST be within the video duration.
- endSec MUST be greater than startSec.
- Do not invent timestamps.
- Prefer a segment around ${targetDuration} seconds.
- Choose a start point that allows a full ${targetDuration}-second clip whenever possible.
- Score each highlight from 0 to 100.

IMPORTANT BACKEND RULE:

The backend will determine the final clip duration.
Your endSec is only used as a reference for the selected moment.

Return ONLY JSON matching the requested schema.
`;

      logger.log(
        '[ai] analyzing video'
      );

      const response =
        await ai.models.generateContent({
          model:
            cfg.geminiModel ||
            'gemini-3.8-flash',

          contents: [
            {
              fileData: {
                fileUri: file.uri,
                mimeType: file.mimeType
              }
            },

            {
              text: prompt
            }
          ],

          config: {
            responseMimeType:
              'application/json',

            responseSchema:
              schema,

            temperature:
              0.2
          }
        });

      const raw =
        response.text ||
        '';

      const parsed =
        JSON.parse(
          cleanJson(raw)
        );

      const highlights =
        Array.isArray(
          parsed.highlights
        )
          ? parsed.highlights
          : [];

      /*
       * IMPORTANT:
       *
       * Gemini may return:
       *
       * start = 120
       * end   = 150
       *
       * even when user requested 60 seconds.
       *
       * We DO NOT use Gemini's duration.
       *
       * We use Gemini's start as an anchor
       * and force the requested duration.
       */

      const normalized =
        highlights
          .map((h) => {
            const start =
              Number(h.startSec);

            const score =
              Number(h.score);

            if (
              !Number.isFinite(start)
            ) {
              return null;
            }

            /*
             * Keep the entire requested duration
             * inside the source video.
             *
             * Example:
             *
             * Video = 180 sec
             * Target = 60 sec
             * Gemini start = 150 sec
             *
             * Instead of 150 -> 210,
             * which exceeds the video,
             * shift it backward:
             *
             * 120 -> 180
             */
            let safeStart =
              clamp(
                start,
                0,
                Math.max(
                  0,
                  sourceDuration -
                    actualTargetDuration
                )
              );

            let safeEnd =
              Math.min(
                sourceDuration,
                safeStart +
                  actualTargetDuration
              );

            /*
             * Safety check.
             *
             * Make sure requested duration
             * is recovered whenever possible.
             */
            if (
              safeEnd -
                safeStart <
              actualTargetDuration
            ) {
              safeStart =
                Math.max(
                  0,
                  safeEnd -
                    actualTargetDuration
                );

              safeEnd =
                Math.min(
                  sourceDuration,
                  safeStart +
                    actualTargetDuration
                );
            }

            if (
              safeEnd <=
              safeStart
            ) {
              return null;
            }

            const finalDuration =
              Math.round(
                (
                  safeEnd -
                  safeStart
                ) * 100
              ) / 100;

            logger.log(
              `[ai] normalized highlight: ` +
              `${safeStart.toFixed(2)} -> ` +
              `${safeEnd.toFixed(2)} ` +
              `(${finalDuration.toFixed(2)}s)`
            );

            return {
              startSec:
                Math.round(
                  safeStart * 100
                ) / 100,

              durationSec:
                finalDuration,

              score:
                clamp(
                  Number.isFinite(
                    score
                  )
                    ? score
                    : 50,
                  0,
                  100
                ),

              reason:
                String(
                  h.reason ||
                  'AI-selected highlight'
                ).slice(
                  0,
                  500
                )
            };
          })
          .filter(Boolean);

      /*
       * Highest scoring clips first.
       */
      normalized.sort(
        (a, b) =>
          b.score -
          a.score
      );

      const selected = [];

      /*
       * Remove overlapping clips.
       */
      for (
        const candidate of normalized
      ) {
        const overlaps =
          selected.some(
            (x) => {
              const a1 =
                candidate.startSec;

              const a2 =
                candidate.startSec +
                candidate.durationSec;

              const b1 =
                x.startSec;

              const b2 =
                x.startSec +
                x.durationSec;

              return (
                Math.max(
                  a1,
                  b1
                ) <
                Math.min(
                  a2,
                  b2
                )
              );
            }
          );

        if (!overlaps) {
          selected.push(
            candidate
          );
        }

        if (
          selected.length >=
          maxClips
        ) {
          break;
        }
      }

      /*
       * Return final AI highlights.
       *
       * durationSec here is now the
       * BACKEND-FORCED duration.
       */
      return selected
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
        .map(
          (h, index) => ({
            index:
              index + 1,

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

    } finally {
      /*
       * Delete Gemini uploaded file
       * after analysis.
       */
      if (
        file &&
        file.name
      ) {
        await ai.files
          .delete({
            name:
              file.name
          })
          .catch(
            () => {}
          );
      }
    }
  }

  return {
    analyzeVideo
  };
}

function mimeFromPath(file) {
  const ext =
    path.extname(file)
      .toLowerCase();

  if (
    ext === '.webm'
  ) {
    return 'video/webm';
  }

  if (
    ext === '.mov' ||
    ext === '.qt'
  ) {
    return 'video/quicktime';
  }

  return 'video/mp4';
}

module.exports = {
  createAIHighlights
};