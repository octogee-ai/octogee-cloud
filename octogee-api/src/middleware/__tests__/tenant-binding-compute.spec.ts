import express from "express";
import { Registry } from "prom-client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import { GATEWAY_CREDENTIAL_TOKEN_AUDIENCE, GATEWAY_CREDENTIAL_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import { K8S_SA_TOKEN_HEADER, createTenantBindingMetrics, createTenantBindingMiddleware } from "../tenant-binding.js";
import { createGatewayCredentialAuth } from "../gateway-credential-auth.js";
import { createTenantEnforcementMiddleware } from "../tenant-enforcement.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createFleetBrokerRoutes } from "../../routes/fleet-broker.js";
import type { ReviewResult, Reviewer } from "../../lib/token-review.js";

const TOKEN = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;

const docs = {
  "gateways/b-x": {
    gatewayId: "b-x", createdAt: 1, createdBy: "t", updatedAt: 1, updatedBy: "t", latestRelease: 1, desiredRelease: 1, liveRelease: 1,
    liveRevisionId: "b-x-r1", trafficRevisionId: "b-x-r1", desiredStatus: "running", roll: null, configSchemaVersion: 1,
    profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "UidA", builderSlug: "mama", modelBrokerLimits: null, preemption: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-mama", generation: 2, claimedByUid: "UidA" },
  },
  "glmGateways/b-x": {
    docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "serving", runtime: "gce-vm",
    vm: { instanceName: "octogee-pool-ab12cd34", zone: "us-central1-a", instanceId: "4242", internalIp: "10.128.0.9", status: "RUNNING", provisioningModel: "SPOT", updatedAt: 1 },
  },
};

function computeReview(audience: string, instanceId = "4242"): ReviewResult {
  return {
    authenticated: true,
    saName: "octogee-computer-test",
    namespace: "octogee-test",
    audiences: [audience],
    podName: "octogee-pool-ab12cd34",
    podUid: instanceId,
    computeInstance: { projectId: "octogee", zone: "us-central1-a", instanceId, instanceName: "octogee-pool-ab12cd34" },
  };
}

function appWith(tenantReviewer: Reviewer, credentialReviewer: Reviewer) {
  const app = express();
  app.use(createTenantBindingMiddleware({
    reviewer: tenantReviewer, store: createDocumentFixtureStore(docs), namespace: "octogee-test",
    metrics: createTenantBindingMetrics(new Registry()), logger: { warn: vi.fn() },
  }));
  app.get("/bound", (req, res) => res.json(req.boundTenant ?? null));
  app.post("/secret", createGatewayCredentialAuth({
    reviewer: credentialReviewer, store: createDocumentFixtureStore(docs), namespace: "octogee-test", logger: { warn: vi.fn() },
  }), (_req, res) => res.status(204).end());
  return app;
}

describe("tenant binding for a VM gateway", () => {
  it("binds a pool-named VM under a pod-shaped name every pod-scoped broker check accepts", async () => {
    const res = await request(appWith(async () => computeReview("octogee-api"), async () => ({ authenticated: false })))
      .get("/bound").set(K8S_SA_TOKEN_HEADER, TOKEN);
    expect(res.body).toEqual({
      kind: "gateway", gatewayId: "b-x", ownerUid: "UidA",
      saName: "octogee-computer-test", podName: "octogee-gateway-b-x-vm-4242", podUid: "4242",
    });
    expect(podBelongsToGateway("b-x", res.body.podName)).toBe(true);
  });

  it("grants the credential capability only to a second token from the same instance", async () => {
    const same = appWith(async () => computeReview("octogee-api"), async () => computeReview(GATEWAY_CREDENTIAL_TOKEN_AUDIENCE));
    expect((await request(same).post("/secret").set(K8S_SA_TOKEN_HEADER, TOKEN).set(GATEWAY_CREDENTIAL_TOKEN_HEADER, TOKEN)).status).toBe(204);

    const other = appWith(async () => computeReview("octogee-api"), async () => computeReview(GATEWAY_CREDENTIAL_TOKEN_AUDIENCE, "9999"));
    expect((await request(other).post("/secret").set(K8S_SA_TOKEN_HEADER, TOKEN).set(GATEWAY_CREDENTIAL_TOKEN_HEADER, TOKEN)).status).toBe(403);
  });
});

describe("isolated runtime-state routes for a VM gateway", () => {
  it("authorize the VM's own snapshotter through binding, enforcement, and the route's pod-scoped check", async () => {
    const store = createDocumentFixtureStore(docs);
    const app = express();
    app.use(express.json());
    app.use(createTenantBindingMiddleware({
      reviewer: async () => computeReview("octogee-api"), store, namespace: "octogee-test",
      metrics: createTenantBindingMetrics(new Registry()), logger: { warn: vi.fn() },
    }));
    app.use(createTenantEnforcementMiddleware({ readFlowGateway: async () => null, store }));
    app.use("/internal/fleet", createFleetBrokerRoutes({
      store,
      createIsolatedRuntimeStateSignedUrl: async (input) => ({ url: `signed:${input.gcsPath}`, method: "GET", gcsPath: input.gcsPath, expiresAt: "later" }),
    }));

    const res = await request(app)
      .post("/internal/fleet/builder-runtime-state/download-url")
      .set(K8S_SA_TOKEN_HEADER, TOKEN)
      .send({ gatewayId: "b-x", revisionId: "b-x", slug: "mama" });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("signed:customers/mama/runtime-state/allocations/b-x-g2/checkpoint.tar.gz");
  });
});
