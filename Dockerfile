FROM node:20-bookworm-slim

# FFmpeg + Python + required tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version

# Application directory
WORKDIR /app

# Install Node dependencies first for Docker cache
COPY package*.json ./

RUN npm install --omit=dev

# Copy application
COPY . .

# Production environment
ENV NODE_ENV=production

# Render port
EXPOSE 10000

# Start backend
CMD ["node", "server.js"]
