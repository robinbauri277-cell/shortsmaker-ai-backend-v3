'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ValidationError } = require('./errors');

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be'
]);

function validateYouTubeUrl(value) {
  let url;

  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new ValidationError(
      'BAD_YOUTUBE_URL',
      'Please enter a valid YouTube URL.',
      400
    );
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ValidationError(
      'BAD_YOUTUBE_URL',
      'Only HTTP/HTTPS YouTube URLs are supported.',
      400
    );
  }

  const host = url.hostname.toLowerCase();

  if (!YOUTUBE_HOSTS.has(host)) {
    throw new ValidationError(
      'BAD_YOUTUBE_URL',
      'Only youtube.com and youtu.be URLs are supported.',
      400
    );
  }

  if (
    host.includes('youtu.be') &&
    (!url.pathname || url.pathname === '/')
  ) {
    throw new ValidationError(
      'BAD_YOUTUBE_URL',
      'The YouTube video URL is incomplete.',
      400
    );
  }

  if (
    !host.includes('youtu.be') &&
    !url.searchParams.get('v') &&
    !/^\/shorts\//i.test(url.pathname)
  ) {
    throw new ValidationError(
      'BAD_YOUTUBE_URL',
      'Please provide a YouTube video or Shorts URL.',
      400
    );
  }

  return url.href;
}

function runYtDlp({
  ytDlpPath,
  url,
  outputPath,
  maxBytes,
  timeoutMs
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--restrict-filenames',

      '--max-filesize',
      String(maxBytes),

      '--format',
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',

      '--merge-output-format',
      'mp4',

      '--output',
      outputPath,

      url
    ];

    const child = spawn(
      ytDlpPath,
      args,
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');

      finish(
        reject,
        new ValidationError(
          'YOUTUBE_TIMEOUT',
          'YouTube download timed out. Please try a shorter video.',
          504
        )
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();

      if (stdout.length > 4000) {
        stdout = stdout.slice(-4000);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();

      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    child.on('error', () => {
      finish(
        reject,
        new ValidationError(
          'YTDLP_UNAVAILABLE',
          'YouTube downloader is not available on the server.',
          503
        )
      );
    });

    child.on('close', (code) => {
      if (settled) return;

      if (code !== 0) {
        const lower = stderr.toLowerCase();

        let message =
          'Could not download this YouTube video.';

        if (
          lower.includes('private video') ||
          lower.includes('sign in')
        ) {
          message =
            'This YouTube video is private or requires sign-in.';
        } else if (
          lower.includes('age-restricted')
        ) {
          message =
            'This YouTube video is age-restricted and cannot be downloaded by this server.';
        } else if (
          lower.includes('video unavailable') ||
          lower.includes('unavailable')
        ) {
          message =
            'This YouTube video is unavailable.';
        } else if (
          lower.includes('max-filesize') ||
          lower.includes('larger than')
        ) {
          message =
            'The YouTube video is larger than the 500 MB limit.';
        }

        finish(
          reject,
          new ValidationError(
            'YOUTUBE_DOWNLOAD_FAILED',
            message,
            422
          )
        );

        return;
      }

      finish(resolve, {
        stdout,
        stderr
      });
    });
  });
}

async function downloadYouTube({
  url,
  outputDir,
  maxBytes,
  timeoutMs
}) {
  const cleanUrl =
    validateYouTubeUrl(url);

  const fileName =
    'youtube-' +
    Date.now() +
    '-' +
    Math.random()
      .toString(36)
      .slice(2, 10) +
    '.mp4';

  const outputPath =
    path.join(
      outputDir,
      fileName
    );

  await fs.promises.mkdir(
    outputDir,
    {
      recursive: true
    }
  );

  try {
    await runYtDlp({
      ytDlpPath: 'yt-dlp',
      url: cleanUrl,
      outputPath,
      maxBytes,
      timeoutMs
    });

    const stat =
      await fs.promises.stat(
        outputPath
      );

    if (
      !stat.isFile() ||
      stat.size <= 0
    ) {
      throw new ValidationError(
        'YOUTUBE_EMPTY',
        'YouTube download completed but produced no video file.',
        422
      );
    }

    if (
      stat.size > maxBytes
    ) {
      throw new ValidationError(
        'FILE_TOO_LARGE',
        'The downloaded YouTube video exceeds the 500 MB limit.',
        413
      );
    }

    return {
      path: outputPath,
      filename: fileName,
      size: stat.size,
      url: cleanUrl
    };

  } catch (error) {
    await fs.promises
      .rm(
        outputPath,
        { force: true }
      )
      .catch(() => {});

    throw error;
  }
}

module.exports = {
  validateYouTubeUrl,
  downloadYouTube
};
