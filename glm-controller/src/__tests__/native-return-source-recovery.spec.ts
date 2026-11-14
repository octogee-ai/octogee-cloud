import { describe, expect, it, vi } from "vitest";
import { createMigrateUserHandler, type MigrateUserDeps } from "../handlers/migrate-user.js";
import { enqueuePlacementMigration } from "../placement-policy-reconciler.js";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createNativeReturnSourceRecoveryOwner } from "../native-return-source-recovery.js";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";

const uid = "JSdDrHQlrQQEDCco52IYEwolLGZ2", source = "ceckert-test-m-4e0f970a", target = "shared-6e65610bead4";
const operationId = `builder-return-${source}-g114`, retirementId = `shared-pool-retire-${target}`;
function fixture() {
  const records: Record<string, any> = {
    [`users/${uid}`]: { username: "ceckert-test", provisioning: { openclaw: { slug: "ceckert-test", gatewayId: source,
      activationLease: { status: "returning", leaseId: "lease114", generation: 114, targetGatewayId: source, returnOperationId: operationId, pendingDemand: { eventKey: "human-chat" } } } } },
    [`gateways/${source}`]: { gatewayId: source, latestRelease: 7, gatewayClass: "isolated", ownerUid: uid, builderSlug: "ceckert-test", desiredStatus: "running", desiredRelease: 7, liveRelease: 7,
      allocation: { kind: "disposable-builder", claimedByUid: uid, leaseId: "lease114", generation: 114 } },
    [`glmGateways/${source}`]: { docKind: "runtime", gatewayId: source, release: 7, lifecycle: "active", runtime: "gce-vm", vm: { instanceName: "native-source", instanceId: "vm114", zone: "us-central1-a" }, vmHome: { returnOperationId: operationId, checkpointRequestedAt: 50 } },
    [`gateways/${source}/assignments/${uid}`]: { uid, slug: "ceckert-test", gatewayId: source, source: "migrate-user", epoch: 25, state: "serving", createdAt: 10, updatedAt: 10, updatedByOperationId: null },
    [`gateways/${target}`]: { gatewayId: target, desiredRelease: 3, latestRelease: 3, gatewayClass: "shared", desiredStatus: "retired", retirementVersion: 1, retirementClaim: { operationId: retirementId, version: 1, phase: "claimed" } },
    [`glmOperations/${retirementId}`]: { kind: "retire-gateway", status: "succeeded", gatewayId: target, createdAt: 200, completedAt: 300,
      input: { gatewayId: target, source: "shared-pool-scaler", retirementClaimVersion: 1 }, steps: [{ name: "helm-uninstall", status: "done" }, { name: "revoke-agent-store-credentials", status: "done" }] },
    [`glmOperations/${operationId}`]: { kind: "migrate-user", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy", inputUid: uid, gatewayId: target,
      startedAt: 90, completedAt: 100, attempts: 22, rolledBack: false, steps: [{ name: "quiesce-source", status: "failed" }],
      attemptHistory: [{ attempt: 22, error: "old Native cleanup permission denied", steps: [{ name: "quiesce-source", status: "failed" }] }],
      input: { uid, userSlug: "ceckert-test", fromGatewayId: source, toGatewayId: target, source: "builder-activation-lease" },
      schedulerHandoffReleased: false, schedulerHandoff: { uid, slug: "ceckert-test", fromGatewayId: source, toGatewayId: target, migrationId: `mig-${operationId}:scheduler:22:claim:90` } },
  };
  const events: string[] = [];
  let proof = true;
  const deps = {
    store: createDocumentFixtureStore(records), now: () => 1000, log: vi.fn(),
    verifyRetiredTarget: vi.fn(async (gatewayId: string, assertCurrent: () => Promise<void>) => { expect(gatewayId).toBe(target); await assertCurrent(); return proof; }),
    releaseSourceHold: vi.fn(async () => { events.push("hold"); }),
    prepareSourceStores: vi.fn(async (gatewayId: string, slug: string, authority?: { expectedUserUid: string; assertCurrent(): Promise<void> }) => {
      expect(gatewayId).toBe(source); expect(slug).toBe("ceckert-test"); expect(authority?.expectedUserUid).toBe(uid); await authority?.assertCurrent(); events.push("ownership");
    }),
    sourceClient: vi.fn(async () => ({ scheduler: vi.fn(async () => { events.push("scheduler"); }), resume: vi.fn(async () => { events.push("ingress"); }) }) as any),
  };
  const owner = createNativeReturnSourceRecoveryOwner(deps);
  const request = () => owner.request({ uid, operationId, requestedAt: 400, requestedBy: uid });
  const ctx = { assertActiveClaim: vi.fn(async () => {
    if (records[`glmOperations/${operationId}`].startedAt !== 500) throw new Error("claim lost");
  }), reportStep: vi.fn(async (step: OperationStep) => { expect(step.name).toBeTruthy(); }) };
  const claim = () => { records[`glmOperations/${operationId}`].status = "running"; records[`glmOperations/${operationId}`].startedAt = 500; return { ...structuredClone(records[`glmOperations/${operationId}`]), id: operationId } as Operation; };
  return { records, deps, owner, request, ctx, claim, events, setProof: (value: boolean) => { proof = value; } };
}

