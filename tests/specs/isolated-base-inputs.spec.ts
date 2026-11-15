import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseIsolatedToolGroups } from "../../gateway-supervisor/lib/isolated-tool-groups";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const manifestPath = path.join(repoRoot, "gateway/isolated-toolchain/groups.json");
const projectorPath = path.join(repoRoot, "gateway/isolated-toolchain/base-inputs.mjs");
const manifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const project = (input: unknown) => execFileSync(process.execPath, [projectorPath], {
  input: JSON.stringify(input),
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
});

describe("Isolated base installation inputs", () => {
  it("keeps OS and standalone cache inputs unchanged across npm-only updates", () => {
    const original = manifest();
    const updated = manifest();
    updated.groups.find((group: { id: string }) => group.id === "agent-clis")
      .npmPackages["@anthropic-ai/claude-code"] = "2.1.272";
    updated.groups.find((group: { id: string }) => group.id === "browser").enabled = false;

    expect(project(updated)).toBe(project(original));
  });

  it("preserves every input consumed by OS and standalone installation", () => {
    const input = manifest();
    expect(JSON.parse(project(input))).toEqual({
      schemaVersion: input.schemaVersion,
      groups: input.groups.filter((group: { enabled: boolean; delivery: string }) =>
        group.enabled && group.delivery === "base"),
      pythonPackages: input.pythonPackages,
      standaloneTools: input.standaloneTools,
    });
  });

  it.each(["4.3.0-rc.1", "4.3.0-beta-2"])("preserves supported prerelease pin %s", (version) => {
    const input = manifest();
    input.standaloneTools.helm.version = version;

    expect(parseIsolatedToolGroups(input).standaloneTools.helm.version).toBe(version);
    expect(JSON.parse(project(input)).standaloneTools.helm.version).toBe(version);
    expect(project(input)).not.toBe(project(manifest()));
  });

  it.each([
    { version: "4.3" },
    { version: "4.3.0-" },
    { version: "4.3.0+build" },
    { version: ["4.3.0"] },
  ])(
    "rejects standalone version $version consistently with the manifest parser",
    ({ version }) => {
      const input = manifest();
      input.standaloneTools.helm.version = version;

      expect(() => parseIsolatedToolGroups(input)).toThrow();
      expect(() => project(input)).toThrow();
    },
  );

  it.each([
    ["base group enablement", (input: ReturnType<typeof manifest>) => { input.groups.find((g: { id: string }) => g.id === "media").enabled = false; }],
    ["OS packages", (input: ReturnType<typeof manifest>) => { input.groups.find((g: { id: string }) => g.id === "shell").debianPackages.push("screen"); }],
    ["command verification", (input: ReturnType<typeof manifest>) => { input.groups.find((g: { id: string }) => g.id === "shell").commands.push("screen"); }],
    ["Python pins", (input: ReturnType<typeof manifest>) => { input.pythonPackages[0] = "PyYAML==6.0.4"; }],
    ["standalone pins", (input: ReturnType<typeof manifest>) => { input.standaloneTools.gh.version = "2.999.0"; }],
    ["standalone checksums", (input: ReturnType<typeof manifest>) => { input.standaloneTools.gcloud.sha256 = "b".repeat(64); }],
  ])("invalidates the stable cache when %s changes", (_label, update) => {
    const updated = manifest();
    update(updated);
    expect(project(updated)).not.toBe(project(manifest()));
  });

  it.each([
    ["groups", (input: ReturnType<typeof manifest>) => { delete input.groups; }],
    ["group enablement", (input: ReturnType<typeof manifest>) => { delete input.groups[0].enabled; }],
    ["group delivery", (input: ReturnType<typeof manifest>) => { input.groups[0].delivery = "other"; }],
    ["OS packages", (input: ReturnType<typeof manifest>) => { input.groups.find((g: { id: string }) => g.id === "shell").debianPackages = "curl"; }],
    ["Python pins", (input: ReturnType<typeof manifest>) => { delete input.pythonPackages; }],
    ["standalone pins", (input: ReturnType<typeof manifest>) => { delete input.standaloneTools.gh.version; }],
    ["standalone checksums", (input: ReturnType<typeof manifest>) => { input.standaloneTools.gcloud.sha256 = "bad"; }],
  ])("rejects missing or malformed %s instead of dropping installation inputs", (_label, corrupt) => {
    const input = manifest();
    corrupt(input);
    expect(() => project(input)).toThrow();
  });
});
