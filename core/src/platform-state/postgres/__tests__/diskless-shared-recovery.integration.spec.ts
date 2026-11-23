import { describe, expect, it } from "vitest";
import { commitDisklessSharedRecovery, readUserRestoreAuthoritySnapshot } from "../../../fleet-state.js";
import { initialGatewayReleaseDocuments } from "../../../gateway-live-release.js";
import { dsn } from "./fixtures/harness.js";
import { lease, NOW, useUserFixture, type UserFixture } from "./fixtures/users.js";

const uid = "alice";
const fromGatewayId = "builder-alice";
const toGatewayId = "shared-blue";
const operationId = "builder-return-builder-alice-g1";
const migrationId = `mig-${operationId}`;
const input = { uid, slug: uid, fromGatewayId, toGatewayId, operationId, migrationId, claimStartedAt: NOW };
const commits = { workspace: "a".repeat(40) };
const agentId = "octogee-alice-coach";

async function seedRecovery({ store, records, place }: UserFixture): Promise<void> {
  await records.create({ uid, createdAt: NOW });
  await records.admit(uid, { slug: uid, persona: null, createdAt: NOW, provisioningStartedAt: NOW });
  await place(uid, fromGatewayId);
  await records.patch(uid, {
    openclaw: { status: "complete" },
    workspaceCheckpoint: { gatewayId: fromGatewayId, assignmentEpoch: 0, observedAt: NOW, commits },
    scheduleCheckpoint: { gatewayId: fromGatewayId, assignmentEpoch: 0, observedAt: NOW, snapshot: {
      version: 1, operationId: "checkpoint-alice", agentIds: [agentId], jobs: [], scratch: [],
    } },
  });
  await records.setActivationLease(uid, lease({
    status: "active", leaseId: "diskless-alice", targetGatewayId: fromGatewayId, activeAt: NOW,
  }), { leaseId: null, generation: null });
  await store.gateways.roots.patch(fromGatewayId, {
    ownerUid: uid, builderSlug: uid,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "diskless-alice", generation: 1, claimedByUid: uid, ephemeralHomeGiB: 4 },
    ephemeralWriter: { podUid: "original", podName: "builder-alice-original", exclusion: { at: NOW, method: "terminal-pod" } },
  });
  const target = initialGatewayReleaseDocuments({
    gatewayId: toGatewayId, now: NOW, createdBy: "test", desiredStatus: "running",
    artifact: { imageRepository: "registry.example/gateway", imageTag: "abc1234" },
    config: {
      configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard",
      sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
      serviceAccount: null, builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null,
    },
  });
  await store.gateways.roots.create({ ...target.gatewayDoc, liveRelease: 1 });
  await store.gateways.releases.createInitial(target.releaseDoc);
  await store.fleetRegistry.create({
    gatewayId: toGatewayId, release: 1, lifecycle: "serving", createdAt: NOW, createdByOperationId: null,
    helm: {
      releaseName: "shared-blue", deploymentName: "shared-blue", gatewayServiceName: "shared-blue",
      gatewayEdgeServiceName: "shared-blue-edge", serviceAccountName: "shared-blue",
      imageRepository: "registry.example/gateway", imageTag: "abc1234", replicas: 1,
      availableReplicas: 1, lastAppliedAt: NOW,
    },
    heartbeat: {
      status: "ready", lastHeartbeatAt: NOW, version: null, openclawVersion: null,
      internalUrl: null, startedAt: NOW, mountedCustomers: [], migratingIn: [],
    },
    lastError: { message: null, at: null },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW },
  });
  await store.users.agentStores.put(uid, {
    kind: "agent", agentId, schema: "alice", storeId: "alice-store", gatewayId: fromGatewayId,
    generation: 1, assignmentEpoch: 0, recordedAt: NOW,
  });
  await store.journal.operations.create({
    id: operationId, kind: "migrate-user", status: "running", origin: "automatic",
    createdAt: NOW, createdBy: "glm-controller-placement-policy", startedAt: NOW, completedAt: null, steps: [],
    gatewayId: toGatewayId, inputUid: uid,
    input: { uid, userSlug: uid, fromGatewayId, toGatewayId, durableRecovery: true },
  });
}

describe.skipIf(!dsn)("PostgreSQL diskless Shared recovery", () => {
  const fixture = useUserFixture();

  it("commits one destination fence and one immutable checkpoint when the same claim races", async () => {
    const { store, records } = fixture();
    await seedRecovery(fixture());
    const deps = { store, now: () => new Date(NOW + 1_000) };
    const [first, retry] = await Promise.all([
      commitDisklessSharedRecovery(deps, input),
      commitDisklessSharedRecovery(deps, input),
    ]);
    expect(first).toMatchObject({ targetEpoch: 1, restorePending: true, workspaceCommits: commits });
    expect(retry).toEqual(first);
    expect(await store.gateways.assignments.listForUid(uid)).toMatchObject([{ gatewayId: toGatewayId, epoch: 1 }]);
    expect(await records.get(uid)).toMatchObject({ gateway: { gatewayId: toGatewayId }, fences: { restoreFence: { operationId } } });
    expect(await store.gateways.roots.get(fromGatewayId)).toMatchObject({ desiredStatus: "paused" });
    expect(await store.users.scheduleTransfers.get(uid, migrationId)).toMatchObject({ nativeExport: first.scheduler });
    expect(await store.users.scheduleTransfers.listUnrestored()).toEqual([]);
    expect(await readUserRestoreAuthoritySnapshot(deps, { uid, slug: uid, gatewayId: toGatewayId }))
      .toMatchObject({ migrationId, assignmentEpoch: 1 });
  });
});
