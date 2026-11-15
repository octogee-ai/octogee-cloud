FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS platform-npm
ARG NPM_VERSION=12.2.1
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
COPY infra/gateway/openclaw-tarball/npm-12.2.1.patch infra/gateway/openclaw-tarball/npm-distribution.test.mjs /tmp/
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && patch --batch --forward --directory=/usr/local/lib/node_modules/npm -p1 < /tmp/npm-12.2.1.patch \
    && node /tmp/npm-distribution.test.mjs /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = "$NPM_VERSION" \
    && test "$(npx --version)" = "$NPM_VERSION"

FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS llm-broker-builder
RUN rm -rf /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /llm-broker
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY llm-broker/.npmrc llm-broker/package.json llm-broker/package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY llm-broker/tsconfig.json ./
COPY llm-broker/src/ ./src/
RUN npm run build

FROM scratch AS llm-broker-package
COPY --from=llm-broker-builder /llm-broker/package.json /llm-broker/package.json
COPY --from=llm-broker-builder /llm-broker/dist /llm-broker/dist

# Build context: platform/.
#
# octogee-api compiles gateway-edge/src/* in addition to its own src/ —
# the cluster route handlers physically live in gateway-edge/src/routes/
# and are imported via relative paths from octogee-api/src.
# When gateway-edge is later slimmed to just its ~3 locality routes,
# the bulk of the route code moves out of that tree and this
# Dockerfile's COPY surface shrinks accordingly.
#
# Mirror of gateway-edge's build pattern: rootDir=.. so tsc emits
# dist/octogee-api/src/ alongside dist/gateway-edge/src/ (the routes).
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS builder
RUN rm -rf /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /octogee-api

# Packed internal directory dependencies must be present at their declared sibling paths.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY --from=llm-broker-package / /
COPY octogee-api/.npmrc octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --ignore-scripts

# octogee-api compiles gateway-edge/src/* (the cluster route handlers). Install
# gateway-edge's deps so its package imports resolve during tsc by walking up
# from /gateway-edge/src/. Builder stage only.
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* /gateway-edge/
RUN npm ci --prefix /gateway-edge --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY octogee-api/tsconfig.json ./
COPY octogee-api/src/ ./src/
COPY gateway-edge/src/ /gateway-edge/src/

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
COPY --from=llm-broker-package / /
COPY octogee-api/.npmrc octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm rebuild better-sqlite3 --foreground-scripts \
    && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()"

# Runtime module resolution note: the BUILDER stage installs gateway-edge
# deps at /gateway-edge/node_modules so tsc can resolve npm packages
# imported by files under /gateway-edge/src/. That's a build-time
# concern only. At RUNTIME, the compiled .js lives under
# /octogee-api/dist/gateway-edge/... — Node's resolution walks UP from
# that path through /octogee-api/dist → /octogee-api → /octogee-api/node_modules.
# So all runtime imports resolve through octogee-api's deps, not
# gateway-edge's. No /gateway-edge install here (was previously dead
# weight + a silent divergence trap if the two package.jsons drifted).
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