function failedCleanupRetry() {
  const h = fixture();
  const operation = h.records[`glmOperations/${operationId}`];
  const error = `/unmount/${target}: 500 {"error":"unmount failed","message":"voice migration resume failed: HTTP 409"}`;
  Object.assign(operation.attemptHistory[0], { startedAt: 90, completedAt: 100 });
  operation.attemptHistory.push({ attempt: 23, startedAt: 110, completedAt: 120, steps: [], error });
  Object.assign(operation, {
    attempts: 23, startedAt: 110, completedAt: 120, steps: [], error,
    schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 130,
  });
  h.records[`glmGateways/${source}`].vmHome = {};
  return { ...h, operation };
}

describe("retired target Native return source-only recovery", () => {
  it("recovers the original source claim after a failed cleanup-only retry", async () => {
    const h = failedCleanupRetry();
    const history = structuredClone(h.operation.attemptHistory);
    expect(await h.request()).toBe(true);
    expect(h.events).toEqual([]);
    expect(await h.owner.recover(h.claim(), h.ctx)).toMatchObject({ rolledBack: true });
    expect(h.events).toEqual(["hold", "ownership", "scheduler", "ingress"]);
    const client = await h.deps.sourceClient.mock.results[0].value;
    expect(client.scheduler).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: source, migrationId: `mig-${operationId}:scheduler:22:claim:90`, phase: "resume",
    }));
    expect(h.operation.attemptHistory).toEqual(history);
  });

  it.each([
    ["unreleased scheduler", (op: any) => { op.schedulerHandoffReleased = false; }],
    ["old release receipt", (op: any) => { op.schedulerHandoffReleasedAt = 100; }],
    ["missing historical claim", (op: any) => { op.attemptHistory[0].startedAt = 91; }],
    ["later migration progress", (op: any) => { op.attemptHistory[1].steps.push({ name: "keys-sync-state", status: "done" }); }],
    ["other failure", (op: any) => { op.attemptHistory[1].error = "unrelated failure"; }],
    ["forward recovery", (op: any) => { op.schedulerHandoff.forwardRecovery = {}; }],
  ])("refuses historical scheduler recovery with %s", async (_change, corrupt) => {
    const h = failedCleanupRetry();
    corrupt(h.operation);
    expect(await h.request()).toBe(false);
    expect(h.operation.status).toBe("failed");
  });

  it("queues the exact failed generation without claiming rollback, changing pending demand or contacting Native31", async () => {
    const h = fixture(), before = structuredClone(h.records[`users/${uid}`]);
    expect(await h.request()).toBe(true);
    expect(h.records[`glmOperations/${operationId}`]).toMatchObject({ status: "pending", rolledBack: false, schedulerHandoffReleased: false,
      input: { toGatewayId: target, recoverSourceOnly: true, nativeReturnSourceRecovery: { sourceEpoch: 25, generation: 114, leaseId: "lease114" } } });
    expect(h.records[`users/${uid}`]).toEqual(before); expect(h.events).toEqual([]);
    expect(h.records[`glmOperations/${operationId}`].attemptHistory).toHaveLength(1);
  });
  it.each(["lease", "epoch", "owner", "vm", "cutover", "target-assignment", "retirement-pending", "retirement-version", "retained-data", "credential-step", "restore-fence", "transfer-fence", "competing", "foreign-handoff", "rollback-missing", "unfinished-receipt", "manual", "retained-transfer", "foreign-checkpoint", "scheduler-claim", "scheduler-attempt"])("refuses changed %s custody", async change => {
    const h = fixture(), op = h.records[`glmOperations/${operationId}`];
    if (change === "lease") h.records[`users/${uid}`].provisioning.openclaw.activationLease.generation = 115;
    if (change === "epoch") h.records[`gateways/${source}/assignments/${uid}`].epoch = 0;
    if (change === "owner") h.records[`gateways/${source}`].ownerUid = "foreign";
    if (change === "vm") h.records[`glmGateways/${source}`].runtime = "cluster";
    if (change === "cutover") op.cutoverCommittedAt = 99;
    if (change === "target-assignment") h.records[`gateways/${target}/assignments/${uid}`] = { uid, slug: "ceckert-test", gatewayId: target, source: "migrate-user", epoch: 1, state: "serving" };
    if (change === "retirement-pending") h.records[`glmOperations/${retirementId}`].status = "pending";
    if (change === "retirement-version") h.records[`gateways/${target}`].retirementVersion = 2;
    if (change === "retained-data") h.records[`glmOperations/${retirementId}`].input.retainData = true;
    if (change === "credential-step") h.records[`glmOperations/${retirementId}`].steps.pop();
    if (change === "restore-fence") h.records[`users/${uid}`].provisioning.openclaw.restoreFence = {};
    if (change === "transfer-fence") h.records[`users/${uid}`].provisioning.openclaw.sourceTransferFence = {};
    if (change === "competing") h.records["glmOperations/foreign"] = { kind: "migrate-user", status: "running", input: { uid } };
    if (change === "foreign-handoff") op.schedulerHandoff.toGatewayId = "shared-foreign";
    if (change === "scheduler-claim") op.schedulerHandoff.migrationId = `mig-${operationId}:scheduler:22:claim:91`;
    if (change === "scheduler-attempt") op.schedulerHandoff.migrationId = `mig-${operationId}:scheduler:21:claim:90`;
    if (change === "rollback-missing") delete op.rolledBack;
    if (change === "unfinished-receipt") delete op.completedAt;
    if (change === "manual") op.origin = "manual";
    if (change === "retained-transfer") op.sourceTransferExecution = {};
    if (change === "foreign-checkpoint") h.records[`glmGateways/${source}`].vmHome.returnOperationId = "foreign-operation";
    expect(await h.request()).toBe(false); expect(op.status).toBe("failed"); expect(h.events).toEqual([]);
  });
  it.each([
    ["source assignment", (records: Record<string, any>) => { records[`gateways/${source}/assignments/${uid}`].epoch = -1; }],
    ["source runtime", (records: Record<string, any>) => { delete records[`glmGateways/${source}`].lifecycle; }],
    ["target root", (records: Record<string, any>) => { delete records[`gateways/${target}`].latestRelease; }],
  ])("fails closed on a malformed %s without queueing", async (_record, corrupt) => {
    const h = fixture(); corrupt(h.records);
    await expect(h.request()).rejects.toBeInstanceOf(MalformedRecordError);
    expect(h.records[`glmOperations/${operationId}`].status).toBe("failed"); expect(h.events).toEqual([]);
  });
  it("does not queue without the physical retirement proof", async () => {
    const h = fixture(); h.setProof(false); expect(await h.request()).toBe(false); expect(h.events).toEqual([]);
    expect(h.records[`glmOperations/${operationId}`].status).toBe("failed");
  });
  it("accepts a fully removed root only with the same complete retirement and physical absence proof", async () => {
    const h = fixture(); delete h.records[`gateways/${target}`]; expect(await h.request()).toBe(true);
    expect(await h.owner.recover(h.claim(), h.ctx)).toMatchObject({ rolledBack: true });
  });
  it("refuses a changed retirement claim while inspecting runtime absence", async () => {
    const h = fixture(); h.deps.verifyRetiredTarget.mockImplementation(async () => { h.records[`gateways/${target}`].retirementVersion = 2; return true; });
    expect(await h.request()).toBe(false); expect(h.records[`glmOperations/${operationId}`].status).toBe("failed");
  });
  it("publishes rollback only after exact source scheduler and ingress acknowledgements", async () => {
    const h = fixture(), user = structuredClone(h.records[`users/${uid}`]); expect(await h.request()).toBe(true);
    const buildClient = vi.fn(() => { throw new Error("forward client must never run"); });
    const handler = createMigrateUserHandler({ recoverNativeReturnSource: h.owner.recover, buildClient } as unknown as MigrateUserDeps);
    const result = await handler(h.claim(), h.ctx);
    expect(buildClient).not.toHaveBeenCalled();
    expect(h.events).toEqual(["hold", "ownership", "scheduler", "ingress"]);
    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(h.records[`glmOperations/${operationId}`]).toMatchObject({ schedulerHandoffReleased: true, input: { nativeReturnSourceRecovery: { completedAt: 1000 } } });
    expect(h.records[`users/${uid}`]).toEqual(user); expect(h.deps.sourceClient).toHaveBeenCalledOnce();
    expect(await h.owner.recover(h.claim(), h.ctx)).toMatchObject({ rolledBack: true }); expect(h.events).toHaveLength(4);
  });
  it("does not send a source scheduler RPC after losing its claim while recording the step", async () => {
    const h = fixture(); expect(await h.request()).toBe(true); const operation = h.claim();
    h.ctx.reportStep.mockImplementation(async (step: OperationStep) => {
      if (step.name === "recover-native-source-scheduler" && step.status === "running") h.records[`glmOperations/${operationId}`].startedAt = 501;
    });
    expect(await h.owner.recover(operation, h.ctx)).toMatchObject({ rolledBack: false });
    expect(h.events).not.toContain("scheduler"); expect(h.events).not.toContain("ingress");
  });
  it("keeps full PostgreSQL proof outside the ownership transaction's same advisory lock", async () => {
    const h = fixture(); expect(await h.request()).toBe(true); let insideOwnershipLock = false;
    h.deps.verifyRetiredTarget.mockImplementation(async (_gatewayId, assertCurrent) => {
      if (insideOwnershipLock) throw new Error("nested PostgreSQL credential advisory lock would deadlock");
      await assertCurrent(); return true;
    });
    h.deps.prepareSourceStores.mockImplementation(async (_gatewayId, _slug, authority) => {
      insideOwnershipLock = true;
      try { await authority!.assertCurrent(); } finally { insideOwnershipLock = false; }
    });
    expect(await h.owner.recover(h.claim(), h.ctx)).toMatchObject({ rolledBack: true });
  });
  it("retargets only through the subsequent normal operator retry and retains the actual recovery receipt", async () => {
    const h = fixture(); expect(await h.request()).toBe(true); expect(await h.owner.recover(h.claim(), h.ctx)).toMatchObject({ rolledBack: true });
    Object.assign(h.records[`glmOperations/${operationId}`], { status: "failed", rolledBack: true, retryRequestedAt: 2000 });
    const platformArtifact = { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}` };
    await enqueuePlacementMigration({ store: createDocumentFixtureStore(h.records), now: () => 2000, platformArtifact },
      { uid, builderSlug: "ceckert-test", fromGatewayId: source, toGatewayId: "shared-new", source: "builder-activation-lease", operationId });
    const operation = h.records[`glmOperations/${operationId}`];
    expect(operation).toMatchObject({ status: "pending", gatewayId: "shared-new", input: { toGatewayId: "shared-new" } });
    expect(operation.input.recoverSourceOnly).toBeUndefined(); expect(operation.input.nativeReturnSourceRecovery).toBeUndefined();
    expect(operation.nativeReturnSourceRecoveryReceipts).toHaveLength(1);
    expect(operation.nativeReturnSourceRecoveryReceipts[0]).toMatchObject({ uid, sourceGatewayId: source, targetGatewayId: target,
      sourceEpoch: 25, generation: 114, completedAt: 1000, targetRetirement: { operationId: retirementId, version: 1 } });
  });
  it.each(["proof-lost", "ownership-failed", "scheduler-failed", "ingress-failed", "url-claim-lost", "scheduler-claim-lost", "lease-changed", "epoch-changed", "root-recreated", "vm-replaced", "ingress-claim-lost"])("retains unresolved custody after %s", async change => {
    const h = fixture(); expect(await h.request()).toBe(true); const op = h.claim();
    if (change === "proof-lost") h.setProof(false);
    if (change === "lease-changed") h.records[`users/${uid}`].provisioning.openclaw.activationLease.generation = 115;
    if (change === "epoch-changed") h.records[`gateways/${source}/assignments/${uid}`].epoch = 26;
    if (change === "root-recreated") h.records[`gateways/${target}`].desiredStatus = "running";
    if (change === "vm-replaced") h.records[`glmGateways/${source}`].vm.instanceId = "replacement";
    if (change === "ownership-failed") h.deps.prepareSourceStores.mockRejectedValue(new Error("ownership failed"));
    const client = { scheduler: vi.fn(async () => { h.events.push("scheduler");
      if (change === "scheduler-failed") throw new Error("scheduler did not acknowledge");
      if (change === "scheduler-claim-lost") h.records[`glmOperations/${operationId}`].startedAt = 501;
    }), resume: vi.fn(async () => {
      h.events.push("ingress");
      if (change === "ingress-failed") throw new Error("ingress did not acknowledge");
      if (change === "ingress-claim-lost") h.records[`glmOperations/${operationId}`].startedAt = 501;
    }) };
    h.deps.sourceClient.mockImplementation(async () => {
      if (change === "url-claim-lost") h.records[`glmOperations/${operationId}`].startedAt = 501;
      return client;
    });
    expect(await h.owner.recover(op, h.ctx)).toMatchObject({ success: false, rolledBack: false });
    expect(h.records[`glmOperations/${operationId}`].schedulerHandoffReleased).toBe(false);
    expect(h.records[`glmOperations/${operationId}`].input.nativeReturnSourceRecovery.completedAt).toBeUndefined();
    if (change !== "ingress-failed" && change !== "ingress-claim-lost") expect(client.resume).not.toHaveBeenCalled();
  });
});
