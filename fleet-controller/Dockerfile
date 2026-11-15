FROM scratch AS overlay
COPY fleet-controller/src/main.ts /src/main.ts

# A product build replaces this stage with `--build-context product=<product dir>`:
# its charts/octogee and charts/octogee-gateway values files join the baked charts.
# Without one, the platform values stand in as their own product.
FROM scratch AS product
COPY charts/octogee/values*.yaml /charts/octogee/
COPY charts/octogee-gateway/values*.yaml /charts/octogee-gateway/

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
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm
COPY --from=platform-npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY deploy/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem

# Helm is PINNED to one version across every path that runs `helm upgrade`
# against the cluster — CI's toolchain (ci/install-tools.sh) and the isolated
# toolchain (gateway/isolated-toolchain/groups.json) — so the
# umbrella upgrade and the fleet controller's per-gateway upgrades share identical
# server-side-apply semantics. helm-runner.ts relies on v4's `--server-side=true
# --force-conflicts` string-flag syntax + `--take-ownership` (adopts leftover
# unowned resources rather than wedging a roll); the build verifies all three
# flags below before publishing. Bump all three sites together. kubectl is
# also pinned — resolving it from dl.k8s.io/release/stable.txt at build time
# made this image's bytes depend on an untracked, time-varying network read,
# which the per-image build-fingerprint (.github/actions/build-image-fingerprint/)
# can't see: two builds from an identical git tree could silently get
# different kubectl versions, defeating fingerprint-based reuse.
ARG HELM_VERSION=v4.3.1
ARG KUBECTL_VERSION=v1.36.6

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && case "$(dpkg --print-architecture)" in \
       amd64) HELM_SHA256=0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b; KUBECTL_SHA256=29818b6729dc9262b692307470d0558d027725e738be5dd47c760261868a2634 ;; \
       arm64) HELM_SHA256=8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88; KUBECTL_SHA256=35507ef408c3d38849e5d3203e18f8e861db822aa664101a9ced0869edd06046 ;; \
       *) echo "Unsupported controller architecture" >&2; exit 1 ;; \
     esac \
  && echo "Installing helm ${HELM_VERSION}" \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://get.helm.sh/helm-${HELM_VERSION}-linux-$(dpkg --print-architecture).tar.gz" \
       --output /tmp/helm.tar.gz \
  && echo "${HELM_SHA256}  /tmp/helm.tar.gz" | sha256sum -c - \
  && tar -xz -f /tmp/helm.tar.gz -C /tmp \
  && mv "/tmp/linux-$(dpkg --print-architecture)/helm" /usr/local/bin/helm \
  && rm -rf "/tmp/linux-$(dpkg --print-architecture)" /tmp/helm.tar.gz \
  && echo "Installing kubectl ${KUBECTL_VERSION}" \
  && curl -fsSL -o /usr/local/bin/kubectl \
       "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
  && echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl \
  && helm version --short \
  && helm upgrade --help | grep -q -- '--server-side' \
  && helm upgrade --help | grep -q -- '--force-conflicts' \
  && helm upgrade --help | grep -q -- '--take-ownership' \
  && kubectl version --client=true

# Build context must be the repo root: `docker build -f
# fleet-controller/Dockerfile .` from the repo root. tsconfig rootDir: ".."
# emits dist/fleet-controller/src/ (matches the ENTRYPOINT below).
WORKDIR /app/fleet-controller

# Packed internal directory dependencies must exist at the declared sibling paths
# before npm ci. Single-stage, so they remain available for runtime resolution.
COPY core/package.json /app/core/package.json
COPY core/dist /app/core/dist
COPY shared/package.json /app/shared/package.json
COPY shared/dist /app/shared/dist
COPY core-testing/package.json /app/core-testing/package.json
COPY core-testing/dist /app/core-testing/dist

# Two-stage install: dev deps for the build (typescript), then prune to
# runtime-only after `tsc` finishes. Avoids `npx tsc` falling back to a
# downloaded unpinned compiler.
COPY fleet-controller/.npmrc fleet-controller/package.json fleet-controller/package-lock.json* ./
# --ignore-scripts for parity with every other service image: nothing here is
# native, so no dependency install script is load-bearing. npm 12 already
# blocks them (no allowScripts policy) and says so only in a warning — stating
# the intent keeps the image independent of which npm builds it (#2834).
RUN npm ci --ignore-scripts

COPY fleet-controller/tsconfig.json ./
COPY fleet-controller/src ./src
COPY --from=overlay / ./

RUN npx tsc \
  && npm prune --omit=dev
COPY --from=overlay / ./

# Bake both helm charts into the image:
#   - /charts/octogee         — umbrella (mattermost, gitea, glm-controller,
#                               ingresses, gateway-fleet spanning resources)
#   - /charts/octogee-gateway — standalone single-instance gateway pod chart
#                               (one helm release per gateway instance,
#                               installed by the fleet controller at runtime)
# Chart pins move with the controller's image SHA — no runtime git
# clone, no drift between desired-state writes and the chart shape
# the fleet controller renders against.
COPY charts/octogee         /charts/octogee
COPY charts/octogee-gateway /charts/octogee-gateway
COPY --from=product charts/octogee/values*.yaml         /charts/octogee/
COPY --from=product charts/octogee-gateway/values*.yaml /charts/octogee-gateway/

USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/fleet-controller/src/main.js"]
