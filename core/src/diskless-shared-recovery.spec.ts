import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { builderActivateOperationId, DISKLESS_ACTIVATION_WRITER_EXCLUDED } from "@octogee/shared/types/isolated-operation-ids";
import { describe, expect, it } from "vitest";
import { commitCutoverAtomic, commitDisklessSharedRecovery, readDisklessActivationWriterExcluded, readUserRestoreAuthoritySnapshot } from "./fleet-state.js";

const NOW = 10_000;
const uid = "uid-alice";
const slug = "alice";
const fromGatewayId = "builder-alice";
const toGatewayId = "shared-blue";
const operationId = "builder-return-builder-alice-g1";
const migrationId = `mig-${operationId}`;
const input = { uid, slug, fromGatewayId, toGatewayId, operationId, migrationId, claimStartedAt: 9_000 };
const commits = { workspace: "a".repeat(40) };
const agentId = "octogee-alice-coach";

function root(gatewayId: string, isolated: boolean) {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    gatewayClass: isolated ? "isolated" : "shared", imageProfile: isolated ? "isolated" : "standard",
    profile: null, sizingTier: "s", sizingProfile: isolated ? "hobby" : null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: isolated ? uid : null, builderSlug: isolated ? slug : null, modelBrokerLimits: null,
  };
}

async function harness(excluded = true, workspaceEpoch = 4) {
  const docs = new Map<string, Record<string, unknown>>([
    [`gateways/${fromGatewayId}`, {
      ...root(fromGatewayId, true),
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "one", generation: 1, claimedByUid: uid, ephemeralHomeGiB: 4 },
      ephemeralWriter: { podUid: "original", podName: "builder-alice-original",
        node: { providerId: "gce://test-proj/us-central1-a/original", instanceId: "127" },
        ...(excluded ? { exclusion: { at: 8_900, method: "compute-instance-gone" } } : {}) },
    }],
    [`gateways/${toGatewayId}`, root(toGatewayId, false)],
    [`gateways/${fromGatewayId}/assignments/${uid}`, {
      uid, slug, gatewayId: fromGatewayId, state: "serving", source: "migrate-user", epoch: 4, createdAt: 1, updatedAt: 1,
    }],
    [`glmGateways/${toGatewayId}`, {
      docKind: "runtime", gatewayId: toGatewayId, release: 1, lifecycle: "serving",
      heartbeat: { status: "ready", lastHeartbeatAt: 9_900, mountedCustomers: [] },
      kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 9_900 },
    }],
    [`users/${uid}`, {
      username: slug, provisioning: { status: "complete", openclaw: { slug, status: "complete", gatewayId: fromGatewayId,
        activationLease: { leaseId: "one", generation: 1, status: "active", targetGatewayId: fromGatewayId } } },
      workspaceCheckpoint: { gatewayId: fromGatewayId, assignmentEpoch: workspaceEpoch, observedAt: 8_500, commits },
      scheduleCheckpoint: { gatewayId: fromGatewayId, assignmentEpoch: 4, observedAt: 8_500,
        snapshot: { version: 1, operationId: "checkpoint-alice", agentIds: [agentId], jobs: [], scratch: [] } },
    }],
  ]);
  const store = createDocumentFixtureStore(docs);
  await store.journal.operations.create({
    id: operationId, kind: "migrate-user", status: "running", origin: "automatic",
    createdAt: 8_990, createdBy: "glm-controller-placement-policy", startedAt: 9_000, completedAt: null, steps: [],
    input: { uid, userSlug: slug, fromGatewayId, toGatewayId, durableRecovery: true },
  });
  await store.users.agentStores.put(uid, {
    kind: "agent", agentId, storeId: "durable-store", schema: "alice", gatewayId: fromGatewayId,
    generation: 1, assignmentEpoch: 4, recordedAt: 8_900,
  });
  return { docs, store, deps: { store, now: () => new Date(NOW) } };
}

