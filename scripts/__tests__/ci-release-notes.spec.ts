import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gkeRunFrom, releaseNotes } from "../ci/release-notes.mjs";

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
const gkeRun = { date: "2026-11-15", commit: sha };
const notes = (overrides: Record<string, unknown> = {}) => releaseNotes({ tag: "v0.1.0", fleetVersion: "v0.2.0", manifest, gkeRun, ...overrides });

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
    const text = notes();
    expect(text).toContain("schema migrations run forward automatically");
    expect(text).toContain("no promise that stored data survives a minor release");
    expect(text).toMatch(/may drop stored data or need `down` and a fresh `up`/);
    expect(text).not.toContain("no migrations");
  });

  it("says what a user of this release gets and what is not there yet", () => {
    const text = notes();
    expect(text).toContain("## What this release is");
    expect(text).toContain("PostgreSQL 16");
    expect(text).toContain("Nothing places, scales or moves users automatically");
    expect(text).toContain("The Admin API and the Helm values are pre-1.0");
  });

  it("names the date and commit of the full run of the GKE install guide", () => {
    expect(notes()).toContain(`[docs/gke.md](https://github.com/octogee-ai/octogee-cloud/blob/v0.1.0/docs/gke.md) was followed end to end on a fresh Google Cloud project at ${sha} on 2026-11-15.`);
  });

  it.each([
    [{ tag: "v1" }, "A release tag looks like v0.1.0"],
    [{ fleetVersion: "main" }, "An octogee-fleet release version looks like v0.2.0"],
    [{ manifest: { ...manifest, sha: "abc" } }, "The image manifest names no full commit SHA"],
    [{ manifest: { ...manifest, images: { "octogee-api": { digest: "latest", platforms: {} } } } }, "The image manifest has no index digest for octogee-api"],
    [{ gkeRun: undefined }, "The tag message names no full GKE install guide run"],
    [{ gkeRun: { date: "2026-11-15", commit: "d".repeat(40) } }, `The GKE install guide run was at ${"d".repeat(40)}, not the tagged commit ${sha}`],
  ])("refuses %j", (overrides, message) => {
    expect(() => notes(overrides)).toThrow(message);
  });

  it("reads the GKE install guide run from the tag message", () => {
    expect(gkeRunFrom(`v0.1.0\n\nGKE install guide: 2026-11-15 ${sha}\n`)).toEqual(gkeRun);
    expect(gkeRunFrom("v0.1.0")).toBeUndefined();
    expect(gkeRunFrom(`GKE install guide: 15 Nov ${sha}`)).toBeUndefined();
  });

  it("writes the notes from the command line", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-notes-"));
    try {
      const file = join(directory, "image-manifest.json");
      writeFileSync(file, JSON.stringify(manifest));
      const message = join(directory, "tag-message");
      writeFileSync(message, `v0.1.0\n\nGKE install guide: 2026-11-15 ${sha}\n`);
      const result = spawnSync(process.execPath, ["scripts/ci/release-notes.mjs", "--tag=v0.1.0", "--fleet=v0.2.0", `--manifest=${file}`, `--tag-message=${message}`], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(notes());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
