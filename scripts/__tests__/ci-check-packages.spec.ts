import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPackages } from "../ci/check-packages.mjs";

const names = (paths: string[], full = false) => checkPackages(paths, full).include.map((job: { name: string }) => job.name);
const always = ["scripts", "tests", "release-artifacts"];

describe("package checks selected before runner allocation", () => {
  it("keeps repository, cross-component and release checks with the changed service's whole suite", () => {
    expect(names(["platform-api/src/routes/fleet-broker.ts"])).toEqual([
      "scripts", "platform-api", "tests", "release-artifacts",
    ]);
  });

  it("includes build consumers and combines changed components", () => {
    expect(names(["llm-broker/src/index.ts", "fleet-controller/src/index.ts"])).toEqual([
      "scripts", "llm-broker", "platform-api", "tests", "release-artifacts", "libraries",
    ]);
  });

  it("keeps repository checks for documentation without treating shipped Markdown as documentation", () => {
    expect(names(["docs/kind.md", "README.md"])).toEqual(always);
    expect(names(["templates/shared/AGENTS.md"])).toEqual(names([], true));
  });

  it.each([
    [], ["new-component/index.ts"], ["core/src/platform-state.ts"], ["shared/types/user.ts"],
    ["core-testing/src/index.ts"], ["scripts/ops/sync-local-file-deps.mjs"],
    [".github/workflows/checks.yml"], ["gateway/openclaw-tarball/current.json"],
    ["platform-api/package.json"], ["llm-broker/package-lock.json"],
  ])("runs every package when selection is uncertain: %j", (...paths: string[]) => {
    expect(names(paths)).toEqual(names([], true));
  });

  it("does not narrow full main, scheduled or manual checks", () => {
    expect(names(["platform-api/src/index.ts"], true)).toEqual(names([], true));
  });

  it("includes both owners when git reports a cross-component rename as deletion and addition", () => {
    expect(names(["gateway-edge/src/old.ts", "platform-api/src/new.ts"])).toEqual([
      "scripts", "gateway-edge", "platform-api", "tests", "release-artifacts",
    ]);
  });

  it("reads NUL-delimited paths literally and emits the complete job definitions", () => {
    const directory = mkdtempSync(join(tmpdir(), "check-packages-"));
    try {
      const file = join(directory, "paths");
      writeFileSync(file, "platform-api/src/a\n'b.ts\0");
      const output = execFileSync(process.execPath, ["ci/check-packages.mjs", file], { encoding: "utf8" });
      const matrix = JSON.parse(output);
      const all = JSON.parse(readFileSync(new URL("../../.github/check-packages.json", import.meta.url), "utf8"));
      expect(matrix.include).toEqual(all.include.filter((job: { name: string }) => [...always, "platform-api"].includes(job.name)));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
