import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep, UserMigrationV2GatewayRootFence, UserMigrationV2State } from "@octogee/shared/types/glm";
import { operationElapsed, assertActiveOperationClaim, assertUserRestoreSettled, createOperationContext, PendingUserRestoreError } from "../operation-context";

function makeDeps() {
  const persistedSnapshots: OperationStep[][] = [];
  const logCalls: string[] = [];
  return {
    persist: vi.fn(async (steps: OperationStep[]) => {
      persistedSnapshots.push(steps);
    }),
    log: (msg: string) => logCalls.push(msg),
    opId: "op-test-1",
    persistedSnapshots,
    logCalls,
  };
}

describe("createOperationContext", () => {
  describe("step logging", () => {
    it("logs a step starting and finishing with how long it took", async () => {
      const deps = makeDeps();
      const { ctx } = createOperationContext(deps);
      await ctx.reportStep({ name: "transfer-state", status: "running", startedAt: 1_000 });
      await ctx.reportStep({ name: "transfer-state", status: "done", completedAt: 4_500 });
      expect(deps.logCalls).toEqual([
        "[glm-controller] op=op-test-1 step=transfer-state status=running",
        "[glm-controller] op=op-test-1 step=transfer-state status=done durationMs=3500",
      ]);
    });

    it("includes the error on a failed step", async () => {
      const deps = makeDeps();
      const { ctx } = createOperationContext(deps);
      await ctx.reportStep({ name: "cutover", status: "running", startedAt: 10 });
      await ctx.reportStep({ name: "cutover", status: "failed", completedAt: 25, error: "source is held" });
      expect(deps.logCalls.at(-1)).toBe("[glm-controller] op=op-test-1 step=cutover status=failed durationMs=15: source is held");
    });

    it("logs a step reported only when finished, without a duration", async () => {
      const deps = makeDeps();
      const { ctx } = createOperationContext(deps);
      await ctx.reportStep({ name: "noop", status: "skipped", completedAt: 25 });
      expect(deps.logCalls.at(-1)).toBe("[glm-controller] op=op-test-1 step=noop status=skipped");
    });
  });

  it("reports the elapsed time of a claimed operation", () => {
    expect(operationElapsed({ startedAt: 1_000 }, 3_500)).toBe(" after 2500ms");
    expect(operationElapsed({ startedAt: null }, 3_500)).toBe("");
  });

  it.each(["RPC timed out", "restore response does not match"])("retains the durable fence when %s", async (message) => {
    const acknowledge = vi.fn(async () => undefined);
    const begin = vi.fn(async () => acknowledge);
    const { ctx } = createOperationContext({ ...makeDeps(), userRestore: {
      begin, assertSettled: async () => undefined,
    } });
    await expect(ctx.withUserRestoreFence!({
      uid: "u1", slug: "alice", gatewayId: "shared-1", fromGatewayId: "builder-1", assignmentEpoch: 4,
    }, async () => { throw new Error(message); })).rejects.toThrow(message);
    expect(begin).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges only the same completed restore and surfaces a lost acknowledgement", async () => {
    const acknowledge = vi.fn(async () => { throw new Error("claim changed"); });
    const work = vi.fn(async () => undefined);
    const { ctx } = createOperationContext({ ...makeDeps(), userRestore: {
      begin: async () => acknowledge, assertSettled: async () => undefined,
    } });
    await expect(ctx.withUserRestoreFence!({
      uid: "u1", slug: "alice", gatewayId: "shared-1", fromGatewayId: "builder-1", assignmentEpoch: 4,
    }, work)).rejects.toThrow("claim changed");
    expect(work).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("persists migration V2 state and exposes cancellation without swallowing errors", async () => {
    const persistUserMigrationV2 = vi.fn(async () => undefined);
    const cancellationRequested = vi.fn(async () => true);
    const { ctx } = createOperationContext({
      ...makeDeps(),
      persistUserMigrationV2,
      cancellationRequested,
    });
    const rootFence = (gatewayId: string): UserMigrationV2GatewayRootFence => ({
      gatewayId, updatedAt: 1, latestRelease: 1, desiredRelease: 1, liveRelease: 1,
      gatewayClass: "isolated", ownerUid: "u1", builderSlug: "alice", configHash: "7".repeat(64),
    });
    const migration: UserMigrationV2State = {
      phase: "initialized",
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "u1",
      slug: "alice",
      sourceGatewayId: "source",
      sourceRelease: 1,
      sourceEpoch: 1,
      sourceAssignmentMode: "assigned",
      sourceRootFence: rootFence("source"),
      targetGatewayId: "target",
      targetRelease: 1,
      targetRootFence: rootFence("target"),
    };

    await ctx.persistUserMigrationV2?.(migration);

    expect(persistUserMigrationV2).toHaveBeenCalledWith(migration);
    await expect(ctx.cancellationRequested?.()).resolves.toBe(true);
  });
  it("appends the first running event as a new step", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running", startedAt: 100 });

    expect(steps).toEqual([{ name: "quiesce-source", status: "running", startedAt: 100 }]);
  });

  it("collapses a matching done event onto the most recent running step of the same name", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running", startedAt: 100 });
    await ctx.reportStep({ name: "quiesce-source", status: "done", completedAt: 200 });

    expect(steps).toEqual([
      { name: "quiesce-source", status: "done", startedAt: 100, completedAt: 200 },
    ]);
  });

  it("refreshes a matching running step without growing the operation step history", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "release-roll", status: "running", startedAt: 100 });
    await ctx.reportStep({ name: "release-roll", status: "running", startedAt: 100 });

    expect(steps).toEqual([{ name: "release-roll", status: "running", startedAt: 100 }]);
    expect(deps.persistedSnapshots).toHaveLength(2);
  });

  it("collapses a matching failed event onto the running step and preserves the error", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "transfer-state", status: "running", startedAt: 200 });
    await ctx.reportStep({
      name: "transfer-state",
      status: "failed",
      completedAt: 300,
      error: "503",
    });

    expect(steps).toEqual([
      {
        name: "transfer-state",
        status: "failed",
        startedAt: 200,
        completedAt: 300,
        error: "503",
      },
    ]);
  });

  it("treats rollback steps as separate entries — they never collapse onto forward-pass steps of the same suffix", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running", startedAt: 100 });
    await ctx.reportStep({ name: "quiesce-source", status: "done", completedAt: 200 });
    await ctx.reportStep({ name: "rollback:quiesce-source", status: "running", startedAt: 300 });
    await ctx.reportStep({ name: "rollback:quiesce-source", status: "done", completedAt: 400 });

    expect(steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      "quiesce-source:done",
      "rollback:quiesce-source:done",
    ]);
  });

  it("calls persist with a fresh array snapshot on every reportStep — never with a mutating reference", async () => {
    const deps = makeDeps();
    const { ctx } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running" });
    await ctx.reportStep({ name: "quiesce-source", status: "done" });

    expect(deps.persistedSnapshots).toHaveLength(2);
    expect(deps.persistedSnapshots[0]).not.toBe(deps.persistedSnapshots[1]);
    expect(deps.persistedSnapshots[0].map((s) => s.status)).toEqual(["running"]);
    expect(deps.persistedSnapshots[1].map((s) => s.status)).toEqual(["done"]);
  });

  it("logs but does not throw when persist fails — migration must not be aborted by Firestore hiccups", async () => {
    const persist = vi.fn(async () => {
      throw new Error("Firestore unavailable");
    });
    const logCalls: string[] = [];
    const { ctx } = createOperationContext({
      persist,
      log: (msg) => logCalls.push(msg),
      opId: "op-test-1",
    });

    await expect(
      ctx.reportStep({ name: "quiesce-source", status: "running" }),
    ).resolves.toBeUndefined();
    expect(logCalls.some((l) => l.includes("Firestore unavailable"))).toBe(true);
  });

  it("appends a new entry when the buffer has no in-progress step of the same name (e.g. duplicate done)", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

await ctx.reportStep({ name: "quiesce-source", status: "done", completedAt: 200 });

    expect(steps).toEqual([{ name: "quiesce-source", status: "done", completedAt: 200 }]);
  });
});

