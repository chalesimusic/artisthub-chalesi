# Dockerfile for Render.com with FFmpeg support
FROM node:20-slim

# Install FFmpeg for video rendering
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Create upload directories
RUN mkdir -p uploads/audio uploads/video uploads/thumbnails data

EXPOSE 10000

CMD ["node", "server.js"]
