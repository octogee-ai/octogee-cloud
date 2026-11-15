import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayBakePlan } from "../ci/gateway-bake.mjs";

const repoRoot = path.resolve("..");

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoRoot, filePath), "utf8");
}

function installedAptPackages(filePath: string): Set<string> {
  const packages = new Set<string>();
  const installCommand = "apt-get install -y --no-install-recommends";
  let collecting = false;

  for (const rawLine of readRepoFile(filePath).split("\n")) {
    let line = rawLine;

    if (line.includes(installCommand)) {
      collecting = true;
      line = line.slice(line.indexOf(installCommand) + installCommand.length);
    }

    if (!collecting) {
      continue;
    }

    const reachedCleanup = line.includes("rm -rf /var/lib/apt/lists");
    const packageSegment = line
      .split("rm -rf /var/lib/apt/lists")[0]
      .split("#")[0]
      .replace(/\\/g, " ");

    for (const token of packageSegment.split(/\s+/)) {
      if (/^[a-z0-9][a-z0-9+.-]*$/i.test(token)) {
        packages.add(token);
      }
    }

    if (reachedCleanup) {
      collecting = false;
    }
  }

  return packages;
}

function gatewayImageArgs(): Record<string, Record<string, string>> {
  const base = `inputs-${"b".repeat(64)}`;
  const { target } = gatewayBakePlan({
    repository: "us-central1-docker.pkg.dev/octogee/octogee",
    sha: "a".repeat(40),
    base,
    isolatedBase: `${base}-builder-${"c".repeat(12)}`,
    toolchain: { lockSha256: "d".repeat(64), groupsSha256: "e".repeat(64) },
    build: { base: false, isolatedBase: false, images: ["octogee-gateway", "octogee-gateway-builder"] },
  });
  return {
    "octogee-gateway": target["octogee-gateway"].args,
    "octogee-gateway-builder": target["octogee-gateway-builder"].args,
  };
}

function runInstructionContaining(dockerfile: string, needle: string): string {
  const instruction = dockerfile
    .split(/\n(?=[A-Z]+\s)/u)
    .find((block) => block.startsWith("RUN ") && block.includes(needle));
  if (!instruction) throw new Error(`missing RUN instruction containing ${needle}`);
  return instruction;
}