describe("active operation claim", () => {
  const claimed: Operation = {
    id: "op-1", kind: "migrate-user", status: "running", createdBy: "test", createdAt: 90, startedAt: 100, completedAt: null, steps: [],
    input: { uid: "uid-alice", fromGatewayId: "source", toGatewayId: "target" },
  };

  it("accepts the same running uncancelled migration attempt", () => {
    expect(() => assertActiveOperationClaim(claimed, { ...claimed })).not.toThrow();
  });

  it("allows current cancellation cleanup but rejects another claimant's phase persistence", () => {
    const cancelled = {...claimed,cancellationRequestedAt:102};
    expect(() => assertActiveOperationClaim(claimed,cancelled,true)).not.toThrow();
    expect(() => assertActiveOperationClaim(claimed,{...cancelled,startedAt:101},true)).toThrow("operation claim");
  });

  it.each([
    null,
    { ...claimed, status: "completed" },
    { ...claimed, status: "pending" },
    { ...claimed, startedAt: 101 },
    { ...claimed, cancellationRequestedAt: 102 },
    { ...claimed, kind: "restart-gateway" },
    { ...claimed, input: { ...claimed.input, uid: "uid-other" } },
    { ...claimed, input: { ...claimed.input, fromGatewayId: "other" } },
    { ...claimed, input: { ...claimed.input, toGatewayId: "other" } },
  ])("rejects stale, cancelled, or changed claims: %j", (fresh) => {
    expect(() => assertActiveOperationClaim(claimed, fresh as Operation | null)).toThrow("operation claim");
  });

  it("exposes claim failures without swallowing them as progress-reporting errors", async () => {
    const assertActiveClaim = vi.fn(async () => { throw new Error("operation re-claimed"); });
    const { ctx } = createOperationContext({ ...makeDeps(), assertActiveClaim });
    await expect(ctx.assertActiveClaim!()).rejects.toThrow("operation re-claimed");
  });
});


