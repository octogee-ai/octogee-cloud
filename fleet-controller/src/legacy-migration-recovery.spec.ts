import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { Operation } from "@octogee/shared/types/glm";
import {
  attemptNeverHeldSource,
  rearmOwnedLegacyMigration,
  recoverFailedLegacyMigrations,
  sourceRecoveryForwardRetryable,
} from "./legacy-migration-recovery.js";

function fixture(migrationId: string, operationId = "op-1") {
  const steps = [{ name: "keys-sync-state", status: "failed" as const, error: "request timed out" }];
  const operation: Operation = { id: operationId, kind: "migrate-user", status: "failed", attempts: 1, createdBy: "test", createdAt: 900, startedAt: 1_000,
    completedAt: 2_000, error: "reaped: controller restarted mid-op", input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
    steps, schedulerHandoff: { migrationId, uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
  };
  const path = `glmOperations/${operationId}`;
  const records: Record<string, Record<string, unknown>> = {
    [path]: operation as unknown as Record<string, unknown>,
    "users/alice": { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "preparing", phase: "preparing", startedAt: 1_000, operationId } } } },
    "gateways/shared-a/assignments/alice": { uid: "alice", slug: "alice", gatewayId: "shared-a", source: "migrate-user", state: "serving", epoch: 4,
      createdAt: 500, updatedAt: 500, updatedByOperationId: null },
  };
  const store = createDocumentFixtureStore(records);
  const rearm = () => rearmOwnedLegacyMigration({ store, operationId, now: 3_000, admitted: () => true });
  return { operation, records, rearm, stored: () => Object.is(records[path], operation) ? undefined : records[path] };
}

describe("claimed scheduler recovery evidence", () => {
  it.each(["mig-op-1:scheduler:1:claim:1000"])("recovers %s without inflating attempts or losing steps", async id => {
    const h = fixture(id);
    expect(attemptNeverHeldSource(h.operation)).toBe(true);
    expect(await h.rearm()).toBe(true);
    expect(h.stored()).toMatchObject({ attempts: 1, schedulerHandoff: { migrationId: id, sourceRecovery: { steps: h.operation.steps } },
      attemptHistory: [{ attempt: 1, startedAt: 1_000, steps: h.operation.steps }] });
  });
  it.each([false, true])("rejects unqualified custody even with persisted source recovery=%s", async recovery => {
    const h = fixture("mig-op-1:scheduler:1");
    if (recovery) h.operation.schedulerHandoff!.sourceRecovery = { migrationId: h.operation.schedulerHandoff!.migrationId, sourceEpoch: 4, steps: h.operation.steps };
    expect(attemptNeverHeldSource(h.operation)).toBe(false);
    expect(await h.rearm()).toBe(false);
    expect(h.stored()).toBeUndefined();
  });

  it("does not attribute current steps to a different claim of the same failure attempt", async () => {
    const h = fixture("mig-op-1:scheduler:1:claim:999");
    expect(attemptNeverHeldSource(h.operation)).toBe(false);
    expect(await h.rearm()).toBe(false);
    expect(h.stored()).toBeUndefined();
  });
});

describe("forward retry after source recovery", () => {
  const claimed = (steps: Operation["steps"]) => {
    const { operation } = fixture("mig-op-1:scheduler:1:claim:1000");
    operation.steps = steps;
    return operation;
  };

  it("retries forward when every failed forward step was transient or left native cleanup incomplete", () => {
    expect(sourceRecoveryForwardRetryable(claimed([{ name: "keys-sync-state", status: "failed", error: "request timed out" }]))).toBe(true);
    expect(sourceRecoveryForwardRetryable(claimed([
      { name: "keys-sync-state", status: "failed", error: "native cleanup incomplete: purgeFailed=true failed=[agent.db]" },
      { name: "rollback:restore-source", status: "failed", error: "target refused the restore" },
    ]))).toBe(true);
  });

  it("does not retry forward after a terminal forward failure", () => {
    expect(sourceRecoveryForwardRetryable(claimed([{ name: "keys-sync-state", status: "failed", error: "target refused the restore" }]))).toBe(false);
  });

  it("does not retry forward without evidence from the claimed attempt", () => {
    expect(sourceRecoveryForwardRetryable(fixture("mig-op-1:scheduler:1").operation)).toBe(false);
  });
});

