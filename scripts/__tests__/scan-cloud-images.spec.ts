import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const registry = "ghcr.io/octogee-ai/octogee-cloud";
const sha = "a".repeat(40);
const arm = `sha256:${"1".repeat(64)}`;
const amd = `sha256:${"2".repeat(64)}`;
const images = ["glm-controller", "octogee-api", "llm-broker", "gateway-edge", "octogee-gateway", "vm-bridge"];
const builder = "octogee-gateway-builder";
const published = [...images, builder];
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octogee-scan-images-"));
  writeFileSync(join(directory, "trivy"), `#!/usr/bin/env bash
    args="$*"
    echo "$args" >> "$CALLS"
    while [[ "$1" != --output ]]; do shift; done
    out="$2"
    reference="\${!#}"
    if [[ -n "$FAIL_IMAGE" && "$reference" == */"$FAIL_IMAGE"@* ]]; then exit 1; fi
    if [[ " $args " == *' --vex '* ]]; then
      if [[ "$FAIL_VEX" == 1 ]]; then exit 1; fi
      printf '%s\\n' '{"Results":[{"Vulnerabilities":[]}]}' > "$out"
    else
      printf '%s\\n' '{"Results":[{"Vulnerabilities":[{"Severity":"CRITICAL"}]}]}' > "$out"
    fi
  `, { mode: 0o755 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run({ manifestSha = sha, include = published, failImage = "", failVex = false, platform = "linux/arm64" } = {}) {
  const manifest = join(directory, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    registry, sha: manifestSha,
    images: Object.fromEntries(include.map(name => [name, { platforms: name === builder ? { "linux/amd64": amd } : { "linux/arm64": arm, "linux/amd64": amd } }])),
  }));
  return spawnSync("bash", ["scripts/ci/scan-cloud-images.sh", manifest, sha, platform, join(directory, "reports")], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CALLS: join(directory, "calls"),
      FAIL_IMAGE: failImage, FAIL_VEX: failVex ? "1" : "0", GITHUB_STEP_SUMMARY: join(directory, "summary") },
  });
}

it("reports findings and produces an SBOM for every exact architecture digest", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(join(directory, "calls"), "utf8");
  for (const name of images) {
    expect(calls).toContain(`${registry}/${name}@${arm}`);
    expect(calls).not.toContain(`${registry}/${name}@${amd}`);
    expect(readFileSync(join(directory, "summary"), "utf8")).toContain(`${name}@${arm}\` | 1 | 0 | 0 | 0 | 0 |`);
  }
  expect(calls).not.toContain(builder);
  const vexCalls = calls.split("\n").filter(line => line.includes("--vex "));
  expect(vexCalls).toEqual([
    expect.stringContaining(`--vex scripts/ci/vex/gateway-debian-backports.openvex.json --show-suppressed --output ${join(directory, "reports", "octogee-gateway.vex.trivy.json")} ${registry}/octogee-gateway@${arm}`),
  ]);
  expect(calls).toContain(`convert --format cyclonedx --output ${join(directory, "reports", "octogee-gateway.cdx.json")} ${join(directory, "reports", "octogee-gateway.trivy.json")}`);
  const summary = readFileSync(join(directory, "summary"), "utf8");
  expect(summary).toContain(`octogee-gateway@${arm}\` with VEX | 0 | 0 | 0 | 0 | 0 |`);
  expect(readdirSync(join(directory, "reports"))).toHaveLength(14);
});

it("scans the isolated gateway image with the amd64 images", () => {
  const result = run({ platform: "linux/amd64" });
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(join(directory, "calls"), "utf8");
  for (const name of published) expect(calls).toContain(`${registry}/${name}@${amd}`);
  expect(readdirSync(join(directory, "reports"))).toHaveLength(16);
});

it.each([
  [{ manifestSha: "b".repeat(40) }, "Image manifest does not match"],
  [{ include: images.slice(0, -1) }, "vm-bridge has no valid linux/arm64 digest"],
  [{ include: images, platform: "linux/amd64" }, "octogee-gateway-builder has no valid linux/amd64 digest"],
])("rejects an invalid manifest before invoking Trivy", (options, error) => {
  const result = run(options);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  expect(readdirSync(directory)).not.toContain("calls");
});

it("continues scanning other images and fails the job after a Trivy error", () => {
  const result = run({ failImage: "octogee-api" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Trivy could not finish reports");
  const reports = readdirSync(join(directory, "reports"));
  expect(reports).toContain("octogee-gateway.cdx.json");
  expect(reports).not.toContain("octogee-api.cdx.json");
});

it("preserves the raw Gateway reports when the VEX scan fails", () => {
  const result = run({ failVex: true });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("could not finish the VEX report");
  const reports = readdirSync(join(directory, "reports"));
  expect(reports).toContain("octogee-gateway.trivy.json");
  expect(reports).toContain("octogee-gateway.cdx.json");
  expect(reports).not.toContain("octogee-gateway.vex.trivy.json");
});