describe("gateway base image", () => {
  it("installs the controlled workstation over the gateway system before adding OpenClaw", () => {
    const base = readRepoFile("gateway/Dockerfile.base");
    const isolatedBase = readRepoFile("gateway/Dockerfile.isolated-base");
    const userConfig = readRepoFile("gateway/openclaw.isolated.template.json");

    expect(base).toMatch(/^FROM node:\d+\.\d+\.\d+-trixie-slim@sha256:[0-9a-f]{64} AS gateway-debian$/mu);
    expect(base).not.toContain("gateway-core-runtime");
    expect(isolatedBase).toContain("ARG GATEWAY_BASE_IMAGE");
    expect(isolatedBase).toContain("FROM ${GATEWAY_BASE_IMAGE} AS openclaw-runtime");
    expect(isolatedBase).toContain("FROM ${GATEWAY_SYSTEM_IMAGE} AS isolated-toolchain-validation");
    expect(isolatedBase).toContain("FROM ${GATEWAY_SYSTEM_IMAGE} AS isolated-base-system");
    expect(isolatedBase.indexOf("COPY --link --from=openclaw-runtime")).toBeGreaterThan(
      isolatedBase.indexOf("/tmp/isolated-toolchain-validation/ /opt/octogee/toolchains/image/"),
    );
    expect(isolatedBase).toContain("gateway/isolated-toolchain/package.json /octogee/toolchain/package.json");
    expect(isolatedBase).toContain("gateway/isolated-toolchain/package-lock.json /octogee/toolchain/package-lock.json");
    expect(isolatedBase).toContain("gateway/isolated-toolchain/groups.json /octogee/toolchain/groups.json");
    expect(isolatedBase).toContain("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256");
    expect(isolatedBase).toContain("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256");
    expect(isolatedBase).toContain("DEBIAN_PACKAGES=");
    expect(isolatedBase).toContain("standaloneTools.gcloud.version");
    expect(isolatedBase).toContain("pip3 install --break-system-packages --no-cache-dir");
    expect(JSON.parse(userConfig).plugins.entries.codex).toEqual({ enabled: true });
    expect(userConfig).not.toContain('"browser": {\n    "enabled": true');
  });

  it("keeps post-readiness hydration npm-only", () => {
    const hydrator = readRepoFile("scripts/lib/isolated-toolchain-hydrator.ts");
    const isolatedBase = readRepoFile("gateway/Dockerfile.isolated-base");

    expect(hydrator).toContain('"ci",');
    expect(hydrator).toContain("--prefer-offline");
    expect(hydrator).not.toContain("apt-get");
    expect(hydrator).not.toContain("dpkg-deb");
    expect(hydrator).not.toContain("/usr/bin/curl");
    expect(isolatedBase).toContain("apt-get install -y --no-install-recommends $DEBIAN_PACKAGES");
    expect(isolatedBase).toContain("google-cloud-cli-${GCLOUD_VERSION}-linux-x86_64.tar.gz");
  });

  it("pins the post-readiness user tools and their npm integrity", () => {
    const packageJson = JSON.parse(
      readRepoFile("gateway/isolated-toolchain/package.json"),
    ) as {
      dependencies: Record<string, string>;
      allowScripts: Record<string, boolean>;
    };
    const packageLock = JSON.parse(
      readRepoFile("gateway/isolated-toolchain/package-lock.json"),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };

    expect(packageJson.dependencies).toEqual({
      "@anthropic-ai/claude-code": "2.1.322",
      "@openai/codex": "0.167.1",
      "@sparticuz/chromium": "153.0.0",
      "firebase-tools": "15.35.0",
      "npm-check-updates": "23.1.1",
      "pnpm": "12.18.0",
      "tsx": "4.23.15",
      "typescript": "7.0.2",
    });
    expect(packageJson.allowScripts).toEqual({
      "@anthropic-ai/claude-code@2.1.322": true,
      "esbuild@0.28.2": true,
      "pnpm@12.18.0": true,
      "protobufjs@7.6.6": true,
      "re2@1.27.0": true,
    });
    expect(packageLock.packages["node_modules/@anthropic-ai/claude-code"]).toMatchObject({
      version: "2.1.322",
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(packageLock.packages["node_modules/@openai/codex"]).toMatchObject({
      version: "0.167.1",
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(packageLock.packages["node_modules/@sparticuz/chromium"]).toMatchObject({
      version: "153.0.0",
      integrity: expect.stringMatching(/^sha512-/),
    });
    for (const packageName of [
      "firebase-tools", "npm-check-updates", "pnpm", "tsx", "typescript",
    ]) {
      expect(packageLock.packages[`node_modules/${packageName}`]).toMatchObject({
        version: packageJson.dependencies[packageName],
        integrity: expect.stringMatching(/^sha512-/),
      });
    }

    const isolatedBase = readRepoFile("gateway/Dockerfile.isolated-base");
    expect(isolatedBase).toContain("npm ci --omit=dev --include=optional");
    expect(isolatedBase).toContain("node_modules/.bin/claude --version");
    expect(isolatedBase).toContain("node_modules/.bin/codex --version");
    expect(isolatedBase).toContain("node_modules/@sparticuz/chromium/bin/chromium.br");
    expect(isolatedBase).toContain("node_modules/.bin/firebase --version");
    expect(isolatedBase).toContain("node_modules/.bin/pnpm --version");
    expect(isolatedBase).toContain("unexpected Anthropic platform payload");
    expect(isolatedBase).toContain("unexpected OpenAI platform payload");
  });

  it("keeps the OpenClaw launcher rooted beside its imported package files", () => {
    const base = readRepoFile("gateway/Dockerfile.base");

    expect(base).not.toContain(
      "COPY --from=openclaw-installer /usr/local/bin/openclaw /usr/local/bin/openclaw",
    );
    expect(base.match(/ln -s \.\.\/lib\/node_modules\/openclaw\/openclaw\.mjs \/usr\/local\/bin\/openclaw/g))
      .toHaveLength(1);
    expect(base.match(/require\('\/usr\/local\/lib\/node_modules\/openclaw\/package\.json'\)\.bin\.openclaw/g))
      .toHaveLength(1);
  });

  it("pins gitleaks in gateway-edge for fail-closed agent import scanning", () => {
    const dockerfile = readRepoFile("gateway-edge/Dockerfile");
    expect(dockerfile).toContain("ARG GITLEAKS_VERSION=8.30.1");
    expect(dockerfile).toContain("github.com/zricethezav/gitleaks/v8@v${GITLEAKS_VERSION}");
    expect(dockerfile).toContain('test "$(/go/bin/gitleaks version)" = "${GITLEAKS_VERSION}"');
    expect(dockerfile).toContain("COPY --from=gitleaks-builder /go/bin/gitleaks /usr/local/bin/gitleaks");
  });

  it("ships the workstation packages in the shared gateway base image", () => {
    const installed = installedAptPackages("gateway/Dockerfile.base");

    expect([...installed]).toEqual(expect.arrayContaining([
      "curl", "jq", "python3", "git", "sqlite3",
      "chromium", "fonts-liberation", "fonts-noto-color-emoji",
      "tigervnc-standalone-server", "openbox", "tint2", "sakura", "pcmanfm", "mousepad",
    ]));
  });

  it("ships discovery binaries and disables runtime tool downloads", () => {
    const installed = installedAptPackages("gateway/Dockerfile.base");
    const baseDockerfile = readRepoFile("gateway/Dockerfile.base");
    const dockerfile = readRepoFile("gateway/Dockerfile");

    expect(installed.has("ripgrep")).toBe(true);
    expect(installed.has("fd-find")).toBe(false);
    expect(baseDockerfile).toContain("ARG FD_VERSION=10.5.2");
    expect(baseDockerfile).toContain(
      "342a9d1618c4340668cb7ad96d353064bf226ac403add80e587103975d5fa49c",
    );
    expect(baseDockerfile).toContain(
      'echo "${FD_SHA256}  /tmp/fd.deb" | sha256sum -c -',
    );
    expect(dockerfile).toContain("ENV OPENCLAW_OFFLINE=1");
    expect(dockerfile).toContain("/usr/local/libexec/octogee-isolated-toolchain");
    expect(dockerfile).toContain("ENV CLAUDE_BIN=/usr/local/bin/claude");
    expect(dockerfile).not.toMatch(/npm install[^\n]*@anthropic-ai\/claude-code/);
  });

  it("leaves preinstalled Claude and Codex binaries intact for the standard image", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile");
    const wrapperInstruction = runInstructionContaining(
      dockerfile,
      "ENABLE_BUILDER_TOOLCHAIN_WRAPPER",
    );
    const disabledArm = wrapperInstruction.match(/false\)([\s\S]*?);;/u)?.[1];

    expect(dockerfile).toContain("ARG ENABLE_BUILDER_TOOLCHAIN_WRAPPER=false");
    for (const args of Object.values(gatewayImageArgs())) {
      expect(args).not.toHaveProperty("ENABLE_BUILDER_TOOLCHAIN_WRAPPER");
    }
    expect(disabledArm).toContain("test -x /usr/local/bin/claude");
    expect(disabledArm).toContain("test -x /usr/local/bin/codex");
    expect(disabledArm).not.toContain("rm -f");
    expect(disabledArm).not.toContain("ln -s");
  });

  it("keeps boot-critical tools preinstalled in user final builds", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile");
    const wrapperInstruction = runInstructionContaining(
      dockerfile,
      "ENABLE_BUILDER_TOOLCHAIN_WRAPPER",
    );
    const enabledArm = wrapperInstruction.match(/true\)([\s\S]*?);;/u)?.[1];

    expect(enabledArm).toContain(
      "rm -f /usr/local/bin/claude /usr/local/bin/codex /usr/bin/chromium",
    );
    expect(enabledArm).toContain(
      "ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/local/bin/claude",
    );
    expect(enabledArm).toContain(
      "ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/local/bin/codex",
    );
    expect(enabledArm).toContain(
      "ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/bin/chromium",
    );
  });

  it("pins the npm runtime shared by core boot and post-readiness hydration", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile.base");
    const install = runInstructionContaining(dockerfile, "npm install --global /tmp/npm.tgz");
    const npmUpgrade = dockerfile.indexOf(install);

    expect(npmUpgrade).toBeGreaterThan(dockerfile.indexOf("AS gateway-core-system"));
    expect(npmUpgrade).toBeLessThan(dockerfile.indexOf("AS gateway-runtime-system"));
    expect(install).toContain("source=gateway/openclaw-tarball/npm-fork.tgz,target=/tmp/npm.tgz,readonly");
    expect(install).toContain('test "$(npm --version)" = "$NPM_VERSION"');
    expect(install).toContain('test "$(npx --version)" = "$NPM_VERSION"');
    expect(install).toContain("npm cache clean --force");
  });

  it("copies only staged OpenClaw runtime outputs into the shipped stage and verifies them at build time", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile.base");
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM gateway-runtime-system AS gateway-runtime"));

    expect(dockerfile).toContain("FROM gateway-core-system AS openclaw-installer");
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-installer /usr/local/lib/node_modules/openclaw",
    );
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-core-plugin-installer /usr/local/lib/node_modules/openclaw/dist/extensions/mattermost",
    );
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-full-plugin-installer --chown=node:node /opt/openclaw-runtime-deps",
    );
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-full-plugin-installer /usr/local/lib/node_modules/openclaw/dist/extensions/codex",
    );
    expect(runtimeStage).not.toContain("openclaw-tarball/");
    expect(runtimeStage).not.toContain("/home/node/.openclaw");
    const verification = runInstructionContaining(runtimeStage, "openclaw --version");
    expect(runtimeStage.indexOf(verification)).toBeGreaterThan(runtimeStage.indexOf("/opt/openclaw-runtime-deps /opt/openclaw-runtime-deps"));
    expect(runtimeStage.trimEnd().endsWith(verification.trimEnd())).toBe(true);
    expect(verification).toContain("test -d /opt/openclaw-runtime-deps/npm");
    expect(verification).toContain("for plugin in mattermost parallel codex");
    expect(verification).toContain('/usr/local/lib/node_modules/openclaw/dist/extensions/$plugin/package.json');
    expect(verification).toContain("for package in mattermost parallel-plugin codex");
    expect(verification).toContain('find /opt/openclaw-runtime-deps/npm -type d -path "*/node_modules/@openclaw/$package" -print -quit');
  });

  it("does not retain package-manager caches in runtime install layers", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile.base");

    expect(
      runInstructionContaining(dockerfile, "@anthropic-ai/claude-code"),
    ).toContain("npm cache clean --force");
    expect(
      runInstructionContaining(dockerfile, "npm install --global /tmp/npm.tgz"),
    ).toContain("npm cache clean --force");
    expect(runInstructionContaining(dockerfile, "pip3 install")).toContain("--no-cache-dir");
  });

  it("copies the pruned dependencies and application payload into the gateway runtime", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile");
    const runtimeStageMarker = "FROM ${RUNTIME_BASE_IMAGE} AS gateway-runtime";
    const runtimeStage = dockerfile.slice(dockerfile.indexOf(runtimeStageMarker));
    const runtimeInstructions = runtimeStage
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(dockerfile).toContain("FROM ${OPENCLAW_BASE_IMAGE} AS gateway-build");
    expect(runtimeStage).toContain("COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/scripts/node_modules");
    expect(runtimeStage).toContain("COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/shared/node_modules");
    expect(runtimeStage).toContain("COPY --from=gateway-payload --chown=node:node /octogee/scripts");
    expect(runtimeStage).toContain("COPY --from=gateway-payload --chown=node:node /octogee/shared");
    expect(runtimeStage).toContain("COPY --from=gateway-payload --chown=node:node /octogee/extensions");
    expect(runtimeInstructions).not.toMatch(/npm (?:ci|install|prune)/u);
    expect(runtimeStage).not.toContain("chown -R node:node /octogee/extensions");
  });

  it("gates each final image on its required OpenClaw runtime plugin set", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile");

    expect(dockerfile).toContain(
      "COPY gateway/verify-openclaw-runtime-deps.sh /usr/local/bin/verify-openclaw-runtime-deps",
    );
    expect(dockerfile).toContain(
      '/usr/local/bin/verify-openclaw-runtime-deps "$OPENCLAW_RUNTIME_PLUGINS"',
    );
    for (const args of Object.values(gatewayImageArgs())) {
      expect(args.OPENCLAW_RUNTIME_PLUGINS).toBe("mattermost,parallel-plugin,codex");
    }
  });

  it("bundles exact-source Codex with plugin-local dependencies and verifies native bundled trust", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile.base");

    expect(dockerfile).toContain('"$OPENCLAW_ROOT/package.json"');
    expect(dockerfile).toContain('test -f "$OC_VENDOR/openclaw-codex.tgz"');
    expect(dockerfile).toContain('CODEX_BUNDLED_DIR="$OPENCLAW_ROOT/dist/extensions/codex"');
    expect(dockerfile).toContain('cp -a "$CODEX_VENDORED/package" "$CODEX_BUNDLED_DIR"');
    const omitDev = dockerfile.indexOf('delete pkg.devDependencies;');
    const install = dockerfile.indexOf('npm install --prefix "$CODEX_BUNDLED_DIR" --omit=dev --include=optional --ignore-scripts --package-lock=false');
    const restore = dockerfile.indexOf('cp "$CODEX_VENDORED/package/package.json" "$CODEX_BUNDLED_DIR/package.json"');
    const profile = dockerfile.indexOf('OPENCLAW_STATE_DIR="$(mktemp -d)"');
    const refresh = dockerfile.indexOf('openclaw plugins registry --refresh');
    const inspect = dockerfile.indexOf('openclaw plugins inspect codex --json');
    expect(omitDev).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(omitDev);
    expect(restore).toBeGreaterThan(install);
    expect(profile).toBeGreaterThan(restore);
    expect(refresh).toBeGreaterThan(profile);
    const verification = runInstructionContaining(dockerfile, "openclaw plugins registry --refresh");
    expect(verification).toContain("export OPENCLAW_STATE_DIR");
    expect(verification).toContain('rm -rf "$OPENCLAW_STATE_DIR"');
    expect(inspect).toBeGreaterThan(refresh);
    expect(dockerfile).toContain('test ! -e "$CODEX_BUNDLED_DIR/node_modules/openclaw"');
    expect(dockerfile).toContain(
      'node /tmp/verify-codex-source-match.mjs "$CODEX_VENDORED/package" "$OPENCLAW_ROOT" /tmp/oc-codex-inspect.json',
    );
    expect(dockerfile).toContain("openclaw plugins inspect codex --json");
    expect(dockerfile).toContain('node /tmp/verify-codex-native-hook-runtime.mjs "$CODEX_BUNDLED_DIR/package.json"');
    expect(dockerfile).not.toContain('CODEX_SPEC=');
    expect(dockerfile).not.toContain('npm view');
    expect(dockerfile).not.toContain('npm-pack:$VENDORED_CODEX');
    expect(dockerfile).not.toContain("OPENCLAW_COMPATIBILITY_HOST_VERSION");
  });

  it("proves the final isolated image retains its boot-critical payloads", () => {
    const dockerfile = readRepoFile("gateway/Dockerfile");
    const gate = readRepoFile("gateway/verify-runtime-image.sh");

    expect(dockerfile).toContain('RUN /usr/local/bin/verify-runtime-image "$IMAGE_PROFILE"');
    expect(gate).toContain('! staged_plugin parallel-plugin');
    expect(gate).toContain('openclaw/dist/extensions/parallel/package.json');
    expect(gate).toContain('"$global_root/openclaw/dist/extensions/codex/package.json"');
    expect(gate).toContain('! staged_plugin codex');
    expect(gate).toContain("! staged_plugin mattermost");
    expect(gate).toContain('"$global_root/@anthropic-ai/claude-code"');
    expect(gate).toContain('"$global_root/@openai/codex"');
    expect(gate).toContain('test -x "$tool_bin/claude"');
    expect(gate).toContain('test -x "$tool_bin/codex"');
    expect(gate).toContain('test -x "$chromium_bin"');
    expect(gate).toContain('test ! -e "$global_root/@sparticuz/chromium"');
    expect(gate).toContain("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256");
    expect(gate).toContain("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256");
  });
});