describe("released forward-only user activation recovery admission", () => {
  it.each(["released", "history-evicted", "held", "committed", "source-moved", "epoch-changed", "shared-target", "wrong-generation"] as const)("admits only the released target while the source still owns the activation: %s", async scenario => {
    const target = "alice-s-12345678", id = `builder-activate-${target}-g1`;
    const h = fixture(`mig-${id}:scheduler:1:claim:1000`, id);
    Object.assign(h.operation.input, { source: "builder-activation-lease", userSlug: "alice", toGatewayId: target });
    Object.assign(h.operation.schedulerHandoff!, { toGatewayId: target, stageAfterCutover: true,
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: scenario === "epoch-changed" ? 3 : 4,
        ...(scenario === "held" ? {} : { targetReleased: true }) } });
    h.operation.steps = [{ name: "final-sync-state", status: "failed", error: "released target" }];
    h.records["users/alice"] = { provisioning: { openclaw: { gatewayId: scenario === "source-moved" ? target : "shared-a",
      migration: { state: "moving", phase: "transferring", startedAt: 1_000, operationId: id }, activationLease: { leaseId: "lease-one", generation: 1, status: "activating",
        sourceGatewayId: "shared-a", sourceAssignmentEpoch: 4, targetGatewayId: target } } } };
    h.records[`gateways/${target}`] = { gatewayId: target, desiredRelease: 1, latestRelease: 1, desiredStatus: "running", gatewayClass: scenario === "shared-target" ? "shared" : "isolated", ownerUid: "alice",
      allocation: { kind: "disposable-builder", leaseId: "lease-one", generation: scenario === "wrong-generation" ? 2 : 1, claimedByUid: "alice" } };
    if (scenario === "history-evicted") Object.assign(h.operation, { attempts: 50, startedAt: 8_000, attemptHistory: [] });
    if (scenario === "committed") h.operation.cutoverCommittedAt = 2_000;
    const admitted = await h.rearm();
    expect(admitted).toBe(scenario === "released" || scenario === "history-evicted");
    if (admitted) expect(h.stored()).toMatchObject({ status: "pending", input: { recoverSourceOnly: true },
      schedulerHandoff: { forwardRecovery: { targetReleased: true }, sourceRecovery: { sourceEpoch: 4, steps: h.operation.steps } } });
    else expect(h.stored()).toBeUndefined();
  });
});

