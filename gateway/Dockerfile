ARG OPENCLAW_BASE_IMAGE=octogee-gateway-base
ARG RUNTIME_BASE_IMAGE=${OPENCLAW_BASE_IMAGE}
ARG GATEWAY_SYSTEM_IMAGE=${OPENCLAW_BASE_IMAGE}

FROM ${GATEWAY_SYSTEM_IMAGE} AS gateway-dependencies

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

COPY --chown=node:node core/package.json /octogee/core/package.json
COPY --chown=node:node core-testing/package.json /octogee/core-testing/package.json
COPY --chown=node:node shared/package.json shared/package-lock.json /octogee/shared/
COPY --chown=node:node shared/vendor/picomatch/ /octogee/shared/vendor/picomatch/
COPY --chown=node:node gateway-supervisor/.npmrc gateway-supervisor/package.json gateway-supervisor/package-lock.json /octogee/scripts/
COPY --chown=node:node gateway-supervisor/vendor/picomatch/ /octogee/scripts/vendor/picomatch/

WORKDIR /octogee/scripts
RUN npm install --no-audit --no-fund \
    && cd /octogee/shared && npm ci --no-audit --no-fund

FROM gateway-dependencies AS gateway-production-dependencies

RUN npm prune --omit=dev --no-audit --no-fund \
    && cd /octogee/shared && npm prune --omit=dev --no-audit --no-fund

FROM ${GATEWAY_SYSTEM_IMAGE} AS gateway-local-packages

USER root

COPY core/package.json /octogee/core/package.json
COPY core/dist /octogee/core/dist
COPY shared/package.json /octogee/shared/package.json
COPY shared/dist /octogee/shared/dist
COPY gateway/pack-local-deps.sh /tmp/pack-local-deps.sh
RUN bash /tmp/pack-local-deps.sh /octogee/core /packages/@octogee/core \
    && bash /tmp/pack-local-deps.sh /octogee/shared /packages/@octogee/shared

# A product build replaces this stage with `--build-context product=<product dir>`: its
# extensions and tier templates add to the platform's, its gateway-supervisor/src/main.ts replaces the
# platform composition root, and the libraries its overlay dependencies stage under
# gateway-supervisor/node_modules join the platform's. Without one, the platform stands in as its own product.
FROM scratch AS product
COPY gateway/extensions/platform/ /gateway/extensions/
COPY gateway-supervisor/src/ /gateway-supervisor/src/
COPY --from=gateway-local-packages /packages/ /gateway-supervisor/node_modules/
COPY templates/tiers/ /templates/tiers/

FROM ${OPENCLAW_BASE_IMAGE} AS gateway-build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /octogee/scripts

COPY --from=gateway-dependencies /octogee /octogee
COPY --from=gateway-local-packages --chown=node:node /packages /octogee/scripts/node_modules
COPY --chown=node:node --from=product gateway-supervisor/node_modules/ /octogee/scripts/node_modules/
COPY --from=gateway-local-packages --chown=node:node /octogee/core/dist /octogee/core/dist
COPY --chown=node:node shared/ /octogee/shared/

COPY --chown=node:node gateway-supervisor/entrypoints/ /octogee/scripts/entrypoints/
COPY --chown=node:node gateway-supervisor/libexec/ /octogee/scripts/libexec/
COPY --chown=node:node gateway-supervisor/secret-resolver.mjs /octogee/scripts/
COPY --chown=node:node gateway-supervisor/publish-gateway-token.mjs /octogee/scripts/
COPY --chown=node:node gateway-supervisor/tsconfig.json /octogee/scripts/
COPY --chown=node:node gateway-supervisor/lib/ /octogee/scripts/lib/
COPY --chown=node:node gateway-supervisor/src/ /octogee/scripts/src/
COPY --chown=node:node --from=product gateway-supervisor/src/ /octogee/scripts/src/
COPY --chown=node:node gateway-supervisor/ops/verify-native-modules.mjs /octogee/scripts/ops/
COPY --chown=node:node gateway-supervisor/ops/migrate-user-stores.ts \
      gateway-supervisor/ops/write-image-agent-schema-descriptor.ts /octogee/scripts/ops/
RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/secret-resolver.mjs \
      --bundle --platform=node --format=esm \
      --outfile=/tmp/octogee-secret-resolver.mjs \
    && cp /tmp/octogee-secret-resolver.mjs /octogee/scripts/secret-resolver.mjs \
    && rm /tmp/octogee-secret-resolver.mjs

RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/entrypoints/source-transfer-stage.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=/octogee/scripts/source-transfer-stage.mjs
RUN /octogee/scripts/node_modules/.bin/esbuild \
      /octogee/scripts/entrypoints/supervise-runner.ts \
      /octogee/scripts/entrypoints/provisioner.ts \
      /octogee/scripts/entrypoints/byosub-syncback-runner.ts \
      /octogee/scripts/entrypoints/runner-metrics-exporter.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outdir=/octogee/scripts/shared-runners --out-extension:.js=.mjs
RUN /octogee/scripts/node_modules/.bin/esbuild \
      /octogee/scripts/entrypoints/shared-maintenance-startup.ts \
      /octogee/scripts/entrypoints/prestop-flush.ts \
      /octogee/scripts/entrypoints/user-identity.ts \
      /octogee/scripts/entrypoints/clean-user-project-placeholders.ts \
      /octogee/scripts/entrypoints/claim-ephemeral-writer.ts \
      /octogee/scripts/entrypoints/recover-restarted-gateway-container-locks.ts \
      /octogee/scripts/entrypoints/system-config-restore.ts \
      /octogee/scripts/entrypoints/configured-user-bootstrap.ts \
      /octogee/scripts/entrypoints/isolated-runtime-state-restore.ts \
      /octogee/scripts/entrypoints/agent-anchor-restore.ts \
      /octogee/scripts/entrypoints/pre-boot-config.ts \
      /octogee/scripts/entrypoints/ensure-configured-agent-runtime-dirs.ts \
      /octogee/scripts/entrypoints/user-claim.ts \
      /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts \
      /octogee/scripts/entrypoints/surge-openclaw-supervisor.ts \
      /octogee/scripts/entrypoints/prepare-openclaw-sqlite-journals.ts \
      /octogee/scripts/entrypoints/openclaw-boot-sentinel.ts \
      /octogee/scripts/entrypoints/isolated-toolchain-hydrator.ts \
      /octogee/scripts/entrypoints/system-config-watch.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outdir=/octogee/scripts/bundled-entrypoints --out-extension:.js=.mjs

RUN /octogee/scripts/node_modules/.bin/tsc -p tsconfig.json --noEmit \
    || { echo "Type-check failed — fix errors before deploying" >&2; exit 1; }

# ── Workspace templates ─────────────────────────────────────────────────────
# ── Plugin extensions ────────────────────────────────────────────────────────
# Staged at /octogee/extensions/ and projected into ~/.openclaw/extensions/.
# Each extension ships as one self-contained index.js: runtime dependencies are
# bundled in, only node builtins and openclaw/plugin-sdk/* stay external, and no
# node_modules tree is left for OpenClaw's plugin-generation capture to copy.
COPY --chown=node:node gateway/extensions/platform/ /octogee/extensions/
COPY --chown=node:node --from=product gateway/extensions/ /octogee/extensions/
COPY --chown=node:node gateway/build-extensions.mjs \
      gateway/extension-manifest.mjs \
      gateway/verify-extension-bundles.mjs \
      /octogee/gateway/
RUN node /octogee/gateway/build-extensions.mjs \
      /octogee/extensions \
      /octogee/scripts/node_modules/.bin/esbuild

COPY gateway/bundled-extensions/octogee-identity-tools/ /octogee/bundled-extensions/octogee-identity-tools/
RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/bundled-extensions/octogee-identity-tools/index.ts \
      --bundle --platform=node --format=esm --target=node24 --packages=external \
      --alias:@octogee/core=/octogee/core/dist --alias:@octogee/shared=/octogee/shared/dist \
      --outfile=/octogee/bundled-extensions/octogee-identity-tools/index.js \
    && rm /octogee/bundled-extensions/octogee-identity-tools/index.ts

# ── Extension bundle gate ───────────────────────────────────────────────────
# A plugin whose imports do not resolve is skipped at boot — the gateway comes
# up Ready with fewer plugins than configured and only `openclaw` CLI output
# names the missing module. Load each bundle here, where a failure can still
# stop the image from being pushed, and refuse any leftover node_modules.
RUN node /octogee/gateway/verify-extension-bundles.mjs /octogee/extensions /usr/local/lib/node_modules/openclaw

FROM gateway-build AS gateway-payload

RUN rm -rf /octogee/scripts/node_modules /octogee/shared/node_modules

