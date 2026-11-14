import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../.github/workflows/build-main.yml", import.meta.url), "utf8"));
const fleetInstalls = Object.values(workflow.jobs as Record<string, { steps?: { run?: string }[] }>)
  .flatMap(job => job.steps ?? [])
  .map(step => step.run ?? "")
  .filter(run => run.includes("octogee-fleet@"));

it("names one octogee-fleet release, by version and commit, for the releases it tests", () => {
  expect(workflow.env.OCTOGEE_FLEET_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(workflow.env.OCTOGEE_FLEET_COMMIT).toMatch(/^[0-9a-f]{40}$/);
});

it("installs that octogee-fleet commit in every job that drives the fleet", () => {
  expect(fleetInstalls.length).toBeGreaterThan(1);
  for (const run of fleetInstalls) expect(run).toContain("octogee-fleet@${OCTOGEE_FLEET_COMMIT}");
});
