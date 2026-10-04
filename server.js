'use strict';

const { loadConfig } = require('./config');
const { createFfmpeg } = require('./ffmpeg');
const { JobManager } = require('./jobs');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const ffmpeg = createFfmpeg(config);
  const jobs = new JobManager(config, ffmpeg);
  await jobs.init();
  jobs.startCleanupTimer();

  const bins = await ffmpeg.checkBinaries();
  console.log(`[startup] ffmpeg=${bins.ffmpeg} ffprobe=${bins.ffprobe} version=${bins.version || 'unknown'}`);
  if (!bins.ffmpeg || !bins.ffprobe) {
    console.error('[startup] FFmpeg/FFprobe not found. Video processing will fail. See README (Dockerfile or FFMPEG_PATH).');
  }
  console.log(`[startup] allowed origins: ${config.corsOrigins.join(', ')}`);

  const app = createApp({ config, ffmpeg, jobs });
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`[startup] listening on ${config.port}`));
  // Node's default requestTimeout (5 min) would cut off slow mobile uploads.
  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  const shutdown = () => {
    jobs.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[startup] fatal:', e);
  process.exit(1);
});
