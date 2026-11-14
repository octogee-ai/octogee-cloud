import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseNotes } from "../ci/release-notes.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const registry = "ghcr.io/octogee-ai/octogee-cloud";
const sha = "c".repeat(40);
const digest = (n: number) => `sha256:${String(n).repeat(64)}`;
const manifest = {
  sha, registry, source: "https://github.com/octogee-ai/octogee-cloud",
  images: {
    "octogee-api": { digest: digest(1), platforms: { "linux/amd64": digest(2), "linux/arm64": digest(3) } },
    "octogee-gateway-builder": { digest: digest(4), platforms: { "linux/amd64": digest(5) } },
  },
};
const notes = (overrides: Record<string, unknown> = {}) => releaseNotes({ tag: "v0.1.0", fleetVersion: "v0.2.0", manifest, ...overrides });

describe("release notes", () => {
  it("names the commit, how to start from the release and the octogee-fleet version it was tested with", () => {
    const text = notes();
    expect(text).toContain(`v0.1.0 is commit ${sha} on main`);
    expect(text).toContain("git clone --branch v0.1.0 https://github.com/octogee-ai/octogee-cloud");
    expect(text).toContain("go install github.com/octogee-ai/octogee-fleet@v0.2.0");
    expect(text).toContain("--manifest=image-manifest.json");
  });

  it("lists every image by its release tag and index digest, with the platforms it was built for", () => {
    const text = notes();
    expect(text).toContain(`| \`${registry}/octogee-api:v0.1.0\` | \`${digest(1)}\` | linux/amd64, linux/arm64 |`);
    expect(text).toContain(`| \`${registry}/octogee-gateway-builder:v0.1.0\` | \`${digest(4)}\` | linux/amd64 |`);
  });

  it("says what upgrading between pre-1.0 releases can and cannot promise", () => {
    expect(notes()).toMatch(/pre-1\.0[\s\S]*no migrations[\s\S]*`down`[\s\S]*fresh `up`/);
  });

  it.each([
    [{ tag: "v1" }, "A release tag looks like v0.1.0"],
    [{ fleetVersion: "main" }, "An octogee-fleet release version looks like v0.2.0"],
    [{ manifest: { ...manifest, sha: "abc" } }, "The image manifest names no full commit SHA"],
    [{ manifest: { ...manifest, images: { "octogee-api": { digest: "latest", platforms: {} } } } }, "The image manifest has no index digest for octogee-api"],
  ])("refuses %j", (overrides, message) => {
    expect(() => notes(overrides)).toThrow(message);
  });

  it("writes the notes from the command line", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-notes-"));
    try {
      const file = join(directory, "image-manifest.json");
      writeFileSync(file, JSON.stringify(manifest));
      const result = spawnSync(process.execPath, ["scripts/ci/release-notes.mjs", "--tag=v0.1.0", "--fleet=v0.2.0", `--manifest=${file}`], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(notes());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
