# syntax=docker/dockerfile:1
# Content Radar app image: the dashboard (React build), API, channel scheduler,
# and SQLite database in one Node process (`src/app/server.js`).
#
#   docker build -t news-engine:local .
#
# - No secrets are baked in: `.dockerignore` keeps `.env*`, `.cache`, and other
#   local state out of the build context. Configuration comes from the runtime
#   environment (see `src/app/config/env.js` for the required variables).
# - Files copied from the build context get normalized modes (directories 755,
#   files 644), so a checkout with owner-only files still yields code the
#   `node` user can read. The symbolic `--chmod` needs Dockerfile syntax 1.14+,
#   which the `syntax` line above guarantees on any BuildKit builder.
# - `/data` holds content-radar.db, its backups, and the file cache; mount a
#   persistent volume there. The process runs as the unprivileged `node` user,
#   which owns `/data` (a new named volume inherits that ownership).
# - On SIGTERM the app waits for the channel run in flight (SHUTDOWN_WAIT_SECONDS,
#   default 120) and never closes the database under it, so give the container
#   a stop grace period of at least SHUTDOWN_WAIT_SECONDS + 15 s (135 s by
#   default); docker-compose.yml sets `stop_grace_period: 135s`.

# --- Dashboard build: static files in /build/web/dist ---
# devDependencies are required here (Vite, its plugins, and vitest/config used
# by vite.config.ts), so NODE_ENV stays unset in this stage.
FROM node:24-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Runtime ---
# Node 24 ships node:sqlite as a stable module (no ExperimentalWarning, no native build).
FROM node:24-alpine AS runtime
WORKDIR /app
COPY --chmod=u=rwX,go=rX package.json package-lock.json ./
# Production dependencies only; none of them needs an install script.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
# Application code stays root-owned and read-only for the runtime user.
COPY --chmod=u=rwX,go=rX src/ ./src/
# src/app/create-app.js serves the dashboard from ../../web/dist, i.e. /app/web/dist.
COPY --from=web /build/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    CACHE_PATH=/data/news.json
VOLUME /data
EXPOSE 3000

# Liveness only: /healthz is the one route served without an Access token and
# answers `ok` without touching data.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/app/server.js"]
