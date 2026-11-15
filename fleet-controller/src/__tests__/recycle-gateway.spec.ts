import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type { GatewayLifecycleStatus } from "@octogee/shared/types/gateway-releases";
import { createRecycleGatewayHandler } from "../handlers/recycle-gateway";
import type { RecycleGatewayDeps } from "../handlers/recycle-gateway";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-recycle-1",
    kind: "recycle-gateway",
    status: "pending",
    createdBy: "durability-harness",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "default" },
    steps: [],
    ...overrides,
  };
}

function mkCtx() {
  const reported: OperationStep[] = [];
  const ctx: OperationContext = {
    reportStep: async (step) => {
      reported.push(step);
    },
  };
  return { ctx, reported };
}

function scriptedReplicas(seq: number[]): () => Promise<number | null> {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)];
}

function mkDeps(overrides: Partial<RecycleGatewayDeps> = {}): RecycleGatewayDeps {
  return {
    readDesiredStatus: vi.fn(async () => "running" as GatewayLifecycleStatus),
    setDesiredStatus: vi.fn(async () => undefined),
    readServingRevisionId: vi.fn(async (gatewayId: string) => `${gatewayId}-r7`),
    readAvailableReplicas: vi.fn(scriptedReplicas([0, 1])),
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    wait: vi.fn(async () => undefined),
    log: vi.fn(),
    drainTimeoutMs: 180_000,
    readyTimeoutMs: 420_000,
    pollIntervalMs: 5_000,
    ...overrides,
  };
}

describe("createRecycleGatewayHandler — desired-state recycle (reconciler does the scaling)", () => {
  it("pauses (reconciler drains to 0) then restores running (reconciler brings up a fresh pod)", async () => {
    const deps = mkDeps();
    const handler = createRecycleGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(deps.setDesiredStatus).toHaveBeenNthCalledWith(1, "default", "paused");
    expect(deps.setDesiredStatus).toHaveBeenNthCalledWith(2, "default", "running");
    // never touches replicas directly — that's the reconciler's job (no race)
    expect(deps).not.toHaveProperty("scaleDeployment");
    expect(deps.readAvailableReplicas).toHaveBeenCalledWith("default-r7");
  });

  it("reports drain then restore steps, each running → done", async () => {
    const deps = mkDeps();
    const handler = createRecycleGatewayHandler(deps);
    const { ctx, reported } = mkCtx();
    await handler(mkOp(), ctx);
    expect(reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "drain:running",
      "drain:done",
      "restore:running",
      "restore:done",
    ]);
  });

  it("waits for full drain (0 available) before restoring running", async () => {
    const deps = mkDeps({ readAvailableReplicas: vi.fn(scriptedReplicas([2, 1, 0, 1])) });
    const handler = createRecycleGatewayHandler(deps);
    const { ctx } = mkCtx();
    await handler(mkOp(), ctx);
    const order = (deps.setDesiredStatus as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(order).toEqual(["paused", "running"]);
  });

  it("refuses to recycle a gateway that is not running (paused/draining/retired)", async () => {
    const deps = mkDeps({ readDesiredStatus: vi.fn(async () => "paused" as GatewayLifecycleStatus) });
    const handler = createRecycleGatewayHandler(deps);
    const { ctx } = mkCtx();
    const result = await handler(mkOp(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not running|paused/i);
    expect(deps.setDesiredStatus).not.toHaveBeenCalled();
  });

  it("RESTORES running if the drain times out — never leaves the gateway wedged paused", async () => {
    const deps = mkDeps({
      readAvailableReplicas: vi.fn(async () => 1), // never drains
      drainTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    const handler = createRecycleGatewayHandler(deps);
    const { ctx, reported } = mkCtx();
    const result = await handler(mkOp(), ctx);
    expect(result.success).toBe(false);
    expect(reported.find((s) => s.status === "failed")?.name).toBe("drain");
    // un-paused on the way out
    expect(deps.setDesiredStatus).toHaveBeenNthCalledWith(1, "default", "paused");
    expect(deps.setDesiredStatus).toHaveBeenNthCalledWith(2, "default", "running");
  });

  it("reports restore failed if the fresh pod never becomes ready (desired stays running — reconciler keeps trying)", async () => {
    const deps = mkDeps({
      readAvailableReplicas: vi.fn(scriptedReplicas([0, 0, 0, 0, 0, 0])),
      readyTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    const handler = createRecycleGatewayHandler(deps);
    const { ctx, reported } = mkCtx();
    const result = await handler(mkOp(), ctx);
    expect(result.success).toBe(false);
    expect(reported.find((s) => s.status === "failed")?.name).toBe("restore");
    // desired is left at running (the safe state) — last call is running
    const calls = (deps.setDesiredStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][1]).toBe("running");
  });

  it("restores running and surfaces the error if a desiredStatus write throws mid-recycle", async () => {
    const setDesiredStatus = vi
      .fn<(id: string, s: GatewayLifecycleStatus) => Promise<void>>()
      .mockResolvedValueOnce(undefined) // paused ok
      .mockRejectedValueOnce(new Error("firestore unavailable")) // restore throws
      .mockResolvedValue(undefined); // best-effort un-pause
    const deps = mkDeps({ setDesiredStatus });
    const handler = createRecycleGatewayHandler(deps);
    const { ctx } = mkCtx();
    const result = await handler(mkOp(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/firestore unavailable/);
    // a final best-effort restore-to-running was attempted
    expect(setDesiredStatus.mock.calls.at(-1)).toEqual(["default", "running"]);
  });

  it("returns failure when gatewayId is missing (defensive — raw glmOperations doc)", async () => {
    const deps = mkDeps();
    const handler = createRecycleGatewayHandler(deps);
    const { ctx } = mkCtx();
    const result = await handler(mkOp({ input: {} }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
    expect(deps.setDesiredStatus).not.toHaveBeenCalled();
  });

  it("reads replicas from the serving revision and fails closed when it is absent", async () => {
    const deps = mkDeps({ readServingRevisionId: vi.fn(async () => null) });
    const result = await createRecycleGatewayHandler(deps)(mkOp(), mkCtx().ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/serving revision/i);
    expect(deps.readAvailableReplicas).not.toHaveBeenCalled();
  });
});
