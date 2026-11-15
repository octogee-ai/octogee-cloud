import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { Registry } from "prom-client";

import { createAutomationAuthorizationBrokerRoutes } from "../routes/automation-authorization-broker.js";
import {
  K8S_SA_TOKEN_HEADER,
  createTenantBindingMetrics,
  createTenantBindingMiddleware,
} from "../middleware/tenant-binding.js";
import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { createTenantEnforcementMiddleware } from "../middleware/tenant-enforcement.js";
import type { Reviewer } from "../lib/token-review.js";
import { requireAuthenticatedUid } from "../../../gateway-edge/src/middleware/auth.js";

vi.mock("../../../gateway-edge/src/middleware/auth.js", () => ({
  requireAuthenticatedUid: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    req.uid = "hermetic-uid";
    next();
  },
}));

const WELL_FORMED_SA_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LWlkIn0",
  "eyJhdWQiOlsib2N0b2dlZS1hcGkiXSwiZXhwIjoxNzUyODAwMDAwLCJpc3MiOiJrOHMifQ",
  "c2lnbmF0dXJlLXNlZ21lbnQtZm9yLXRlc3RpbmctcHVycG9zZXMtb25seQ",
].join(".");
const DEFAULT_AGENT_CHANNEL_ID = "c".repeat(26);

function sharedGatewayRoot(): Record<string, unknown> {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: "default-r1",
    trafficRevisionId: "default-r1",
    desiredStatus: "running",
    roll: null,
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

function middlewareStackApp(saName: string) {
  const docs = {
    "gateways/default": sharedGatewayRoot(),
    "users/hermetic-uid": {
      username: "eggman",
      provisioning: { openclaw: { slug: "eggman", gatewayId: "default" } },
    },
    "workspaces/eggman": { id: "eggman", ownerUid: "hermetic-uid" },
    "workspaces/eggman/channels/coach-dm": {
      mattermost: { channelId: DEFAULT_AGENT_CHANNEL_ID },
    },
  };
  const store = createDocumentFixtureStore(docs);
  const reviewer: Reviewer = async () => ({
    authenticated: true,
    namespace: "octogee-test",
    saName,
    audiences: ["octogee-api"],
    podName: "octogee-gateway-default-abc123-def45",
    podUid: "pod-uid",
  });
  const app = express();
  app.use(express.json());
  app.use("/internal", createTenantBindingMiddleware({
    reviewer,
    store,
    namespace: "octogee-test",
    metrics: createTenantBindingMetrics(new Registry()),
    logger: { warn: () => undefined },
  }));
  app.use("/internal", createTenantEnforcementMiddleware({ readFlowGateway: async () => null, store }));
  app.use(
    "/internal/automations",
    authenticationFailureLimit, requireAuthenticatedUid, brokerRequestLimit(240, "user"),
    createAutomationAuthorizationBrokerRoutes({ store }),
  );
  return app;
}

function appForTest(input: {
  uid?: string;
  boundGatewayId?: string;
  docs?: Record<string, Record<string, unknown>>;
}) {
  const store = createDocumentFixtureStore(input.docs ?? {});
  const reads = {
    user: vi.spyOn(store.users.records, "get"),
    workspace: vi.spyOn(store.workspaces.records, "get"),
    channel: vi.spyOn(store.workspaces.channels, "get"),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = input.uid;
    req.boundTenant = input.boundGatewayId
      ? { kind: "gateway", gatewayId: input.boundGatewayId }
      : undefined;
    next();
  });
  app.use("/internal/automations", createAutomationAuthorizationBrokerRoutes({ store }));
  return { app, store, reads };
}

