import { describe, expect, it, vi } from "vitest";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import type { DurableGateway } from "../converge-gateway.js";
import { markGatewayLive } from "../index.js";

function fixture(changed: Record<string, unknown> = {}, status = "draining") {
  const gateway = {
    gatewayId: "shared-blue", createdAt: 1, createdBy: "test", updatedAt: 2, updatedBy: "test",
    latestRelease: 3, desiredRelease: 3, liveRelease: null, desiredStatus: status,
    configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard",
    sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null,
    serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null,
  } as DurableGateway;
  const documents = new Map<string, Record<string, unknown>>([
    ["gateways/shared-blue", { ...gateway, ...changed }],
    ["glmGateways/shared-blue", {
      docKind: "runtime", gatewayId: "shared-blue", release: 3, lifecycle: "provisioning",
      createdAt: 1, createdByOperationId: null, helm: {}, heartbeat: {}, lastError: { message: null, at: null },
    }],
  ]);
  const backing = fixtureDocumentsAt(documents);
  const writes = vi.fn((path: string, row: Record<string, unknown>) => backing.set(path, row));
  const store = createJournalFixtureStore(journalRowsAtPaths(documents), { documents: { ...backing, set: writes } });
  const publish = () => markGatewayLive({ store, log: vi.fn() }, gateway, {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "build-3",
  });
  return { documents, writes, publish };
}

describe("verified Gateway live publication", () => {
  it("publishes a draining source as serving without reopening placement", async () => {
    const h = fixture();
    await h.publish();
    expect(h.documents.get("gateways/shared-blue")).toMatchObject({ desiredStatus: "draining", liveRelease: 3 });
    expect(h.documents.get("glmGateways/shared-blue")).toMatchObject({ lifecycle: "serving", release: 3 });
  });

  it("publishes a paused release without advertising a serving runtime", async () => {
    const h = fixture({}, "paused");
    await h.publish();
    expect(h.documents.get("gateways/shared-blue")).toMatchObject({ desiredStatus: "paused", liveRelease: 3 });
    expect(h.documents.get("glmGateways/shared-blue")).toMatchObject({ lifecycle: "provisioning" });
  });

  it.each([
    { desiredRelease: 4 },
    { desiredStatus: "paused" },
    { desiredStatus: "retired" },
    { desiredStatus: "running" },
    { runtimeRestartFence: { kind: "source-recovery", phase: "reserved" } },
    { retirementClaim: { operationId: "retire-source" } },
  ])("refuses publication after transaction-time custody changes: %j", async (changed) => {
    const h = fixture(changed);
    await h.publish();
    expect(h.writes).not.toHaveBeenCalled();
  });
});
