import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { docs } = vi.hoisted(() => ({ docs: {} as Record<string, Record<string, unknown> | undefined> }));

vi.mock("@octogee/core/http/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.uid = req.get("authorization");
    next();
  },
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(docs) };
});

const { createIsolatedGatewayRoutes } = await import("./gateways.js");

function isolatedRoot(gatewayId: string) {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    desiredRelease: 1,
    latestRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "alice",
    builderSlug: "alice",
    modelBrokerLimits: null,
    preemption: null,
  };
}

function servingRuntime(gatewayId: string, runtime: Record<string, unknown>) {
  return {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    lastError: { message: null, at: null },
    ...runtime,
  };
}

async function listedGateway() {
  const app = express();
  app.use(createIsolatedGatewayRoutes());
  const response = await request(app).get("/gateways/me").set("authorization", "alice");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.gateways).toHaveLength(1);
  return response.body.gateways[0];
}

describe("the signed-in user's gateway list", () => {
  beforeEach(() => {
    for (const path of Object.keys(docs)) delete docs[path];
    docs["users/alice"] = { provisioning: { openclaw: { slug: "alice", gatewayId: "gw-alice" } } };
    docs["gateways/gw-alice"] = isolatedRoot("gw-alice");
  });

  it("says a gateway running on a VM has a desktop", async () => {
    docs["glmGateways/gw-alice"] = servingRuntime("gw-alice", { runtime: "gce-vm", vm: { status: "RUNNING" } });
    expect(await listedGateway()).toMatchObject({ gatewayId: "gw-alice", hasDesktop: true });
  });

  it("says a gateway running as a pod has no desktop", async () => {
    docs["glmGateways/gw-alice"] = servingRuntime("gw-alice", { runtime: "cluster" });
    expect(await listedGateway()).toMatchObject({ gatewayId: "gw-alice", hasDesktop: false });
  });

  it("says a gateway with no runtime record yet has no desktop", async () => {
    expect(await listedGateway()).toMatchObject({ gatewayId: "gw-alice", hasDesktop: false });
  });
});
