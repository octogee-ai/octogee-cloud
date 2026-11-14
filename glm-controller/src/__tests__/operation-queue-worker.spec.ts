import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLM_OPERATIONS_COLLECTION, type Operation, type OperationAttemptRecord } from "@octogee/shared/types/glm";
import {
  drainPendingOperationsOnce,
  processOperation,
  reAdoptAndRunOperation,
  startOperationWorker,
  startOperationQueueDrain,
  OPERATION_QUEUE_DRAIN_MS_DEFAULT,
} from "../index";
import type { OperationHandler, OperationHandlers } from "../operation-router";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { MissingRecordError, type PlatformStateStore, type WatchEvent, type WatchListener } from "@octogee/core/platform-state";
import { resumeOrphanedRunningOps } from "../resume-orphaned-ops.js";
import { operationNeedsDurableRestartResume } from "../operation-retry.js";

type Rows = Record<string, Record<string, unknown>>;

function createOperationsFixture(
  initial: Rows,
  opts: { gateways?: Rows; runtimes?: Rows; users?: Rows; documents?: Rows } = {},
) {
  const writeLog: Array<{ id: string; data: Record<string, unknown> }> = [];
  const recording = { enabled: false };
  class RecordingDocuments extends Map<string, Record<string, unknown>> {
    override set(path: string, row: Record<string, unknown>): this {
      if (recording.enabled && path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`)) {
        writeLog.push({ id: path.slice(GLM_OPERATIONS_COLLECTION.length + 1), data: row });
      }
      return super.set(path, row);
    }
  }
  const documents = new RecordingDocuments([
    ...Object.entries(initial).map(([id, row]) => [`${GLM_OPERATIONS_COLLECTION}/${id}`, row] as const),
    ...Object.entries(opts.gateways ?? {}).map(([id, row]) => [`gateways/${id}`, {
      desiredStatus: "running", desiredRelease: 1, latestRelease: 1, liveRelease: 1, ...row,
    }] as const),
    ...Object.entries(opts.runtimes ?? {}).map(([id, row]) => [`glmGateways/${id}`, {
      docKind: "runtime", gatewayId: id, release: 1, lifecycle: "active", ...row,
    }] as const),
    ...Object.entries(opts.users ?? {}).map(([uid, row]) => [`users/${uid}`, row] as const),
    ...Object.entries(opts.documents ?? {}),
  ]);
  recording.enabled = true;
  const listeners: Array<WatchListener<"operations">> = [];
  const watchRequests: unknown[] = [];
  let closedWatches = 0;
  const fixture = createDocumentFixtureStore(documents);
  const db = new Proxy(fixture, {
    get: (target, property, receiver) => property === "watch"
      ? (request: unknown, listener: WatchListener<"operations">) => {
        watchRequests.push(request);
        listeners.push(listener);
        return { closed: Promise.resolve(), close: async () => { closedWatches += 1; } };
      }
      : Reflect.get(target, property, receiver),
  });
  const store = {
    get: (id: string) => documents.get(`${GLM_OPERATIONS_COLLECTION}/${id}`),
    set: (id: string, row: Record<string, unknown>) => documents.set(`${GLM_OPERATIONS_COLLECTION}/${id}`, row),
  };
  const emit = async (event: WatchEvent<"operations">) => {
    for (const listener of listeners) await listener.onEvent(event);
  };
  return { db, store, documents, writeLog, emit, watchRequests, closedWatches: () => closedWatches };
}

function baseOp(overrides: Partial<Operation> & { id: string }): Record<string, unknown> {
  return {
    kind: "rollout",
    status: "pending",
    createdBy: "admin",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: {},
    steps: [],
    ...overrides,
  };
}

function buildDeps(
  store: PlatformStateStore,
  handlers: Partial<OperationHandlers>,
): Parameters<typeof drainPendingOperationsOnce>[0] {
  return {
    store,
    handlers: handlers as OperationHandlers,
    log: () => undefined,
  } as unknown as Parameters<typeof drainPendingOperationsOnce>[0];
}

describe("gateway operation queue — enqueue instead of reject (glmOperations wiring)", () => {
  it.each(["wake", "idle return"] as const)("lets a target rollout release a compatibility-blocked %s", async direction => {
    const wake = direction === "wake";
    const fromGatewayId = wake ? "shared-a" : "builder-a", toGatewayId = wake ? "builder-a" : "shared-a";
    const migrationId = wake ? "builder-activate-builder-a-g2" : "builder-return-builder-a-g2";
    const waiting = baseOp({ id: migrationId, kind: "migrate-user", origin: "automatic", createdAt: 1,
      input: { uid: "alice", source: "builder-activation-lease", fromGatewayId, toGatewayId },
      output: { gatewayCompatibilityPending: true } });
    const rollout = baseOp({ id: "target-roll", origin: "operator", createdAt: 2, input: { gatewayId: toGatewayId } });
    const events: string[] = [];
    const { db, store } = createOperationsFixture({ [migrationId]: waiting, "target-roll": rollout }, {
      gateways: { "builder-a": { gatewayId: "builder-a", gatewayClass: "isolated" }, "shared-a": { gatewayId: "shared-a", gatewayClass: "shared" } },
      runtimes: { "builder-a": { runtime: "cluster" }, "shared-a": { runtime: "cluster" } },
    });
    const deps = buildDeps(db, {
      rollout: async () => { events.push("rollout"); return { success: true, steps: [] }; },
      "migrate-user": async () => { events.push("migration"); return { success: true, steps: [] }; },
    });
    await processOperation(waiting as unknown as Operation, deps);
    expect(events).toEqual([]);
    expect(store.get(migrationId)?.status).toBe("pending");
    await processOperation(rollout as unknown as Operation, deps);
    await processOperation(waiting as unknown as Operation, deps);
    expect(events).toEqual(["rollout", "migration"]);
  });

  it("rolls a user ahead of its untouched idle return blocked by another Shared migration", async () => {
    const returnId = "builder-return-builder-a-g2";
    const blockedReturn = baseOp({ id: returnId, kind: "migrate-user", origin: "automatic",
      createdBy: "glm-controller-placement-policy", createdAt: 2,
      input: { uid: "alice", userSlug: "alice", source: "builder-activation-lease", fromGatewayId: "builder-a", toGatewayId: "shared-target" } });
    const olderMigration = baseOp({ id: "older-shared-move", kind: "migrate-user", createdAt: 1,
      nextAttemptAt: Date.now() + 60_000, input: { fromGatewayId: "shared-source", toGatewayId: "shared-target" } });
    const rollout = baseOp({ id: "operator-roll", origin: "operator", createdAt: 3, input: { gatewayId: "builder-a" } });
    const handler: OperationHandler = vi.fn(async () => ({ success: true, steps: [] }));
    const { db, store } = createOperationsFixture({ [returnId]: blockedReturn, "older-shared-move": olderMigration, "operator-roll": rollout }, {
      gateways: { "builder-a": { gatewayId: "builder-a", gatewayClass: "isolated" } },
      runtimes: { "builder-a": { runtime: "cluster" } },
    });

    await processOperation(rollout as unknown as Operation, buildDeps(db, { rollout: handler }));

    expect(handler).toHaveBeenCalledOnce();
    expect(store.get("operator-roll")?.status).toBe("succeeded");
    expect(store.get(returnId)).toEqual(blockedReturn);
    expect(store.get("older-shared-move")).toEqual(olderMigration);
  });

  it("runs the older return when an intervening Shared rollout blocks the operator user roll", async () => {
    const returnId = "builder-return-builder-a-g2";
    const returning = baseOp({ id: returnId, kind: "migrate-user", origin: "automatic", createdAt: 1,
      input: { source: "builder-activation-lease", fromGatewayId: "builder-a", toGatewayId: "shared-target" } });
    const sharedRoll = baseOp({ id: "shared-roll", createdAt: 2, input: { gatewayId: "shared-target" } });
    const userRoll = baseOp({ id: "user-roll", origin: "operator", createdAt: 3, input: { gatewayId: "builder-a" } });
    const handler: OperationHandler = vi.fn(async () => ({ success: true, steps: [] }));
    const { db, store } = createOperationsFixture({ [returnId]: returning, "shared-roll": sharedRoll, "user-roll": userRoll }, {
      gateways: { "builder-a": { gatewayId: "builder-a", gatewayClass: "isolated" }, "shared-target": { gatewayId: "shared-target", gatewayClass: "shared" } },
      runtimes: { "builder-a": { runtime: "cluster" }, "shared-target": { runtime: "cluster" } },
    });

    await processOperation(returning as unknown as Operation, buildDeps(db, { "migrate-user": handler }));

    expect(handler).toHaveBeenCalledOnce();
    expect(store.get(returnId)?.status).toBe("succeeded");
    expect(store.get("shared-roll")).toEqual(sharedRoll);
    expect(store.get("user-roll")).toEqual(userRoll);
  });

  it.each([
    { name: "running return", returning: { status: "running", startedAt: 10 } },
    { name: "earlier claim", returning: { firstStartedAt: 10 } },
    { name: "prior attempt", returning: { attempts: 1, attemptHistory: [{ attempt: 1 }] } },
    { name: "source step", returning: { steps: [{ name: "quiesce-source", status: "done" }] } },
    { name: "transfer dispatch", returning: { sourceTransferExecution: { status: "dispatched" } } },
    { name: "scheduler custody", returning: { schedulerHandoff: { migrationId: "original" } } },
    { name: "released scheduler custody", returning: { schedulerHandoffReleased: true } },
    { name: "migration state", returning: { userMigrationV2: { phase: "initialized" } } },
    { name: "cancellation", returning: { cancellationRequestedAt: 10 } },
    { name: "retained output", returning: { output: { configCleanup: { migrationId: "original" } } } },
    { name: "automatic rollout", rollout: { origin: "automatic" } },
    { name: "Shared target rollout", rollout: { input: { gatewayId: "shared-target" } } },
  ])("keeps queue exclusion for $name", async ({ returning, rollout }) => {
    const returnId = "builder-return-builder-a-g2";
    const blockedReturn = { ...baseOp({ id: returnId, kind: "migrate-user", origin: "automatic", createdAt: 1,
      input: { source: "builder-activation-lease", fromGatewayId: "builder-a", toGatewayId: "shared-target" } }), ...returning };
    const queuedRoll = { ...baseOp({ id: "operator-roll", origin: "operator", createdAt: 2, input: { gatewayId: "builder-a" } }), ...rollout };
    const handler: OperationHandler = vi.fn(async () => ({ success: true, steps: [] }));
    const { db, store } = createOperationsFixture({ [returnId]: blockedReturn, "operator-roll": queuedRoll });

    await processOperation(queuedRoll as unknown as Operation, buildDeps(db, { rollout: handler }));

    expect(handler).not.toHaveBeenCalled();
    expect(store.get("operator-roll")?.status).toBe("pending");
    expect(store.get(returnId)).toEqual(blockedReturn);
  });

  it("does not execute an audit record from a pending scan or snapshot", async () => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const audit = {
      recordType: "audit",
      status: "recorded",
      actor: "operator",
      createdAt: 1,
    };
    const { db, store } = createOperationsFixture({ "audit-pending": audit });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: rolloutHandler }));
    await processOperation({ ...audit, id: "audit-pending" } as never, buildDeps(db, { rollout: rolloutHandler }));

    expect(rolloutHandler).not.toHaveBeenCalled();
    expect(store.get("audit-pending")?.status).toBe("recorded");
  });

  it("does not let an audit-shaped row participate in serial command conflicts", async () => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "audit-running": {
        recordType: "audit",
        status: "running",
        kind: "rollout",
        createdAt: 1,
      },
      "op-rollout": baseOp({ id: "op-rollout", createdAt: 2, input: { gatewayId: "walter" } }),
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: rolloutHandler }));

    expect(rolloutHandler).toHaveBeenCalledOnce();
    expect(store.get("op-rollout")?.status).toBe("succeeded");
    expect(store.get("audit-running")?.status).toBe("running");
  });

  it("admits a pending durable cleanup retry while release admission drains", async () => {
    const migrationHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "op-cleanup": baseOp({
        id: "op-cleanup",
        kind: "migrate-user",
        createdAt: 1,
        output: { configCleanup: { migrationId: "migration-1" } },
      }),
    });
    const deps = buildDeps(db, { "migrate-user": migrationHandler });
    (deps as unknown as { releaseAdmissionGate: unknown }).releaseAdmissionGate = {
      stateInTransaction: async () => ({ draining: true, releaseId: "candidate", reason: "deploy" }),
    };

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-cleanup")?.status).toBe("succeeded");
    expect(migrationHandler).toHaveBeenCalledOnce();
  });

  it("queues a second rollout op instead of failing it while an earlier one is running, then admits it once the first finishes", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const rolloutHandler: OperationHandler = vi.fn(async (op) => {
      if (op.id === "op-walter") {
        await firstGate;
        return { steps: [], success: true };
      }
      return { steps: [], success: true };
    });

    const { db, store } = createOperationsFixture({
      "op-walter": baseOp({ id: "op-walter", createdAt: 1, input: { gatewayId: "walter-blue" } }),
    });
    const deps = buildDeps(db, { rollout: rolloutHandler });

    const firstDrain = drainPendingOperationsOnce(deps);
    // Let op-walter's claim transaction commit and its handler start (and
    // suspend on firstGate) before the second gateway's roll is requested —
    // matching the real sequence: walter-blue's roll is already running when
    // default-green is clicked. A macrotask tick drains every microtask the
    // fake-Firestore claim path schedules.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("op-walter")?.status).toBe("running");

    store.set(
      "op-default",
      baseOp({ id: "op-default", createdAt: 2, input: { gatewayId: "default-green" } }),
    );

    await drainPendingOperationsOnce(deps);

    const queued = store.get("op-default");
    expect(queued?.status).toBe("pending");
    expect(queued?.waitingOn).toBe("roll walter-blue");
    expect(queued?.error).toBeUndefined();

    releaseFirst();
    await firstDrain;
    expect(store.get("op-walter")?.status).toBe("succeeded");

    await drainPendingOperationsOnce(deps);
    expect(store.get("op-default")?.status).toBe("succeeded");
    expect(store.get("op-default")?.waitingOn).toBeUndefined();
  });

  it("runs a Shared rollout while an unrelated gateway VM rollout is blocked", async () => {
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "vm-roll": baseOp({ id: "vm-roll", status: "running", input: { gatewayId: "sep092" } }),
      "shared-roll": baseOp({ id: "shared-roll", createdAt: 2, input: { gatewayId: "shared-0" } }),
    }, {
      gateways: {
        sep092: { gatewayId: "sep092", gatewayClass: "isolated" },
        "shared-0": { gatewayId: "shared-0", gatewayClass: "shared" },
      },
      runtimes: { sep092: { runtime: "gce-vm" }, "shared-0": { runtime: "cluster" } },
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));

    expect(store.get("vm-roll")?.status).toBe("running");
    expect(store.get("shared-roll")?.status).toBe("succeeded");
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ["another Shared", "shared-1", "shared", "cluster", "roll shared-0"],
    ["another isolated VM", "builder-2", "isolated", "gce-vm", "roll builder-1"],
    ["an isolated gateway on Kubernetes", "builder-2", "isolated", "cluster", "roll shared-0"],
  ] as const)("queues %s rollout when both rollout lanes are occupied", async (_name, gatewayId, gatewayClass, runtime, waitingOn) => {
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "vm-roll": baseOp({ id: "vm-roll", status: "running", input: { gatewayId: "builder-1" } }),
      "shared-roll": baseOp({ id: "shared-roll", status: "running", input: { gatewayId: "shared-0" } }),
      "next-roll": baseOp({ id: "next-roll", createdAt: 2, input: { gatewayId } }),
    }, {
      gateways: {
        "builder-1": { gatewayId: "builder-1", gatewayClass: "isolated" },
        "shared-0": { gatewayId: "shared-0", gatewayClass: "shared" },
        [gatewayId]: { gatewayId, gatewayClass },
      },
      runtimes: {
        "builder-1": { runtime: "gce-vm" }, "shared-0": { runtime: "cluster" }, [gatewayId]: { runtime },
      },
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));

    expect(store.get("next-roll")?.status).toBe("pending");
    expect(store.get("next-roll")?.waitingOn).toBe(waitingOn);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["missing root", undefined, { runtime: "gce-vm" }],
    ["wrong root identity", { gatewayId: "other", gatewayClass: "isolated" }, { runtime: "gce-vm" }],
    ["missing runtime", { gatewayId: "builder", gatewayClass: "isolated" }, undefined],
    ["unstamped runtime", { gatewayId: "builder", gatewayClass: "isolated" }, {}],
    ["unknown class", { gatewayId: "builder", gatewayClass: "other" }, { runtime: "gce-vm" }],
    ["Shared VM mismatch", { gatewayId: "builder", gatewayClass: "shared" }, { runtime: "gce-vm" }],
  ] as const)("keeps an unclassified %s rollout globally exclusive", async (_name, root, runtime) => {
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "vm-roll": {
        ...baseOp({ id: "vm-roll", status: "running", input: { gatewayId: "builder", rolloutLane: "builder-vm" } }),
        rolloutLane: "builder-vm",
      },
      "shared-roll": baseOp({ id: "shared-roll", createdAt: 2, input: { gatewayId: "shared-0" } }),
    }, {
      gateways: { "shared-0": { gatewayId: "shared-0", gatewayClass: "shared" }, ...(root ? { user: root } : {}) },
      runtimes: { "shared-0": { runtime: "cluster" }, ...(runtime ? { user: runtime } : {}) },
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));

    expect(store.get("shared-roll")?.status).toBe("pending");
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves an older return reservation while allowing a disjoint rollout", async () => {
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "vm-roll": baseOp({ id: "vm-roll", status: "running", input: { gatewayId: "builder" } }),
      "return": baseOp({
        id: "return", kind: "migrate-user", createdAt: 1, nextAttemptAt: Date.now() + 60_000,
        input: { fromGatewayId: "builder", toGatewayId: "shared-0" },
      }),
      "shared-roll": baseOp({ id: "shared-roll", createdAt: 2, input: { gatewayId: "shared-0" } }),
      "other-shared-roll": baseOp({ id: "other-shared-roll", createdAt: 0, input: { gatewayId: "shared-1" } }),
    }, {
      gateways: {
        builder: { gatewayId: "builder", gatewayClass: "isolated" },
        "shared-0": { gatewayId: "shared-0", gatewayClass: "shared" },
        "shared-1": { gatewayId: "shared-1", gatewayClass: "shared" },
      },
      runtimes: { builder: { runtime: "gce-vm" }, "shared-0": { runtime: "cluster" }, "shared-1": { runtime: "cluster" } },
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));

    expect(store.get("shared-roll")?.status).toBe("pending");
    expect(store.get("shared-roll")?.waitingOn).toBe("migration builder → shared-0");
    expect(store.get("other-shared-roll")?.status).toBe("succeeded");
  });

  it("never marks a queued op failed — it stays pending the whole time it waits", async () => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "op-running": { ...baseOp({ id: "op-running", createdAt: 1 }), status: "running" },
      "op-queued": baseOp({ id: "op-queued", createdAt: 2, input: { gatewayId: "default-green" } }),
    });
    const deps = buildDeps(db, { rollout: rolloutHandler });

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-queued")?.status).toBe("pending");
    expect(rolloutHandler).not.toHaveBeenCalled();
  });

  it("queues a migrate-customer op behind another one targeting the SAME gateway, but admits one to a DIFFERENT target immediately", async () => {
    const migrateHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "op-running": {
        ...baseOp({
          id: "op-running",
          kind: "migrate-user",
          createdAt: 1,
          input: { fromGatewayId: "gw-blue", toGatewayId: "gw-green" },
        }),
        status: "running",
      },
      "op-same-target": baseOp({
        id: "op-same-target",
        kind: "migrate-user",
        createdAt: 2,
        input: { toGatewayId: "gw-green" },
      }),
      "op-other-target": baseOp({
        id: "op-other-target",
        kind: "migrate-user",
        createdAt: 3,
        input: { toGatewayId: "gw-purple" },
      }),
    });
    const deps = buildDeps(db, { "migrate-user": migrateHandler });

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-same-target")?.status).toBe("pending");
    expect(store.get("op-same-target")?.waitingOn).toBe("migration gw-blue → gw-green");
    expect(store.get("op-other-target")?.status).toBe("succeeded");
    expect(migrateHandler).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "rollout begins on migration source",
      {
        running: { kind: "migrate-user", input: { fromGatewayId: "source", toGatewayId: "target" } },
        pending: { kind: "rollout", input: { gatewayId: "source" } },
      },
    ],
    [
      "rollout begins on migration target",
      {
        running: { kind: "migrate-user", input: { fromGatewayId: "source", toGatewayId: "target" } },
        pending: { kind: "rollout", input: { gatewayId: "target" } },
      },
    ],
    [
      "migration begins during source rollout",
      {
        running: { kind: "rollout", input: { gatewayId: "source" } },
        pending: { kind: "migrate-user", input: { fromGatewayId: "source", toGatewayId: "target" } },
      },
    ],
    [
      "migration begins during target rollout",
      {
        running: { kind: "rollout", input: { gatewayId: "target" } },
        pending: { kind: "migrate-user", input: { fromGatewayId: "source", toGatewayId: "target" } },
      },
    ],
  ] as const)("serializes cross-protocol conflict: %s", async (_name, fixture) => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const migrateHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "op-running": {
        ...baseOp({
          id: "op-running",
          kind: fixture.running.kind,
          createdAt: 1,
          input: fixture.running.input,
        }),
        status: "running",
      },
      "op-pending": baseOp({
        id: "op-pending",
        kind: fixture.pending.kind,
        createdAt: 2,
        input: fixture.pending.input,
      }),
    });
    const deps = buildDeps(db, {
      rollout: rolloutHandler,
      "migrate-user": migrateHandler,
    });

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-pending")?.status).toBe("pending");
    expect(rolloutHandler).not.toHaveBeenCalled();
    expect(migrateHandler).not.toHaveBeenCalled();
  });
});

describe("gateway operation queue — FIFO per scope across the fast path", () => {
  it("a NEW rollout arriving via the fast path after the blocker completed queues behind the older queued op; the drain then claims the old one first", async () => {
    const claimedOrder: string[] = [];
    const rolloutHandler: OperationHandler = vi.fn(async (op) => {
      claimedOrder.push(op.id);
      return { steps: [], success: true };
    });
    const { db, store } = createOperationsFixture({
      "op-done": {
        ...baseOp({ id: "op-done", createdAt: 1, input: { gatewayId: "canary" } }),
        status: "succeeded",
        completedAt: 10,
      },
      "op-old": {
        ...baseOp({ id: "op-old", createdAt: 2, input: { gatewayId: "walter-blue" } }),
        waitingOn: "canary → canary-blue",
      },
    });
    const deps = buildDeps(db, { rollout: rolloutHandler });

    store.set(
      "op-new",
      baseOp({ id: "op-new", createdAt: 3, input: { gatewayId: "default-green" } }),
    );
    await processOperation(
      { ...(store.get("op-new") as unknown as Operation), id: "op-new" },
      deps,
    );

    expect(rolloutHandler).not.toHaveBeenCalled();
    expect(store.get("op-new")?.status).toBe("pending");
    expect(store.get("op-new")?.waitingOn).toBe("roll walter-blue");

    await drainPendingOperationsOnce(deps);

    expect(claimedOrder).toEqual(["op-old", "op-new"]);
    expect(store.get("op-old")?.status).toBe("succeeded");
    expect(store.get("op-new")?.status).toBe("succeeded");
  });

  it("clears nextAttemptAt when claiming so a running doc never carries stale backoff state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: OperationHandler = vi.fn(async () => {
      await gate;
      return { steps: [], success: true };
    });
    const { db, store } = createOperationsFixture({
      "op-retry": {
        ...baseOp({ id: "op-retry", createdAt: 1, input: { gatewayId: "walter-blue" } }),
        attempts: 1,
        nextAttemptAt: 1,
      },
    });
    const deps = buildDeps(db, { rollout: handler });

    const drain = drainPendingOperationsOnce(deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get("op-retry")?.status).toBe("running");
    expect(store.get("op-retry")?.nextAttemptAt).toBeUndefined();

    release();
    await drain;
    expect(store.get("op-retry")?.status).toBe("succeeded");
  });
});

describe("gateway operation queue — automatic retry with backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([1_010_000, 1_031_000])("moves a rolled-back failure behind queued users at %i", async (retryAt) => {
    vi.setSystemTime(1_000_000);
    const calls: string[] = [];
    let failed = false;
    const handler: OperationHandler = vi.fn(async (op) => {
      calls.push(op.id);
      if (op.id === "retry" && !failed) {
        failed = true;
        return { steps: [], success: false, error: "runtime-update timed out", rolledBack: true };
      }
      return { steps: [], success: true };
    });
    const { db, store } = createOperationsFixture({
      retry: baseOp({ id: "retry", kind: "migrate-user", createdAt: 1,
        input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" } }),
      healthy: baseOp({ id: "healthy", kind: "migrate-user", createdAt: 2,
        input: { uid: "bob", fromGatewayId: "shared-a", toGatewayId: "shared-b" } }),
    });
    const deps = buildDeps(db, { "migrate-user": handler });
    await processOperation({ ...store.get("retry"), id: "retry" } as unknown as Operation, deps);
    expect(store.get("retry")).toMatchObject({ status: "pending", createdAt: 1, queuedAt: 1_000_000 });
    vi.setSystemTime(retryAt);
    await drainPendingOperationsOnce(deps);
    expect(calls.slice(0, 2)).toEqual(["retry", "healthy"]);
    expect(store.get("healthy")?.status).toBe("succeeded");
    vi.setSystemTime(1_032_000);
    await drainPendingOperationsOnce(deps);
    expect(calls).toEqual(["retry", "healthy", "retry"]);
    expect(store.get("retry")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(store.get("retry")?.queuedAt).toBeUndefined();
  });

  it("admits new snapshot work while a rolled-back migration backs off", async () => {
    vi.setSystemTime(1_010_000);
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      retry: baseOp({ id: "retry", kind: "migrate-user", createdAt: 1, queuedAt: 1_000_000,
        nextAttemptAt: 1_030_000, input: { uid: "alice", toGatewayId: "shared-b" } }),
      newcomer: baseOp({ id: "newcomer", kind: "migrate-user", createdAt: 1_005_000,
        input: { uid: "bob", toGatewayId: "shared-b" } }),
    });
    await processOperation({ ...store.get("newcomer"), id: "newcomer" } as unknown as Operation, buildDeps(db, { "migrate-user": handler }));
    expect(handler).toHaveBeenCalledOnce();
    expect(store.get("newcomer")?.status).toBe("succeeded");
    expect(store.get("retry")?.status).toBe("pending");
  });

  it("requeues a transient failure with backoff and attempts, then succeeds once the backoff elapses", async () => {
    vi.setSystemTime(1_000_000);
    let calls = 0;
    const handler: OperationHandler = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" };
      }
      return { steps: [], success: true };
    });
    const { db, store } = createOperationsFixture({
      "op-migrate": baseOp({ id: "op-migrate", kind: "migrate-user", createdAt: 1 }),
    });
    const deps = buildDeps(db, { "migrate-user": handler });

    await drainPendingOperationsOnce(deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.get("op-migrate")?.status).toBe("pending");
    expect(store.get("op-migrate")?.attempts).toBe(1);
    expect(store.get("op-migrate")?.firstStartedAt).toBe(1_000_000);
    expect(store.get("op-migrate")?.startedAt).toBeNull();
    expect(store.get("op-migrate")?.nextAttemptAt).toBe(1_000_000 + 30_000);

    // Backoff hasn't elapsed — the drain must not re-invoke the handler yet.
    vi.setSystemTime(1_000_000 + 10_000);
    await drainPendingOperationsOnce(deps);
    expect(handler).toHaveBeenCalledTimes(1);

    // Backoff elapsed — the drain retries and this attempt succeeds.
    vi.setSystemTime(1_000_000 + 31_000);
    await drainPendingOperationsOnce(deps);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.get("op-migrate")?.status).toBe("succeeded");
    expect(store.get("op-migrate")?.attempts).toBe(2);
    expect(store.get("op-migrate")?.firstStartedAt).toBe(1_000_000);
    expect(store.get("op-migrate")?.startedAt).toBe(1_031_000);
  });

  it("counts a give's readiness checks across worker passes without spending its attempts, then retries a transient failure", async () => {
    vi.setSystemTime(1_000_000);
    const notLive = "placement rejected for lin-s-0a1b2c3d: no-live-revision";
    const answers = [notLive, notLive, notLive, "connect ECONNREFUSED 10.0.0.1:443"];
    const handler: OperationHandler = vi.fn(async () => {
      const error = answers.shift();
      return error ? { steps: [], success: false, error } : { steps: [], success: true };
    });
    const { db, store } = createOperationsFixture({
      "op-give": baseOp({ id: "op-give", kind: "migrate-user", createdAt: 1, input: {
        uid: "uid-lin", fromGatewayId: "shared-a", toGatewayId: "lin-s-0a1b2c3d", source: "operator-isolated-gateway",
      } }),
    });
    const deps = buildDeps(db, { "migrate-user": handler });

    for (const check of [1, 2, 3]) {
      await drainPendingOperationsOnce(deps);
      expect(store.get("op-give")).toMatchObject({ status: "pending", output: { isolatedGatewayReadinessChecks: check } });
      expect(store.get("op-give")?.attempts ?? 0).toBe(0);
      vi.setSystemTime(Date.now() + 61_000);
    }

    await drainPendingOperationsOnce(deps);
    expect(store.get("op-give")).toMatchObject({ status: "pending", attempts: 1 });

    vi.setSystemTime(Date.now() + 31_000);
    await drainPendingOperationsOnce(deps);
    expect(store.get("op-give")).toMatchObject({ status: "succeeded" });
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it("fails a terminal (validation) error immediately with no retry", async () => {
    vi.setSystemTime(1_000_000);
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "missing gatewayId in op.input",
    }));
    const { db, store } = createOperationsFixture({
      "op-bad": baseOp({ id: "op-bad", kind: "add-gateway", createdAt: 1 }),
    });
    const deps = buildDeps(db, { "add-gateway": handler });

    await drainPendingOperationsOnce(deps);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.get("op-bad")?.status).toBe("failed");
    expect(store.get("op-bad")?.error).toBe("missing gatewayId in op.input");
    expect(store.get("op-bad")?.attempts).toBe(1);
  });

  it("releases a scope-blocked rollout immediately so the next Shared rollout can run", async () => {
    vi.setSystemTime(1_000_000);
    const error = "VM sep092: identity scopes are outdated; pause and resume the gateway through Admin to repair them";
    const handler: OperationHandler = vi.fn(async (op) => op.id === "op-user"
      ? { steps: [], success: false, error }
      : { steps: [], success: true });
    const { db, store } = createOperationsFixture({
      "op-user": baseOp({ id: "op-user", kind: "rollout", createdAt: 1, input: { gatewayId: "sep092" } }),
      "op-shared": baseOp({ id: "op-shared", kind: "rollout", createdAt: 2, input: { gatewayId: "shared-0" } }),
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));

    expect(store.get("op-user")).toMatchObject({ status: "failed", attempts: 1, completedAt: 1_000_000, error });
    expect(store.get("op-user")?.nextAttemptAt).toBeUndefined();
    expect(store.get("op-shared")?.status).toBe("succeeded");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(1_000_000);
  });

  it("stops retrying and fails terminally once the attempt cap is reached, even for a transient cause", async () => {
    vi.setSystemTime(1_000_000);
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "connect ECONNREFUSED 10.0.0.1:443",
    }));
    const { db, store } = createOperationsFixture({
      "op-flaky": baseOp({ id: "op-flaky", kind: "restart-gateway", createdAt: 1 }),
    });
    const deps = buildDeps(db, { "restart-gateway": handler });

    await drainPendingOperationsOnce(deps);
    vi.setSystemTime(1_000_000 + 31_000);
    await drainPendingOperationsOnce(deps);
    vi.setSystemTime(1_000_000 + 31_000 + 121_000);
    await drainPendingOperationsOnce(deps);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(store.get("op-flaky")?.status).toBe("failed");
    expect(store.get("op-flaky")?.attempts).toBe(3);
    expect((store.get("op-flaky")?.attemptHistory as unknown[]).length).toBe(3);
  });

  it.each([
    "/restore/default transport failed: fetch failed",
    "10 ABORTED: Too much contention on these documents. Please try again.",
  ])("keeps an automatic user return pending beyond the generic cap after %s", async (error) => {
    vi.setSystemTime(1_000_000);
    const handler: OperationHandler = vi.fn(async () => { throw new Error(error); });
    const priorAttempts: OperationAttemptRecord[] = [
      { attempt: 1, startedAt: 1, completedAt: 2, error: "fetch failed", classification: "transient", steps: [] },
      { attempt: 2, startedAt: 3, completedAt: 4, error: "fetch failed", classification: "transient", steps: [] },
      { attempt: 3, startedAt: 5, completedAt: 6, error: "fetch failed", classification: "transient", steps: [] },
    ];
    const { db, store } = createOperationsFixture({
      "builder-return-run-alice-g1": baseOp({
        id: "builder-return-run-alice-g1",
        kind: "migrate-user",
        origin: "automatic",
        createdAt: 1,
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
          toGatewayId: "default",
        },
        attempts: 3,
        attemptHistory: priorAttempts,
      }),
    });
    const deps = buildDeps(db, { "migrate-user": handler });

    await drainPendingOperationsOnce(deps);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.get("builder-return-run-alice-g1")?.status).toBe("pending");
    expect(store.get("builder-return-run-alice-g1")?.attempts).toBe(4);
    expect(store.get("builder-return-run-alice-g1")?.nextAttemptAt).toBe(1_000_000 + 480_000);
    expect((store.get("builder-return-run-alice-g1")?.attemptHistory as unknown[]).length).toBe(4);
  });
});

describe("startOperationQueueDrain", () => {
  it("ticks on the configured interval and can be stopped", async () => {
    vi.useFakeTimers();
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "op-1": baseOp({ id: "op-1", createdAt: 1 }),
    });
    const deps = buildDeps(db, { rollout: handler });

    const stop = startOperationQueueDrain(deps, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.get("op-1")?.status).toBe("succeeded");

    stop();
    store.set("op-2", baseOp({ id: "op-2", createdAt: 2 }));
    await vi.advanceTimersByTimeAsync(OPERATION_QUEUE_DRAIN_MS_DEFAULT * 2);
    expect(store.get("op-2")?.status).toBe("pending");

    vi.useRealTimers();
  });
});

describe("queue drain — composite-index-free FIFO", () => {
  it("drains pending ops in createdAt order from the unordered pending listing", async () => {
    const { db } = createOperationsFixture({
      "op-c": baseOp({ id: "op-c", createdAt: 30 }),
      "op-a": baseOp({ id: "op-a", createdAt: 10 }),
      "op-b": baseOp({ id: "op-b", createdAt: 20 }),
    });
    const order: string[] = [];
    const handler: OperationHandler = vi.fn(async (op) => {
      order.push(op.id);
      return { steps: [], success: true };
    });
    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));
    expect(order).toEqual(["op-a", "op-b", "op-c"]);
  });
});

describe("completion bookkeeping reads the fresh doc, not the caller's snapshot", () => {
  it("re-adopts a committed migration and completes its persisted handoff through the boot sweep", async () => {
    const schedulerHandoff = { uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "alice-user",
      migrationId: "migration:scheduler:1:claim:100", stageAfterCutover: true as const };
    const original = baseOp({ id: "committed-migration", kind: "migrate-user", status: "running", startedAt: 100,
      input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "alice-user" }, schedulerHandoff,
      cutoverCommittedAt: 200 });
    const { db, store } = createOperationsFixture({ "committed-migration": original });
    const handler: OperationHandler = vi.fn(async op => {
      expect(op.schedulerHandoff).toEqual(schedulerHandoff);
      expect(op.cutoverCommittedAt).toBe(200);
      expect(op.resumeCount).toBe(1);
      expect(op.startedAt).toBeGreaterThan(100);
      return { steps: [], success: true };
    });
    const deps = buildDeps(db, { "migrate-user": handler });
    expect(await resumeOrphanedRunningOps({ store: createDocumentFixtureStore({ "glmOperations/committed-migration": original }), log: vi.fn(),
      resumableKinds: new Set(["migrate-user"]), resumableOperation: operationNeedsDurableRestartResume,
      redrive: (op) => reAdoptAndRunOperation(op, deps),
    })).toEqual({ scanned: 1, resumed: 1 });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.get("committed-migration")).toMatchObject({ status: "succeeded", schedulerHandoff, cutoverCommittedAt: 200 });
  });

  it("preserves an explicit first start when claiming a pre-started pending operation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_100_000);
    const { db, store } = createOperationsFixture({
      "op-prestarted": baseOp({
        id: "op-prestarted", createdAt: 1_000_000,
        startedAt: 1_000_000, firstStartedAt: 1_000_000,
      }),
    });
    await drainPendingOperationsOnce(buildDeps(db, {
      rollout: vi.fn(async () => ({ steps: [], success: true })),
    }));
    expect(store.get("op-prestarted")).toMatchObject({
      status: "succeeded", startedAt: 1_100_000, firstStartedAt: 1_000_000,
    });
    vi.restoreAllMocks();
  });

  it("discards the original worker's completion after a controller resume", async () => {
    let finishOriginal!: () => void;
    let claimed!: () => void;
    const blocked = new Promise<void>((resolve) => { finishOriginal = resolve; });
    const claimObserved = new Promise<void>((resolve) => { claimed = resolve; });
    const handler: OperationHandler = vi.fn()
      .mockImplementationOnce(async () => {
        claimed();
        await blocked;
        return { steps: [], success: false, error: "old worker failed" };
      })
      .mockResolvedValueOnce({ steps: [], success: true });
    const initial = baseOp({ id: "op-fenced", createdAt: 1 });
    const { db, store } = createOperationsFixture({ "op-fenced": initial });
    const deps = buildDeps(db, { rollout: handler });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const original = processOperation(initial as unknown as Operation, deps);
    await claimObserved;
    clock.mockReturnValue(1_100_000);
    await reAdoptAndRunOperation(store.get("op-fenced") as unknown as Operation, deps);
    finishOriginal();
    await original;
    expect(store.get("op-fenced")).toMatchObject({
      status: "succeeded", firstStartedAt: 1_000_000, startedAt: 1_100_000,
      lastResumedAt: 1_100_000, resumeCount: 1, attempts: 1,
    });
    expect(store.get("op-fenced")?.error).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("preserves the first start on resume while fencing the old handler", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_100_000);
    const original = baseOp({
      id: "op-resume", status: "running", startedAt: 1_000_000,
      firstStartedAt: 900_000, resumeCount: 1,
    });
    const { db, store } = createOperationsFixture({ "op-resume": original });
    const handler: OperationHandler = vi.fn(async (op) => {
      expect(op.startedAt).toBe(1_100_000);
      expect(op.firstStartedAt).toBe(900_000);
      expect(op.resumeCount).toBe(2);
      expect(store.get(op.id)?.startedAt).not.toBe(original.startedAt);
      return { steps: [], success: true };
    });
    await reAdoptAndRunOperation(original as unknown as Operation, buildDeps(db, { rollout: handler }));
    expect(handler).toHaveBeenCalledOnce();
    expect(store.get("op-resume")).toMatchObject({
      status: "succeeded", firstStartedAt: 900_000, startedAt: 1_100_000,
      lastResumedAt: 1_100_000, resumeCount: 2,
    });
    vi.restoreAllMocks();
  });

  it("does not invent a first start for an operation whose earlier history was not recorded", async () => {
    const original = baseOp({ id: "old-retry", attempts: 2 });
    const { db, store } = createOperationsFixture({ "old-retry": original });
    await drainPendingOperationsOnce(buildDeps(db, {
      rollout: vi.fn(async () => ({ steps: [], success: true })),
    }));
    expect(store.get("old-retry")?.firstStartedAt).toBeNull();
  });

  it("a stale worker snapshot cannot reset attempts or drop attemptHistory", async () => {
    const priorAttempts: OperationAttemptRecord[] = [
      { attempt: 1, startedAt: 1, completedAt: 2, error: "e1", classification: "transient", steps: [] },
      { attempt: 2, startedAt: 3, completedAt: 4, error: "e2", classification: "transient", steps: [] },
    ];
    const { db, store } = createOperationsFixture({
      "op-r": baseOp({ id: "op-r", createdAt: 5, attempts: 2, attemptHistory: priorAttempts }),
    });
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "connect ECONNREFUSED 10.0.0.1:443",
    }));
    const staleSnapshot = { ...(baseOp({ id: "op-r", createdAt: 5 }) as unknown as Operation), id: "op-r" };
    await processOperation(staleSnapshot, buildDeps(db, { rollout: handler }));
    const doc = store.get("op-r")!;
    expect(doc.attempts).toBe(3);
    expect(doc.status).toBe("failed");
    expect((doc.attemptHistory as unknown[]).length).toBe(3);
  });
});

describe("queued op bookkeeping is write-quiet", () => {
  it("does not rewrite an identical waitingOn on every drain tick", async () => {
    const { db, store, writeLog } = createOperationsFixture({
      "op-live": baseOp({ id: "op-live", status: "running" }),
      "op-blocked": baseOp({ id: "op-blocked", createdAt: 9 }),
    });
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));
    const firstWrites = writeLog.filter((w) => w.id === "op-blocked").length;
    expect(store.get("op-blocked")?.waitingOn).toBeTruthy();
    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));
    const secondWrites = writeLog.filter((w) => w.id === "op-blocked").length;
    expect(secondWrites).toBe(firstWrites);
  });
});

describe("pending operation watch", () => {
  it("claims the watch snapshot and each later addition, ignoring modifications, until stopped", async () => {
    const claimed: string[] = [];
    const handler: OperationHandler = vi.fn(async (op) => {
      claimed.push(op.id);
      return { steps: [], success: true };
    });
    const { db, store, emit, watchRequests, closedWatches } = createOperationsFixture({
      "op-a": baseOp({ id: "op-a", kind: "add-gateway", createdAt: 1 }),
      "op-b": baseOp({ id: "op-b", kind: "add-gateway", createdAt: 2 }),
    });
    const pending = async (id: string) => (await db.journal.operations.get(id))!;
    const stop = startOperationWorker(buildDeps(db, { "add-gateway": handler }));
    expect(watchRequests).toEqual([{ aggregate: "operations", filter: { statuses: ["pending"] } }]);

    await emit({ kind: "snapshot", records: [await pending("op-a")], cursor: "c1" as never });
    await vi.waitFor(() => expect(store.get("op-a")?.status).toBe("succeeded"));
    await emit({ kind: "changes", changes: [{ type: "modified", key: "op-b", record: await pending("op-b") }], cursor: "c2" as never });
    await emit({ kind: "resync", reason: "backend-restart" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("op-b")?.status).toBe("pending");
    await emit({ kind: "changes", changes: [{ type: "added", key: "op-b", record: await pending("op-b") }], cursor: "c3" as never });
    await vi.waitFor(() => expect(store.get("op-b")?.status).toBe("succeeded"));

    stop();
    expect(claimed).toEqual(["op-a", "op-b"]);
    expect(closedWatches()).toBe(1);
  });
});

describe("verified user erasure completion", () => {
  const erasure = () => baseOp({ id: "erase-1", kind: "erase-user", createdBy: "alice", input: { uid: "alice", deletionId: "del-1" } });
  const verified = vi.fn(async () => ({
    steps: [], success: true, scrubInputOnSuccess: true,
    output: { verifiedDeletion: { deletionId: "del-1", archiveId: "archive-1" } },
  }));

  it("trims the deletion job to its anonymous archive in the same transaction that scrubs the operation", async () => {
    const { db, store, documents } = createOperationsFixture({ "erase-1": erasure() }, { documents: {
      "customerDeletionJobs/del-1": {
        version: 1, uid: "alice", slug: "alice", status: "hibernating", requestedBy: "alice", requestedAt: 1, eraseAfter: 2,
        erasureOperationId: "erase-1", cleanupContext: { slug: "alice" }, stripeCustomerIds: ["cus_1"],
        posthogErasure: { personUuids: ["person-1"], requestedPersonUuids: ["person-1"] },
      },
    } });

    await drainPendingOperationsOnce(buildDeps(db, { "erase-user": verified }));

    expect(documents.get("customerDeletionJobs/del-1")).toEqual({
      version: 1, status: "verified", requestedAt: 1, eraseAfter: 2, archiveId: "archive-1", completedAt: expect.any(Number),
    });
    const operation = store.get("erase-1")!;
    expect(operation.status).toBe("succeeded");
    expect(operation).not.toHaveProperty("input");
    expect(operation).not.toHaveProperty("createdBy");
    expect(await db.journal.operations.listReferencingUid("alice")).toEqual([]);
  });

  it("leaves the operation running when its deletion job has vanished instead of inventing a verified job", async () => {
    const { db, store, documents } = createOperationsFixture({ "erase-1": erasure() });

    await expect(drainPendingOperationsOnce(buildDeps(db, { "erase-user": verified }))).rejects.toBeInstanceOf(MissingRecordError);

    expect(store.get("erase-1")?.status).toBe("running");
    expect(documents.get("customerDeletionJobs/del-1")).toBeUndefined();
  });
});

describe("claim admission fences", () => {
  it.each([
    ["another VM recovery owns the user", { users: { alice: { provisioning: { computerRecovery: { operationId: "recover-1" } } } } }],
    ["a gateway runtime restart outcome is unresolved", { gateways: { "shared-a": { gatewayId: "shared-a", gatewayClass: "shared",
      runtimeRestartFence: { attemptId: "attempt-1", gatewayId: "shared-a", kind: "process", phase: "dispatched", startedAt: 1 } } } }],
  ] as const)("leaves a migration pending while %s", async (_name, seeds) => {
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const log = vi.fn();
    const { db, store } = createOperationsFixture({
      "op-move": baseOp({ id: "op-move", kind: "migrate-user", input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" } }),
    }, seeds);

    await drainPendingOperationsOnce({ ...buildDeps(db, { "migrate-user": handler }), log });

    expect(handler).not.toHaveBeenCalled();
    expect(store.get("op-move")?.status).toBe("pending");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/claim transaction failed op=op-move: .*(VM recovery is in progress|restart outcome is unresolved)/));
  });

  it("lets the recovery's own operation claim the fenced user", async () => {
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createOperationsFixture({
      "recover-1": baseOp({ id: "recover-1", kind: "add-gateway", input: { uid: "alice" } }),
    }, { users: { alice: { provisioning: { computerRecovery: { operationId: "recover-1" } } } } });

    await drainPendingOperationsOnce(buildDeps(db, { "add-gateway": handler }));

    expect(handler).toHaveBeenCalledOnce();
    expect(store.get("recover-1")?.status).toBe("succeeded");
  });
});
