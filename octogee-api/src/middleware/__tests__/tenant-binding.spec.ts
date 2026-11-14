import express from "express";
import { Registry } from "prom-client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  K8S_SA_TOKEN_HEADER,
  createTenantBindingMetrics,
  createTenantBindingMiddleware,
} from "../tenant-binding.js";
import type { Reviewer } from "../../lib/token-review.js";

const WELL_FORMED_SA_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LWlkIn0",
  "eyJhdWQiOlsib2N0b2dlZS1hcGkiXSwiZXhwIjoxNzUyODAwMDAwLCJpc3MiOiJrOHMifQ",
  "c2lnbmF0dXJlLXNlZ21lbnQtZm9yLXRlc3RpbmctcHVycG9zZXMtb25seQ",
].join(".");

function gatewayRootStore(roots: Record<string, Record<string, unknown>>) {
  return createDocumentFixtureStore(
    Object.fromEntries(Object.entries(roots).map(([gatewayId, root]) => [`gateways/${gatewayId}`, root])),
  );
}

function gatewayRoot(serviceAccountName: string | null = null): Record<string, unknown> {
  return {
    gatewayId: "walter",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: "walter-r1",
    trafficRevisionId: "walter-r1",
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-walter",
    builderSlug: "walter",
    modelBrokerLimits: null,
    preemption: null,
  };
}

function retiringGatewayRoot(): Record<string, unknown> {
  return {
    ...gatewayRoot(),
    desiredStatus: "retired",
    retirementVersion: 1,
    retirementClaim: {
      operationId: "op-retire-walter",
      version: 1,
      claimedAt: 1,
      phase: "claimed",
      liveRelease: 1,
      liveRuntimeIdentity: null,
      previousDesiredStatus: "running",
    },
  };
}

function walterPodReview(): Awaited<ReturnType<Reviewer>> {
  return {
    authenticated: true,
    namespace: "octogee",
    saName: "octogee-gw-walter",
    audiences: ["octogee-api"],
    podName: "octogee-gateway-walter-r7-5bc5949d46-p946t",
    podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
  };
}

function buildApp(opts: {
  reviewer: Reviewer;
  docs?: Record<string, Record<string, unknown>>;
  registry?: Registry;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}) {
  const app = express();
  const registry = opts.registry ?? new Registry();
  app.use(express.json());
  app.use(
    "/internal",
    createTenantBindingMiddleware({
      reviewer: opts.reviewer,
      store: gatewayRootStore(
        opts.docs ?? {
          walter: gatewayRoot(),
        },
      ),
      namespace: "octogee",
      metrics: createTenantBindingMetrics(registry),
      logger: { warn: opts.warn ?? (() => undefined) },
    }),
  );
  app.post("/internal/probe", (req, res) => {
    const body = req.body as { gatewayId?: unknown } | undefined;
    res.json({
      attempted: req.tenantBindingAttempted,
      requestedGatewayId: body?.gatewayId ?? null,
      boundTenant: req.boundTenant ?? null,
    });
  });
  return { app, registry };
}

