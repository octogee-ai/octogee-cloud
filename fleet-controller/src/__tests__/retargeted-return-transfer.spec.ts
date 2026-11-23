import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import { nativeReturnTargetExclusionId } from "@octogee/core/fleet-state";
import { buildOperationAuditIntent } from "@octogee/core/operation-audit";
import { migrationTransferTaskId, retargetedMigrationTransferId } from "@octogee/core/platform-state";
import { claimTransferTask, finishTransferTask, readTransferAttemptForCleanup } from "../lib/migration-transfer-lease.js";

const source = "alice-s-current", retired = "shared-old", target = "shared-new";
const operationId = `builder-return-${source}-g4`;
const migrationId = `mig-${operationId}`;
const taskId = `${migrationId}__keys`;

function fixture() {
  const retirement = { operationId: `shared-pool-retire-${retired}`, version: 1, createdAt: 200, completedAt: 300 };
  const old = { kind: "gateway-rsync-transfer", migrationId, slug: "alice", mode: "keys", sourceGatewayId: source,
    targetGatewayId: retired, status: "succeeded", attempt: 1, attemptId: "old-attempt",
    createdAt: 90, updatedAt: 100, startedAt: 90, completedAt: 100 };
  const op = {
    kind: "migrate-user", status: "running", origin: "automatic", createdBy: "glm-controller-placement-policy",
    createdAt: 80, startedAt: 500, inputUid: "uid-alice", gatewayId: target,
    input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: source, toGatewayId: target, source: "builder-activation-lease" },
    nativeReturnSourceRecoveryReceipts: [{ uid: "uid-alice", slug: "alice", operationId, sourceGatewayId: source,
      targetGatewayId: retired, completedAt: 400, targetRetirement: retirement }],
  };
  const retiredOp = { kind: "retire-gateway", status: "succeeded", gatewayId: retired, createdAt: 200, completedAt: 300,
    input: { gatewayId: retired, source: "shared-pool-scaler", retirementClaimVersion: 1 },
    steps: [{ name: "helm-uninstall", status: "done" }, { name: "revoke-agent-store-credentials", status: "done" }] };
  const documents = { [`glmMigrationTransferTasks/${taskId}`]: old, [`glmOperations/${operationId}`]: op,
    [`glmOperations/${retirement.operationId}`]: retiredOp };
  const deps = { store: createDocumentFixtureStore(documents), now: () => 1000, workerId: "fleet-controller", leaseMs: 60000,
    namespace: "octogee-test", runCommand: vi.fn(), log: vi.fn(), beforeRecovery: vi.fn() };
  const input = { migrationId, slug: "alice", fromGatewayId: source, toGatewayId: target, mode: "keys" as const };
  const cleanup = (gatewayId: string) => readTransferAttemptForCleanup(deps, { migrationId, slug: "alice", gatewayId, mode: "keys" });
  return { old, op, retiredOp, deps, input, cleanup, claim: () => claimTransferTask(deps, taskId, input) };
}

describe("retargeted native return transfer custody", () => {
  it("preserves the old receipt and uses a separate task and cleanup claim for the new destination", async () => {
    const h = fixture();
    expect(await h.cleanup(target)).toBeUndefined();
    const claim = await h.claim();
    expect(claim.taskId).not.toBe(taskId);
    await finishTransferTask(h.deps.store, claim, () => 1100);
    expect(await h.deps.store.migrationTasks.get(taskId)).toMatchObject(h.old);
    expect(await h.deps.store.migrationTasks.get(claim.taskId)).toMatchObject({ targetGatewayId: target, status: "succeeded" });
    expect(await h.cleanup(target)).toBe(claim.attemptId);
    expect(await h.cleanup(retired)).toBe("old-attempt");
    expect(await h.claim()).toMatchObject({ taskId: claim.taskId, attempt: 2 });
  });

  it.each(["receipt", "retirement", "tenant", "source", "running", "timing"])("refuses to retarget with changed %s custody", async change => {
    const h = fixture();
    if (change === "receipt") h.op.nativeReturnSourceRecoveryReceipts = [];
    if (change === "retirement") h.retiredOp.status = "failed";
    if (change === "tenant") h.old.slug = "bob";
    if (change === "source") h.old.sourceGatewayId = "other";
    if (change === "running") h.old.status = "running";
    if (change === "timing") h.old.completedAt = 201;
    await expect(h.claim()).rejects.toThrow(/identity changed|already running/);
    await expect(h.cleanup(target)).rejects.toThrow("identity changed");
  });
});

const eckUid = "uid-eck", eck = "eck", eckSource = "eck-s-original";
const oldShared = "shared-retired", newShared = "shared-current";
const eckOperation = `builder-return-${eckSource}-g22`;
const eckMigration = `mig-${eckOperation}`;
const eckOldScheduler = `${eckMigration}:scheduler:1:claim:15`;
const eckNewScheduler = `${eckMigration}:scheduler:122:claim:500`;
const eckCompensatedAt = 399, eckRestoredAt = 450;

