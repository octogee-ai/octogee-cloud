import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { SourceRecoveryPendingError } from "../placement-refusal.js";
import {
  checkUnreachableRecoveryFence,
  recoverUnreachableIsolatedGateway,
  retireOwnedIsolatedGateway,
  retirementAuthorityFenceAllows,
  type PodObservation,
} from "./index.js";

const GATEWAY = "alice-xs-12345678";
const RECOVERY = `builder-recover-${GATEWAY}-g1`;
const RETIREMENT = `placement-retire-uid-alice-${GATEWAY}-g1`;
const ACTIVATION_INPUT = { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: GATEWAY, source: "builder-activation-lease" };
const requireOwner = async () => undefined;

function isolatedRoot(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: GATEWAY,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 5,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: "s",
    sizingProfile: "hobby",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-alice",
    builderSlug: "alice",
    modelBrokerLimits: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: "uid-alice" },
    ...overrides,
  };
}

function harness(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries({
    [`gateways/${GATEWAY}`]: isolatedRoot(),
    "users/uid-alice": {
      username: "alice",
      provisioning: { status: "complete", openclaw: { gatewayId: "shared-blue", slug: "alice",
        activationLease: { leaseId: "lease-one", generation: 1, status: "returning", targetGatewayId: GATEWAY, returnReason: "source-unavailable" } } },
    },
    "gateways/shared-blue/assignments/uid-alice": { uid: "uid-alice", slug: "alice", gatewayId: "shared-blue", source: "onboarding", state: "serving", epoch: 4, createdAt: 1, updatedAt: 1 },
    ...seed,
  }));
  const store = createDocumentFixtureStore(docs);
  const log = vi.fn();
  const diagnostics = vi.fn(async (_gatewayId: string): Promise<PodObservation> => ({ status: "missing", totalPods: 0 }));
  const deps = { store, now: () => 10_000, readSizingKey: async () => "hobby", log, requireOwner, readGatewayPodDiagnostics: diagnostics, sourceRecoveryPending: () => false };
  const request = { uid: "uid-alice", builderSlug: "alice", gatewayId: GATEWAY, leaseId: "lease-one", generation: 1, authoritativeGatewayId: "shared-blue" };
  return { docs, store, log, diagnostics, deps, request };
}

