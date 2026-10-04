FROM node:20-bookworm-slim

# FFmpeg provides both the ffmpeg and ffprobe binaries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 10000
USER node
CMD ["node", "src/server.js"]
