import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { publishPlatformGatewayReady } from "../index.js";

const runtime = (heartbeat: Record<string, unknown>) => ({
  docKind: "runtime", gatewayId: "walter", release: 2, lifecycle: "provisioning", heartbeat,
});

describe("publishPlatformGatewayReady", () => {
  it("marks the runtime serving and ready while keeping the heartbeat it already reported", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["glmGateways/walter", runtime({
        status: "booting", startedAt: 7, mountedCustomers: ["alice"], lastError: "boom",
        configStatus: { runtimeReady: true }, lastHeartbeatAt: 5,
      })],
    ]);
    await publishPlatformGatewayReady(createDocumentFixtureStore(documents), { gatewayId: "walter", imageTag: "abc1234@sha256:1", now: 100 });
    expect(documents.get("glmGateways/walter")).toEqual({
      ...runtime({}),
      lifecycle: "serving",
      heartbeat: {
        status: "ready", version: "abc1234", internalUrl: expect.stringContaining("octogee-gateway-walter"),
        startedAt: 7, mountedCustomers: ["alice"], lastError: "boom",
        configStatus: { runtimeReady: true }, lastHeartbeatAt: 5,
      },
    });
  });

  it("starts the readiness clock and an empty mounted set for a runtime with no reported heartbeat", async () => {
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/walter", runtime({ status: "unknown" })]]);
    await publishPlatformGatewayReady(createDocumentFixtureStore(documents), { gatewayId: "walter", now: 100 });
    expect(documents.get("glmGateways/walter")?.heartbeat).toEqual({
      status: "ready", version: "unknown", internalUrl: expect.stringContaining("octogee-gateway-walter"),
      startedAt: 100, mountedCustomers: [], lastError: null,
    });
  });

  it("refuses to publish readiness for a gateway with no runtime record", async () => {
    await expect(publishPlatformGatewayReady(createDocumentFixtureStore({}), { gatewayId: "walter", now: 100 }))
      .rejects.toThrow("cannot publish readiness: glmGateways/walter is not the gateway's runtime doc");
  });
});
