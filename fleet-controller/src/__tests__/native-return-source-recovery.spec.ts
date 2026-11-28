import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import type { Operation } from "@octogee/shared/types/glm";
import { createNativeReturnSourceRecoveryOwner } from "../native-return-source-recovery.js";
import type { OperationContext } from "../operation-router.js";

const uid = "uid-journey", slug = "journey", source = "journey-s-fa041b86", target = "shared-retired";
const operationId = `builder-return-${source}-g1`;
const claim = 1_000, failedAt = 1_100, migrationId = `mig-${operationId}:scheduler:1:claim:${claim}`;
const retirementId = `shared-pool-retire-${target}`;
const FLUSHED_STEPS = ["keys-sync-state", "pre-sync-state", "wait-for-active-work", "quiesce-source", "flush-source"]
  .map(name => ({ name, status: "done" })).concat([{ name: "final-sync-state", status: "failed" }]);
const IMPORT_REFUSED = `migration forward recovery pending: status 503: /finish-rsync-import/${target}: 500 ` +
  `{"error":"import failed","message":"carried agent roster does not match migration authority: ` +
  `authority [octogee-${slug}-coach, octogee-${slug}-proj-pier-coach] carried [octogee-${slug}-coach]"}`;

function specimen() {
  const op: Record<string, unknown> = {
    kind: "migrate-user", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy", inputUid: uid,
    gatewayId: target, attempts: 1, startedAt: claim, completedAt: failedAt, rolledBack: false, error: IMPORT_REFUSED,
    input: { uid, userSlug: slug, fromGatewayId: source, toGatewayId: target, source: "builder-activation-lease" },
    steps: FLUSHED_STEPS,
    attemptHistory: [{ attempt: 1, startedAt: claim, completedAt: failedAt, error: IMPORT_REFUSED, classification: "terminal", steps: FLUSHED_STEPS }],
    schedulerHandoff: { uid, slug, fromGatewayId: source, toGatewayId: target, migrationId,
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 1, sourceSystemConfigCommit: "37ed8ab59e9a5791dac5424882c007b43069962f" } },
    schedulerHandoffReleased: false,
  };
  const openclaw = { slug, gatewayId: source, migration: { state: "moving", phase: "transferring", startedAt: claim, operationId },
    activationLease: { leaseId: "lease-1", generation: 1, status: "returning", targetGatewayId: source, returnOperationId: operationId,
      sourceGatewayId: target } };
  const root: Record<string, unknown> = { gatewayId: source, gatewayClass: "isolated", ownerUid: uid, builderSlug: slug, desiredStatus: "running",
    desiredRelease: 1, liveRelease: 1, latestRelease: 1, imageProfile: "isolated",
    allocation: { kind: "disposable-builder", claimedByUid: uid, leaseId: "lease-1", generation: 1 } };
  const assignment = { uid, slug, gatewayId: source, epoch: 1, state: "quiescing", updatedByOperationId: operationId,
    source: "migrate-user", createdAt: 10, updatedAt: claim };
  const retirement = { kind: "retire-gateway", status: "succeeded", gatewayId: target, createdAt: 2_000, completedAt: 2_100,
    input: { gatewayId: target, source: "shared-pool-scaler", retirementClaimVersion: 1 },
    steps: [{ name: "helm-uninstall", status: "done" }, { name: "revoke-agent-store-credentials", status: "done" }] };
  const records: Record<string, Record<string, unknown>> = {
    [`users/${uid}`]: { username: slug, provisioning: { openclaw } },
    [`gateways/${source}`]: root,
    [`gateways/${source}/assignments/${uid}`]: assignment,
    [`glmGateways/${source}`]: { docKind: "runtime", gatewayId: source, release: 1, lifecycle: "serving", runtime: "cluster" },
    [`glmOperations/${operationId}`]: op,
    [`glmOperations/${retirementId}`]: retirement,
  };
  return { records, op, root, openclaw, assignment };
}

function owner(records: Record<string, Record<string, unknown>>) {
  const store = createDocumentFixtureStore(records);
  const scheduler = vi.fn(async () => ({ operationId, phase: "resume" as const, drained: true, agentIds: [] }));
  const resume = vi.fn(async () => undefined);
  const deps = {
    store, now: () => 5_000, log: vi.fn(),
    verifyRetiredTarget: vi.fn(async () => true),
    releaseSourceHold: vi.fn(async () => undefined),
    prepareSourceStores: vi.fn(async () => undefined),
    sourceClient: vi.fn(async () => ({ scheduler, resume }) as never),
  };
  return { store, deps, scheduler, resume, recovery: createNativeReturnSourceRecoveryOwner(deps) };
}

async function runClaimed(h: ReturnType<typeof owner>) {
  await h.store.transaction({ label: "test.claim" }, async tx => {
    const op = (await tx.journal.operations.get(operationId))!;
    await tx.journal.operations.patch(operationId, { status: "running", startedAt: 4_000 }, { revision: op.revision });
  });
  const claimed = (await h.store.journal.operations.get(operationId))!;
  const steps: unknown[] = [];
  const ctx = { assertActiveClaim: vi.fn(async () => undefined), reportStep: vi.fn(async (step: unknown) => { steps.push(step); }) };
  const result = await h.recovery.recover({ id: operationId, ...claimed } as unknown as Operation, ctx as unknown as OperationContext);
  return { result, steps: ctx.reportStep.mock.calls.map(([step]) => step as { name: string; status: string }) };
}