describe("settled user restore", () => {
  const operation: Operation = {
    id: "return-1", kind: "migrate-user", status: "running", createdBy: "test", createdAt: 890, startedAt: 900, completedAt: null, steps: [],
    input: { uid: "u1", fromGatewayId: "builder-1", toGatewayId: "shared-1", userSlug: "alice" },
  };
  const acknowledged = {
    phase: "acknowledged", operationId: "return-1", uid: "u1", fromGatewayId: "builder-1",
    gatewayId: "shared-1", slug: "alice", attemptId: "attempt-1", assignmentEpoch: 4,
    claimStartedAt: 100, dispatchedAt: 200, acknowledgedAt: 300,
  };

  it("allows no restore and a matching acknowledgement from a previous claim", () => {
    expect(() => assertUserRestoreSettled(operation, undefined)).not.toThrow();
    expect(() => assertUserRestoreSettled(operation, acknowledged)).not.toThrow();
  });

  it("allows a valid nonblank slug when the operation did not persist builderSlug", () => {
    expect(() => assertUserRestoreSettled({ ...operation, input: {
      uid: "u1", fromGatewayId: "builder-1", toGatewayId: "shared-1",
    } }, acknowledged)).not.toThrow();
  });

  it("admits only a matching dispatched intent for native resumption", () => {
    const pending = { ...acknowledged, phase: "dispatched" };
    expect(() => assertUserRestoreSettled(operation, pending)).toThrow(PendingUserRestoreError);
    for (const changed of [{ uid: "foreign" }, { assignmentEpoch: -1 }, { attemptId: " " }, { dispatchedAt: 0 }]) {
      try {
        assertUserRestoreSettled(operation, { ...pending, ...changed });
        expect.fail("malformed intent was admitted");
      } catch (error) {
        expect(error).not.toBeInstanceOf(PendingUserRestoreError);
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it.each([
    null, false, [], "acknowledged", { phase: "acknowledged" },
    { ...acknowledged, phase: "dispatched" },
    { ...acknowledged, operationId: "other" },
    { ...acknowledged, uid: "other" },
    { ...acknowledged, fromGatewayId: "other" },
    { ...acknowledged, gatewayId: "other" },
    { ...acknowledged, slug: "other" },
    { ...acknowledged, slug: " " },
    { ...acknowledged, attemptId: " " },
    { ...acknowledged, assignmentEpoch: -1 },
    { ...acknowledged, assignmentEpoch: 0.5 },
    { ...acknowledged, assignmentEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...acknowledged, claimStartedAt: 0 },
    { ...acknowledged, claimStartedAt: Number.NaN },
    { ...acknowledged, dispatchedAt: Number.POSITIVE_INFINITY },
    { ...acknowledged, dispatchedAt: -1 },
    { ...acknowledged, acknowledgedAt: 0 },
    { ...acknowledged, acknowledgedAt: 199 },
  ])("blocks unresolved or malformed restore receipt %j", (attempt) => {
    expect(() => assertUserRestoreSettled(operation, attempt)).toThrow(/restore/);
  });
});
