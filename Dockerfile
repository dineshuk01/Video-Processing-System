# Video Transcoder - Production Dockerfile
# Used as an AWS ECS Fargate Task to transcode videos via FFmpeg

FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source files and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Final Production Image ---
FROM node:20-slim AS production

WORKDIR /app

# Install FFmpeg globally (replaces static ffmpeg-static binary)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Copy compiled output and production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# The container entrypoint is the standalone transcoder task
ENTRYPOINT ["node", "dist/transcoderTask.js"]
