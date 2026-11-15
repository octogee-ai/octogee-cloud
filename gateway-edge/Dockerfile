FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS platform-npm
ARG NPM_VERSION=12.2.1
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
COPY gateway/openclaw-tarball/npm-12.2.1.patch gateway/openclaw-tarball/npm-distribution.test.mjs /tmp/
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && patch --batch --forward --directory=/usr/local/lib/node_modules/npm -p1 < /tmp/npm-12.2.1.patch \
    && node /tmp/npm-distribution.test.mjs /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = "$NPM_VERSION" \
    && test "$(npx --version)" = "$NPM_VERSION"

# Build context: platform/. gateway-edge consumes packed internal directory
# dependencies; no sibling source is compiled.
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS builder
RUN rm -rf /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /gateway-edge
# Packed directories must be present before npm ci resolves their type interfaces.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY gateway-edge/tsconfig.json ./
COPY gateway-edge/src/ ./src/
# `npm run build` = tsc → tsc-alias → verify:no-alias-leakage. The
# alias rewriter and post-build grep guard together prevent the
# MODULE_NOT_FOUND @shared/* runtime failure. See README "Shared code".
RUN npm run build

FROM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS gitleaks-builder
ARG GITLEAKS_VERSION=8.30.1
RUN GODEBUG=http2client=0 CGO_ENABLED=0 go install \
      -ldflags="-X github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION} -X github.com/zricethezav/gitleaks/v8/version.DefaultMsg=${GITLEAKS_VERSION}" \
      github.com/zricethezav/gitleaks/v8@v${GITLEAKS_VERSION} \
    && test "$(/go/bin/gitleaks version)" = "${GITLEAKS_VERSION}"

FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
ARG OS_PACKAGE_REFRESH=2026-11-11
RUN test -n "$OS_PACKAGE_REFRESH" && apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY deploy/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem
WORKDIR /gateway-edge
# git + openssh-client are required for the Phase 6 working-tree
# routes (`core/src/workspace/workspace-git.ts`). Without them
# `spawn('git', …)` ENOENTs and `git push` over SSH has no transport.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=gitleaks-builder /go/bin/gitleaks /usr/local/bin/gitleaks
# The runtime install packs the direct internal directory dependencies.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /gateway-edge/dist ./dist
COPY gateway-edge/agent-import-gitleaks.toml ./agent-import-gitleaks.toml
USER node
EXPOSE 3001
ENV PORT=3001
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/gateway-edge/src/main.js"]