FROM ${RUNTIME_BASE_IMAGE} AS gateway-runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/scripts/node_modules /octogee/scripts/node_modules
COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/shared/node_modules /octogee/shared/node_modules
COPY --from=gateway-local-packages --chown=node:node /packages /octogee/scripts/node_modules
COPY --chown=node:node --from=product gateway-supervisor/node_modules/ /octogee/scripts/node_modules/
COPY --from=gateway-payload --chown=node:node /octogee/core /octogee/core
COPY --from=gateway-payload --chown=node:node /octogee/scripts /octogee/scripts
COPY --from=gateway-payload --chown=node:node /octogee/shared /octogee/shared
COPY --from=gateway-payload --chown=node:node /octogee/extensions /octogee/extensions
COPY --from=gateway-payload --chown=root:root /octogee/bundled-extensions/octogee-identity-tools /usr/local/lib/node_modules/openclaw/dist/extensions/octogee-identity-tools
COPY deploy/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem
RUN chown root:root /octogee/scripts \
    && chmod 755 /octogee/scripts \
    && chmod 500 /octogee/scripts/secret-resolver.mjs
RUN node /octogee/scripts/ops/verify-native-modules.mjs
RUN /octogee/scripts/node_modules/.bin/tsx /octogee/scripts/ops/write-image-agent-schema-descriptor.ts \
    && rm /octogee/scripts/ops/write-image-agent-schema-descriptor.ts

# Workspace templates are runtime data and bypass the build stage.
COPY --chown=node:node templates/claws/ /octogee/templates/claws/
COPY --chown=node:node templates/github-workflow/ /octogee/templates/github-workflow/
COPY --chown=node:node templates/shared/ /octogee/templates/shared/
COPY --chown=node:node templates/tiers/ /octogee/templates/tiers/
COPY --chown=node:node --from=product templates/ /octogee/templates/

# ── Computer-use skills ────────────────────────────────────────────────────
COPY gateway/hobby-skills /opt/octogee/skills/computer-x11
COPY gateway/cua-skills /tmp/cua-skills
COPY gateway/install-cua-skills.mjs /tmp/install-cua-skills.mjs
RUN node /tmp/install-cua-skills.mjs "$(npm root -g)/openclaw" /tmp/cua-skills /opt/octogee/skills/computer \
    && rm -rf /tmp/cua-skills /tmp/install-cua-skills.mjs

