import { describe, expect, it, vi } from "vitest";
import { operationScopedLog, withOperationLogScope } from "./operation-log-scope.js";

describe("operation log scope", () => {
  it("tags lines from a logger closure built before the operation started, across awaits", async () => {
    const sink = vi.fn();
    const builtEarly = operationScopedLog(sink);
    const dependency = { warn: (message: string) => builtEarly(`[surge-handoff] ${message}`) };
    await withOperationLogScope("surge-default-target-uid", async () => {
      await Promise.resolve();
      dependency.warn("prune failed");
      await new Promise((resolve) => setTimeout(resolve, 1));
      dependency.warn("abort failed");
    });
    expect(sink.mock.calls.map(([line]) => line)).toEqual([
      "[surge-handoff] prune failed op=surge-default-target-uid",
      "[surge-handoff] abort failed op=surge-default-target-uid",
    ]);
  });

  it("leaves lines outside any operation untagged and never tags a line twice", async () => {
    const sink = vi.fn();
    const outer = operationScopedLog(sink);
    const inner = operationScopedLog(outer);
    outer("idle sweep");
    await withOperationLogScope("op-1", async () => inner("[migrate-customer] cutover committed"));
    expect(sink.mock.calls.map(([line]) => line)).toEqual([
      "idle sweep",
      "[migrate-customer] cutover committed op=op-1",
    ]);
  });

  it("leaves a line alone when it already names the operation mid-message, but still tags a different or prefixed id", async () => {
    const sink = vi.fn();
    const log = operationScopedLog(sink);
    await withOperationLogScope("op-1", async () => {
      log("[glm-controller] op=op-1 step progress discarded because the operation was re-claimed");
      log("[glm-controller] op=op-1 progress gate-source:running discarded (status=failed)");
      log("[migrate-customer] predecessor op=op-10 still running");
      log("[migrate-customer] recovery for mig-op-1 staged");
    });
    expect(sink.mock.calls.map(([line]) => line)).toEqual([
      "[glm-controller] op=op-1 step progress discarded because the operation was re-claimed",
      "[glm-controller] op=op-1 progress gate-source:running discarded (status=failed)",
      "[migrate-customer] predecessor op=op-10 still running op=op-1",
      "[migrate-customer] recovery for mig-op-1 staged op=op-1",
    ]);
  });

  it("keeps concurrent operations' tags apart", async () => {
    const sink = vi.fn();
    const log = operationScopedLog(sink);
    await Promise.all([
      withOperationLogScope("op-a", async () => { await new Promise((resolve) => setTimeout(resolve, 2)); log("a done"); }),
      withOperationLogScope("op-b", async () => { log("b done"); }),
    ]);
    expect(sink.mock.calls.map(([line]) => line).sort()).toEqual(["a done op=op-a", "b done op=op-b"]);
  });
});
