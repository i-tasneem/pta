# PTA app image. Debian slim (not alpine) so native modules (better-sqlite3)
# build reliably on arm64 (OCI Ampere A1).
FROM node:20-bookworm-slim

# Build tools for native deps; removed after install to keep the image lean
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Build the frontend (vite -> frontend/dist, served by Express)
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