describe("failed preparation whose target unmount was never confirmed", () => {
  const target = "alice-xs-12345678";
  const retirementId = `placement-retire-alice-${target}-g1`;
  type Scenario = "gone" | "retired" | "running" | "retirement-failed" | "target-assigned" | "unmount-done" | "committed" |
    "source-moved" | "other-marker" | "activation" | "handoff-held";

  function unconfirmedUnmount(scenario: Scenario) {
    const h = fixture("mig-op-1:scheduler:1:claim:1000");
    Object.assign(h.operation, {
      error: "pre import failed — rollback:unmount-target: transport failed: fetch failed",
      steps: [
        { name: "keys-sync-state", status: "done" },
        { name: "pre-sync-state", status: "failed", error: "Isolated target did not finish normal startup before import; source retained" },
        { name: "rollback:unmount-target", status: scenario === "unmount-done" ? "done" : "failed", error: "transport failed: fetch failed" },
      ],
      schedulerHandoffReleased: scenario !== "handoff-held",
      ...(scenario === "committed" ? { cutoverCommittedAt: 1_500 } : {}),
    });
    Object.assign(h.operation.input, { source: scenario === "activation" ? "builder-activation-lease" : "operator-isolated-gateway", userSlug: "alice", toGatewayId: target });
    Object.assign(h.operation.schedulerHandoff!, { toGatewayId: target, stageAfterCutover: true });
    h.records["users/alice"] = { provisioning: { openclaw: { gatewayId: scenario === "source-moved" ? "shared-b" : "shared-a",
      migration: { state: "preparing", phase: "preparing", startedAt: 1_000, operationId: scenario === "other-marker" ? "op-2" : "op-1" } } } };
    if (scenario !== "gone") {
      h.records[`gateways/${target}`] = { gatewayId: target, desiredRelease: 1, latestRelease: 1, gatewayClass: "isolated", ownerUid: "alice",
        desiredStatus: scenario === "running" ? "running" : "retired", retirementClaim: { operationId: retirementId, version: 1 } };
      h.records[`glmOperations/${retirementId}`] = { id: retirementId, kind: "retire-gateway", status: scenario === "retirement-failed" ? "failed" : "succeeded",
        createdBy: "test", createdAt: 2_100, input: { uid: "alice", gatewayId: target } };
    }
    if (scenario === "target-assigned") {
      h.records[`gateways/${target}/assignments/alice`] = { uid: "alice", slug: "alice", gatewayId: target, source: "migrate-user", state: "migrating", epoch: 0,
        createdAt: 1_200, updatedAt: 1_200, updatedByOperationId: "op-1" };
    }
    const logs: string[] = [];
    const sweep = () => recoverFailedLegacyMigrations({ store: createDocumentFixtureStore(h.records), log: (line) => logs.push(line), now: () => 3_000 });
    const marker = () => (h.records["users/alice"]?.provisioning as { openclaw?: { migration?: unknown } } | undefined)?.openclaw?.migration;
    return { ...h, logs, sweep, marker };
  }

  it.each(["gone", "retired"] as const)("releases the marker once the target is retired (%s)", async (scenario) => {
    const h = unconfirmedUnmount(scenario);
    await h.sweep();
    expect(h.marker()).toBeUndefined();
    expect(h.stored()).toBeUndefined();
    expect(h.logs).toEqual([`[migration-recovery] released op-1's preparation marker for alice: target ${target} retired before its unmount was confirmed`]);
  });

  it.each(["running", "retirement-failed", "target-assigned", "unmount-done", "committed", "source-moved", "other-marker", "activation", "handoff-held"] as const)(
    "keeps the marker while the target may still hold the user or the operation owns no preparation: %s", async (scenario) => {
      const h = unconfirmedUnmount(scenario);
      const before = h.marker();
      await h.sweep();
      expect(h.marker()).toEqual(before);
      expect(h.logs).toEqual([]);
    });
});

