import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("User boot base", () => {
  const dockerfile = read("gateway/Dockerfile.isolated-base");

  it("inherits the full OpenClaw base and installs controlled groups without the operator image", () => {
    expect(dockerfile).toContain("ARG GATEWAY_BASE_IMAGE");
    expect(dockerfile).toContain("FROM ${GATEWAY_BASE_IMAGE}");
    expect(dockerfile).not.toContain("TOOLKIT_IMAGE");
    expect(dockerfile).not.toContain("Dockerfile.operator-toolkit");

    expect(dockerfile).toContain("DEBIAN_PACKAGES=");
    expect(dockerfile).toContain("standaloneTools.gcloud.version");
    expect(dockerfile).toContain("/usr/lib/google-cloud-sdk");
    expect(dockerfile).toContain("/usr/local/bin/terraform");
    expect(dockerfile).not.toContain("operator-tools.versions");
  });

  it("bakes non-npm workstation groups while leaving npm payloads for hydration", () => {
    expect(dockerfile).toMatch(
      /COPY[^\n]*stamp-claude-first-run\.mjs[^\n]*\/octogee\/gateway\/stamp-claude-first-run\.mjs/,
    );
    expect(dockerfile).not.toContain("claude-wrapper.sh");
    expect(dockerfile).not.toContain("claude-real");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends $DEBIAN_PACKAGES");
    expect(dockerfile).toContain("pip3 install --break-system-packages --no-cache-dir");
    expect(dockerfile).not.toContain("COPY --from=isolated-toolchain-validation /tmp/isolated-toolchain-validation/node_modules");
    expect(dockerfile).not.toContain("apply-gateway-class-policy.mjs");
    expect(dockerfile).toMatch(/USER\s+node\s*$/m);
  });
});
