import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../gateway-edge/src/lib/platform-state.js", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("../../../gateway-edge/src/lib/platform-state.js")>()),
    platformStateStore: createDocumentFixtureStore(new Map()),
  };
});

import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  GATEWAY_CREDENTIAL_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import { createGatewayCredentialAuth } from "../middleware/gateway-credential-auth.js";
import { GATEWAY_CREDENTIAL_ROUTES } from "../app.js";
import { InMemoryNpmCacheCapabilityStore } from "../lib/npm-cache-capabilities.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "builder-alice";
const POD_NAME = "octogee-gateway-builder-alice-vm-4242";
const POD_UID = "4242";
const SA_NAME = "octogee-gw-builder-alice";
const JWT = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
const TOKEN = "n".repeat(43);
const NOW_MS = Date.parse("2026-08-30T12:00:00.000Z");

function gatewayDoc() {
  return {
    gatewayId: GATEWAY_ID,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
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
    ownerUid: "uid-alice",
    builderSlug: "alice",
    modelBrokerLimits: null,
    preemption: null,
  };
}

function platformStore(assignedSlug: string | null = "alice", preparation: {
  operation?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}) {
  return createDocumentFixtureStore({
    [`gateways/${GATEWAY_ID}`]: gatewayDoc(),
    [`gateways/${GATEWAY_ID}/assignments/uid-alice`]: assignedSlug === null ? undefined : {
      uid: "uid-alice",
      slug: assignedSlug,
      gatewayId: GATEWAY_ID,
      source: "onboarding",
      state: "serving",
      epoch: 1,
      updatedAt: 1,
      updatedByOperationId: null,
    },
    "users/uid-alice": preparation.user ?? { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: "shared-source" } } },
    [`glmGateways/${GATEWAY_ID}`]: preparation.runtime && { docKind: "runtime", release: 1, lifecycle: "running", ...preparation.runtime },
    "glmOperations/move-alice": preparation.operation && { inputUid: "uid-alice", ...preparation.operation },
  });
}

function brokerOptions(
  store = new InMemoryNpmCacheCapabilityStore(() => TOKEN),
  extra: Record<string, unknown> = {},
) {
  return {
    store: platformStore(),
    npmCacheCapabilities: store,
    npmCacheRegistryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
    now: () => NOW_MS,
    ...extra,
  };
}

function userApp(options = brokerOptions()) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = {
      kind: "gateway",
      gatewayId: GATEWAY_ID,
      ownerUid: "uid-alice",
      saName: SA_NAME,
      podName: POD_NAME,
      podUid: POD_UID,
    };
    next();
  }) as RequestHandler);
  app.use(createGatewayCredentialAuth({
    reviewer: vi.fn(async () => ({
      authenticated: true as const,
      saName: SA_NAME,
      namespace: "octogee-test",
      audiences: [GATEWAY_CREDENTIAL_TOKEN_AUDIENCE],
      podName: POD_NAME,
      podUid: POD_UID,
    })),
    namespace: "octogee-test",
    mapIdentity: async () => ({ kind: "gateway", gatewayId: GATEWAY_ID }),
    logger: { warn: vi.fn() },
  }));
  app.use("/internal/fleet", createFleetBrokerRoutes(options as never));
  return app;
}

function proxyApp(options: ReturnType<typeof brokerOptions>) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "platform", actor: "npm-cache-proxy" };
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes(options as never));
  return app;
}

describe("npm cache capability broker", () => {
  const preparation = () => ({
    operation: { kind: "migrate-user", status: "running", input: {
      uid: "uid-alice", slug: "alice", fromGatewayId: "shared-source", toGatewayId: GATEWAY_ID,
    } },
    runtime: { gatewayId: GATEWAY_ID, runtime: "gce-vm", vm: { instanceId: POD_UID }, vmInstance: { ownerUid: "uid-alice", builderSlug: "alice" } },
  });

  it("hydrates the exact destination instance during its owner's active migration before assignment", async () => {
    const options = brokerOptions(undefined, { store: platformStore(null, preparation()) });
    const response = await request(userApp(options))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });
    expect(response.status).toBe(200);
  });

  it.each(["finished", "foreign-owner", "foreign-source", "foreign-target", "replaced-instance", "moved-user", "cancelled", "foreign-runtime-owner", "foreign-runtime-slug"])("rejects stale or unrelated preparation (%s)", async (scenario) => {
    const state: Parameters<typeof platformStore>[1] = preparation();
    if (scenario === "cancelled") state.operation!.cancellationRequestedAt = 1;
    if (scenario === "foreign-runtime-owner") state.runtime!.vmInstance = { ownerUid: "other-uid", builderSlug: "alice" };
    if (scenario === "foreign-runtime-slug") state.runtime!.vmInstance = { ownerUid: "uid-alice", builderSlug: "other-slug" };
    if (scenario === "finished") state.operation!.status = "succeeded";
    if (scenario === "foreign-owner") (state.operation!.input as Record<string, unknown>).uid = "other-uid";
    if (scenario === "foreign-source") (state.operation!.input as Record<string, unknown>).fromGatewayId = "other-source";
    if (scenario === "foreign-target") (state.operation!.input as Record<string, unknown>).toGatewayId = "other-target";
    if (scenario === "replaced-instance") state.runtime!.vm = { instanceId: "previous-instance" };
    if (scenario === "moved-user") state.user = { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: "another-source" } } };
    const response = await request(userApp(brokerOptions(undefined, { store: platformStore(null, state) })))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });
    expect(response.status).toBe(403);
  });

  it("requires the second purpose-audience KSA credential", async () => {
    expect(GATEWAY_CREDENTIAL_ROUTES.has("/internal/fleet/npm-registry-credentials"))
      .toBe(true);
    const response = await request(userApp())
      .post("/internal/fleet/npm-registry-credentials")
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(403);
  });

  it("issues only to the exact assigned isolated pod and marks the response no-store", async () => {
    const response = await request(userApp())
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      registryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
      token: TOKEN,
      expiresAt: "2026-08-30T12:10:00.000Z",
    });
  });

  it("rejects a configured user before its assignment exists", async () => {
    const options = brokerOptions();
    options.store = platformStore(null);
    const response = await request(userApp(options))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(403);
  });

  it("rejects a slug that is not the gateway assignment", async () => {
    const options = brokerOptions();
    options.store = platformStore("mallory");
    const response = await request(userApp(options))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(403);
  });

  it("lets only the npm proxy actor authorize the opaque capability", async () => {
    const store = new InMemoryNpmCacheCapabilityStore(() => TOKEN);
    const options = brokerOptions(store);
    await request(userApp(options))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" })
      .expect(200);

    const authorized = await request(proxyApp(options))
      .post("/internal/fleet/npm-cache-authorize")
      .send({ token: TOKEN });
    expect(authorized.status).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");
    expect(authorized.body.authorization).toMatchObject({
      gatewayId: GATEWAY_ID,
      uid: "uid-alice",
      slug: "alice",
      podUid: POD_UID,
      audience: "octogee-npm-cache-proxy",
    });
  });

  it("redacts an issuance failure from both the response and report", async () => {
    const report = vi.fn();
    const store = {
      issue: () => { throw new Error("upstream secret capability-token-value"); },
      authorize: () => null,
    };
    const response = await request(userApp(brokerOptions(store as never, {
      reportNpmCacheCapabilityFailure: report,
    })))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("capability-token-value");
    expect(report).toHaveBeenCalledWith({ gatewayId: GATEWAY_ID, reason: "unexpected-error" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("capability-token-value");
  });
});