describe("failed move to an isolated gateway whose target unmount was never confirmed after the source quiesced", () => {
  const target = "alice-xs-12345678";
  const retirementId = `operator-retire-${target}`;
  type Scenario = "gone" | "retired" | "verify-target" | "flush-source" | "running" | "retirement-failed" | "target-assigned" | "committed" |
    "source-moved" | "other-marker" | "quiesced-by-another-move" | "activation" | "handoff-held" | "cutover-failed" | "unmount-done";
  const forward = (failed: "flush-source" | "final-sync-state" | "verify-target" | "cutover-firestore") => {
    const order = ["keys-sync-state", "pre-sync-state", "wait-for-active-work", "quiesce-source", "flush-source", "final-sync-state", "verify-target", "cutover-firestore"];
    return order.slice(0, order.indexOf(failed) + 1).map((name) => ({ name, status: name === failed ? "failed" as const : "done" as const }));
  };

  function unconfirmedTargetUnmount(scenario: Scenario) {
    const h = fixture("mig-op-1:scheduler:1:claim:1000");
    const failedStep = scenario === "verify-target" || scenario === "flush-source" ? scenario : scenario === "cutover-failed" ? "cutover-firestore" : "final-sync-state";
    Object.assign(h.operation, {
      error: `/push-rsync-state/shared-a: 500 connection refused — rollback:unmount-target: /unmount/${target} transport failed: fetch failed`,
      steps: [...forward(failedStep), { name: "rollback:unmount-target", status: scenario === "unmount-done" ? "done" : "failed", error: "transport failed: fetch failed" }],
      schedulerHandoffReleased: scenario !== "handoff-held",
      ...(scenario === "committed" ? { cutoverCommittedAt: 1_500 } : {}),
    });
    Object.assign(h.operation.input, { source: scenario === "activation" ? "builder-activation-lease" : "operator-isolated-gateway", userSlug: "alice", toGatewayId: target });
    Object.assign(h.operation.schedulerHandoff!, { toGatewayId: target, stageAfterCutover: true, scheduleTransfer: true });
    h.records["users/alice"] = { provisioning: { openclaw: { gatewayId: scenario === "source-moved" ? "shared-b" : "shared-a",
      migration: { state: "moving", phase: "transferring", startedAt: 1_000, operationId: scenario === "other-marker" ? "op-2" : "op-1" } } } };
    h.records["gateways/shared-a/assignments/alice"] = { ...h.records["gateways/shared-a/assignments/alice"],
      state: "quiescing", updatedByOperationId: scenario === "quiesced-by-another-move" ? "op-2" : "op-1" };
    if (scenario !== "gone") {
      h.records[`gateways/${target}`] = { gatewayId: target, desiredRelease: 1, latestRelease: 1, gatewayClass: "isolated", ownerUid: "alice",
        desiredStatus: scenario === "running" ? "running" : "retired", retirementClaim: { operationId: retirementId, version: 1 } };
      h.records[`glmOperations/${retirementId}`] = { id: retirementId, kind: "retire-gateway", status: scenario === "retirement-failed" ? "failed" : "succeeded",
        createdBy: "test", createdAt: 2_100, input: { gatewayId: target } };
    }
    if (scenario === "target-assigned") {
      h.records[`gateways/${target}/assignments/alice`] = { uid: "alice", slug: "alice", gatewayId: target, source: "migrate-user", state: "migrating", epoch: 0,
        createdAt: 1_200, updatedAt: 1_200, updatedByOperationId: "op-1" };
    }
    const logs: string[] = [];
    const sweep = () => recoverFailedLegacyMigrations({ store: createDocumentFixtureStore(h.records), log: (line) => logs.push(line), now: () => 3_000 });
    const marker = () => (h.records["users/alice"]?.provisioning as { openclaw?: { migration?: unknown } } | undefined)?.openclaw?.migration;
    const source = () => h.records["gateways/shared-a/assignments/alice"];
    return { ...h, logs, sweep, marker, source };
  }

  it.each(["gone", "retired", "verify-target", "flush-source"] as const)("queues source recovery that skips the target once the target is retired (%s)", async (scenario) => {
    const h = unconfirmedTargetUnmount(scenario);
    const steps = h.operation.steps;
    await h.sweep();
    expect(h.stored()).toMatchObject({
      status: "pending", input: { recoverSourceOnly: true, toGatewayId: target }, schedulerHandoffReleased: false,
      schedulerHandoff: { sourceRecovery: { migrationId: "mig-op-1:scheduler:1:claim:1000", sourceEpoch: 4, steps, retiredTarget: { gatewayId: target } } },
    });
    expect(h.marker()).toMatchObject({ state: "moving", operationId: "op-1" });
    expect(h.source()).toMatchObject({ state: "quiescing", updatedByOperationId: "op-1" });
    expect(h.logs).toEqual(["[migration-recovery] queued native source recovery for op-1; assignment and marker remain held"]);
  });

  it("queues the retry of a retired-target recovery whose own attempt failed", async () => {
    const h = unconfirmedTargetUnmount("retired");
    await h.sweep();
    const rearmed = h.stored() as unknown as Operation;
    h.records["glmOperations/op-1"] = { ...rearmed, status: "failed", startedAt: 4_000, completedAt: 4_500, attempts: 2,
      error: "source gateway starting; retry shortly", steps: [] } as unknown as Record<string, unknown>;
    h.logs.length = 0;
    await h.sweep();
    expect(h.records["glmOperations/op-1"]).toMatchObject({ status: "pending", input: { recoverSourceOnly: true },
      schedulerHandoff: { sourceRecovery: { retiredTarget: { gatewayId: target } } } });
    expect(h.logs).toEqual(["[migration-recovery] queued native source recovery for op-1; assignment and marker remain held"]);
  });

  it.each(["running", "retirement-failed", "target-assigned", "committed", "source-moved", "other-marker", "quiesced-by-another-move", "activation",
    "handoff-held", "cutover-failed", "unmount-done"] as const)(
    "leaves the move held while the target may still hold the user or the move no longer owns the source: %s", async (scenario) => {
      const h = unconfirmedTargetUnmount(scenario);
      const [marker, source] = [h.marker(), h.source()];
      await h.sweep();
      expect(h.stored()).toBeUndefined();
      expect(h.marker()).toEqual(marker);
      expect(h.source()).toEqual(source);
      expect(h.logs).toEqual([]);
    });
});