# ── Entrypoint + config templates ──────────────────────────────────────────
COPY --chown=node:node gateway/openclaw.template.json /octogee/gateway/openclaw.template.json
COPY --chown=node:node gateway/openclaw.isolated.template.json /octogee/gateway/openclaw.isolated.template.json
COPY --chown=node:node gateway/workflow-tools.mjs /octogee/gateway/workflow-tools.mjs
COPY --chown=node:node gateway/apply-gateway-class-policy.mjs /octogee/gateway/apply-gateway-class-policy.mjs
COPY --chown=node:node gateway/quarantine-user-cron-jobs.mjs /octogee/gateway/quarantine-user-cron-jobs.mjs
COPY --chmod=755 gateway/shared-auxiliary-runner.sh /octogee/gateway/shared-auxiliary-runner.sh
COPY --chmod=755 gateway/bundled-entrypoint-runner.sh /octogee/gateway/bundled-entrypoint-runner.sh
COPY gateway/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY gateway/gateway-class-dual-read.sh /usr/local/libexec/gateway-class-dual-read.sh
COPY gateway/desktop-node.sh /usr/local/bin/octogee-desktop-node
COPY gateway/hobby-desktop.sh /usr/local/bin/octogee-hobby-desktop
COPY gateway/hobby-session.sh /usr/local/bin/octogee-hobby-session
COPY desktop/rootfs/usr/local/bin/octo-desktop-browser /usr/local/bin/octo-desktop-browser
COPY desktop/rootfs/usr/local/bin/octo-desktop-control /usr/local/bin/octo-desktop-control
COPY desktop/rootfs/usr/share/omarchy/octo-desktop/desk /usr/share/omarchy/octo-desktop/desk
COPY desktop/image/rootfs/etc/chromium/policies/managed/octogee-desk.json /etc/chromium/policies/managed/octogee-desk.json
COPY gateway/hobby-desktop/rc.xml gateway/hobby-desktop/menu.xml gateway/hobby-desktop/tint2rc /usr/share/octogee/hobby-desktop/
COPY gateway/hobby-desktop/theme /usr/share/themes/Octogee
COPY gateway/hobby-desktop/applications /usr/share/applications
COPY gateway/hobby-desktop/icons/hicolor /usr/share/icons/hicolor
COPY gateway/octogee /usr/local/bin/octogee
COPY gateway/octo-desk /usr/local/bin/octo-desk
COPY --chmod=755 gateway/octo-project /usr/local/bin/octo-project
COPY gateway/octo-desktop-style /usr/local/bin/octo-desktop-style
COPY gateway/isolated-toolchain-wrapper.sh /usr/local/libexec/octogee-isolated-toolchain
COPY gateway/verify-openclaw-runtime-deps.sh /usr/local/bin/verify-openclaw-runtime-deps
COPY gateway/verify-runtime-image.sh /usr/local/bin/verify-runtime-image
COPY gateway/verify-config-templates.mjs /usr/local/libexec/verify-config-templates.mjs
ARG OPENCLAW_RUNTIME_PLUGINS=mattermost,parallel-plugin,codex
ARG ENABLE_BUILDER_TOOLCHAIN_WRAPPER=false
RUN chmod 755 /usr/local/bin/octogee-hobby-desktop /usr/local/bin/octogee-hobby-session /usr/local/bin/octo-desktop-browser /usr/local/bin/octo-desktop-control /usr/local/bin/entrypoint.sh /usr/local/bin/octogee-desktop-node /usr/local/bin/octogee /usr/local/bin/octo-desk /usr/local/bin/octo-desktop-style /usr/local/bin/verify-openclaw-runtime-deps /usr/local/bin/verify-runtime-image /usr/local/libexec/octogee-isolated-toolchain \
    && /usr/local/bin/verify-openclaw-runtime-deps "$OPENCLAW_RUNTIME_PLUGINS" \
    && case "$ENABLE_BUILDER_TOOLCHAIN_WRAPPER" in \
      false) \
        test -x /usr/local/bin/claude \
        && test -x /usr/local/bin/codex \
        && test -x /usr/bin/chromium \
        && test -x /usr/bin/gtk-launch \
        && test -x /usr/bin/tint2 \
        && test -x /usr/bin/sakura \
        && test -x /usr/bin/mousepad \
        && test -f /usr/share/themes/Octogee/openbox-3/themerc \
        && python3 -c 'import xml.etree.ElementTree as tree; tree.parse("/usr/share/octogee/hobby-desktop/rc.xml"); tree.parse("/usr/share/octogee/hobby-desktop/menu.xml")' \
        && grep -qxF 'Exec=/usr/local/bin/octo-desktop-browser --new-window %U' /usr/share/applications/chromium.desktop \
        ;; \
      true) \
        rm -f /usr/local/bin/claude /usr/local/bin/codex /usr/bin/chromium \
        && ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/local/bin/claude \
        && ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/local/bin/codex \
        && ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/bin/chromium \
        ;; \
      *) \
        echo "ENABLE_BUILDER_TOOLCHAIN_WRAPPER must be true or false" >&2 \
        && exit 2 \
        ;; \
    esac

# ── Runtime image gate ──────────────────────────────────────────────────────
ARG IMAGE_PROFILE=gateway
RUN /usr/local/bin/verify-runtime-image "$IMAGE_PROFILE" \
    && cd /octogee/scripts \
    && node --input-type=module -e 'import { beginWorkspaceIdentityBoot } from "@octogee/core/openclaw-workspace-bootstrap"; beginWorkspaceIdentityBoot({ GATEWAY_CLASS: "shared" });'

COPY gateway/.bashrc /etc/skel/.bashrc
COPY gateway/.bashrc /home/node/.bashrc
RUN chown node:node /home/node/.bashrc \
    && install -d -o node -g node /home/node/.cache

# Restore working directory + non-root user
WORKDIR /home/node
USER node
RUN node /usr/local/libexec/verify-config-templates.mjs /octogee/gateway /octogee/extensions /opt/openclaw-runtime-deps/npm

ENV OCTOGEE_TEMPLATES_DIR=/octogee/templates
ENV PATH=/work/cache/toolchains/active/bin:${PATH}

# Suppress Node.js deprecation warnings (punycode etc.) from third-party deps
ENV NODE_OPTIONS=--no-deprecation
ENV OPENCLAW_OFFLINE=1
ENV CLAUDE_BIN=/usr/local/bin/claude

# Build SHA — injected by Cloud Build via --build-arg
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
