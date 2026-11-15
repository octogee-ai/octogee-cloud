FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS platform-npm
ARG NPM_VERSION=12.2.1
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
COPY gateway/openclaw-tarball/npm-12.2.1.patch gateway/openclaw-tarball/npm-distribution.test.mjs /tmp/
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && patch --batch --forward --directory=/usr/local/lib/node_modules/npm -p1 < /tmp/npm-12.2.1.patch \
    && node /tmp/npm-distribution.test.mjs /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = "$NPM_VERSION" \
    && test "$(npx --version)" = "$NPM_VERSION"

# Build context: platform/. tsc emits dist/octogee-api/src/, the path chart
# commands name.
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS builder
RUN rm -rf /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /octogee-api

# Packed internal directory dependencies must be present at their declared sibling paths.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY platform-api/.npmrc platform-api/package.json platform-api/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY platform-api/tsconfig.json ./
COPY platform-api/src/ ./src/

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
ARG OS_PACKAGE_REFRESH=2026-11-11
RUN test -n "$OS_PACKAGE_REFRESH" && apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /octogee-api

# The runtime install also packs the direct internal directory dependencies.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY platform-api/.npmrc platform-api/package.json platform-api/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm rebuild better-sqlite3 --foreground-scripts \
    && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()"

COPY --from=builder /octogee-api/dist ./dist

# Bake the build SHA into the image so the boot banner can report it.
# Passed by Cloud Build via --build-arg BUILD_SHA=$_IMAGE_TAG. Without
# this, process.env.BUILD_SHA stays undefined and the banner logs
# "unknown" — making it hard to diagnose stale-image deploy issues
# in PROD.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/octogee-api/src/main.js"]
