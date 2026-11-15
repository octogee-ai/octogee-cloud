import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationKind, OperationStep } from "@octogee/shared/types/glm";
import {
  routeOperation,
  type OperationContext,
} from "../operation-router";
import { operationHandlers } from "./fixtures/operation-handlers";

const ctx: OperationContext = {
  reportStep: async () => undefined,
};

function mkOp(overrides: Partial<Operation>): Operation {
  return {
    id: "op-1",
    kind: "add-gateway",
    status: "pending",
    createdBy: "agent:test",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: {},
    steps: [],
    ...overrides,
  };
}

describe("routeOperation", () => {
  it("dispatches to the handler matching op.kind", async () => {
    const calls: OperationKind[] = [];
    const handlers = operationHandlers({
      "add-gateway": async () => {
        calls.push("add-gateway");
        return { steps: [], success: true };
      },
      "migrate-user": async () => {
        calls.push("migrate-user");
        return { steps: [], success: true };
      },
      "retire-gateway": async () => {
        calls.push("retire-gateway");
        return { steps: [], success: true };
      },
      rollout: async () => {
        calls.push("rollout");
        return { steps: [], success: true };
      },
    });
    await routeOperation(mkOp({ kind: "migrate-user" }), handlers, ctx);
    expect(calls).toEqual(["migrate-user"]);
  });

  it("returns the handler's success + steps verbatim", async () => {
    const steps: OperationStep[] = [
      { name: "step-a", status: "done" },
      { name: "step-b", status: "done" },
    ];
    const handlers = operationHandlers({
      "add-gateway": async () => ({ steps, success: true }),
      "migrate-user": async () => ({ steps: [], success: true }),
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    });
    const result = await routeOperation(mkOp({ kind: "add-gateway" }), handlers, ctx);
    expect(result.success).toBe(true);
    expect(result.steps).toBe(steps);
  });

  it("propagates handler failure as success=false with the error message", async () => {
    const handlers = operationHandlers({
      "add-gateway": async () => {
        throw new Error("helm install timed out");
      },
      "migrate-user": async () => ({ steps: [], success: true }),
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    });
    const result = await routeOperation(mkOp({ kind: "add-gateway" }), handlers, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/helm install timed out/);
  });

  it("rejects unknown kinds with an explicit error (defensive — strict typing should prevent at the boundary)", async () => {
    const handlers = operationHandlers({
      "add-gateway": async () => ({ steps: [], success: true }),
      "migrate-user": async () => ({ steps: [], success: true }),
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    });
    const op = mkOp({ kind: "bogus" as OperationKind });
    const result = await routeOperation(op, handlers, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown operation kind/i);
  });

  it("forwards the context (with reportStep) to the matched handler", async () => {
    const reportStep = vi.fn(async (_step: OperationStep) => undefined);
    const liveCtx: OperationContext = { reportStep };
    const handlers = operationHandlers({
      "add-gateway": async () => ({ steps: [], success: true }),
      "migrate-user": async (_op, c) => {
        await c.reportStep({ name: "in-progress", status: "running" });
        return { steps: [], success: true };
      },
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    });
    await routeOperation(mkOp({ kind: "migrate-user" }), handlers, liveCtx);
    expect(reportStep).toHaveBeenCalledWith({ name: "in-progress", status: "running" });
  });
});
