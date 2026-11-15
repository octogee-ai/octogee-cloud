FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS platform-npm
ARG NPM_VERSION=12.2.1
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
COPY gateway/openclaw-tarball/npm-12.2.1.patch gateway/openclaw-tarball/npm-distribution.test.mjs /tmp/
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && patch --batch --forward --directory=/usr/local/lib/node_modules/npm -p1 < /tmp/npm-12.2.1.patch \
    && node /tmp/npm-distribution.test.mjs /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = "$NPM_VERSION" \
    && test "$(npx --version)" = "$NPM_VERSION"

FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
ARG OS_PACKAGE_REFRESH=2026-11-11
RUN test -n "$OS_PACKAGE_REFRESH" && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

WORKDIR /app/provisioning-service
COPY core/package.json /app/core/package.json
COPY core/dist /app/core/dist
COPY shared/package.json /app/shared/package.json
COPY shared/dist /app/shared/dist

COPY provisioning-service/.npmrc provisioning-service/package.json provisioning-service/package-lock.json ./
RUN npm ci --ignore-scripts

COPY provisioning-service/tsconfig.json ./
COPY provisioning-service/src ./src
RUN npx tsc -p tsconfig.json \
  && npm prune --omit=dev

ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA} \
    NODE_ENV=production
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/src/main.js"]