describe("tenant binding middleware", () => {
  it("soft-fails missing tokens and still lets existing internal auth decide", async () => {
    const { app, registry } = buildApp({
      reviewer: async () => ({ authenticated: false }),
    });

    const res = await request(app).post("/internal/probe").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      attempted: true,
      requestedGatewayId: null,
      boundTenant: null,
    });
    await expect(registry.metrics()).resolves.toContain('result="missing"');
  });

  it("binds a valid gateway service-account token to the gateway owner", async () => {
    const { app, registry } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-walter",
        audiences: ["octogee-api"],
        podName: "octogee-gateway-walter-r7-5bc5949d46-p946t",
        podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "walter" });

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "gateway",
      gatewayId: "walter",
      ownerUid: "uid-walter",
      saName: "octogee-gw-walter",
      podName: "octogee-gateway-walter-r7-5bc5949d46-p946t",
      podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
    });
    await expect(registry.metrics()).resolves.toContain('result="ok"');
  });

  it("binds a retiring gateway's live pod token on a fresh review so its preStop flush is admitted", async () => {
    const warn = vi.fn();
    const reviewer = vi.fn<Reviewer>(async () => walterPodReview());
    const { app } = buildApp({ warn, docs: { walter: retiringGatewayRoot() }, reviewer });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "walter" });

    expect(res.body.boundTenant).toMatchObject({
      kind: "gateway",
      gatewayId: "walter",
      podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
    });
    expect(reviewer).toHaveBeenLastCalledWith(WELL_FORMED_SA_TOKEN, { fresh: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a retiring gateway's cached pod token once a fresh review shows the pod is gone", async () => {
    const warn = vi.fn();
    const reviewer = vi.fn<Reviewer>(async (_jwt, opts) =>
      opts?.fresh ? { authenticated: false } : walterPodReview(),
    );
    const { app, registry } = buildApp({ warn, docs: { walter: retiringGatewayRoot() }, reviewer });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "walter" });

    expect(res.body.boundTenant).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[tenant-binding] retiring gateway pod token failed fresh review",
      expect.objectContaining({ saName: "octogee-gw-walter" }),
    );
    await expect(registry.metrics()).resolves.toContain('result="invalid"');
  });

  it("keeps the cached review for a serving gateway", async () => {
    const reviewer = vi.fn<Reviewer>(async () => walterPodReview());
    const { app } = buildApp({ reviewer });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "walter" });

    expect(res.body.boundTenant).toMatchObject({ gatewayId: "walter" });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledWith(WELL_FORMED_SA_TOKEN);
  });

  it("does not fabricate pod identity when TokenReview did not verify both claims", async () => {
    const { app } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-walter",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "gateway",
      gatewayId: "walter",
      ownerUid: "uid-walter",
    });
  });

  it("binds the platform cron service-account token to a platform tenant", async () => {
    const { app, registry } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-cron",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({ kind: "platform", actor: "cron" });
    await expect(registry.metrics()).resolves.toContain('result="ok_platform"');
  });

  it("never yields a platform binding for a wrong-audience token (the kind=platform gate)", async () => {
    const warn = vi.fn();
    const { app, registry } = buildApp({
      warn,
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-cron",
        audiences: ["some-other-audience"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toBeNull();
    expect(warn).toHaveBeenCalled();
    await expect(registry.metrics()).resolves.toContain('result="audience_mismatch"');
  });

  it("rejects a retired operator gateway service-account token", async () => {
    const { app, registry } = buildApp({
      docs: { walter: gatewayRoot("octogee-gateway-walter") },
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gateway-walter",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "walter" });

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toBeNull();
    await expect(registry.metrics()).resolves.toContain('result="unknown_sa"');
  });

  it("does not let a request body forge the caller gateway", async () => {
    const { app } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-walter",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "other" });

    expect(res.status).toBe(200);
    expect(res.body.requestedGatewayId).toBe("other");
    expect(res.body.boundTenant.gatewayId).toBe("walter");
  });

  it("binds known platform callers", async () => {
    const { app } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-api",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "platform",
      actor: "octogee-api",
    });
  });

  it("records shared gateway callers without attaching a tenant", async () => {
    const warn = vi.fn();
    const { app, registry } = buildApp({
      warn,
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gateway",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toBeNull();
    await expect(registry.metrics()).resolves.toContain('result="shared_gateway"');
    expect(warn).not.toHaveBeenCalled();
  });

  it("soft-fails invalid tokens, reviewer errors, and unknown tenants", async () => {
    const warn = vi.fn();
    const invalid = buildApp({
      warn,
      reviewer: async () => ({ authenticated: false }),
    });
    const reviewerError = buildApp({
      warn,
      reviewer: async () => {
        throw new Error("api down");
      },
    });
    const unknownTenant = buildApp({
      warn,
      docs: {},
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-walter",
        audiences: ["octogee-api"],
      }),
    });

    await request(invalid.app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .expect(200);
    await request(reviewerError.app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .expect(200);
    const res = await request(unknownTenant.app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .expect(200);

    expect(res.body.boundTenant).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