describe("unreachable isolated gateway recovery", () => {
  it("pauses the gateway, then records a zero-pod receipt once the pods are gone", async () => {
    const h = harness();

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).resolves.toEqual({ state: "recovered", operationId: RECOVERY });

    expect(h.docs.get(`gateways/${GATEWAY}`)).toMatchObject({ desiredStatus: "paused", updatedBy: `glm-controller-placement-policy:${RECOVERY}` });
    expect(h.docs.get(`gatewayRecoveryReceipts/${RECOVERY}`)).toMatchObject({
      kind: "recover-unreachable-disposable",
      status: "succeeded",
      createdBy: "glm-controller-placement-policy",
      input: { uid: "uid-alice", userSlug: "alice", gatewayId: GATEWAY, leaseId: "lease-one", generation: 1, authoritativeGatewayId: "shared-blue" },
      recoveryReceipt: { schemaVersion: 1, observedAt: 10_000, pods: 0 },
    });
  });

  it.each([
    ["an unknown observation", { status: "unknown", totalPods: 0 }, "observation-unknown"],
    ["an observation error", { status: "missing", totalPods: 0, error: "kubectl timed out" }, "observation-unknown"],
    ["pods still present", { status: "not-ready", totalPods: 1 }, "pods-present"],
  ] as const)("keeps the reserve and waits on %s, and a later call completes it", async (_name, observation, reason) => {
    const h = harness();
    h.diagnostics.mockResolvedValueOnce(observation);

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).resolves.toEqual({ state: "waiting", reason, operationId: RECOVERY });
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("paused");
    expect(h.docs.get(`gatewayRecoveryReceipts/${RECOVERY}`)?.status).toBe("pending");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`recovery ${RECOVERY} waiting for pod absence`));

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).resolves.toEqual({ state: "recovered", operationId: RECOVERY });
    expect(h.docs.get(`gatewayRecoveryReceipts/${RECOVERY}`)?.status).toBe("succeeded");
  });

  it("treats an empty observation error as no error, as before", async () => {
    const h = harness();
    h.diagnostics.mockResolvedValueOnce({ status: "missing", totalPods: 0, error: "" });

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).resolves.toEqual({ state: "recovered", operationId: RECOVERY });
  });

  it("waits, with the reserve kept, when the observation itself throws", async () => {
    const h = harness();
    h.diagnostics.mockRejectedValueOnce(new Error("api server unavailable"));

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).resolves.toEqual({ state: "waiting", reason: "observation-unknown", operationId: RECOVERY });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("error=api server unavailable"));
  });

  it("writes nothing when the user is no longer authoritative on the shared gateway", async () => {
    const h = harness();
    h.docs.get("gateways/shared-blue/assignments/uid-alice")!.state = "quiescing";

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).rejects.toThrow("no longer authoritative");
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("running");
    expect(h.docs.has(`gatewayRecoveryReceipts/${RECOVERY}`)).toBe(false);
    expect(h.diagnostics).not.toHaveBeenCalled();
  });

  it("writes nothing when the gateway became ready again", async () => {
    const h = harness({
      [`glmGateways/${GATEWAY}`]: { docKind: "runtime", gatewayId: GATEWAY, release: 1, lifecycle: "serving", runtime: "gce-vm",
        heartbeat: { status: "ready", lastHeartbeatAt: 9_000 } },
    });

    await expect(recoverUnreachableIsolatedGateway(h.deps, h.request)).rejects.toThrow("became ready before recovery");
    expect(h.docs.has(`gatewayRecoveryReceipts/${RECOVERY}`)).toBe(false);
  });

  it("refuses before any write when the owner fence refuses", async () => {
    const h = harness();
    const refusal = new Error("placement automation is owned by fleet-controller");

    await expect(recoverUnreachableIsolatedGateway({ ...h.deps, requireOwner: async () => { throw refusal; } }, h.request)).rejects.toBe(refusal);
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("running");
    expect(h.docs.has(`gatewayRecoveryReceipts/${RECOVERY}`)).toBe(false);
  });
});

describe("unreachable recovery of a failed activation's target", () => {
  const ACTIVATION = builderActivateOperationId(GATEWAY, 1);
  const activation = (status: string, released: boolean, recoverSourceOnly = false) => ({ [`glmOperations/${ACTIVATION}`]: {
    kind: "migrate-user", status, createdAt: 1, createdBy: "test", startedAt: 1, completedAt: status === "failed" ? 2 : null,
    input: { ...ACTIVATION_INPUT, ...(recoverSourceOnly ? { recoverSourceOnly } : {}) }, steps: [], schedulerHandoffReleased: released,
  } });
  const recovering = (operation: { id: string; schedulerHandoffReleased?: unknown }) =>
    operation.id === ACTIVATION && operation.schedulerHandoffReleased === false;

  it("refuses while the failed activation recovers its source, and pauses nothing", async () => {
    const h = harness(activation("failed", false));

    await expect(recoverUnreachableIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, h.request))
      .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("running");
    expect(h.docs.has(`gatewayRecoveryReceipts/${RECOVERY}`)).toBe(false);
  });

  it.each(["pending", "running"])("refuses while a re-armed source-only recovery is %s, and pauses nothing", async (status) => {
    const h = harness(activation(status, false, true));

    await expect(recoverUnreachableIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, h.request))
      .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("running");
    expect(h.docs.has(`gatewayRecoveryReceipts/${RECOVERY}`)).toBe(false);
  });

  it("refuses the dry run the same way", async () => {
    const h = harness(activation("failed", false));

    await expect(checkUnreachableRecoveryFence({ ...h.deps, sourceRecoveryPending: recovering }, h.request))
      .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
  });

  it.each([
    ["the source recovery is released", activation("failed", true)],
    ["the activation is still running", activation("running", false)],
  ])("recovers once %s", async (_name, seed) => {
    const h = harness(seed);

    await expect(recoverUnreachableIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, h.request))
      .resolves.toEqual({ state: "recovered", operationId: RECOVERY });
  });
});

