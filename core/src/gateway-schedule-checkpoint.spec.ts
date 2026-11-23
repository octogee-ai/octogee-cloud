import { workspaceDefaultAgentId } from "@octogee/shared/types/identity";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { describe, expect, it } from "vitest";
import { parseWorkspaceCheckpoint, recordGatewayScheduleCheckpoint, recordGatewayWorkspaceCheckpoint } from "./gateway-schedule-checkpoint.js";
import { claimEphemeralWriter } from "./isolated-gateway-lifecycle/ephemeral-recovery-state.js";

const uid = "uid-alice";
const gatewayId = "builder-alice";
const pod = { podUid: "pod-one", podName: "octogee-gateway-builder-alice-rs-one" };
const replacement = { podUid: "pod-two", podName: "octogee-gateway-builder-alice-rs-two" };
const agent = workspaceDefaultAgentId("alice");
const snapshot = { version: 1 as const, operationId: "checkpoint-alice", agentIds: [agent], jobs: [{ id: "job-one", agentId: agent, name: "Daily report" }], scratch: [] };

function harness() {
  const docs = new Map<string, Record<string, unknown>>([
    [`gateways/${gatewayId}`, {
      gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
      latestRelease: 1, desiredRelease: 1, liveRelease: 1,
      ownerUid: uid, gatewayClass: "isolated", desiredStatus: "running", builderSlug: "alice",
      configSchemaVersion: 1, profile: null, imageProfile: "isolated", sizingTier: "s", sizingProfile: "hobby",
      gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
      serviceAccount: null, builderAccess: null, modelBrokerLimits: null,
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: uid, ephemeralHomeGiB: 4 },
    }],
    [`users/${uid}`, { provisioning: { openclaw: { slug: "alice", gatewayId } } }],
    [`gateways/${gatewayId}/assignments/${uid}`, { uid, slug: "alice", gatewayId, state: "serving", epoch: 3, source: "onboarding", createdAt: 1, updatedAt: 1 }],
  ]);
  const store = createDocumentFixtureStore(docs);
  const claim = (identity = pod) => claimEphemeralWriter({ store, gatewayId, ownerUid: uid, pod: identity });
  const report = { store, uid, gatewayId, pod, assignmentEpoch: 3, observedAt: 4_000, now: 4_100, snapshot };
  return { docs, store, claim, report };
}

function registryWithPod() {
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", createdAt: 1,
    createdByOperationId: null, helm: {}, heartbeat: {}, lastError: { message: null, at: null },
    kubernetes: {
      status: "ready", readyPods: 1, totalPods: 1, observedAt: 3_900,
      pods: [{ uid: pod.podUid, name: pod.podName, replicaSetUid: "rs", nodeName: "test-node", nodePool: "spot",
        providerId: "gce://test-project/us-central1-a/test-node", instanceId: "1234" }],
    },
  };
}

