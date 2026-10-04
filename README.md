# ShortsMaker AI backend (Stage 2)

Node.js + Express + Multer + FFmpeg. Upload a video, get back real MP4 clips.

## What it does, and what it does NOT do

| Feature | Status |
|---|---|
| Upload MP4 / MOV / WebM, validate with ffprobe | Implemented |
| Interval clips (15/30/45/60 s, 1-5 clips, evenly spaced) | Implemented, labelled `interval-basic`, **not AI** |
| Manual trim (start/end seconds) | Implemented, labelled `manual-trim` |
| 9:16, 16:9, 1:1 at 720p / 1080p (centre crop) | Implemented |
| Async jobs, real progress, real MP4 + download URLs | Implemented |
| AI highlight detection | **Not implemented** (`features.aiHighlights: false`) |
| Automatic subtitles / speech-to-text | **Not implemented** (`features.speechToText: false`) |
| YouTube URL download | **Not implemented** |
| Permanent storage (R2) | **Not implemented**; clips live on temporary disk for `JOB_TTL_MINUTES` |

## API contract

All errors: `{ "error": "<readable string>", "code": "<MACHINE_CODE>" }` (the Stage 1 frontend reads `error` as a string).

### GET /api/health
`200 {"status":"ok","ffmpeg":true,"ffprobe":true,"features":{...},"limits":{...},"queue":{...}}`
`503 {"status":"degraded",...}` if FFmpeg or FFprobe is missing.

### POST /api/shorts/process  (multipart/form-data)
| Field | Required | Values |
|---|---|---|
| `video` | yes | file, MP4/MOV/WebM, up to `MAX_UPLOAD_MB` |
| `duration` | no (30) | 15, 30, 45, 60 |
| `clipCount` | no (1) | 1 to `MAX_CLIP_COUNT` |
| `start` | no (0) | seconds |
| `aspect` | no (9:16) | 9:16, 16:9, 1:1 |
| `resolution` | no (720p) | 720p, 1080p |

`202`:
```json
{ "jobId": "uuid", "accessToken": "secret", "status": "queued", "mode": "interval-basic",
  "ai": false, "clipCount": 1, "warnings": [],
  "statusUrl": "https://.../api/shorts/status/<jobId>", "resultUrl": "https://.../api/shorts/result/<jobId>" }
```
Errors: 400 NO_FILE / WRONG_FIELD_NAME / INVALID_* , 413 FILE_TOO_LARGE, 415 UNSUPPORTED_*, 422 INVALID_VIDEO / VIDEO_TOO_LONG, 429 RATE_LIMITED, 503 SERVER_BUSY.

### POST /api/shorts/trim  (multipart/form-data)
`video`, `start` (required), `end` (required, seconds), optional `aspect`, `resolution`. Same 202 response, `mode: "manual-trim"`.

### GET /api/shorts/status/:jobId
Send the token as header `X-Job-Token: <accessToken>` or `?token=<accessToken>`.
```json
{ "jobId": "...", "status": "queued|processing|completed|failed", "stage": "queued|encoding|done|failed",
  "progress": 0, "currentClip": 1, "clipCount": 1, "mode": "interval-basic", "ai": false,
  "source": { "durationSec": 8, "width": 640, "height": 360 }, "warnings": [],
  "createdAt": "ISO", "updatedAt": "ISO", "expiresAt": null,
  "queuePosition": 1, "error": "only when failed", "errorCode": "only when failed" }
```
No token: 401 `TOKEN_REQUIRED`. Wrong token or unknown job: 404 (identical, so IDs cannot be probed).

### GET /api/shorts/result/:jobId
- `200` completed: `{ jobId, status, mode, ai, warnings, expiresAt, clips: [{ index, startSec, endSec, durationSec, width, height, sizeBytes, previewUrl, downloadUrl }] }`
- `409 JOB_NOT_READY` while queued/processing, `422 JOB_FAILED` if failed.

### GET /api/shorts/download/:jobId/:index?token=...
Streams the MP4 (Range supported, so `<video>` works). Add `&download=1` to force a file download. `downloadUrl` and `previewUrl` already include the token.

