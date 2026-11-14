import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { MigrationRpcError } from "@octogee/core/fleet-migration-client";
import { describe, expect, it, vi } from "vitest";
import { createAbandonedNativeSchedulerRecovery, reportedAbandonedNativeScheduler } from "../lib/native-return-scheduler-recovery.js";

const uid = "uid-alice", slug = "alice", source = "alice-s-current", oldSource = "alice-s-old";
const target = "shared-new", oldTarget = "shared-old", operationId = `builder-return-${source}-g4`;
const oldOperation = `builder-return-${oldSource}-g3`, heldBy = `mig-${oldOperation}:scheduler:1:claim:100`;

function fixture() {
  const op = { kind: "migrate-user", origin: "automatic", createdBy: "glm-controller-placement-policy", inputUid: uid,
    gatewayId: target, status: "running", startedAt: 500,
    input: { uid, userSlug: slug, fromGatewayId: source, toGatewayId: target, source: "builder-activation-lease" },
    schedulerHandoff: { uid, slug, fromGatewayId: source, toGatewayId: target, migrationId: `mig-${operationId}:scheduler:1:claim:500` },
    schedulerHandoffReleased: false,
  };
  const old = { ...op, gatewayId: oldTarget, status: "failed", startedAt: null, completedAt: 200,
    input: { ...op.input, fromGatewayId: oldSource, toGatewayId: oldTarget }, schedulerHandoffReleased: true,
    schedulerHandoff: { uid, slug, fromGatewayId: oldSource, toGatewayId: oldTarget, migrationId: heldBy,
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 5 } },
  };
  const openclaw = { slug, gatewayId: source, migration: { state: "moving", startedAt: 500, operationId },
    activationLease: { leaseId: "lease4", generation: 4, status: "returning", targetGatewayId: source, returnOperationId: operationId } };
  const root = { gatewayId: source, gatewayClass: "isolated", ownerUid: uid, builderSlug: slug, desiredStatus: "running",
    desiredRelease: 1, liveRelease: 1, latestRelease: 1,
    allocation: { kind: "disposable-builder", claimedByUid: uid, leaseId: "lease4", generation: 4 } };
  const assignment = { uid, slug, gatewayId: source, epoch: 7, state: "quiescing", updatedByOperationId: operationId,
    source: "migrate-user", createdAt: 10, updatedAt: 500 };
  const vm = { instanceName: "vm-alice", instanceId: "1234", zone: "us-central1-a", internalIp: "10.0.0.4", status: "RUNNING" };
  const records: Record<string, Record<string, unknown>> = {
    [`users/${uid}`]: { username: slug, provisioning: { openclaw, homeDisk: { id: "4321", source: "home-alice" } } },
    [`gateways/${source}`]: root,
    [`gateways/${source}/assignments/${uid}`]: assignment,
    [`glmGateways/${source}`]: { docKind: "runtime", gatewayId: source, release: 1, lifecycle: "serving", runtime: "gce-vm", vm },
    [`glmOperations/${operationId}`]: op,
    [`glmOperations/${oldOperation}`]: old,
  };
  const deps = { store: createDocumentFixtureStore(records), oldSourceAbsent: vi.fn(async () => true),
    verifyRetiredTarget: vi.fn(async () => true), verifyVm: vi.fn(async () => true) };
  const scheduler = vi.fn(async () => ({ operationId: heldBy, phase: "resume" as const, drained: true, agentIds: ["octogee-alice-coach"] }));
  const assertClaim = vi.fn(async () => undefined);
  const input = { uid, slug, fromGatewayId: source, toGatewayId: target, operationId, claimedStartedAt: 500,
    sourceEpoch: 7, hold: { operationId: oldOperation, migrationId: heldBy, agentId: "octogee-alice-coach" } };
  return { deps, scheduler, op, old, root, openclaw, assignment, vm, records,
    recover: () => createAbandonedNativeSchedulerRecovery(deps)(input, scheduler, assertClaim) };
}

describe("abandoned Native return scheduler recovery", () => {
  it("resumes only the exact abandoned hold on the verified retained VM", async () => {
    const h = fixture();
    await h.recover();
    expect(h.deps.oldSourceAbsent).toHaveBeenCalledWith(oldSource);
    expect(h.deps.verifyRetiredTarget).toHaveBeenCalledWith(oldTarget, expect.any(Function));
    expect(h.deps.verifyVm).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "1234", homeId: "4321" }), expect.anything());
    expect(h.scheduler).toHaveBeenCalledExactlyOnceWith({ gatewayId: source, slug, migrationId: heldBy, phase: "resume" });
  });

  it.each(["old source", "old target", "computer", "old operation", "lease", "assignment", "late claim"])(
    "keeps the scheduler untouched when %s custody cannot be proven", async change => {
      const h = fixture();
      if (change === "old source") h.deps.oldSourceAbsent.mockResolvedValue(false);
      if (change === "old target") h.deps.verifyRetiredTarget.mockResolvedValue(false);
      if (change === "computer") h.deps.verifyVm.mockResolvedValue(false);
      if (change === "old operation") h.old.schedulerHandoffReleased = false;
      if (change === "lease") h.openclaw.activationLease.generation = 5;
      if (change === "assignment") h.assignment.epoch = 8;
      if (change === "late claim") h.deps.verifyVm.mockImplementation(async () => { h.op.startedAt = 501; return true; });
      await expect(h.recover()).rejects.toThrow(/custody|authority|assignment/);
      expect(h.scheduler).not.toHaveBeenCalled();
    },
  );

  it("rejects a report for a different tenant, gateway or scheduler claim", () => {
    const scope = { gatewayId: source, slug, operationId };
    const make = (gatewayId: string, agent: string, migrationId: string) => new MigrationRpcError(
      `/quiesce/${gatewayId}: 500 quiesce failed`, { status: 500, details: {
        error: "quiesce failed", message: `Cron agent ${agent} is held for migration ${migrationId}`,
      } },
    );
    expect(reportedAbandonedNativeScheduler(make(source, "octogee-alice-coach", heldBy), scope)).not.toBeNull();
    expect(reportedAbandonedNativeScheduler(make(source, "octogee-bob-coach", heldBy), scope)).toBeNull();
    expect(reportedAbandonedNativeScheduler(make(oldSource, "octogee-alice-coach", heldBy), scope)).toBeNull();
    expect(reportedAbandonedNativeScheduler(make(source, "octogee-alice-coach", heldBy.replace("claim:100", "claim:0")), scope)).toBeNull();
  });
});