async function compensatedFixture(mode: "keys" | "final") {
  const legacyKey = migrationTransferTaskId({ migrationId: eckMigration, mode });
  const currentKey = migrationTransferTaskId({ migrationId: retargetedMigrationTransferId(eckMigration, newShared), mode });
  const retired = { operationId: `shared-pool-retire-${oldShared}`, version: 1, createdAt: 200, completedAt: 300 };
  const old = { kind: "gateway-rsync-transfer", migrationId: eckMigration, slug: eck, mode, sourceGatewayId: eckSource,
    targetGatewayId: oldShared, status: mode === "keys" ? "succeeded" : "failed", attempt: 43, attemptId: "old-attempt",
    createdAt: 90, updatedAt: 100, startedAt: 90, completedAt: 100, leaseOwner: null, leasePod: null,
    leaseExpiresAt: null as number | null, leaseRestartCount: null,
    ...(mode === "final" ? { error: "source has no applied fingerprint" } : {}) };
  const lastCompensation = { attempt: 121, startedAt: 350, completedAt: 400, classification: "terminal",
    error: "compensating Native return completed on original source", steps: [] };
  const currentHandoff = { uid: eckUid, slug: eck, fromGatewayId: eckSource, toGatewayId: newShared,
    migrationId: eckNewScheduler };
  const oldHandoff = { ...currentHandoff, toGatewayId: oldShared, migrationId: eckOldScheduler,
    forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 10 } };
  const op = { kind: "migrate-user", status: "running", origin: "automatic", createdBy: "glm-controller-placement-policy",
    createdAt: 10, startedAt: 500, completedAt: null, inputUid: eckUid, gatewayId: newShared, attempts: 121,
    input: { uid: eckUid, userSlug: eck, fromGatewayId: eckSource, toGatewayId: newShared, source: "builder-activation-lease" },
    schedulerHandoff: mode === "final" ? { ...currentHandoff, forwardRecovery: oldHandoff.forwardRecovery } : currentHandoff,
    attemptHistory: [lastCompensation], steps: [] };
  const assignment = { uid: eckUid, slug: eck, gatewayId: eckSource, source: "migrate-user",
    state: mode === "keys" ? "serving" : "quiescing", epoch: 10, createdAt: 1, updatedAt: 500, updatedByOperationId: eckOperation };
  const lease = { leaseId: "original-lease", generation: 22, status: "returning", targetGatewayId: eckSource,
    returnOperationId: eckOperation, activeAt: eckRestoredAt };
  const retiredOp = { kind: "retire-gateway", status: "succeeded", gatewayId: oldShared, createdAt: 200, completedAt: 300,
    input: { gatewayId: oldShared, source: "shared-pool-scaler", retirementClaimVersion: 1 },
    steps: [{ name: "helm-uninstall", status: "done" }, { name: "revoke-agent-store-credentials", status: "done" }] };
  const store = createDocumentFixtureStore({ [`glmMigrationTransferTasks/${legacyKey}`]: old, [`glmOperations/${eckOperation}`]: op,
    [`glmOperations/${retired.operationId}`]: retiredOp,
    [`users/${eckUid}`]: { username: eck, provisioning: { openclaw: { slug: eck, gatewayId: eckSource, activationLease: lease,
      migration: { operationId: eckOperation, phase: "transferring", state: "moving", startedAt: 500 } } } },
    [`gateways/${eckSource}/assignments/${eckUid}`]: assignment,
    [`gateways/${eckSource}`]: { gatewayId: eckSource, gatewayClass: "isolated", ownerUid: eckUid, builderSlug: eck,
      desiredStatus: "running", desiredRelease: 7, liveRelease: 7, latestRelease: 7,
      allocation: { kind: "disposable-builder", schemaVersion: 1, claimedByUid: eckUid, leaseId: lease.leaseId, generation: 22 } },
    [`gateways/${newShared}`]: { gatewayId: newShared, desiredRelease: 1, liveRelease: 1, latestRelease: 1, desiredStatus: "running", gatewayClass: "shared" },
  });
  const actor = "verified-operator";
  async function saveAudit(key: string, mutation: Record<string, unknown>, target: Record<string, unknown>, completedAt: number, actionClaimId: string) {
    const audit = buildOperationAuditIntent({ actor, forced: false, what: key, why: key, idempotencyKey: key,
      now: () => 150, mutation, target, preActionStatus: {} });
    await store.journal.audits.create({ ...audit.document, id: audit.id, status: "completed", outcome: "completed",
      lifecycleStage: "action-completed", completedAt, actionClaimId, actionStartedAt: 150, actionRecoveryCount: 0 });
    return audit.id;
  }
  const exclusionId = nativeReturnTargetExclusionId(eckUid);
  const selection = { operationId: eckOperation, sourceGatewayId: eckSource, targetGatewayId: oldShared, sourceEpoch: 10,
    schedulerMigrationId: eckOldScheduler };
  const originalSource = { instanceId: "original-vm" };
  const compensationId = await saveAudit("compensation", { attemptId: "protected-attempt", source: originalSource,
    scope: { ...selection, uid: eckUid, slug: eck, exclusionId } },
    { ...selection, uid: eckUid, slug: eck, exclusionId, original: originalSource, archivedReturn: { handoff: oldHandoff } },
    eckCompensatedAt, "protected-attempt");
  await saveAudit(`native-return-target-exclusion:${eckUid}`, { kind: "native-return-target-exclusion", operationId: eckOperation }, {
    uid: eckUid, targetGatewayId: oldShared, reservation: { selection, oldPodUid: "retired-pod" },
    sharedHandoffRelease: { actor, retirement: retired, verifiedAt: 401 },
    retiredLeaseRestoration: { operationId: eckOperation, sourceEpoch: 10, leaseId: lease.leaseId, generation: 22,
      compensationAuditId: compensationId, restoredAt: eckRestoredAt },
  }, 401, exclusionId);
  const deps = { store, now: () => 1000, workerId: "fleet-controller", leaseMs: 60_000,
    namespace: "octogee-test", runCommand: vi.fn(), log: vi.fn(), beforeRecovery: vi.fn() };
  const input = { migrationId: eckMigration, slug: eck, fromGatewayId: eckSource, toGatewayId: newShared, mode };
  return { old, op, assignment, lease, lastCompensation, retiredOp, deps, input, legacyKey, currentKey, exclusionId, compensationId,
    claim: (toGatewayId = newShared) => claimTransferTask(deps, legacyKey, { ...input, toGatewayId }) };
}

