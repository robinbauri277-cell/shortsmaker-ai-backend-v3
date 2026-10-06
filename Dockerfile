FROM node:20-bookworm-slim

# FFmpeg + required tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    unzip && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version

# Install Deno JavaScript runtime
RUN curl -fsSL \
    https://dl.deno.land/release/latest/deno-x86_64-unknown-linux-gnu.zip \
    -o /tmp/deno.zip && \
    unzip -q /tmp/deno.zip -d /usr/local/bin && \
    chmod a+rx /usr/local/bin/deno && \
    rm -f /tmp/deno.zip && \
    deno --version

WORKDIR /app

# Install Node dependencies first for Docker cache
COPY package*.json ./

RUN npm install --omit=dev

# Copy application
COPY . .

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 10000

CMD ["node", "server.js"]