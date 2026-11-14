import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it, vi } from "vitest";
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