describe("atomic diskless Shared recovery", () => {
  it("publishes exactly one new assignment with a restore fence and reuses immutable checkpoints on retry", async () => {
    const { deps, store } = await harness();
    const result = await commitDisklessSharedRecovery(deps, input);
    expect(result).toMatchObject({ targetEpoch: 5, restorePending: true, workspaceCommits: commits,
      scheduler: { snapshot: { operationId: migrationId } } });
    expect(await store.gateways.assignments.get(fromGatewayId, uid)).toBeNull();
    expect(await store.gateways.assignments.get(toGatewayId, uid)).toMatchObject({ epoch: 5, updatedByOperationId: operationId });
    expect(await store.gateways.roots.get(fromGatewayId)).toMatchObject({ desiredStatus: "paused" });
    expect(await readUserRestoreAuthoritySnapshot(deps, { uid, slug, gatewayId: toGatewayId })).toMatchObject({ migrationId, assignmentEpoch: 5 });
    expect(await store.users.scheduleTransfers.listUnrestored()).toEqual([]);
    await expect(commitDisklessSharedRecovery(deps, input)).resolves.toEqual(result);
  });

  it.each([
    { excluded: false, workspaceEpoch: 4, reason: /exclusion/ },
    { excluded: true, workspaceEpoch: 3, reason: /same-epoch/ },
  ])("preserves source custody before commit without all durable evidence", async ({ excluded, workspaceEpoch, reason }) => {
    const { deps, store } = await harness(excluded, workspaceEpoch);
    await expect(commitDisklessSharedRecovery(deps, input)).rejects.toThrow(reason);
    expect(await store.gateways.assignments.get(toGatewayId, uid)).toBeNull();
    expect(await store.users.records.get(uid)).toMatchObject({ gateway: { gatewayId: fromGatewayId }, fences: {} });
  });

  it.each([2, 3])("seeds immediate recovery only from the serving Shared epoch (%s)", async checkpointEpoch => {
    const { docs, deps, store } = await harness();
    const target = docs.get(`gateways/${fromGatewayId}`)!;
    docs.set(`gateways/${fromGatewayId}`, { ...target, ephemeralWriter: { podUid: "new", podName: "builder-alice-new" } });
    docs.delete(`gateways/${fromGatewayId}/assignments/${uid}`);
    docs.set(`gateways/${toGatewayId}/assignments/${uid}`, {
      uid, slug, gatewayId: toGatewayId, state: "quiescing", source: "migrate-user", epoch: 3, createdAt: 1, updatedAt: 1,
    });
    docs.set(`users/${uid}`, {
      username: slug, provisioning: { status: "complete", openclaw: { slug, status: "complete", gatewayId: toGatewayId,
        activationLease: { leaseId: "one", generation: 1, status: "activating", targetGatewayId: fromGatewayId,
          sourceGatewayId: toGatewayId, sourceAssignmentEpoch: 3 } } },
      workspaceCheckpoint: { gatewayId: toGatewayId, assignmentEpoch: checkpointEpoch, observedAt: 8_500, commits },
      scheduleCheckpoint: { gatewayId: toGatewayId, assignmentEpoch: checkpointEpoch, observedAt: 8_500,
        snapshot: { version: 1, operationId: "checkpoint-alice", agentIds: [agentId], jobs: [], scratch: [] } },
    });
    await commitCutoverAtomic({ ...deps, readSizingKey: async () => "hobby" }, {
      uid, slug, fromGatewayId: toGatewayId, toGatewayId: fromGatewayId, flipMirror: true, automatic: true,
      assignment: { source: "migrate-user", updatedByOperationId: "activate-builder" },
    });

    const user = await store.users.records.get(uid);
    const expected = checkpointEpoch === 3 ? { gatewayId: fromGatewayId, assignmentEpoch: 4 }
      : { gatewayId: toGatewayId, assignmentEpoch: checkpointEpoch };
    expect(user?.workspaceCheckpoint).toMatchObject({ ...expected, observedAt: 8_500, commits });
    expect(user?.scheduleCheckpoint).toMatchObject({ ...expected, observedAt: 8_500 });
  });

  it("lets the exact interrupted activation end before the same lease returns to Shared", async () => {
    const { docs, deps, store } = await harness();
    const sourceShared = "shared-origin";
    const original = docs.get(`users/${uid}`)!;
    docs.set(`users/${uid}`, { ...original, provisioning: { status: "complete", openclaw: {
      slug, status: "complete", gatewayId: fromGatewayId, activationLease: {
        leaseId: "one", generation: 1, status: "activating", targetGatewayId: fromGatewayId,
        sourceGatewayId: sourceShared, sourceAssignmentEpoch: 3,
      },
    } } });
    const activationId = builderActivateOperationId(fromGatewayId, 1);
    await store.journal.operations.create({
      id: activationId, kind: "migrate-user", status: "running", origin: "automatic",
      createdAt: 7_000, createdBy: "glm-controller-placement-policy", startedAt: 8_000, completedAt: null, steps: [],
      input: { uid, userSlug: slug, fromGatewayId: sourceShared, toGatewayId: fromGatewayId, source: "builder-activation-lease" },
      cutoverCommittedAt: 8_450,
    });
    const scope = { uid, slug, gatewayId: fromGatewayId, claim: { operationId: activationId, startedAt: 8_000 } };
    await expect(readDisklessActivationWriterExcluded(store, scope)).resolves.toBe(true);
    await expect(readDisklessActivationWriterExcluded(store, { ...scope, claim: { ...scope.claim, startedAt: 8_001 } })).resolves.toBe(false);
    await expect(commitDisklessSharedRecovery(deps, input)).rejects.toThrow(/completed exclusion/);
    await store.journal.operations.patch(activationId, { status: "failed", error: DISKLESS_ACTIVATION_WRITER_EXCLUDED, completedAt: 9_020 });

    await expect(commitDisklessSharedRecovery(deps, input)).resolves.toMatchObject({ targetEpoch: 5, restorePending: true });
    expect((await store.users.records.get(uid))?.activationLease).toMatchObject({
      status: "returning", returnOperationId: operationId, returnReason: "source-unavailable",
    });
  });
});
