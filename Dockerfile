FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web/index.html web/tsconfig*.json web/vite.config.* ./web/
COPY web/src ./web/src
RUN npm --prefix web run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ECHO_HOST=0.0.0.0 \
    ECHO_PORT=8787 \
    ECHO_DB_PATH=/app/data/echo.db \
    ECHO_STORAGE_DIR=/app/data/storage \
    ECHO_MODEL_DIR=/app/data/models \
    ECHO_BACKUP_DIR=/app/backups

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data/storage /app/data/models /app/backups \
    && chown -R node:node /app
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
