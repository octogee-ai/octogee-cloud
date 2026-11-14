import { describe, it, expect, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import { MIGRATION_TRANSFER_LEASE_MS } from "@octogee/shared/types/fleet-controller";
import type { Operation, OperationAttemptRecord, OperationStep, SchedulerHandoffState } from "@octogee/shared/types/glm";
import { recoverControllerOrphanedOperations, runStuckOpReaperTick } from "../stuck-op-reaper.js";
import { decideOperationClaim } from "../operation-queue.js";

interface FakeOpDoc {
  id: string;
  data: {
    status?: string;
    kind?: string;
    origin?: string;
    startedAt?: number;
    createdAt?: number;
    lastProgressAt?: number;
    expireAt?: number;
    output?: Record<string, unknown>;
    userMigrationV2?: { phase: string };
    recordType?: string;
    input?: Record<string, unknown>;
    steps?: Array<{ name: string; status: string; error?: string }>;
    cutoverCommittedAt?: number;
    schedulerHandoffReleased?: boolean;
    schedulerHandoff?: SchedulerHandoffState;
    completedAt?: number;
    error?: unknown;
    attempts?: number;
    rolledBack?: boolean;
    attemptHistory?: Partial<OperationAttemptRecord>[];
    cancellationRequestedAt?: number;
    nextAttemptAt?: Operation["nextAttemptAt"];
  };
  updated?: FakeOpDoc["data"];
}

interface FakeDbState {
  users?: Record<string, Record<string, unknown>>;
  roots?: Record<string, Record<string, unknown>>;
  assignments?: Record<string, Record<string, unknown>>;
  beforeTransaction?: () => void;
  transactionState?: { active: boolean };
}

function completeAssignment(gatewayId: string, uid: string, assignment: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(assignment, {
    uid, slug: uid, gatewayId, source: "migrate-user", state: "serving", epoch: 1,
    createdAt: 1, updatedAt: 1, updatedByOperationId: null, ...assignment,
  });
}

function completeRoot(gatewayId: string, root: Record<string, unknown>): Record<string, unknown> {
  return { gatewayId, desiredRelease: 1, latestRelease: 1, desiredStatus: "running", ...root };
}

function makeStore(ops: FakeOpDoc[], state: FakeDbState = {}): PlatformStateStore {
  const records: Record<string, Record<string, unknown>> = {};
  for (const op of ops) records[`glmOperations/${op.id}`] = op.data;
  for (const [uid, user] of Object.entries(state.users ?? {})) records[`users/${uid}`] = user;
  for (const [path, assignment] of Object.entries(state.assignments ?? {})) {
    const [gatewayId, uid] = path.split("/");
    records[`gateways/${gatewayId}/assignments/${uid}`] = completeAssignment(gatewayId, uid, assignment);
  }
  for (const [gatewayId, root] of Object.entries(state.roots ?? {})) records[`gateways/${gatewayId}`] = completeRoot(gatewayId, root);
  const documents = fixtureDocumentsAt(records);
  const fixture = createJournalFixtureStore(journalRowsAtPaths(records), {
    beforeTransaction: () => state.beforeTransaction?.(),
    documents: {
      ...documents,
      set: (path, row) => {
        const current = records[path];
        if (current === undefined) {
          records[path] = row;
        } else {
          for (const field of Object.keys(current)) delete current[field];
          Object.assign(current, row);
        }
        const op = ops.find((candidate) => `glmOperations/${candidate.id}` === path);
        if (op) op.updated = structuredClone(row) as FakeOpDoc["data"];
      },
    },
  });
  return {
    journal: fixture.journal,
    users: fixture.users,
    gateways: fixture.gateways,
    transaction: async (options, body) => {
      if (state.transactionState) state.transactionState.active = true;
      try {
        return await fixture.transaction(options, body);
      } finally {
        if (state.transactionState) state.transactionState.active = false;
      }
    },
  } as PlatformStateStore;
}

const NOW = 1_700_000_000_000;

describe("runStuckOpReaperTick", () => {
  it.each(["owned", "purge-failed", "failed-entry", "transient-cleanup", "clean-envelope", "rollback-only", "quiesced", "foreign-marker", "target-assigned", "cutover", "cancelled", "other-attempt", "forward-recovery"])(
    "recovers held target cleanup only for the exact pre-quiesce Shared attempt: %s", async (scenario) => {
      const held = "agent database files are still held open: /state/agents/octogee-alice-coach/agent/openclaw-agent.sqlite";
      const op: FakeOpDoc = { id: "placement-owned", data: {
        kind: "migrate-user", status: "failed", startedAt: 100, attempts: 1, rolledBack: true,
        steps: [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "failed" }, { name: "rollback:unmount-target", status: "failed" }],
        error: held,
        input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
        schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: "mig-placement-owned:scheduler:1:claim:100" },
      } };
      if (scenario === "purge-failed") op.data.error = "native cleanup incomplete: purgeFailed=true failed=[]";
      if (scenario === "failed-entry") op.data.error = 'native cleanup incomplete: purgeFailed=false failed=[{"path":"/state/agent.sqlite"}]';
      if (scenario === "clean-envelope") op.data.error = "native cleanup incomplete: purgeFailed=false failed=[]";
      if (scenario === "transient-cleanup") op.data.error = "request timed out — rollback:unmount-target: target cleanup refused";
      op.data.steps![1].error = scenario === "rollback-only" ? "workspace migration phase authority changed" : String(op.data.error);
      const admitted = ["owned", "purge-failed", "failed-entry", "transient-cleanup"].includes(scenario);
      const marker = { state: "preparing", operationId: scenario === "foreign-marker" ? "other" : op.id, startedAt: 100 };
      const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "serving", updatedByOperationId: op.id };
      if (scenario === "quiesced") op.data.steps!.push({ name: "quiesce-source", status: "running" });
      if (scenario === "cutover") op.data.cutoverCommittedAt = 200;
      if (scenario === "cancelled") op.data.cancellationRequestedAt = 200;
      if (scenario === "other-attempt") op.data.attempts = 2;
      if (scenario === "forward-recovery") op.data.schedulerHandoff!.forwardRecovery = { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 1 };
      const db = makeStore([op], {
        users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: marker } } } },
        assignments: { "shared-a/alice": assignment, ...(scenario === "target-assigned" ? { "shared-b/alice": { state: "serving" } } : {}) },
      });

      await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });

      expect(op.data.status).toBe(admitted ? "pending" : "failed");
      expect(assignment.state).toBe("serving");
      expect(marker.operationId).toBe(scenario === "foreign-marker" ? "other" : op.id);
      if (admitted) {
        expect(op.updated?.input?.recoverSourceOnly).toBe(true);
        expect(op.data.attemptHistory).toEqual([expect.objectContaining({ attempt: 1, steps: expect.arrayContaining([expect.objectContaining({ name: "pre-sync-state", status: "failed" })]) })]);
      } else expect(op.updated).toBeUndefined();
    },
  );

  it("retains exact recovery evidence beyond the diagnostic history limit and backs off failed cleanup", async () => {
    const held = "agent database files are still held open: /state/agent.sqlite";
    const steps = [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "failed", error: held }, { name: "rollback:unmount-target", status: "failed", error: held }];
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "failed", startedAt: 100, attempts: 1, error: held, steps,
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: "mig-placement-owned:scheduler:1:claim:100" },
    } };
    const openclaw: Record<string, unknown> = { gatewayId: "shared-a", migration: { state: "preparing", operationId: op.id, startedAt: 100 } };
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw } } },
      assignments: { "shared-a/alice": { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "serving", updatedByOperationId: op.id } },
    });
    await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });
    expect(op.data.schedulerHandoff?.sourceRecovery).toEqual({ migrationId: "mig-placement-owned:scheduler:1:claim:100", sourceEpoch: 1, steps });
    for (let attempt = 2; attempt <= 23; attempt++) {
      Object.assign(op.data, { status: "failed", attempts: attempt, steps: [], error: "target cleanup refused", completedAt: NOW + attempt * 600_000 });
      op.data.input!.recoverSourceOnly = true;
      op.data.attemptHistory = Array.from({ length: 20 }, (_, index) => ({ attempt: attempt + index, steps: [], error: "target cleanup refused" }));
      await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW + attempt * 600_000, stalenessMs: 15 * 60_000 });
      expect(op.data.status).toBe("pending");
      expect(op.updated?.nextAttemptAt).toBeGreaterThan(NOW + attempt * 600_000);
      expect(op.data.schedulerHandoff?.sourceRecovery).toEqual({ migrationId: "mig-placement-owned:scheduler:1:claim:100", sourceEpoch: 1, steps });
    }
    Object.assign(op.data, { status: "failed", rolledBack: true, schedulerHandoffReleased: true, error: "abandoned Shared migration rolled back; native source recovery completed" });
    op.updated = undefined;
    await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW + 30 * 600_000, stalenessMs: 15 * 60_000 });
    expect(op.data.status).toBe("failed");
    expect(op.updated).toBeUndefined();
    Object.assign(op.data, { status: "running", rolledBack: undefined, startedAt: NOW, schedulerHandoffReleased: true });
    delete openclaw.migration;
    await recoverControllerOrphanedOperations({ store: db, log: vi.fn(), now: () => NOW + 30 * 600_000, controllerStartedAt: NOW + 1_000 });
    expect(op.data).toMatchObject({ status: "failed", rolledBack: true, steps: [{ name: "recover-source", status: "done" }] });
    expect(op.data.schedulerHandoffReleased).toBe(true);
  });

  it.each([
    ["held", "agent database files are still held open: /state/agent.sqlite", true],
    ["partial", "native cleanup incomplete: purgeFailed=true failed=[]", true],
    ["failed-entry", 'native cleanup incomplete: purgeFailed=false failed=["purge failed"]', true],
    ["deletion-pending", '[import:alice] agents.create failed for octogee-alice-coach (agent "octogee-alice-coach" deletion cleanup is still pending)', true],
    ["transient", "request timed out", true],
    ["unknown", "workspace migration authority changed", false],
    ["complete", "native cleanup incomplete: purgeFailed=false failed=[]", false],
  ])("recovers a terminal forward failure only for recoverable target cleanup: %s", async (_label, cleanupError, admitted) => {
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "failed", startedAt: 100, attempts: 1, rolledBack: false, error: "target verification refused",
      steps: [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "done" }, { name: "quiesce-source", status: "done" },
        { name: "verify-target", status: "failed", error: "target verification refused" }, { name: "rollback:unmount-target", status: "failed", error: String(cleanupError) }],
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: "mig-placement-owned:scheduler:1:claim:100" },
    } };
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "preparing", operationId: op.id, startedAt: 100 } } } } },
      assignments: { "shared-a/alice": { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "serving", updatedByOperationId: op.id } },
    });
    await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });
    expect(op.data.status).toBe(admitted ? "pending" : "failed");
    if (admitted) expect(op.data.schedulerHandoff?.sourceRecovery?.steps).toEqual(op.data.attemptHistory![0].steps);
    else expect(op.updated).toBeUndefined();
  });

  it.each(["quiescing", "acknowledged"])("requeues an interrupted disposable activation before releasing or retiring its source: %s", async (phase) => {
    const target = "alice-s-12345678";
    const op: FakeOpDoc = { id: `builder-activate-${target}-g2`, data: {
      kind: "migrate-user", status: "running", startedAt: NOW - 1_000, attempts: 0,
      steps: [{ name: "quiesce-source", status: "done" }],
      input: { uid: "alice", userSlug: "alice", fromGatewayId: "shared-a", toGatewayId: target, source: "builder-activation-lease" },
      schedulerHandoffReleased: true,
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: target, migrationId: `mig-builder-activate-${target}-g2:scheduler:1:claim:${NOW - 1_000}`, stageAfterCutover: true },
    } };
    const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 4, state: "quiescing", updatedByOperationId: op.id };
    const marker = { state: "moving", operationId: op.id, startedAt: 100 };
    if (phase === "acknowledged") assignment.state = "serving";
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", ...(phase === "quiescing" ? { migration: marker } : {}), activationLease: { leaseId: "lease-a", generation: 2, status: "activating", sourceGatewayId: "shared-a", sourceAssignmentEpoch: 4, targetGatewayId: target } } } } },
      assignments: { "shared-a/alice": assignment },
      roots: { [target]: { gatewayId: target, gatewayClass: "isolated", ownerUid: "alice", allocation: { kind: "disposable-builder", leaseId: "lease-a", generation: 2, claimedByUid: "alice" } } },
    });
    await recoverControllerOrphanedOperations({ store: db, log: vi.fn(), now: () => NOW, controllerStartedAt: NOW });
    expect(op.data.status).toBe("pending");
    expect(op.updated?.input?.recoverSourceOnly).toBe(true);
    expect(op.data.schedulerHandoffReleased).toBe(false);
    expect(assignment.state).toBe(phase === "quiescing" ? "quiescing" : "serving");
  });
  it.each<{ held: boolean; retry: boolean; legacyQueued: boolean; steps: OperationStep[] }>([
    { held: true, retry: false, legacyQueued: false, steps: [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed" }] },
    { held: false, retry: false, legacyQueued: false, steps: [{ name: "keys-sync-state", status: "failed" }] },
    { held: true, retry: true, legacyQueued: false, steps: [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed" }, { name: "rollback:unmount-target", status: "failed" }] },
    { held: true, retry: true, legacyQueued: true, steps: [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed" }] },
  ])("admits a terminally failed disposable activation to source recovery only when its source was held: held=$held retry=$retry legacyQueued=$legacyQueued", async ({ held, retry, legacyQueued, steps }) => {
    const target = "alice-s-12345678";
    const id = `builder-activate-${target}-g2`;
    const op: FakeOpDoc = { id, data: {
      kind: "migrate-user", status: "failed", startedAt: NOW - 5_000, completedAt: NOW - 1_000, attempts: 1,
      error: "target import refused", steps,
      attemptHistory: [{ attempt: 1, startedAt: NOW - 5_000, completedAt: NOW - 1_000, error: "target import refused", classification: "terminal", steps }],
      input: { uid: "alice", userSlug: "alice", fromGatewayId: "shared-a", toGatewayId: target, source: "builder-activation-lease" },
      schedulerHandoffReleased: false,
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: target, migrationId: `mig-${id}:scheduler:1:claim:${NOW - 5_000}`, stageAfterCutover: true },
    } };
    const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 4, state: held ? "quiescing" : "serving", updatedByOperationId: id };
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "moving", operationId: id, startedAt: 100 },
        activationLease: { leaseId: "lease-a", generation: 2, status: "activating", sourceGatewayId: "shared-a", sourceAssignmentEpoch: 4, targetGatewayId: target } } } } },
      assignments: { "shared-a/alice": assignment },
      roots: { [target]: { gatewayId: target, gatewayClass: "isolated", ownerUid: "alice", allocation: { kind: "disposable-builder", leaseId: "lease-a", generation: 2, claimedByUid: "alice" } } },
    });
    await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });
    expect(op.data.status).toBe(held ? "pending" : "failed");
    expect(op.updated?.input?.recoverSourceOnly).toBe(held ? true : undefined);
    expect(assignment.state).toBe(held ? "quiescing" : "serving");
    if (retry) {
      Object.assign(op.data, { status: "failed", attempts: 2, steps: [], error: "target cleanup refused" });
      op.data.input!.recoverSourceOnly = true;
      if (legacyQueued) delete op.data.schedulerHandoff!.sourceRecovery;
      await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });
      expect(op.data.status).toBe("pending");
      if (!legacyQueued) expect(op.updated?.nextAttemptAt).toBeGreaterThan(NOW);
      expect(assignment.state).toBe("quiescing");
    }
  });
  it("ignores failed audit entries without migration input", async () => {
    const audit: FakeOpDoc = { id: "audit-unrelated", data: { status: "failed", recordType: "audit", error: "operator action failed" } };
    const log = vi.fn();
    await runStuckOpReaperTick({ store: makeStore([audit]), log, now: () => NOW, stalenessMs: 15 * 60_000 });
    expect(audit.updated).toBeUndefined();
    expect(log.mock.calls.flat().join("\n")).not.toContain("recovery admission failed");
  });
  it("recovers a failed owned rsync conflict on a later tick without restarting the fleet controller", async () => {
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "failed", attempts: 1, startedAt: 100, steps: [{ name: "keys-sync-state", status: "failed" }],
      error: "rsync import port 30873 is already serving migrationId=other slug=bob",
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: "mig-placement-owned:scheduler:1:claim:100" },
    } };
    const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "serving", updatedByOperationId: op.id };
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "preparing", operationId: op.id, startedAt: 100 } } } } },
      assignments: { "shared-a/alice": assignment },
    });
    await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });
    expect(op.data.status).toBe("pending");
    expect(op.updated?.input?.recoverSourceOnly).toBe(true);
    expect(assignment.state).toBe("serving");
  });
  it.each(["boot", "budget", "scheduler-only-released"])("requeues an abandoned owned Shared migration without pretending the source is serving: %s", async (scenario) => {
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "failed", attempts: 1, startedAt: 100, completedAt: NOW - 1_000, steps: [],
      error: "reaped: controller restarted mid-op", input: {
        uid: "alice", userSlug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b",
      },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: "mig-placement-owned:scheduler:1:claim:100" },
    } };
    if (scenario === "budget") op.data.error = "reaped: op exceeded 15m running budget — controller likely restarted mid-op or the work hung past the inner deadlines";
    if (scenario === "scheduler-only-released") op.data.schedulerHandoffReleased = true;
    const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "quiescing", updatedByOperationId: op.id };
    const marker = { state: "moving", operationId: op.id, startedAt: 100 };
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: marker } } } },
      assignments: { "shared-a/alice": assignment },
    });
    await recoverControllerOrphanedOperations({ store: db, log: vi.fn(), now: () => NOW, controllerStartedAt: NOW });
    expect(op.data.status).toBe("pending");
    expect(assignment.state).toBe("quiescing");
    expect(marker.operationId).toBe(op.id);
    expect(op.data.schedulerHandoff).toMatchObject({ migrationId: "mig-placement-owned:scheduler:1:claim:100" });
    expect(op.data.attempts).toBe(1);
    expect(op.updated?.input?.recoverSourceOnly).toBe(true);
  });
  it.each(["previous-controller", "current-controller"])("does not strand a boot-missed orphan or race a live claim: %s", async (scenario) => {
    const claimedAt = NOW - 30 * 60_000;
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "running", attempts: 0, startedAt: claimedAt, steps: [],
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: `mig-placement-owned:scheduler:1:claim:${claimedAt}` },
    } };
    const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "quiescing", updatedByOperationId: op.id };
    const db = makeStore([op], { users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "moving", operationId: op.id, startedAt: 100 } } } } }, assignments: { "shared-a/alice": assignment } });
    await runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000,
      controllerStartedAt: claimedAt + (scenario === "previous-controller" ? 1_000 : -1_000),
    } as never);
    expect(op.data.status).toBe(scenario === "previous-controller" ? "pending" : "failed");
    expect(assignment.state).toBe("quiescing");
  });

  it.each(["foreign-marker", "moved", "foreign-gate", "target-assigned", "cutover", "v2", "cancelled", "restore", "source-transfer", "terminal", "missing-handoff"])("preserves abandoned state when recovery has %s", async (scenario) => {
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "failed", attempts: 1, startedAt: 100, steps: [], error: "reaped: controller restarted mid-op",
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: "mig-placement-owned:scheduler:1:claim:100" },
    } };
    const openclaw: Record<string, unknown> = { gatewayId: "shared-a", migration: { state: "moving", startedAt: 100, operationId: op.id } };
    const assignment = { uid: "alice", gatewayId: "shared-a", state: "quiescing", epoch: 1, updatedByOperationId: op.id };
    if (scenario === "foreign-marker") openclaw.migration = { state: "moving", startedAt: 100, operationId: "another" };
    if (scenario === "moved") openclaw.gatewayId = "shared-b";
    if (scenario === "foreign-gate") assignment.updatedByOperationId = "another";
    if (scenario === "cutover") op.data.cutoverCommittedAt = 200;
    if (scenario === "v2") op.data.userMigrationV2 = { phase: "initial" };
    if (scenario === "cancelled") op.data.cancellationRequestedAt = 200;
    if (scenario === "restore") openclaw.restoreFence = { operationId: "restore" };
    if (scenario === "source-transfer") openclaw.sourceTransferFence = { operationId: op.id };
    if (scenario === "terminal") op.data.error = "signature verification failed";
    if (scenario === "missing-handoff") delete op.data.schedulerHandoff;
    const db = makeStore([op], {
      users: { alice: { provisioning: { openclaw } } },
      assignments: { "shared-a/alice": assignment, ...(scenario === "target-assigned" ? { "shared-b/alice": { state: "serving" } } : {}) },
    });
    await recoverControllerOrphanedOperations({ store: db, log: vi.fn(), now: () => NOW, controllerStartedAt: NOW });
    expect(op.updated).toBeUndefined();
    expect(assignment.state).toBe("quiescing");
  });

  it("requeues a live orphan's journal and uses a fresh scheduler attempt after the old controller exits", async () => {
    const op: FakeOpDoc = { id: "placement-owned", data: {
      kind: "migrate-user", status: "running", startedAt: NOW - 1_000, attempts: 0,
      steps: [{ name: "quiesce-source", status: "done" }],
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      schedulerHandoff: { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", migrationId: `mig-placement-owned:scheduler:1:claim:${NOW - 1_000}` },
    } };
    const assignment = { uid: "alice", gatewayId: "shared-a", epoch: 1, state: "quiescing", updatedByOperationId: op.id };
    const db = makeStore([op], { users: { alice: { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "moving", operationId: op.id, startedAt: 100 } } } } }, assignments: { "shared-a/alice": assignment } });
    await recoverControllerOrphanedOperations({ store: db, log: vi.fn(), now: () => NOW, controllerStartedAt: NOW });
    expect(op.data).toMatchObject({ status: "pending", attempts: 1, steps: [], schedulerHandoff: { migrationId: `mig-placement-owned:scheduler:1:claim:${NOW - 1_000}` } });
    expect(op.data.attemptHistory).toMatchObject([{ attempt: 1, steps: [{ name: "quiesce-source", status: "done" }] }]);
    expect(assignment.state).toBe("quiescing");
  });
  it("preserves an ID-less persisted automatic user return for restart recovery", async () => {
    const ops: FakeOpDoc[] = [{
      id: "builder-return-builder-alice-g1",
      data: {
        kind: "migrate-user", origin: "automatic", status: "running",
        startedAt: NOW - 60 * 60_000,
        input: { uid: "alice", source: "builder-activation-lease", fromGatewayId: "builder-alice" },
      },
    }];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops), log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("does not reap a stale running audit record", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "audit-running",
        data: {
          recordType: "audit",
          status: "running",
          kind: "rollout",
          startedAt: NOW - 60 * 60_000,
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(result).toEqual({ scanned: 0, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });


  it.each([{ age: MIGRATION_TRANSFER_LEASE_MS + 59_000, reaped: 0 }, { age: MIGRATION_TRANSFER_LEASE_MS + 61_000, reaped: 1 }])("respects the bounded final-import deadline at age $age", async ({ age, reaped }) => {
    const ops: FakeOpDoc[] = [{ id: "slow-final", data: { status: "running", kind: "migrate-user",
      startedAt: NOW - age, lastProgressAt: NOW - age, steps: [{ name: "final-sync-state", status: "running" }] } }];
    await expect(runStuckOpReaperTick({ store: makeStore(ops), log: vi.fn(), now: () => NOW,
      stalenessMs: 15 * 60_000 })).resolves.toEqual({ scanned: 1, reaped });
  });


  it("rechecks a newly running final-import budget inside the reap transaction", async () => {
    const ops: FakeOpDoc[] = [{ id: "changed-stage", data: { status: "running", kind: "migrate-user",
      startedAt: NOW - 1_100_000, input: { uid: "uid-mike", fromGatewayId: "shared-a", toGatewayId: "isolated-target" },
      steps: [{ name: "pre-sync-state", status: "running" }] } }];
    const db = makeStore(ops, { beforeTransaction: () => { ops[0].data.steps = [{ name: "final-sync-state", status: "running" }]; } });
    await expect(runStuckOpReaperTick({ store: db, log: vi.fn(), now: () => NOW,
      stalenessMs: 15 * 60_000 })).resolves.toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("flips status=failed on a `running` op older than stalenessMs", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-stuck",
        data: {
          status: "running",
          kind: "migrate-user",
          startedAt: NOW - 20 * 60_000,
        },
      },
    ];
    const log = vi.fn();
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toMatchObject({
      status: "failed",
      completedAt: NOW,
      error: expect.stringContaining("reaped"),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("op-stuck"));
  });

  it("does not manufacture a cleanup lease when the reaper cannot prove freeze ownership", async () => {
    const ops: FakeOpDoc[] = [{
      id: "op-stuck-migration",
      data: {
        status: "running",
        kind: "migrate-user",
        startedAt: NOW - 20 * 60_000,
      },
    }];

    await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(ops[0].updated).not.toHaveProperty("output.configCleanup");
  });

  it.each(["restoreFence", "sourceTransferFence"])("leaves the legacy operation and assignment unchanged while %s is unresolved", async (fence) => {
    const ops: FakeOpDoc[] = [{ id: "placement-owned", data: {
      status: "running", kind: "migrate-user", startedAt: NOW - 20 * 60_000,
      input: { uid: "uid-mike", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
    } }];
    const assignment = { uid: "uid-mike", gatewayId: "shared-a", state: "quiescing", source: "migrate-user", updatedByOperationId: "placement-owned" };
    const db = makeStore(ops, {
      users: { "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a", [fence]: { operationId: "restore-1", sourceGatewayId: "shared-a", targetGatewayId: "shared-b" } } } } },
      assignments: { "shared-a/uid-mike": assignment },
    });
    const log = vi.fn();
    await expect(runStuckOpReaperTick({ store: db, log, now: () => NOW, stalenessMs: 15 * 60_000 })).resolves.toEqual({ scanned: 1, reaped: 0 });
    expect(assignment.state).toBe("quiescing");
    expect(ops[0].updated).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("restore"));
  });

  it("keeps the source closed when native recovery ownership is missing", async () => {
    const ops: FakeOpDoc[] = [{
      id: "placement-owned",
      data: {
        status: "running",
        kind: "migrate-user",
        startedAt: NOW - 20 * 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
        },
      },
    }];
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      source: "migrate-user",
      updatedByOperationId: "placement-owned",
    };
    const transactionState = { active: false };
    const db = makeStore(ops, {
      users: {
        "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a" } } },
      },
      assignments: { "shared-a/uid-mike": assignment },
      transactionState,
    });
    const log = vi.fn(() => expect(transactionState.active).toBe(false));

    const result = await runStuckOpReaperTick({
      store: db,
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(assignment).toMatchObject({
      state: "quiescing",
      updatedByOperationId: "placement-owned",
    });
    expect(ops[0].updated).toMatchObject({ status: "failed" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("source recovery remains unacknowledged"));
  });

  it.each([
    ["a foreign gate owner", "another-operation", "shared-a"],
    ["a committed user move", "placement-owned", "shared-b"],
  ])("does not reopen a legacy source assignment with %s", async (_reason, owner, userGatewayId) => {
    const ops: FakeOpDoc[] = [{
      id: "placement-owned",
      data: {
        status: "running",
        kind: "migrate-user",
        startedAt: NOW - 20 * 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
        },
      },
    }];
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      source: "migrate-user",
      updatedByOperationId: owner,
    };
    const db = makeStore(ops, {
      users: {
        "uid-mike": { provisioning: { openclaw: { gatewayId: userGatewayId } } },
      },
      assignments: { "shared-a/uid-mike": assignment },
    });

    await runStuckOpReaperTick({
      store: db,
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(assignment.state).toBe("quiescing");
    expect(ops[0].updated).toMatchObject({ status: "failed" });
  });

  it.each([
    ["fresh progress", (op: FakeOpDoc) => { op.data.lastProgressAt = NOW; }],
    ["a terminal status", (op: FakeOpDoc) => { op.data.status = "succeeded"; }],
  ])("does not reap or reopen a legacy gate after the transaction observes %s", async (_reason, advance) => {
    const op: FakeOpDoc = {
      id: "placement-raced",
      data: {
        status: "running",
        kind: "migrate-user",
        startedAt: NOW - 20 * 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
        },
      },
    };
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      source: "migrate-user",
      updatedByOperationId: "placement-raced",
    };
    const db = makeStore([op], {
      users: {
        "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a" } } },
      },
      assignments: { "shared-a/uid-mike": assignment },
      beforeTransaction: () => advance(op),
    });
    const log = vi.fn();

    const result = await runStuckOpReaperTick({
      store: db,
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(assignment.state).toBe("quiescing");
    expect(op.updated).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("leaves a stale op alone when a worker re-claims it before the reap writes", async () => {
    const ops: FakeOpDoc[] = [{ id: "op-reclaimed", data: { status: "running", kind: "rollout", startedAt: NOW - 20 * 60_000 } }];
    const store = makeStore(ops);
    const operations = store.journal.operations;
    const listByStatus = operations.listByStatus.bind(operations);
    vi.spyOn(operations, "listByStatus").mockImplementation(async (statuses) => {
      const listed = await listByStatus(statuses);
      if (statuses.includes("running")) ops[0].data.startedAt = NOW - 1_000;
      return listed;
    });

    const result = await runStuckOpReaperTick({ store, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000 });

    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
    expect(ops[0].data.status).toBe("running");
  });

  it("leaves a recent `running` op alone", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-fresh",
        data: { status: "running", kind: "rollout", startedAt: NOW - 30_000 },
      },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it.each(["suspend-user", "erase-user"])(
    "does not terminalize a stale restart-resumable %s operation",
    async (kind) => {
      const ops: FakeOpDoc[] = [{
        id: `op-${kind}`,
        data: { status: "running", kind, startedAt: NOW - 60 * 60_000 },
      }];
      const result = await runStuckOpReaperTick({
        store: makeStore(ops),
        log: vi.fn(),
        now: () => NOW,
        stalenessMs: 15 * 60_000,
      });
      expect(result).toEqual({ scanned: 1, reaped: 0 });
      expect(ops[0].updated).toBeUndefined();
    },
  );

  it.each(["checkpointed", "promotionIntent", "finalized", "complete", "aborted"])(
    "never reaps a durable migration V2 operation held in %s for restart recovery",
    async (phase) => {
      const ops: FakeOpDoc[] = [{
        id: `op-v2-${phase}`,
        data: {
          status: "running",
          kind: "migrate-user",
          startedAt: NOW - 60 * 60_000,
          userMigrationV2: { phase },
        },
      }];

      const result = await runStuckOpReaperTick({
        store: makeStore(ops),
        log: vi.fn(),
        now: () => NOW,
        stalenessMs: 15 * 60_000,
      });

      expect(result).toEqual({ scanned: 1, reaped: 0 });
      expect(ops[0].updated).toBeUndefined();
    },
  );

  it("falls back to createdAt when startedAt is missing", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-no-started",
        data: {
          status: "running",
          kind: "migrate-user",
          createdAt: NOW - 30 * 60_000,
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toBeDefined();
  });

it("skips ops with no anchor timestamp (defensively — log noise only)", async () => {
    const ops: FakeOpDoc[] = [
      { id: "op-no-anchor", data: { status: "running", kind: "rollout" } },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("does NOT reap a long-running op that is still making progress (fresh lastProgressAt beats an old startedAt)", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-progressing",
        data: {
          status: "running",
          kind: "rollout",
          startedAt: NOW - 20 * 60_000, // claimed 20m ago (would reap on absolute age)
          lastProgressAt: NOW - 60_000, // …but a step landed 1m ago
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("reaps a running op whose progress AND claim are both stale past the budget", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-hung",
        data: {
          status: "running",
          kind: "rollout",
          startedAt: NOW - 20 * 60_000,
          lastProgressAt: NOW - 18 * 60_000, // no step in 18m → genuinely stuck
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toMatchObject({ status: "failed" });
  });

  it("reaps multiple stuck ops in a single tick", async () => {
    const ops: FakeOpDoc[] = [
      { id: "op-a", data: { status: "running", kind: "migrate-user", startedAt: NOW - 30 * 60_000 } },
      { id: "op-b", data: { status: "running", kind: "rollout", startedAt: NOW - 20 * 60_000 } },
      { id: "op-c", data: { status: "running", kind: "add-gateway", startedAt: NOW - 60_000 } },
    ];
    const result = await runStuckOpReaperTick({
      store: makeStore(ops),
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 3, reaped: 2 });
    expect(ops[0].updated).toBeDefined();
    expect(ops[1].updated).toBeDefined();
    expect(ops[2].updated).toBeUndefined();
  });
});

describe("recoverControllerOrphanedOperations", () => {
  const BOOTED_AT = NOW - 30_000;

  function orphanedPlacement(overrides: Partial<FakeOpDoc["data"]> = {}): FakeOpDoc {
    return {
      id: "placement-orphan",
      data: {
        status: "running",
        kind: "migrate-user",
        origin: "automatic",
        startedAt: BOOTED_AT - 2 * 60_000,
        lastProgressAt: BOOTED_AT - 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
          source: "continuous-placement-policy",
        },
        schedulerHandoffReleased: false,
        ...overrides,
      },
    };
  }

  function recover(store: PlatformStateStore, log = vi.fn()) {
    return recoverControllerOrphanedOperations({
      store,
      log,
      now: () => NOW,
      controllerStartedAt: BOOTED_AT,
    });
  }

  it("fails an orphan lacking native recovery ownership without falsely reopening its source", async () => {
    const orphan = orphanedPlacement({
      steps: [
        { name: "keys-sync-state", status: "done" },
        { name: "quiesce-source", status: "running" },
      ],
    });
    const queued = {
      id: "placement-queued",
      kind: "migrate-user",
      status: "pending",
      input: { uid: "uid-nina", fromGatewayId: "shared-a", toGatewayId: "shared-c" },
    };
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      updatedByOperationId: "placement-orphan",
    };
    const ops = [orphan];
    const db = makeStore(ops, {
      users: { "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a" } } } },
      assignments: { "shared-a/uid-mike": assignment },
    });
    const running = () => ops
      .filter((op) => op.data.status === "running")
      .map((op) => ({ id: op.id, kind: op.data.kind ?? "", input: op.data.input }));
    expect(decideOperationClaim({
      op: queued as never, now: NOW, runningOpsSameKind: running(), pendingOpsSameKind: [],
    }).outcome).toBe("queue");

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 1 });
    expect(orphan.data).toMatchObject({
      status: "failed",
      completedAt: NOW,
      error: expect.stringMatching(/^reaped: controller restarted mid-op/),
      schedulerHandoffReleased: false,
    });
    expect(assignment).toMatchObject({ state: "quiescing", updatedByOperationId: "placement-orphan" });
    expect(decideOperationClaim({
      op: queued as never, now: NOW, runningOpsSameKind: running(), pendingOpsSameKind: [],
    }).outcome).toBe("claim");
  });

  it("leaves a post-cutover orphan to durable restart recovery without reopening its source", async () => {
    const orphan = orphanedPlacement({
      cutoverCommittedAt: BOOTED_AT - 90_000,
      steps: [
        { name: "cutover-firestore", status: "done" },
        { name: "unmount-source", status: "running" },
      ],
    });
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      updatedByOperationId: "placement-orphan",
    };
    const db = makeStore([orphan], {
      users: { "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-b" } } } },
      assignments: { "shared-a/uid-mike": assignment },
    });

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(orphan.data).toMatchObject({
      status: "running",
      cutoverCommittedAt: BOOTED_AT - 90_000,
      schedulerHandoffReleased: false,
    });
    expect(orphan.updated).toBeUndefined();
    expect(assignment.state).toBe("quiescing");
  });

  it("leaves a migration this controller claimed after boot to its live worker", async () => {
    const claimedHere = orphanedPlacement({ startedAt: BOOTED_AT + 1 });
    const db = makeStore([claimedHere]);

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(claimedHere.updated).toBeUndefined();
  });

  it("leaves an orphan this controller re-claims while the recovery transaction is pending", async () => {
    const raced = orphanedPlacement();
    const db = makeStore([raced], { beforeTransaction: () => { raced.data.startedAt = BOOTED_AT + 5; } });

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(raced.data.status).toBe("running");
  });

  it.each<[string, Partial<FakeOpDoc["data"]>]>([
    ["an add-gateway op", { kind: "add-gateway", input: { gatewayId: "shared-a" } }],
    ["a rollout the resume sweep re-drives", { kind: "rollout", input: { gatewayId: "shared-a" } }],
    ["a durable V2 migration", { userMigrationV2: { phase: "checkpointed" } }],
    ["a suspend-customer op", { kind: "suspend-user" }],
  ])("leaves %s to its own restart recovery", async (_label, overrides) => {
    const op = orphanedPlacement(overrides);
    const db = makeStore([op]);

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(op.updated).toBeUndefined();
  });

  function orphanedRetirement(overrides: Partial<FakeOpDoc["data"]> = {}): FakeOpDoc {
    return {
      id: "shared-pool-retire-shared-c39b93f1591e",
      data: {
        kind: "retire-gateway", origin: "automatic", status: "running",
        startedAt: BOOTED_AT - 8 * 60_000,
        lastProgressAt: BOOTED_AT - 60_000,
        input: { gatewayId: "shared-c39b93f1591e", retirementClaimVersion: 1 },
        steps: [
          { name: "helm-uninstall", status: "done" },
          { name: "delete-pvc", status: "done" },
          { name: "delete-kube-secret", status: "done" },
          { name: "delete-sm-secret", status: "running" },
        ],
        ...overrides,
      },
    };
  }

  it("re-arms a retirement the previous controller orphaned mid-teardown so the operation worker re-drives it from the top", async () => {
    const orphan = orphanedRetirement({ error: "delete-sm-secret timed out", expireAt: NOW + 60_000 });
    const log = vi.fn();

    const result = await recover(makeStore([orphan]), log);

    expect(result).toEqual({ scanned: 1, recovered: 1 });
    expect(orphan.data).toMatchObject({
      status: "pending", startedAt: null, completedAt: null, steps: [],
      input: { gatewayId: "shared-c39b93f1591e", retirementClaimVersion: 1 },
    });
    for (const field of ["error", "lastProgressAt", "expireAt"]) {
      expect(orphan.data).not.toHaveProperty(field);
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining("re-armed orphaned shared-pool-retire-shared-c39b93f1591e"));
  });

  it("leaves a retirement this controller claimed after boot to its live worker", async () => {
    const claimedHere = orphanedRetirement({ startedAt: BOOTED_AT + 1 });

    const result = await recover(makeStore([claimedHere]));

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(claimedHere.updated).toBeUndefined();
  });

  it("leaves a retirement this controller re-claims while the recovery transaction is pending", async () => {
    const raced = orphanedRetirement();
    const db = makeStore([raced], { beforeTransaction: () => { raced.data.startedAt = BOOTED_AT + 5; } });

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(raced.data.status).toBe("running");
  });

  it("leaves a level-triggered user return to the resume sweep", async () => {
    const op: FakeOpDoc = {
      id: "builder-return-builder-alice-g1",
      data: {
        kind: "migrate-user", origin: "automatic", status: "running",
        startedAt: BOOTED_AT - 60_000,
        input: { uid: "alice", source: "builder-activation-lease", fromGatewayId: "builder-alice" },
      },
    };

    const result = await recover(makeStore([op]));

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(op.updated).toBeUndefined();
  });
});
