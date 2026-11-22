import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { UnsupportedOperationError } from "@octogee/core/platform-state";
import { describe, expect, it, vi } from "vitest";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core-testing/journal-store";
import type { DurableGateway, ReadyVmObservation } from "../converge-gateway.js";
import { markGatewayLive } from "../index.js";

function fixture(changed: Record<string, unknown> = {}, status = "draining", release?: ReleasePayload) {
  const gateway = {
    gatewayId: "shared-blue", createdAt: 1, createdBy: "test", updatedAt: 2, updatedBy: "test",
    latestRelease: 3, desiredRelease: 3, liveRelease: release ? 2 : null, desiredStatus: status,
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
  const withTransaction = store.transaction.bind(store);
  store.transaction = (options, work) => withTransaction(options, async tx => {
    let hasWritten = false;
    return work({
      ...tx,
      gateways: { ...tx.gateways, roots: { ...tx.gateways.roots, patch: async (...args) => {
        hasWritten = true;
        return tx.gateways.roots.patch(...args);
      } } },
      fleetRegistry: { ...tx.fleetRegistry, patch: async (...args) => {
        hasWritten = true;
        return tx.fleetRegistry.patch(...args);
      } },
      users: { ...tx.users, records: { ...tx.users.records, listByGateway: async (...args) => {
        if (hasWritten) throw new UnsupportedOperationError("postgresql", "builders.records.listByGateway", "read-after-write");
        return tx.users.records.listByGateway(...args);
      } } },
    });
  });
  const publish = (readyVm?: ReadyVmObservation) => markGatewayLive({ store, log: vi.fn() }, gateway, release ?? {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "build-3",
  }, false, readyVm);
  return { documents, writes, publish };
}

describe("verified Gateway live publication", () => {
  it("publishes a draining source as serving without reopening placement", async () => {
    const h = fixture();
    await h.publish();
    expect(h.documents.get("gateways/shared-blue")).toMatchObject({ desiredStatus: "draining", liveRelease: 3 });
    expect(h.documents.get("glmGateways/shared-blue")).toMatchObject({ lifecycle: "serving", release: 3 });
  });

  it.each([true, false])("publishes the VM's signed heartbeat only for its observed generation (same=%s)", async same => {
    const h = fixture({}, "running");
    const path = "glmGateways/shared-blue";
    h.documents.set(path, {
      ...h.documents.get(path), runtime: "gce-vm", vm: { status: "RUNNING", instanceId: "42",
        instanceName: "computer", internalIp: "10.0.0.2", startedAt: same ? 100 : 120 },
    });

    await h.publish({
      endpoint: { name: "computer", podIP: "10.0.0.2", uid: "octogee-gateway-shared-blue-vm-42" },
      state: { status: "ready", version: "build-3", users: [], startedAt: 120 },
      vmStartedAt: 100,
    });

    if (same) {
      expect(h.documents.get("gateways/shared-blue")).toMatchObject({ liveRelease: 3 });
      expect(h.documents.get(path)).toMatchObject({ lifecycle: "serving", heartbeat: {
        status: "ready", version: "build-3", startedAt: 120, lastHeartbeatAt: expect.any(Number), mountedCustomers: [],
      } });
    } else {
      expect(h.writes).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])("rechecks the installed edge inside VM live publication even with matching signed readiness: %s", async valid => {
    const repo = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
    const edge = "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge";
    const gatewayDigest = `sha256:${"a".repeat(64)}`;
    const edgeDigest = `sha256:${"b".repeat(64)}`;
    const imageTag = `abcdef2@${gatewayDigest}`;
    const version = `abcdef1@${gatewayDigest}`;
    const h = fixture({}, "running", { imageRepository: repo, imageTag, openclawSourceSha: "c".repeat(40),
      gatewayEdgeImage: { imageRepository: edge, imageTag: `abcdef2@${edgeDigest}` } });
    const observedEdge = valid ? edgeDigest : `sha256:${"d".repeat(64)}`;
    const path = "glmGateways/shared-blue";
    h.documents.set(path, { ...h.documents.get(path), runtime: "gce-vm", vm: {
      status: "RUNNING", instanceId: "42", instanceName: "computer", internalIp: "10.0.0.2", startedAt: 100 },
      vmImages: { instanceId: "42", observedAt: 125, containers: [
        { name: "gateway", running: true, imageReference: `${repo}:${version}`, digests: [`${repo}@${gatewayDigest}`] },
        { name: "gateway-edge", running: true, imageReference: `${edge}:abcdef2@${observedEdge}`, digests: [`${edge}@${observedEdge}`] },
      ] },
    });
    await h.publish({
      endpoint: { name: "computer", podIP: "10.0.0.2", uid: "octogee-gateway-shared-blue-vm-42" },
      state: { status: "ready", version, users: [], startedAt: 120 }, vmStartedAt: 100,
    });
    expect(h.documents.get("gateways/shared-blue")).toMatchObject({ liveRelease: valid ? 3 : 2 });
    if (!valid) expect(h.writes).not.toHaveBeenCalled();
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
