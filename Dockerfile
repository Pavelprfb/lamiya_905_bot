# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------- deps stage
FROM node:22-alpine AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
# `npm ci` installs exactly what the lockfile pins. Native optional addons are
# skipped so the image never needs a compiler toolchain.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DATA_DIR=/app/data \
    PORT=3000

# tini reaps zombies and forwards SIGTERM so the app can shut down cleanly.
RUN apk add --no-cache tini curl \
 && mkdir -p /app/data \
 && chown -R node:node /app

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node shared ./shared

# /app/data holds the session index + StringSession files. Mount a volume here so
# logins survive `docker compose restart` / container replacement.
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
