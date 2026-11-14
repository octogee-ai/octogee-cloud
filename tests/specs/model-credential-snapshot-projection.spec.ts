import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("model credential snapshot projection", () => {
  it("keeps fleet broker snapshots on the shared user snapshot projection helper", () => {
    const fleetBroker = readRepoFile("octogee-api/src/routes/fleet-broker.ts");

    expect(fleetBroker).toContain("readByotSnapshotProjection");
    expect(fleetBroker).not.toContain("function snapshotCredentialProjection");
    expect(fleetBroker).not.toContain("function byotSystemConfigFromCredentialRecord");
  });
});