describe("POST /internal/automations/authorize", () => {
  it("bounds repeated requests from the same verified gateway and owner", async () => {
    const client = request(middlewareStackApp("octogee-gw-default"));
    const authorize = () => client.post("/internal/automations/authorize")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .set("Authorization", "Bearer fixture-firebase-token")
      .send({ gatewayId: "default" });
    for (let attempt = 0; attempt < 240; attempt++) await authorize().expect(200);
    const limited = await authorize().expect(429);
    expect(limited.body).toEqual({ error: "rate_limited" });
  });

  it("authorizes current shared/default KSA through the tenant-bound middleware stack", async () => {
    const response = await request(middlewareStackApp("octogee-gw-default"))
      .post("/internal/automations/authorize")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .set("Authorization", "Bearer fixture-firebase-token")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      slug: "eggman",
      gatewayId: "default",
      coachChannelId: DEFAULT_AGENT_CHANNEL_ID,
    });
  });

  it("requires Firebase identity after a valid gateway KSA is tenant-bound", async () => {
    const response = await request(middlewareStackApp("octogee-gw-default"))
      .post("/internal/automations/authorize")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "default" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthenticated" });
  });

  it.each([
    ["no gateway KSA", null],
    ["retired legacy shared KSA", "octogee-gateway"],
  ])("rejects Firebase identity with %s", async (_label, saName) => {
    const target = middlewareStackApp(saName ?? "octogee-gateway");
    const pending = request(target)
      .post("/internal/automations/authorize")
      .set("Authorization", "Bearer fixture-firebase-token")
      .send({ gatewayId: "default" });
    if (saName) pending.set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN);
    const response = await pending;

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "forbidden: request carries no gateway tenant binding",
      code: "tenant-enforcement",
    });
  });

  it("returns the owner slug only when the authenticated user assignment and workspace ownership match the bound gateway", async () => {
    const { app } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
      docs: {
        "users/eggman-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "eggman-devdays" } },
        },
        "workspaces/eggman": { id: "eggman", ownerUid: "eggman-uid" },
        "workspaces/eggman/channels/coach-dm": {
          mattermost: { channelId: DEFAULT_AGENT_CHANNEL_ID },
        },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      slug: "eggman",
      gatewayId: "eggman-devdays",
      coachChannelId: DEFAULT_AGENT_CHANNEL_ID,
    });
  });

  it("reports a not-ready agent channel instead of granting incomplete automation context", async () => {
    const { app } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
      docs: {
        "users/eggman-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "eggman-devdays" } },
        },
        "workspaces/eggman": { id: "eggman", ownerUid: "eggman-uid" },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "coach_channel_not_ready" });
  });

  it("rejects a stored agent channel outside the Mattermost ID contract", async () => {
    const { app } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
      docs: {
        "users/eggman-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "eggman-devdays" } },
        },
        "workspaces/eggman": { id: "eggman", ownerUid: "eggman-uid" },
        "workspaces/eggman/channels/coach-dm": {
          mattermost: { channelId: "mm-coach-eggman" },
        },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "coach_channel_not_ready" });
  });

  it.each(["suspended", "deletion_scheduled", "erasing"])(
    "rejects an assigned owner whose lifecycle is %s",
    async (status) => {
      const { app } = appForTest({
        uid: "eggman-uid",
        boundGatewayId: "eggman-devdays",
        docs: {
          "users/eggman-uid": {
            username: "eggman",
            accountLifecycle: { status },
            provisioning: { openclaw: { slug: "eggman", gatewayId: "eggman-devdays" } },
          },
          "workspaces/eggman": { id: "eggman", ownerUid: "eggman-uid" },
        },
      });

      const response = await request(app)
        .post("/internal/automations/authorize")
        .send({ gatewayId: "eggman-devdays" });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "forbidden" });
    },
  );

  it("404s when the authenticated user's assignment does not match the bound gateway", async () => {
    const { app } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
      docs: {
        "users/eggman-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "default" } },
        },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });

  it("403s when the assigned user is not the workspace owner", async () => {
    const { app } = appForTest({
      uid: "member-uid",
      boundGatewayId: "default",
      docs: {
        "users/member-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "default" } },
        },
        "workspaces/eggman": { id: "eggman", ownerUid: "owner-uid" },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
  });

  it("rejects a malformed broker-derived slug before constructing a workspace Firestore path", async () => {
    const { app, reads } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "default",
      docs: {
        "users/eggman-uid": {
          provisioning: { openclaw: { slug: "../../secrets", gatewayId: "default" } },
        },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
    expect(reads.user).toHaveBeenCalledTimes(1);
    expect(reads.user).toHaveBeenCalledWith("eggman-uid");
    expect(reads.workspace).not.toHaveBeenCalled();
    expect(reads.channel).not.toHaveBeenCalled();
  });

  it("requires a dedicated gateway's bound owner to match the Firebase caller before reads", async () => {
    const { store, reads } = appForTest({
      uid: "other-uid",
      boundGatewayId: "eggman-devdays",
    });
    const boundOwnerApp = express();
    boundOwnerApp.use(express.json());
    boundOwnerApp.use((req, _res, next) => {
      req.uid = "other-uid";
      req.boundTenant = {
        kind: "gateway",
        gatewayId: "eggman-devdays",
        ownerUid: "eggman-uid",
      };
      next();
    });
    boundOwnerApp.use("/internal/automations", createAutomationAuthorizationBrokerRoutes({ store }));

    const response = await request(boundOwnerApp)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
    expect(reads.user).not.toHaveBeenCalled();
    expect(reads.workspace).not.toHaveBeenCalled();
    expect(reads.channel).not.toHaveBeenCalled();
  });

  it("rejects a claimed gateway different from the projected service-account binding before Firestore reads", async () => {
    const { app, reads } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
    expect(reads.user).not.toHaveBeenCalled();
    expect(reads.workspace).not.toHaveBeenCalled();
    expect(reads.channel).not.toHaveBeenCalled();
  });
});
