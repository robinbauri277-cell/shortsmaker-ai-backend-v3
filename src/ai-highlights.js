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

    logger.log('[ai] uploading video for highlight analysis');

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

      const targetDuration = clamp(
        Number(clipDurationSec) || 30,
        15,
        60
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
        required: ['highlights']
      };

      const prompt = `
You are an expert short-form video editor.

Analyze the uploaded video and identify the best moments
that could become viral YouTube Shorts / Instagram Reels.

Video duration:
${durationSec.toFixed(2)} seconds.

Return up to ${maxClips} strong highlights.

Each highlight should:
- have a strong hook
- contain useful, surprising, emotional, funny,
  informative or highly engaging content
- avoid boring introductions
- avoid long silence
- avoid duplicate moments
- be suitable for a ${targetDuration}-second short
- have accurate timestamps

IMPORTANT:
- startSec and endSec MUST be within the video duration.
- endSec MUST be greater than startSec.
- Prefer approximately ${targetDuration} seconds.
- Do not invent timestamps.
- Score each highlight from 0 to 100.

Return ONLY JSON matching the requested schema.
`;

      logger.log('[ai] analyzing video');

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

            responseSchema: schema,

            temperature: 0.2
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

      const normalized = highlights
        .map((h) => {
          const start =
            Number(h.startSec);

          const end =
            Number(h.endSec);

          const score =
            Number(h.score);

          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end)
          ) {
            return null;
          }

          const safeStart =
            clamp(
              start,
              0,
              Math.max(
                0,
                durationSec - 1
              )
            );

          const safeEnd =
            clamp(
              end,
              safeStart + 1,
              durationSec
            );

          if (
            safeEnd <= safeStart
          ) {
            return null;
          }

          return {
            startSec:
              Math.round(
                safeStart * 100
              ) / 100,

            durationSec:
              Math.round(
                (safeEnd - safeStart) *
                  100
              ) / 100,

            score:
              clamp(
                Number.isFinite(score)
                  ? score
                  : 50,
                0,
                100
              ),

            reason:
              String(
                h.reason ||
                'AI-selected highlight'
              ).slice(0, 500)
          };
        })
        .filter(Boolean);

      normalized.sort(
        (a, b) =>
          b.score - a.score
      );

      const selected = [];

      for (
        const candidate of normalized
      ) {
        const overlaps =
          selected.some((x) => {
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
              Math.max(a1, b1) <
              Math.min(a2, b2)
            );
          });

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

      return selected
        .sort(
          (a, b) =>
            b.score - a.score
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
      if (file && file.name) {
        await ai.files
          .delete({
            name: file.name
          })
          .catch(() => {});
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

  if (ext === '.webm') {
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
