import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = resolve(import.meta.dirname, "../../gateway/verify-openclaw-runtime-deps.sh");
const roots: string[] = [];

function runtimeTree(packages: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-runtime-deps-"));
  roots.push(root);
  for (const packageName of packages) {
    const packageRoot = join(
      root,
      "projects",
      `openclaw-${packageName}`,
      "node_modules",
      "@openclaw",
      packageName,
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: `@openclaw/${packageName}` }));
  }
  return root;
}

function verify(root: string) {
  return spawnSync("bash", [verifier], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_RUNTIME_DEPS_ROOT: root },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standard gateway OpenClaw runtime dependencies", () => {
  it("accepts a staged tree containing Mattermost, Parallel, and Codex", () => {
    const result = verify(runtimeTree(["mattermost", "parallel-plugin", "codex"]));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw runtime dependency gate: PASS");
  });

  it("finds the externalized Parallel package under its bundled plugin id", () => {
    const root = runtimeTree([]);
    const bundled = join(root, "bundled");
    mkdirSync(join(bundled, "parallel"), { recursive: true });
    writeFileSync(join(bundled, "parallel", "package.json"), JSON.stringify({ name: "@openclaw/parallel-plugin" }));
    const result = spawnSync("bash", [verifier, "parallel-plugin"], { encoding: "utf8", env: { ...process.env, OPENCLAW_RUNTIME_DEPS_ROOT: root, OPENCLAW_BUNDLED_PLUGIN_ROOT: bundled } });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["mattermost", "parallel-plugin", "codex"])(
    "rejects a staged tree missing @openclaw/%s",
    (missing) => {
      const result = verify(
        runtimeTree(["mattermost", "parallel-plugin", "codex"].filter((name) => name !== missing)),
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`@openclaw/${missing}`);
    },
  );
});
