FROM node:20-bookworm-slim

# ==========================================
# System packages
# ==========================================
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    unzip && \
    rm -rf /var/lib/apt/lists/*

# ==========================================
# Install latest yt-dlp
# ==========================================
RUN curl -fL \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version

# ==========================================
# Install Deno JavaScript runtime
# Required by yt-dlp for modern YouTube
# ==========================================
RUN curl -fsSL https://deno.land/install.sh | \
    DENO_INSTALL=/usr/local sh && \
    chmod a+rx /usr/local/bin/deno && \
    deno --version

# ==========================================
# Application
# ==========================================
WORKDIR /app

# Install Node dependencies first
# for better Docker layer caching
COPY package*.json ./

RUN npm install --omit=dev

# Copy application source
COPY . .

# ==========================================
# Environment
# ==========================================
ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

# ==========================================
# Render port
# ==========================================
EXPOSE 10000

# ==========================================
# Start backend
# ==========================================
CMD ["node", "server.js"]