'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { ValidationError } = require('./errors');

function codeError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function createFfmpeg(cfg) {

  function run(
    cmd,
    args,
    {
      timeoutMs = 0,
      onStdoutLine
    } = {}
  ) {
    return new Promise((resolve, reject) => {
      let child;

      try {
        child = spawn(cmd, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (e) {
        return reject(
          codeError(
            'BINARY_MISSING',
            'Failed to start process'
          )
        );
      }

      let stdout = '';
      let stderr = '';
      let lineBuf = '';
      let timedOut = false;
      let settled = false;

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;

              try {
                child.kill('SIGKILL');
              } catch (_) {}
            }, timeoutMs)
          : null;

      child.stdout.on('data', (d) => {
        const text = d.toString('utf8');

        if (onStdoutLine) {
          lineBuf += text;

          let i;

          while (
            (i = lineBuf.indexOf('\n')) >= 0
          ) {
            const line =
              lineBuf
                .slice(0, i)
                .trim();

            lineBuf =
              lineBuf.slice(i + 1);

            if (line) {
              try {
                onStdoutLine(line);
              } catch (_) {}
            }
          }

          if (lineBuf.length > 4096) {
            lineBuf = '';
          }
        } else {
          if (
            stdout.length <
            1024 * 1024
          ) {
            stdout += text;
          }
        }
      });

      child.stderr.on('data', (d) => {
        stderr = (
          stderr +
          d.toString('utf8')
        ).slice(-8000);
      });

      child.on('error', (e) => {
        if (timer) {
          clearTimeout(timer);
        }

        if (settled) {
          return;
        }

        settled = true;

        reject(
          codeError(
            e.code === 'ENOENT'
              ? 'BINARY_MISSING'
              : 'SPAWN_FAILED',
            'Failed to start process',
            e.message
          )
        );
      });

      child.on('close', (code) => {
        if (timer) {
          clearTimeout(timer);
        }

        if (settled) {
          return;
        }

        settled = true;

        if (timedOut) {
          return reject(
            codeError(
              'TIMEOUT',
              'Process timed out'
            )
          );
        }

        resolve({
          code,
          stdout,
          stderr
        });
      });
    });
  }


  // ==========================================================
  // CHECK FFMPEG / FFPROBE
  // ==========================================================

  async function checkBinaries() {

    const result = {
      ffmpeg: false,
      ffprobe: false,
      version: null
    };

    try {
      const r =
        await run(
          cfg.ffmpegPath,
          ['-version'],
          {
            timeoutMs: 10000
          }
        );

      result.ffmpeg =
        r.code === 0;

      const m =
        /ffmpeg version (\S+)/
          .exec(r.stdout);

      if (m) {
        result.version =
          m[1];
      }

    } catch (_) {}


    try {
      const r =
        await run(
          cfg.ffprobePath,
          ['-version'],
          {
            timeoutMs: 10000
          }
        );

      result.ffprobe =
        r.code === 0;

    } catch (_) {}

    return result;
  }


  // ==========================================================
  // PROBE VIDEO
  // ==========================================================

  async function probe(file) {

    const invalid = () =>
      new ValidationError(
        'INVALID_VIDEO',
        'The file is not a valid, readable video.',
        422
      );

    let res;

    try {

      res =
        await run(
          cfg.ffprobePath,
          [
            '-v',
            'error',

            '-print_format',
            'json',

            '-show_format',
            '-show_streams',

            '-i',
            file
          ],
          {
            timeoutMs:
              cfg.probeTimeoutMs
          }
        );

    } catch (e) {

      if (
        e.code === 'TIMEOUT'
      ) {
        throw invalid();
      }

      throw e;
    }

    if (
      res.code !== 0
    ) {
      throw invalid();
    }

    let data;

    try {
      data =
        JSON.parse(
          res.stdout
        );
    } catch (_) {
      throw invalid();
    }

    const streams =
      Array.isArray(
        data.streams
      )
        ? data.streams
        : [];

    const video =
      streams.find(
        (s) =>
          s.codec_type ===
            'video' &&
          !(
            s.disposition &&
            s.disposition.attached_pic
          )
      );

    if (!video) {
      throw new ValidationError(
        'NO_VIDEO_STREAM',
        'The file contains no video track.',
        422
      );
    }

    const fmt =
      data.format || {};

    const durationSec =
      Number.parseFloat(
        fmt.duration ||
        video.duration
      );

    if (
      !Number.isFinite(
        durationSec
      ) ||
      durationSec <= 0
    ) {
      throw new ValidationError(
        'UNKNOWN_DURATION',
        'Could not determine the video length.',
        422
      );
    }

    return {
      formatName:
        String(
          fmt.format_name || ''
        ),

      durationSec,

      width:
        Number(
          video.width
        ) || 0,

      height:
        Number(
          video.height
        ) || 0,

      videoCodec:
        video.codec_name || '',

      hasAudio:
        streams.some(
          (s) =>
            s.codec_type ===
            'audio'
        )
    };
  }


  // ==========================================================
  // OUTPUT SIZE
  // ==========================================================

  function getOutputSize(
    aspect,
    resolution
  ) {

    const height =
      resolution === '1080p'
        ? 1920
        : 1280;

    if (
      aspect === '16:9'
    ) {
      return {
        width:
          resolution === '1080p'
            ? 1920
            : 1280,

        height:
          resolution === '1080p'
            ? 1080
            : 720
      };
    }

    if (
      aspect === '1:1'
    ) {
      return {
        width:
          resolution === '1080p'
            ? 1080
            : 720,

        height:
          resolution === '1080p'
            ? 1080
            : 720
      };
    }

    // Default = 9:16

    return {
      width:
        resolution === '1080p'
          ? 1080
          : 720,

      height
    };
  }


  // ==========================================================
  // BUILD FFMPEG TRANSCODE
  // ==========================================================

  function buildTranscodeArgs({
    input,
    output,
    startSec,
    durationSec,
    width,
    height
  }) {

    /*
     * High-quality center crop.
     *
     * scale keeps the source large enough,
     * crop creates exact output dimensions.
     */

    const vf =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `setsar=1`;

    return [

      '-hide_banner',

      '-nostdin',

      '-y',

      // Error output only
      '-loglevel',
      'error',

      // Real-time progress
      '-progress',
      'pipe:1',

      '-nostats',

      /*
       * Fast seeking
       */
      '-ss',
      Number(
        startSec
      ).toFixed(3),

      '-i',
      input,

      '-t',
      Number(
        durationSec
      ).toFixed(3),

      // Video
      '-map',
      '0:v:0',

      // Audio if available
      '-map',
      '0:a:0?',

      // Crop / resize
      '-vf',
      vf,

      // H264
      '-c:v',
      'libx264',

      /*
       * ======================================================
       * FAST MODE
       * ======================================================
       *
       * Render environment:
       *
       * FFMPEG_PRESET=veryfast
       * FFMPEG_CRF=20
       *
       * Falls back to veryfast / 20 if env is missing.
       */

      '-preset',
      cfg.ffmpegPreset ||
        'veryfast',

      '-crf',
      String(
        cfg.ffmpegCrf || 20
      ),

      '-pix_fmt',
      'yuv420p',

      // Audio
      '-c:a',
      'aac',

      '-b:a',
      '192k',

      // Web playback
      '-movflags',
      '+faststart',

      /*
       * ======================================================
       * CPU THREADS
       * ======================================================
       *
       * 0 = FFmpeg automatically chooses
       * the best available thread count.
       */

      '-threads',
      String(
        cfg.ffmpegThreads || 0
      ),

      // MP4
      '-f',
      'mp4',

      output
    ];
  }


  // ==========================================================
  // VERIFY OUTPUT
  // ==========================================================

  async function verifyOutput(
    file,
    expectedSec,
    width,
    height
  ) {

    const bad = (why) =>
      codeError(
        'OUTPUT_INVALID',
        'Output validation failed',
        why
      );

    let st;

    try {

      st =
        await fs.promises.stat(
          file
        );

    } catch (_) {

      throw bad(
        'Output missing'
      );
    }

    if (
      !st.isFile() ||
      st.size <= 0
    ) {
      throw bad(
        'Output empty'
      );
    }

    let info;

    try {

      info =
        await probe(file);

    } catch (_) {

      throw bad(
        'Output unreadable'
      );
    }

    if (
      info.videoCodec !==
      'h264'
    ) {
      throw bad(
        'Codec ' +
        info.videoCodec
      );
    }

    if (
      info.width !== width ||
      info.height !== height
    ) {
      throw bad(
        `Size ${info.width}x${info.height}`
      );
    }

    if (
      Math.abs(
        info.durationSec -
        expectedSec
      ) >
      Math.max(
        1.5,
        expectedSec * 0.1
      )
    ) {
      throw bad(
        `Duration ${info.durationSec} vs ${expectedSec}`
      );
    }

    /*
     * IMPORTANT:
     *
     * Full decode verification can consume
     * additional CPU/time on Render.
     *
     * VERIFY_DECODE=false
     * is recommended for FAST mode.
     */

    if (
      cfg.verifyDecode
    ) {

      let r;

      try {

        r =
          await run(
            cfg.ffmpegPath,

            [
              '-hide_banner',
              '-nostdin',

              '-v',
              'error',

              '-i',
              file,

              '-map',
              '0:v:0',

              '-f',
              'null',

              '-'
            ],

            {
              timeoutMs:
                120000
            }
          );

      } catch (_) {

        throw bad(
          'Decode check could not run'
        );
      }

      if (
        r.code !== 0 ||
        r.stderr.trim()
      ) {
        throw bad(
          'Decode errors: ' +
          r.stderr.slice(-500)
        );
      }
    }

    return {

      sizeBytes:
        st.size,

      width,

      height,

      durationSec:
        Math.round(
          info.durationSec * 100
        ) / 100
    };
  }


  // ==========================================================
  // TRANSCODE CLIP
  // ==========================================================

  async function transcodeClip({
    input,
    output,
    startSec,
    durationSec,
    width,
    height,
    timeoutMs,
    onProgress
  }) {

    const args =
      buildTranscodeArgs({
        input,
        output,
        startSec,
        durationSec,
        width,
        height
      });

    const res =
      await run(
        cfg.ffmpegPath,
        args,
        {
          timeoutMs,

          onStdoutLine:
            (line) => {

              /*
               * FFmpeg emits:
               *
               * out_time_us=1234567
               * progress=continue
               */

              const m =
                /^out_time_(?:us|ms)=(\d+)$/
                  .exec(line);

              if (
                m &&
                onProgress
              ) {

                const microseconds =
                  Number(
                    m[1]
                  );

                const seconds =
                  microseconds /
                  1000000;

                const progress =
                  Math.min(
                    1,
                    seconds /
                    durationSec
                  );

                onProgress(
                  progress
                );
              }
            }
        }
      );

    if (
      res.code !== 0
    ) {
      throw codeError(
        'FFMPEG_FAILED',
        'FFmpeg failed',
        res.stderr
      );
    }

    return verifyOutput(
      output,
      durationSec,
      width,
      height
    );
  }


  // ==========================================================
  // PUBLIC API
  // ==========================================================

  return {

    run,

    checkBinaries,

    probe,

    getOutputSize,

    buildTranscodeArgs,

    verifyOutput,

    transcodeClip

  };
}


module.exports = {
  createFfmpeg
};