const request = { uid, operationId, requestedAt: 4_500, requestedBy: "operator-uid" };

describe("returning a user whose return from an isolated pod failed at the final import", () => {
  it("puts the user back on serving on the isolated pod once the shared target is retired, and releases the move", async () => {
    const h = owner(specimen().records);

    expect(await h.recovery.request(request)).toBe(true);
    const armed = await h.store.journal.operations.get(operationId);
    expect(armed).toMatchObject({ status: "pending", input: { recoverSourceOnly: true,
      nativeReturnSourceRecovery: { sourcePod: true, sourceEpoch: 1, schedulerMigrationId: migrationId, failedAt,
        targetRetirement: { operationId: retirementId, version: 1 } } } });
    expect(armed?.input.nativeReturnSourceRecovery).not.toHaveProperty("sourceVm");

    const { result, steps } = await runClaimed(h);

    expect(result).toMatchObject({ success: false, rolledBack: true, error: "native return source recovery completed" });
    expect(steps.filter(step => step.status === "done").map(step => step.name)).toEqual([
      "recover-native-source-ownership", "recover-native-source-scheduler", "recover-native-source-ingress"]);
    expect(h.deps.releaseSourceHold).not.toHaveBeenCalled();
    expect(h.deps.prepareSourceStores).toHaveBeenCalledWith(source, slug, expect.objectContaining({ expectedUserUid: uid }));
    expect(h.scheduler).toHaveBeenCalledWith({ gatewayId: source, migrationId, slug, phase: "resume" });
    expect(h.resume).toHaveBeenCalledWith({ gatewayId: source, migrationId: `mig-${operationId}`, slug });
    expect(await h.store.gateways.assignments.get(source, uid)).toMatchObject({ state: "serving", epoch: 1, updatedByOperationId: operationId });
    expect((await h.store.users.records.get(uid))?.fences.migration).toBeUndefined();
    expect(await h.store.journal.operations.get(operationId)).toMatchObject({ schedulerHandoffReleased: true,
      nativeReturnSourceRecoveryReceipts: [expect.objectContaining({ sourceGatewayId: source, targetGatewayId: target, sourcePod: true })] });
  });

  it.each([
    ["the shared target still exists", (s: ReturnType<typeof specimen>) => {
      s.records[`gateways/${target}`] = { gatewayId: target, gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, liveRelease: 1, latestRelease: 1 };
    }],
    ["the shared target was never retired", (s: ReturnType<typeof specimen>) => { delete s.records[`glmOperations/${retirementId}`]; }],
    ["the move committed its cutover", (s: ReturnType<typeof specimen>) => { s.op.cutoverCommittedAt = 1_050; }],
    ["the user's lease is no longer returning", (s: ReturnType<typeof specimen>) => { s.openclaw.activationLease.status = "active"; }],
    ["the source is rolling to another release", (s: ReturnType<typeof specimen>) => { s.root.desiredRelease = 2; s.root.latestRelease = 2; }],
    ["another move holds the user's fence", (s: ReturnType<typeof specimen>) => { s.openclaw.migration.operationId = "other-move"; }],
    ["the source pod record carries a computer", (s: ReturnType<typeof specimen>) => {
      s.records[`glmGateways/${source}`] = { ...s.records[`glmGateways/${source}`], vm: { instanceName: "vm", instanceId: "1", zone: "z" } };
    }],
  ])("refuses and changes nothing when %s", async (_case, change) => {
    const s = specimen();
    change(s);
    const h = owner(s.records);
    const before = await h.store.journal.operations.get(operationId);

    expect(await h.recovery.request(request)).toBe(false);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[native-return-recovery\\] refused ${operationId}: `)));
    expect(await h.store.journal.operations.get(operationId)).toEqual(before);
    expect(await h.store.gateways.assignments.get(source, uid)).toMatchObject({ state: "quiescing" });
  });

  it("refuses while the retired target's runtime or PostgreSQL login is still live", async () => {
    const h = owner(specimen().records);
    h.deps.verifyRetiredTarget.mockResolvedValue(false);

    expect(await h.recovery.request(request)).toBe(false);
    expect(await h.store.journal.operations.get(operationId)).toMatchObject({ status: "failed" });
  });

  it("still releases the computer's hold for a source that is a computer", async () => {
    const s = specimen();
    s.records[`glmGateways/${source}`] = { docKind: "runtime", gatewayId: source, release: 1, lifecycle: "serving", runtime: "gce-vm",
      vm: { instanceName: "vm-journey", instanceId: "1234", zone: "us-central1-a", status: "RUNNING" } };
    const h = owner(s.records);

    expect(await h.recovery.request(request)).toBe(true);
    const { steps } = await runClaimed(h);

    expect(steps.filter(step => step.status === "done").map(step => step.name)[0]).toBe("recover-native-source-hold");
    expect(h.deps.releaseSourceHold).toHaveBeenCalledOnce();
  });
});
