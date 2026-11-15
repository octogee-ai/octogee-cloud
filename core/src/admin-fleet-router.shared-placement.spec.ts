import request from "supertest";
import { describe, expect, it } from "vitest";
import { platformReleaseRecord, releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { durableGatewayRoot, mkAdminFleetRouteApp } from "@octogee/core-testing/admin-fleet-route-app";

describe("users per shared gateway is the product's", () => {
  const config = { defaultGatewayId: "shared-a", sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 } };

  it("is neither reported nor settable on a platform-only install", async () => {
    const { app, state } = mkAdminFleetRouteApp({ config, users: {} });

    const placement = await request(app).get("/placement").expect(200);

    expect(placement.body.config).toEqual({ defaultGatewayId: "shared-a", sharedGatewayIds: ["shared-a"] });
    expect((await request(app).patch("/placement/capacity").send({ usersPerGateway: 6 })).status).toBe(404);
    expect(state.config).toHaveProperty("sharedGatewayAutoscaling", { enabled: true, buildersPerGateway: 4 });
    expect(Object.values(state.operations)).toEqual([]);
  });
});

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function payload(tag: string): ReleasePayload {
  return { imageRepository: REPO, imageTag: `${tag}@sha256:${tag.charAt(0).repeat(64)}` };
}

function release(gatewayId: string, body: ReleasePayload): Record<string, unknown> {
  return { gatewayId, release: 1, createdAt: 1, createdBy: "op", sourceRelease: null, note: null, payloadHash: releasePayloadHash(body), payload: body };
}

describe("GET /placement after a build ships", () => {
  it("names each shared gateway that is not on the build the platform runs", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { sharedGatewayIds: ["shared-a", "shared-b"] },
      users: {},
      gateways: {
        "shared-a": durableGatewayRoot("shared-a", { liveRelease: 1 }),
        "shared-b": durableGatewayRoot("shared-b", { liveRelease: 1 }),
      },
      releases: {
        "shared-a": { 1: release("shared-a", payload("abc1234")) },
        "shared-b": { 1: release("shared-b", payload("def5678")) },
      },
      platformRelease: platformReleaseRecord(payload("abc1234"), 1) as unknown as Record<string, unknown>,
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.warnings.filter((warning: { code: string }) => warning.code === "shared-gateway-behind-platform-build")).toEqual([{
      code: "shared-gateway-behind-platform-build",
      severity: "warning",
      gatewayId: "shared-b",
      message: "shared-b runs build def5678; the platform runs abc1234",
    }]);
  });

  it("reports the build a shared gateway runs, not the one queued for it, and names a gateway that runs none yet", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { sharedGatewayIds: ["shared-rolling", "shared-new"] },
      users: {},
      gateways: {
        "shared-rolling": durableGatewayRoot("shared-rolling", { latestRelease: 2, desiredRelease: 2, liveRelease: 1 }),
        "shared-new": durableGatewayRoot("shared-new", { liveRelease: null }),
      },
      releases: {
        "shared-rolling": { 1: release("shared-rolling", payload("def5678")), 2: release("shared-rolling", payload("abc1234")) },
        "shared-new": { 1: release("shared-new", payload("abc1234")) },
      },
      platformRelease: platformReleaseRecord(payload("abc1234"), 1) as unknown as Record<string, unknown>,
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.warnings.filter((warning: { code: string }) => warning.code === "shared-gateway-behind-platform-build")).toEqual([
      {
        code: "shared-gateway-behind-platform-build",
        severity: "warning",
        gatewayId: "shared-rolling",
        message: "shared-rolling runs build def5678; the platform runs abc1234",
      },
      {
        code: "shared-gateway-behind-platform-build",
        severity: "warning",
        gatewayId: "shared-new",
        message: "shared-new runs no build yet; the platform runs abc1234",
      },
    ]);
  });
});
