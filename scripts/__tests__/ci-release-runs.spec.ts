import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { kindSmokeRunTitle, successfulKindSmokeRun } from "../ci/release-runs.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sha = "c".repeat(40);
const other = "d".repeat(40);
const run = (databaseId: number, title: string, conclusion: string) => ({ databaseId, displayTitle: title, status: "completed", conclusion });

function releaseCheck(runs: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "release-runs-"));
  try {
    writeFileSync(join(dir, "runs.json"), JSON.stringify(runs));
    return spawnSync(process.execPath, ["scripts/ci/release-runs.mjs", `--sha=${sha}`, `--runs=${join(dir, "runs.json")}`], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the release's kind smoke requirement", () => {
  it("passes with a successful Kind smoke run for the tagged commit, even after a failed one", () => {
    const runs = [run(3, kindSmokeRunTitle(sha), "failure"), run(2, kindSmokeRunTitle(sha), "success")];
    expect(successfulKindSmokeRun(sha, runs)).toBe(2);
    const result = releaseCheck(runs);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  it("fails naming the workflow and the commit when the only run there failed", () => {
    const result = releaseCheck([run(5, kindSmokeRunTitle(other), "success"), run(4, kindSmokeRunTitle(sha), "failure")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error::Kind smoke (.github/workflows/kind-smoke.yml) has no successful run for ${sha}: its latest run there, 4, ended failure.`);
  });

  it("fails naming the workflow and the commit when the smokes never ran there", () => {
    expect(() => successfulKindSmokeRun(sha, [run(5, kindSmokeRunTitle(other), "success")]))
      .toThrow(`Kind smoke (.github/workflows/kind-smoke.yml) has no successful run for ${sha}: it has not run there.`);
  });

  it("matches the run name the Kind smoke workflow gives each run", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/kind-smoke.yml"), "utf8"));
    expect(workflow["run-name"].replace("${{ github.event.workflow_run.head_sha || inputs.sha }}", sha)).toBe(kindSmokeRunTitle(sha));
  });

  it("is a step of the release job, after the Build main check", () => {
    const release = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
    const names = (release.jobs.release.steps as { name?: string; run?: string }[]).map(step => step.name);
    const check = release.jobs.release.steps.find((step: { name?: string }) => step.name === "Check the kind smokes passed at the tagged commit");
    expect(check.run).toContain("--workflow=kind-smoke.yml");
    expect(check.run).toContain("node scripts/ci/release-runs.mjs --sha=\"$GITHUB_SHA\"");
    expect(names.indexOf(check.name)).toBe(names.indexOf("Check the tag is on main and Build main published its images") + 1);
  });
});