describe("durable scheduler checkpoints", () => {
  it("admits the first isolated Pod and denies replacements even with the same allocation", async () => {
    const { claim } = harness();
    await expect(claim()).resolves.toBe(true);
    await expect(claim()).resolves.toBe(true);
    await expect(claim(replacement)).resolves.toBe(false);
  });

  it("permits a new unassigned startup Pod only after the previous writer was excluded", async () => {
    const { claim, docs, store } = harness();
    await expect(claim()).resolves.toBe(true);
    const gateway = `gateways/${gatewayId}`;
    docs.set(gateway, { ...docs.get(gateway), ephemeralWriter: { ...pod,
      node: { providerId: "gce://test-project/us-central1-a/test-node", instanceId: "1234" },
      exclusion: { at: 4_000, method: "compute-instance-gone" } } });
    await expect(claim(replacement)).resolves.toBe(false);
    await store.gateways.assignments.delete(gatewayId, uid);
    const moveLease = (status: "provisioning" | "returning") => docs.set(`users/${uid}`, {
      provisioning: { openclaw: { slug: "alice", gatewayId: "shared-blue",
        activationLease: { status, targetGatewayId: gatewayId, leaseId: "lease-one", generation: 1 } } },
    });
    moveLease("returning");
    await expect(claim(replacement)).resolves.toBe(false);
    moveLease("provisioning");
    await expect(claim(pod)).resolves.toBe(false);
    await expect(claim(replacement)).resolves.toBe(true);
    expect((await store.gateways.roots.get(gatewayId))?.ephemeralWriter).toEqual(replacement);
  });

  it("pins the Compute identity from a Fleet observation of the exact claimed Pod", async () => {
    const { claim, docs, store } = harness();
    docs.set(`glmGateways/${gatewayId}`, registryWithPod());
    await expect(claim()).resolves.toBe(true);
    expect((await store.gateways.roots.get(gatewayId))?.ephemeralWriter).toEqual({
      ...pod, node: { providerId: "gce://test-project/us-central1-a/test-node", instanceId: "1234" },
    });
  });

  it("accepts the sole observed writer on a Shared gateway and rejects another Pod", async () => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    docs.set(`glmGateways/${gatewayId}`, registryWithPod());
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe(true);
    await expect(recordGatewayScheduleCheckpoint({ ...report, pod: replacement })).resolves.toBe(false);
  });

  it("records removals and ignores a delayed earlier capture", async () => {
    const { store, report, claim } = harness();
    await claim();
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe(true);
    await expect(recordGatewayScheduleCheckpoint({ ...report, observedAt: 4_050, snapshot: { ...snapshot, jobs: [] } })).resolves.toBe(true);
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe(true);
    expect((await store.users.records.get(uid))?.scheduleCheckpoint).toMatchObject({ assignmentEpoch: 3, snapshot: { jobs: [] }, observedAt: 4_050 });
  });

  it("rejects capture from an old epoch, replacement Pod, or foreign agent", async () => {
    const { report, claim } = harness();
    await claim();
    await expect(recordGatewayScheduleCheckpoint({ ...report, assignmentEpoch: 2 })).resolves.toBe(false);
    await expect(recordGatewayScheduleCheckpoint({ ...report, pod: replacement })).resolves.toBe(false);
    const foreign = workspaceDefaultAgentId("bob");
    await expect(recordGatewayScheduleCheckpoint({
      ...report, snapshot: { ...snapshot, jobs: [{ ...snapshot.jobs[0], agentId: foreign }] },
    })).resolves.toBe(false);
  });
});


describe("durable workspace checkpoints", () => {
  it("keeps a reaffirmed revision ahead of a delayed intermediate update", async () => {
    const { store, report, claim } = harness();
    await claim();
    const stable = { workspace: "a".repeat(40) };
    const intermediate = { workspace: "b".repeat(40) };
    await recordGatewayWorkspaceCheckpoint({ ...report, commits: stable });
    await recordGatewayWorkspaceCheckpoint({ ...report, observedAt: 4_075, commits: stable });
    await recordGatewayWorkspaceCheckpoint({ ...report, observedAt: 4_050, commits: intermediate });
    expect((await store.users.records.get(uid))?.workspaceCheckpoint?.commits).toEqual(stable);
  });

  it("acknowledges a managed commit from the same serving epoch and retains it over a late report", async () => {
    const { store, report, claim } = harness();
    await claim();
    const older = { workspace: "a".repeat(40) };
    const latest = { workspace: "b".repeat(40), example: "c".repeat(40) };
    expect(parseWorkspaceCheckpoint(latest)).toEqual(latest);
    expect(parseWorkspaceCheckpoint({ workspace: "unconfirmed" })).toBeNull();
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, observedAt: 4_050, commits: latest })).resolves.toBe(true);
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: older })).resolves.toBe(true);
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, pod: replacement, commits: older })).resolves.toBe(false);
    expect((await store.users.records.get(uid))?.workspaceCheckpoint).toMatchObject({
      gatewayId, assignmentEpoch: 3, observedAt: 4_050, commits: latest,
    });
  });

  it("accepts a confirmed workspace save from the quiescing source of an ordinary move", async () => {
    const { report, claim, docs } = harness();
    await claim();
    const key = `gateways/${gatewayId}/assignments/${uid}`;
    docs.set(key, { ...docs.get(key), state: "quiescing" });
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: { workspace: "a".repeat(40) } })).resolves.toBe(true);
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe(false);
  });
});