describe("owned isolated gateway retirement", () => {
  const pausedRoot = () => ({ [`gateways/${GATEWAY}`]: isolatedRoot({ desiredStatus: "paused" }) });
  const retire = { uid: "uid-alice", builderSlug: "alice", gatewayId: GATEWAY, generation: 1, leaseId: "lease-one", reason: "builder-returned" as const };

  it("claims the retirement under the deterministic operation id", async () => {
    const h = harness(pausedRoot());

    await expect(retireOwnedIsolatedGateway(h.deps, retire)).resolves.toEqual({ retired: true, operationId: RETIREMENT });
    expect(h.docs.get(`gateways/${GATEWAY}`)).toMatchObject({ desiredStatus: "retired", retirementClaim: { operationId: RETIREMENT } });
    expect(h.docs.get(`glmOperations/${RETIREMENT}`)).toMatchObject({
      kind: "retire-gateway", status: "pending", origin: "automatic", createdBy: "glm-controller-placement-policy",
      input: { gatewayId: GATEWAY, uid: "uid-alice", userSlug: "alice", reason: "builder-returned" },
    });
  });

  it("answers the blocking reason and writes nothing when the allocation changed", async () => {
    const h = harness(pausedRoot());

    await expect(retireOwnedIsolatedGateway(h.deps, { ...retire, leaseId: "lease-two" })).resolves.toEqual({
      retired: false, operationId: RETIREMENT, reason: `gateway ${GATEWAY} no longer matches isolated allocation for uid-alice`,
    });
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("paused");
    expect(h.docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`retirement blocked for ${GATEWAY}`));
  });

  it("plans a blocked retirement with the same reason and logs no block", async () => {
    const h = harness(pausedRoot());

    await expect(retireOwnedIsolatedGateway(h.deps, { ...retire, leaseId: "lease-two" }, "plan")).resolves.toMatchObject({
      retired: false, reason: `gateway ${GATEWAY} no longer matches isolated allocation for uid-alice`,
    });
    expect(h.log).not.toHaveBeenCalled();
  });

  it("holds the retirement until the return operation it waits on has finished", async () => {
    const h = harness({ ...pausedRoot(), "glmOperations/builder-return-x": { kind: "migrate-user", status: "running", createdAt: 1, createdBy: "test", startedAt: 1, completedAt: null, input: {}, steps: [] } });

    await expect(retireOwnedIsolatedGateway(h.deps, { ...retire, telemetryFenceOperationId: "builder-return-x" })).resolves.toEqual({
      retired: false, operationId: RETIREMENT, reason: "return operation builder-return-x is incomplete",
    });
  });

  it("needs a matching zero-workload recovery receipt when one is named", async () => {
    const h = harness(pausedRoot());

    await expect(retireOwnedIsolatedGateway(h.deps, { ...retire, zeroWorkloadRecoveryOperationId: RECOVERY })).resolves.toMatchObject({
      retired: false, reason: `gateway ${GATEWAY} zero-workload recovery receipt is unavailable`,
    });
    await recoverUnreachableIsolatedGateway(h.deps, h.request);
    await expect(retireOwnedIsolatedGateway(h.deps, { ...retire, zeroWorkloadRecoveryOperationId: RECOVERY })).resolves.toMatchObject({ retired: true });
  });

  describe("after a failed activation", () => {
    const ACTIVATION = builderActivateOperationId(GATEWAY, 1);
    const failedActivation = { [`glmOperations/${ACTIVATION}`]: {
      kind: "migrate-user", status: "failed", createdAt: 1, createdBy: "test", startedAt: 1, completedAt: 2, input: ACTIVATION_INPUT, steps: [],
      schedulerHandoffReleased: false,
    } };
    const activationFailed = { ...retire, reason: "activation-failed" as const };
    const recovering = (operation: { id: string; schedulerHandoffReleased?: unknown }) =>
      operation.id === ACTIVATION && operation.schedulerHandoffReleased === false;

    it.each(["apply", "plan"] as const)("refuses to %s while the activation's source recovery is pending and writes nothing", async (mode) => {
      const h = harness({ ...pausedRoot(), ...failedActivation });

      await expect(retireOwnedIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, activationFailed, mode))
        .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
      expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("paused");
      expect(h.docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
    });

    it("retires once the activation's source recovery is released", async () => {
      const h = harness({ ...pausedRoot(), ...failedActivation });
      h.docs.set(`glmOperations/${ACTIVATION}`, { ...h.docs.get(`glmOperations/${ACTIVATION}`), schedulerHandoffReleased: true });

      await expect(retireOwnedIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, activationFailed))
        .resolves.toEqual({ retired: true, operationId: RETIREMENT });
    });

    it("refuses another retirement reason too while the failed activation recovers its source", async () => {
      const h = harness({ ...pausedRoot(), ...failedActivation });

      await expect(retireOwnedIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, retire))
        .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
      expect(h.docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
    });

    it.each([
      ["pending", "builder-returned", false], ["running", "builder-returned", false], ["pending", "activation-failed", false],
      ["running", "activation-failed", false], ["pending", "builder-returned", true], ["running", "activation-failed", true],
    ] as const)("blocks the retirement as an in-flight migration while the activation is %s, for %s (source-only recovery %s)", async (status, reason, recoverSourceOnly) => {
      const h = harness({ ...pausedRoot(), ...failedActivation });
      h.docs.set(`glmOperations/${ACTIVATION}`, { ...h.docs.get(`glmOperations/${ACTIVATION}`), status, completedAt: null,
        input: { ...ACTIVATION_INPUT, ...(recoverSourceOnly ? { recoverSourceOnly } : {}) } });

      await expect(retireOwnedIsolatedGateway({ ...h.deps, sourceRecoveryPending: recovering }, { ...retire, reason })).resolves.toEqual({
        retired: false, operationId: RETIREMENT, reason: `user migration is in flight for gateway ${GATEWAY}`,
      });
      expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("paused");
      expect(h.docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
    });
  });

  it("lets the owner refusal through rather than reporting it as a blocked retirement", async () => {
    const h = harness(pausedRoot());
    const refusal = new Error("the fleet controller has not yielded placement automation");

    await expect(retireOwnedIsolatedGateway({ ...h.deps, requireOwner: async () => { throw refusal; } }, retire)).rejects.toBe(refusal);
    expect(h.docs.get(`gateways/${GATEWAY}`)?.desiredStatus).toBe("paused");
  });
});

describe("isolated retirement authority fence", () => {
  const fence = (status: "provisioning" | "activating" | "returning", expected: "provisioning" | "activating" | "returning") => retirementAuthorityFenceAllows({
    uid: "uid-alice",
    authoritativeGatewayId: "shared-blue",
    targetGatewayId: "builder-alice",
    leaseId: "lease-one",
    generation: 1,
    expectedLeaseStatus: expected,
    userRecord: {
      gateway: { gatewayId: "shared-blue" },
      activationLease: { leaseId: "lease-one", generation: 1, status, targetGatewayId: "builder-alice" },
    },
    assignment: { uid: "uid-alice", gatewayId: "shared-blue", state: "serving" },
  });

  it.each(["provisioning", "activating", "returning"] as const)("accepts an exact shared-authoritative %s lease", (status) => {
    expect(fence(status, status)).toBe(true);
  });

  it("rejects a lease phase that changed after the retirement request", () => {
    expect(fence("activating", "provisioning")).toBe(false);
  });
});
