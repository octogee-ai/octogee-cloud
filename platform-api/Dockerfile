FROM scratch AS overlay
COPY platform-api/src/main.ts /src/main.ts

FROM scratch AS gateway-edge-overlay
COPY gateway-edge/src/index.ts /src/index.ts

FROM scratch AS packed-package
COPY platform-api/.npmrc /.npmrc

FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS platform-npm
ARG NPM_VERSION=12.2.1
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
COPY gateway/openclaw-tarball/npm-12.2.1.patch gateway/openclaw-tarball/npm-distribution.test.mjs /tmp/
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && patch --batch --forward --directory=/usr/local/lib/node_modules/npm -p1 < /tmp/npm-12.2.1.patch \
    && node /tmp/npm-distribution.test.mjs /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = "$NPM_VERSION" \
    && test "$(npx --version)" = "$NPM_VERSION"

FROM platform-npm AS packer
COPY --from=packed-package / /packed-package/
RUN mkdir -p /packed \
    && if [ -f /packed-package/package.json ]; then \
        destination="/packed/$(node -p 'require("/packed-package/package.json").name.split("/").pop()')" \
        && mkdir -p "$destination" \
        && cd /packed-package \
        && npm pack --ignore-scripts --pack-destination "$destination"; \
    fi

# Build context: platform/.
#
# octogee-api compiles gateway-edge/src/* in addition to its own src/ —
# the cluster route handlers physically live in gateway-edge/src/routes/
# and are imported via relative paths from platform-api/src.
# When gateway-edge is later slimmed to just its ~3 locality routes,
# the bulk of the route code moves out of that tree and this
# Dockerfile's COPY surface shrinks accordingly.
#
# Mirror of gateway-edge's build pattern: rootDir=.. so tsc emits
# dist/<WORKDIR name>/src/ alongside dist/gateway-edge/src/ (the routes). The
# image keeps dist/octogee-api/src/, the path chart commands name.
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

# octogee-api compiles gateway-edge/src/* (the cluster route handlers). Install
# gateway-edge's deps so its package imports resolve during tsc by walking up
# from /gateway-edge/src/. Builder stage only.
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* /gateway-edge/
RUN npm ci --prefix /gateway-edge --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY platform-api/tsconfig.json ./
COPY platform-api/src/ ./src/
COPY --from=overlay / ./
COPY gateway-edge/src/ /gateway-edge/src/
COPY --from=gateway-edge-overlay / /gateway-edge/

RUN npm run build

# Project code runs only in this deliberately narrow image. It contains the
# fixed runner wrapper, archive validator, npm, and JSZip—no API routes, core
# runtime, cloud SDKs, platform credentials, or production dependency tree.
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS project-runner
ARG OS_PACKAGE_REFRESH=2026-11-11
RUN test -n "$OS_PACKAGE_REFRESH" && apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /runner
COPY --from=overlay runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=builder /octogee-api/dist/octogee-api/src/project-runner.js ./dist/octogee-api/src/project-runner.js
COPY --from=builder /octogee-api/dist/octogee-api/src/lib/project-runs/archive.js ./dist/octogee-api/src/lib/project-runs/archive.js
COPY --from=builder /octogee-api/dist/octogee-api/src/lib/project-runs/contracts.js ./dist/octogee-api/src/lib/project-runs/contracts.js
USER node
ENTRYPOINT ["node", "dist/octogee-api/src/project-runner.js"]

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
COPY --from=overlay node_modules* ./node_modules/

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
COPY --from=packer /packed/ ./

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
