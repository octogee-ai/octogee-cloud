import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { records } = vi.hoisted(() => {
  function durableRoot(gatewayId: string) {
    return {
      gatewayId,
      createdAt: 1,
      createdBy: "test",
      updatedAt: 1,
      updatedBy: "test",
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: 1,
      desiredStatus: "running",
      configSchemaVersion: 1,
      profile: "standard",
      gatewayClass: "shared",
      imageProfile: "standard",
      sizingTier: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      builderAccess: null,
      ownerUid: null,
      builderSlug: null,
      modelBrokerLimits: null,
      preemption: null,
    };
  }

  function servingRuntime(
    gatewayId: string,
    heartbeat: Record<string, unknown>,
    lastError: Record<string, unknown> = { message: null, at: null },
  ) {
    return {
      docKind: "runtime",
      gatewayId,
      release: 1,
      lifecycle: "serving",
      createdAt: 1,
      createdByOperationId: null,
      helm: {},
      heartbeat,
      lastError,
    };
  }

  const records = new Map<string, Record<string, unknown>>([
    ["users/admin-user", { provisioning: {} }],
    ["gateways/gw-test-primary", durableRoot("gw-test-primary")],
    ["gateways/gw-test-secondary", durableRoot("gw-test-secondary")],
    ["gateways/gw-test-stale", durableRoot("gw-test-stale")],
    ["glmGateways/gw-test-primary", servingRuntime("gw-test-primary", {
      status: "ready",
      version: "abc1234",
      openclawVersion: "v1.2.3",
      mountedCustomers: ["alice", "bob", "christopher"],
      lastHeartbeatAt: Date.now() - 2_000,
    })],
    ["glmGateways/gw-test-secondary", servingRuntime("gw-test-secondary", {
      status: "ready",
      version: "def5678",
      openclawVersion: "v1.2.3",
      mountedCustomers: ["dana"],
      lastHeartbeatAt: Date.now() - 5_000,
    })],
    ["glmGateways/gw-test-stale", servingRuntime(
      "gw-test-stale",
      {
        status: "ready",
        version: "ghi9012",
        openclawVersion: "v1.2.3",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now() - 5 * 60_000,
      },
      { slug: "frodo", message: "git clone timeout", at: Date.now() },
    )],
  ]);
  return { records };
});

vi.mock("@octogee/core/platform-state", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
    platformStateStoreFromEnvironment: () => createDocumentFixtureStore(records),
  };
});

vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    next();
  },
}));

import express from "express";
import adminRouter, { centralReleaseRouteDeps } from "../routes/admin.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

describe("CENTRAL release authority wiring", () => {
  it("enables release authority only for the active CENTRAL TEST and PROD targets", () => {
    expect(centralReleaseRouteDeps("test-central").releaseEnvironment).toBe("test");
    expect(centralReleaseRouteDeps("test-central").releaseAuthority).toBeDefined();
    expect(centralReleaseRouteDeps("prod-central").releaseEnvironment).toBe("prod");
    expect(centralReleaseRouteDeps("prod-central").releaseAuthority).toBeDefined();
    expect(centralReleaseRouteDeps("test-west")).toEqual({ releaseEnvironment: null });
  });
});

describe("GET /api/admin/gateways", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns the fleet list with image SHA, status, mounted users, and heartbeat freshness", async () => {
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.gateways)).toBe(true);
    expect(res.body.gateways).toHaveLength(3);

    const primary = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-primary");
    expect(primary).toMatchObject({
      gatewayId: "gw-test-primary",
      status: "ready",
      imageTag: "abc1234",
      mountedUsers: ["alice", "bob", "christopher"],
    });
    expect(primary.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    expect(primary.heartbeatAgeMs).toBeLessThan(5_000);
  });

  it("projects durable gateway identities from roots and exact serving revisions", async () => {
    const res = await request(app).get("/api/admin/gateways");
    const primary = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-primary");
    const secondary = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-secondary");
    const stale = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-stale");
    expect(primary.gateway).toBe("gw-test-primary");
    expect(secondary.gateway).toBe("gw-test-secondary");
    expect(stale.gateway).toBe("gw-test-stale");
  });

  it("rolls up gateway counts including derived unreachable, and users mounted", async () => {
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      gateways: { total: 3, ready: 2, paused: 0, unreachable: 1 },
      usersMounted: 4,
    });
  });

  it("surfaces lastError on a gateway when present", async () => {
    const res = await request(app).get("/api/admin/gateways");
    const stale = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-stale");
    expect(stale.lastError).toMatchObject({
      slug: "frodo",
      message: "git clone timeout",
    });
  });
});
