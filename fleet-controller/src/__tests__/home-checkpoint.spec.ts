import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { clearHomeCheckpointRequest } from "../lib/home-checkpoint.js";

const runtime = (vmHome?: Record<string, unknown>) => ({
  docKind: "runtime", gatewayId: "jefe", release: 1, lifecycle: "serving", runtime: "gce-vm",
  ...(vmHome === undefined ? {} : { vmHome }),
});

describe("clearHomeCheckpointRequest", () => {
  it("clears the outstanding checkpoint request and keeps the rest of the home state", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["glmGateways/jefe", runtime({ checkpointRequestedAt: 20, lastCheckpoint: { completedAt: 10 } })],
    ]);
    await clearHomeCheckpointRequest(createDocumentFixtureStore(documents), "jefe");
    expect(documents.get("glmGateways/jefe")?.vmHome).toEqual({ lastCheckpoint: { completedAt: 10 } });
  });

  it("leaves a runtime with no outstanding request untouched", async () => {
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/jefe", runtime()]]);
    await clearHomeCheckpointRequest(createDocumentFixtureStore(documents), "jefe");
    expect(documents.get("glmGateways/jefe")).toEqual(runtime());
  });

  it("refuses a gateway with no runtime record", async () => {
    await expect(clearHomeCheckpointRequest(createDocumentFixtureStore({}), "jefe"))
      .rejects.toThrow("gateway jefe: home checkpoint requires a runtime record");
  });
});
