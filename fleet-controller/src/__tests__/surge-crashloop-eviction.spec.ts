import { describe, expect, it } from "vitest";
import { MissingRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { CRASH_LOOP_EVICTION_BUDGET, claimCrashLoopEviction, crashLoopEvictionDecision } from "../surge-crashloop-eviction.js";

const pod = { uid: "t", name: "gateway-new", podIP: "10.0.0.2", ready: false, terminating: false, crashLooping: true };

describe("crashLoopEvictionDecision", () => {
  it("spends the budget one eviction at a time for the same image, then refuses", () => {
    expect(crashLoopEvictionDecision(undefined, "new-sha")).toEqual({ allowed: true, count: 1 });
    expect(crashLoopEvictionDecision({ imageTag: "new-sha", count: 2 }, "new-sha")).toEqual({ allowed: true, count: 3 });
    expect(crashLoopEvictionDecision({ imageTag: "new-sha", count: CRASH_LOOP_EVICTION_BUDGET }, "new-sha")).toEqual({ allowed: false, count: 3 });
  });

  it("starts a fresh budget for a different image and ignores a malformed record", () => {
    expect(crashLoopEvictionDecision({ imageTag: "old-sha", count: 3 }, "new-sha")).toEqual({ allowed: true, count: 1 });
    expect(crashLoopEvictionDecision({ imageTag: "new-sha", count: "3" }, "new-sha")).toEqual({ allowed: true, count: 1 });
    expect(crashLoopEvictionDecision("garbage", "new-sha")).toEqual({ allowed: true, count: 1 });
  });
});

describe("claimCrashLoopEviction", () => {
  function runtime(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      docKind: "runtime", gatewayId: "gw", release: 1, lifecycle: "serving", createdAt: 1, createdByOperationId: null,
      helm: {}, heartbeat: {}, lastError: { message: null, at: null }, ...fields,
    };
  }

  it("records each allowed eviction on the runtime doc and leaves the doc alone once the budget is spent", async () => {
    const documents: Record<string, Record<string, unknown>> = {
      "glmGateways/gw": runtime({ surgeCrashLoopEvictions: { imageTag: "new-sha", count: 2, lastAt: 1, lastPod: "p" } }),
    };
    const store = createDocumentFixtureStore(documents);
    await expect(claimCrashLoopEviction(store, { gatewayId: "gw", imageTag: "new-sha", pod, now: 50 })).resolves.toEqual({ allowed: true, count: 3, budget: 3 });
    expect(documents["glmGateways/gw"]).toEqual(runtime({ surgeCrashLoopEvictions: { imageTag: "new-sha", count: 3, lastAt: 50, lastPod: "gateway-new" } }));

    await expect(claimCrashLoopEviction(store, { gatewayId: "gw", imageTag: "new-sha", pod, now: 60 })).resolves.toEqual({ allowed: false, count: 3, budget: 3 });
    expect(documents["glmGateways/gw"]).toMatchObject({ surgeCrashLoopEvictions: { count: 3, lastAt: 50 } });
  });

  it("refuses to spend a budget for a gateway without a runtime record instead of creating one", async () => {
    const documents: Record<string, Record<string, unknown>> = {};
    const store = createDocumentFixtureStore(documents);
    await expect(claimCrashLoopEviction(store, { gatewayId: "gw", imageTag: "new-sha", pod, now: 50 })).rejects.toBeInstanceOf(MissingRecordError);
    expect(documents).toEqual({});
  });
});