## Frontend changes needed (Stage 3, nothing breaks today)
The Stage 1 page already works with this API (`video`, `duration`, `jobId`, string `error`). To show results, it must:
1. Keep `accessToken` from the 202 response.
2. Poll `GET statusUrl?token=<accessToken>` every 2 s until `completed` or `failed`.
3. Fetch `resultUrl?token=...` and use `clips[i].previewUrl` in `<video src>` and `downloadUrl` for the download button.

## Environment variables
See `.env.example`. Important ones: `CORS_ORIGINS` (exact Blogger origin(s), no trailing slash), `PUBLIC_BASE_URL`, `MAX_UPLOAD_MB`, `PROCESS_TIMEOUT_SECONDS`, `JOB_TTL_MINUTES`, `MAX_CONCURRENT_JOBS` (keep 1 on a free instance), `FFMPEG_PATH` / `FFPROBE_PATH` (only if not on PATH).

Reserved for later, **not read by this code**: `GEMINI_API_KEY`, `GEMINI_MODEL` (Google AI Studio highlight analysis), a speech-to-text credential, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (Cloudflare R2). Never put these in Blogger or in Git.

## Run locally
```bash
# needs Node 18.17+ and ffmpeg/ffprobe on PATH
npm install
cp .env.example .env     # then edit; or export variables
npm start
curl http://localhost:10000/api/health
```

## Tests
```bash
npm run test:core   # validation + real FFmpeg + job lifecycle, no npm deps needed
npm test            # also runs HTTP tests (after npm install)
node scripts/verify.mjs http://localhost:10000      # checks every endpoint of a running server
```

## Deploy on Render
Render's plain Node runtime does not include FFmpeg, so use one of these.

**Option A (recommended): Docker.** The included `Dockerfile` installs FFmpeg. A Render service's runtime is chosen when it is created, so create a **new** web service instead of editing the old one:
1. Back up: keep the old service `shortsmaker-ai-backend-1` running and untouched.
2. Push this project to GitHub (branch `stage2`, or a new repo).
3. Render -> New -> Web Service -> select the repo/branch -> Runtime: **Docker**. Health Check Path: `/api/health`. Add env vars (`CORS_ORIGINS`, `PUBLIC_BASE_URL` = the new service URL).
4. When the logs show `[startup] ffmpeg=true ffprobe=true`, run `node scripts/verify.mjs <new-url>`.
5. Only after it passes: change `API_BASE` in the Blogger page to the new URL. Delete the old service later.

**Option B: keep the existing Node service.** Build Command: `npm install && npm install ffmpeg-static @ffprobe-installer/ffprobe`, Start Command: `npm start`. The code detects these packages automatically (or set `FFMPEG_PATH` / `FFPROBE_PATH`). Not tested here; check the startup log for `ffmpeg=true`.

## Storage limits (important)
Render's disk is ephemeral: files vanish on every deploy/restart and the free instance sleeps after inactivity. Jobs are kept in memory, so a restart also forgets all jobs (a job in progress fails from the user's side; they upload again). Clips are deleted `JOB_TTL_MINUTES` after completion. For permanent clips, add Cloudflare R2 (S3-compatible) or a Render persistent disk in a later stage. Free instances have small RAM/CPU: expect roughly real-time encoding speed or slower for 1080p.

## Security notes
Helmet; CORS allow-list with a hard 403 for other browser origins; rate limits (general + uploads); random file names (client names are never used on disk); ffprobe validation of every upload; FFmpeg/FFprobe started with argument arrays and no shell; per-job random token; absolute paths never appear in responses; limits on size, duration, clip count, concurrency, queue and processing time. The token appears in download URLs (needed for `<video>`), so treat result links as private.

## Troubleshooting
- Browser shows a CORS error: the page origin is not in `CORS_ORIGINS`. Open the page, check the exact origin (Blogger may redirect to `.in`, `.co.uk` ...), add it, redeploy.
- `/api/health` returns 503 `degraded`: FFmpeg missing. Use the Dockerfile or Option B.
- First request takes ~50 s: Render free instance cold start.
- 413: file above `MAX_UPLOAD_MB`. 503 SERVER_BUSY: queue full.
- Logs: Render -> your service -> Logs. Job failures log `[job <id>] failed: <CODE>`.
