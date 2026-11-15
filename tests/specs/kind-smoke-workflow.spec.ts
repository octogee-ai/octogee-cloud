import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, string> };
type Job = { name?: string; needs?: string; if?: string; steps?: Step[] };
const read = (file: string) => parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"));
const buildMain = read("build-main.yml");
const kindSmoke = read("kind-smoke.yml");
const smokeJobs = kindSmoke.jobs as Record<string, Job>;
const smokes = ["kind-smoke", "kind-isolated-smoke"].map(name => smokeJobs[name]);
const fleetInstalls = Object.values(smokeJobs)
  .flatMap(job => job.steps ?? [])
  .map(step => step.run ?? "")
  .filter(run => run.includes("octogee-fleet@"));

describe("Build main", () => {
  it("builds, publishes and scans images and runs no kind smoke", () => {
    expect(Object.keys(buildMain.jobs)).toEqual(["images", "publish", "image-security"]);
    expect(buildMain.env.OCTOGEE_FLEET_VERSION).toBeUndefined();
  });
});

describe("Kind smoke", () => {
  it("runs after every successful Build main push on main, and on demand for one commit", () => {
    expect(kindSmoke.on.workflow_run).toEqual({ workflows: ["Build main"], types: ["completed"], branches: ["main"] });
    expect(kindSmoke.on.workflow_dispatch.inputs.sha.required).toBe(true);
    expect(smokeJobs.build.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(smokeJobs.build.if).toContain("github.event.workflow_run.event == 'push'");
  });

  it("names each run after the commit it tests", () => {
    expect(kindSmoke["run-name"]).toBe("Kind smoke at ${{ github.event.workflow_run.head_sha || inputs.sha }}");
  });

  it("keeps both smoke jobs, each testing the built commit with that Build main run's image manifest", () => {
    expect(smokes.map(job => job.name)).toEqual(["Kind smoke (amd64)", "Kind isolated gateway smoke (amd64)"]);
    for (const job of smokes) {
      expect(job.needs).toBe("build");
      const checkout = job.steps?.find(step => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("${{ needs.build.outputs.sha }}");
      const manifest = job.steps?.find(step => step.uses?.startsWith("actions/download-artifact@"));
      expect(manifest?.with).toMatchObject({
        name: "image-manifest-${{ needs.build.outputs.sha }}",
        "run-id": "${{ needs.build.outputs.run-id }}",
      });
    }
  });

  it("names one octogee-fleet release, by version and commit, for the releases it tests", () => {
    expect(kindSmoke.env.OCTOGEE_FLEET_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(kindSmoke.env.OCTOGEE_FLEET_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it("installs that octogee-fleet commit in every job that drives the fleet", () => {
    expect(fleetInstalls.length).toBeGreaterThan(1);
    for (const run of fleetInstalls) expect(run).toContain("octogee-fleet@${OCTOGEE_FLEET_COMMIT}");
  });
});