describe("ordinary transfer after retired-target compensation", () => {
  it.each(["keys", "final"] as const)("uses a separate %s key and retains the actual terminal legacy task shape", async mode => {
    const h = await compensatedFixture(mode);
    const legacy = await h.deps.store.migrationTasks.get(h.legacyKey);
    const claim = await h.claim();
    expect(claim).toMatchObject({ taskId: h.currentKey, attempt: 1 });
    await finishTransferTask(h.deps.store, claim, () => 1100);
    await expect(h.deps.store.migrationTasks.get(h.legacyKey)).resolves.toEqual(legacy);
    await expect(h.deps.store.migrationTasks.get(h.currentKey)).resolves.toMatchObject({
      targetGatewayId: newShared, status: "succeeded", migrationId: retargetedMigrationTransferId(eckMigration, newShared),
    });
    await expect(readTransferAttemptForCleanup(h.deps, { migrationId: eckMigration, slug: eck, gatewayId: newShared, mode }))
      .resolves.toBe(claim.attemptId);
    await expect(h.claim(oldShared)).rejects.toThrow(/permanently excluded/);
    await expect(h.deps.store.migrationTasks.get(h.legacyKey)).resolves.toEqual(legacy);
  });

  it.each(["missing restoration", "wrong compensation", "changed epoch", "changed lease", "old scheduler", "stale scheduler",
    "running old task", "old lease", "changed retirement", "late old task"])("fails closed for %s", async reason => {
    const h = await compensatedFixture("keys");
    if (reason === "missing restoration" || reason === "wrong compensation") {
      const audit = (await h.deps.store.journal.audits.get(h.exclusionId))!;
      const { retiredLeaseRestoration, ...target } = audit.target;
      const next = reason === "missing restoration" ? target : {
        ...target, retiredLeaseRestoration: { ...retiredLeaseRestoration as object, compensationAuditId: "different-audit" },
      };
      await h.deps.store.journal.audits.patch(audit.id, { target: next }, { revision: audit.revision });
    }
    if (reason === "changed epoch") h.assignment.epoch = 11;
    if (reason === "changed lease") h.lease.generation = 23;
    if (reason === "old scheduler") Object.assign(h.op.schedulerHandoff, { migrationId: eckOldScheduler, toGatewayId: oldShared });
    if (reason === "stale scheduler") {
      h.op.startedAt = 600;
      h.op.attempts = 122;
      h.op.attemptHistory.push({ ...h.lastCompensation, attempt: 122, startedAt: 500, completedAt: 550, error: "transient import failure" });
    }
    if (reason === "running old task") h.old.status = "running";
    if (reason === "old lease") h.old.leaseExpiresAt = 1_500;
    if (reason === "changed retirement") h.retiredOp.completedAt = 301;
    if (reason === "late old task") h.old.completedAt = 201;
    await expect(h.claim()).rejects.toThrow();
    await expect(h.deps.store.migrationTasks.get(h.currentKey)).resolves.toBeNull();
    await expect(h.deps.store.migrationTasks.get(h.legacyKey)).resolves.toMatchObject(h.old);
  });

  it("reuses only a recorded same-destination scheduler for scoped forward recovery", async () => {
    const h = await compensatedFixture("final");
    h.op.startedAt = 600;
    h.op.attempts = 122;
    h.op.attemptHistory.push({ ...h.lastCompensation, attempt: 122, startedAt: 500, completedAt: 550, error: "forward recovery pending" });
    await expect(h.claim()).resolves.toMatchObject({ taskId: h.currentKey });
  });

});
