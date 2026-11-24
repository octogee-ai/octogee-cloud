import { workspaceDefaultAgentId } from "@octogee/shared/types/identity";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
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
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("accepted");
    await expect(recordGatewayScheduleCheckpoint({ ...report, pod: replacement })).resolves.toBe("kubernetes_writer_mismatch");
  });

  it("accepts the writer of a draining Shared member while that member still serves the owner", async () => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), desiredStatus: "draining", gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    docs.set(`glmGateways/${gatewayId}`, registryWithPod());
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("accepted");
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: { workspace: "a".repeat(40) } })).resolves.toBe("accepted");
  });

  it("accepts a Shared writer between Fleet observation refreshes and refuses one past the reconcile bound", async () => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    const registry = registryWithPod();
    const now = 1_000_000;
    const observed = (ageMs: number) => docs.set(`glmGateways/${gatewayId}`, { ...registry, kubernetes: { ...registry.kubernetes, observedAt: now - ageMs } });
    const late = { ...report, now, observedAt: now - 50 };
    observed(130_000);
    await expect(recordGatewayScheduleCheckpoint(late)).resolves.toBe("accepted");
    await expect(recordGatewayWorkspaceCheckpoint({ ...late, observedAt: now - 40, commits: { workspace: "a".repeat(40) } })).resolves.toBe("accepted");
    observed(GATEWAY_UNREACHABLE_AFTER_MS + 1);
    await expect(recordGatewayScheduleCheckpoint({ ...late, observedAt: now - 30 })).resolves.toBe("kubernetes_observation_stale");
  });

  it("refuses the replaced Pod as soon as the observation records its successor or a second Pod", async () => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    const registry = registryWithPod();
    const [placed] = registry.kubernetes.pods;
    const successor = { ...placed, uid: replacement.podUid, name: replacement.podName };
    docs.set(`glmGateways/${gatewayId}`, { ...registry, kubernetes: { ...registry.kubernetes, totalPods: 2, pods: [placed, successor] } });
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("kubernetes_writer_unobserved");
    docs.set(`glmGateways/${gatewayId}`, { ...registry, kubernetes: { ...registry.kubernetes, pods: [successor] } });
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("kubernetes_writer_mismatch");
    await expect(recordGatewayScheduleCheckpoint({ ...report, pod: replacement })).resolves.toBe("accepted");
  });

  it("accepts checkpoints from a returned owner whose computer only retains a completed scheduler retirement", async () => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    docs.set(`glmGateways/${gatewayId}`, registryWithPod());
    const retirement = { uid, slug: "alice", returnOperationId: "return-one", sourceGatewayId: "alice-s-1" };
    const retain = (custody: Record<string, unknown>) => docs.set(`users/${uid}`, {
      provisioning: { pendingNativeSchedulerRetirement: custody, openclaw: { slug: "alice", gatewayId } },
    });
    retain({ ...retirement, cutoverCommittedAt: 3_000, completedAt: 3_500 });
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("accepted");
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, observedAt: 4_050, commits: { workspace: "a".repeat(40) } })).resolves.toBe("accepted");
    retain(retirement);
    await expect(recordGatewayScheduleCheckpoint({ ...report, observedAt: 4_060 })).resolves.toBe("user_fenced");
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, observedAt: 4_070, commits: { workspace: "b".repeat(40) } })).resolves.toBe("user_fenced");
  });

  it.each([
    ["completion without a committed cutover", { completedAt: 3_500 }],
    ["completion before its cutover", { cutoverCommittedAt: 3_500, completedAt: 3_000 }],
    ["a non-finite completion", { cutoverCommittedAt: 3_000, completedAt: Number.POSITIVE_INFINITY }],
    ["another owner's retirement", { uid: "uid-bob", cutoverCommittedAt: 3_000, completedAt: 3_500 }],
    ["another slug's retirement", { slug: "bob", cutoverCommittedAt: 3_000, completedAt: 3_500 }],
  ])("keeps fencing checkpoints for %s", async (_case, custody) => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    docs.set(`glmGateways/${gatewayId}`, registryWithPod());
    docs.set(`users/${uid}`, {
      provisioning: { pendingNativeSchedulerRetirement: { uid, slug: "alice", returnOperationId: "return-one", ...custody }, openclaw: { slug: "alice", gatewayId } },
    });
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("user_fenced");
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: { workspace: "a".repeat(40) } })).resolves.toBe("user_fenced");
  });

  it("keeps fencing a completed retirement whose journaled return did not succeed with that cutover", async () => {
    const { docs, report } = harness();
    const key = `gateways/${gatewayId}`;
    docs.set(key, { ...docs.get(key), gatewayClass: "shared", allocation: undefined, ownerUid: null, builderSlug: null });
    docs.set(`glmGateways/${gatewayId}`, registryWithPod());
    const retirement = { uid, slug: "alice", returnOperationId: "return-one", sourceGatewayId: "alice-s-1",
      sharedGatewayId: "shared-green", cutoverCommittedAt: 3_000, completedAt: 3_500 };
    docs.set(`users/${uid}`, { provisioning: { pendingNativeSchedulerRetirement: retirement, openclaw: { slug: "alice", gatewayId } } });
    const returned = { kind: "migrate-user", status: "succeeded", cutoverCommittedAt: 3_000, createdAt: 1, createdBy: "test",
      startedAt: 1, completedAt: 3_500, inputUid: uid, input: { uid, fromGatewayId: "alice-s-1", toGatewayId: "shared-green" } };
    docs.set("glmOperations/return-one", returned);
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("accepted");
    docs.set("glmOperations/return-one", { ...returned, status: "failed" });
    await expect(recordGatewayScheduleCheckpoint({ ...report, observedAt: 4_050 })).resolves.toBe("user_fenced");
    docs.set("glmOperations/return-one", { ...returned, cutoverCommittedAt: 2_000 });
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: { workspace: "a".repeat(40) } })).resolves.toBe("user_fenced");
  });

  it("records removals and ignores a delayed earlier capture", async () => {
    const { store, report, claim } = harness();
    await claim();
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("accepted");
    await expect(recordGatewayScheduleCheckpoint({ ...report, observedAt: 4_050, snapshot: { ...snapshot, jobs: [] } })).resolves.toBe("accepted");
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("accepted");
    expect((await store.users.records.get(uid))?.scheduleCheckpoint).toMatchObject({ assignmentEpoch: 3, snapshot: { jobs: [] }, observedAt: 4_050 });
  });

  it("rejects capture from an old epoch, replacement Pod, or foreign agent", async () => {
    const { report, claim } = harness();
    await claim();
    await expect(recordGatewayScheduleCheckpoint({ ...report, assignmentEpoch: 2 })).resolves.toBe("assignment_not_owned");
    await expect(recordGatewayScheduleCheckpoint({ ...report, pod: replacement })).resolves.toBe("ephemeral_writer_mismatch");
    const foreign = workspaceDefaultAgentId("bob");
    await expect(recordGatewayScheduleCheckpoint({
      ...report, snapshot: { ...snapshot, jobs: [{ ...snapshot.jobs[0], agentId: foreign }] },
    })).resolves.toBe("foreign_schedules");
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
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, observedAt: 4_050, commits: latest })).resolves.toBe("accepted");
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: older })).resolves.toBe("accepted");
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, pod: replacement, commits: older })).resolves.toBe("ephemeral_writer_mismatch");
    expect((await store.users.records.get(uid))?.workspaceCheckpoint).toMatchObject({
      gatewayId, assignmentEpoch: 3, observedAt: 4_050, commits: latest,
    });
  });

  it("accepts a confirmed workspace save from the quiescing source of an ordinary move", async () => {
    const { report, claim, docs } = harness();
    await claim();
    const key = `gateways/${gatewayId}/assignments/${uid}`;
    docs.set(key, { ...docs.get(key), state: "quiescing" });
    await expect(recordGatewayWorkspaceCheckpoint({ ...report, commits: { workspace: "a".repeat(40) } })).resolves.toBe("accepted");
    await expect(recordGatewayScheduleCheckpoint(report)).resolves.toBe("assignment_not_serving");
  });
});
