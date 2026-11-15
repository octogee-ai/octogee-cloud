import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { recordRevisionSystemConfigStatus } from "./revision-system-config-status.js";

const runtime = {
  docKind: "runtime",
  gatewayId: "walter",
  release: 7,
  lifecycle: "serving",
  heartbeat: { status: "ready", mountedCustomers: ["walter"], lastHeartbeatAt: 1_000 },
};

describe("gateway system config status telemetry", () => {
  it("updates the matching stable runtime heartbeat", async () => {
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/walter", runtime]]);

    await expect(recordRevisionSystemConfigStatus(createDocumentFixtureStore(documents), {
      gatewayId: "walter",
      revisionId: "walter",
      status: { state: "clean", acceptedCommit: "a".repeat(40) },
    })).resolves.toBe(true);
    expect(documents.get("glmGateways/walter")?.heartbeat).toEqual({
      status: "ready",
      mountedCustomers: ["walter"],
      lastHeartbeatAt: 1_000,
      configStatus: { state: "clean", acceptedCommit: "a".repeat(40), observedAt: { serverNow: true } },
    });
  });

  it("refuses a revision that is not the gateway or a document that is not its runtime record", async () => {
    const legacy = { docKind: "revision", gateway: "other", revisionId: "walter-r7" };
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/walter", legacy]]);
    const store = createDocumentFixtureStore(documents);

    await expect(recordRevisionSystemConfigStatus(store, {
      gatewayId: "walter",
      revisionId: "walter",
      status: { state: "error" },
    })).resolves.toBe(false);
    await expect(recordRevisionSystemConfigStatus(createDocumentFixtureStore({ "glmGateways/walter": runtime }), {
      gatewayId: "walter",
      revisionId: "walter-r7",
      status: { state: "error" },
    })).resolves.toBe(false);
    expect(documents.get("glmGateways/walter")).toEqual(legacy);
  });

  it("fails closed on a runtime record stored under another gateway", async () => {
    const store = createDocumentFixtureStore({ "glmGateways/walter": { ...runtime, gatewayId: "other" } });

    await expect(recordRevisionSystemConfigStatus(store, {
      gatewayId: "walter",
      revisionId: "walter",
      status: { state: "error" },
    })).rejects.toBeInstanceOf(MalformedRecordError);
  });
});
