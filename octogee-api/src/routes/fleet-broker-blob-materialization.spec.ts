import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../gateway-edge/src/lib/platform-state.js", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("../../../gateway-edge/src/lib/platform-state.js")>()),
    platformStateStore: createDocumentFixtureStore(new Map()),
  };
});
import { GATEWAY_CREDENTIAL_TOKEN_AUDIENCE, GATEWAY_CREDENTIAL_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import { GATEWAY_CREDENTIAL_ROUTES } from "../app.js";
import { createGatewayCredentialAuth } from "../middleware/gateway-credential-auth.js";
import { createTenantEnforcementMiddleware } from "../middleware/tenant-enforcement.js";
import { gatewayVmPodName } from "@octogee/shared/types/glm";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

function harness(metadata: Record<string, unknown> = { generation: "17", size: "3", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" }) {
  const store = createDocumentFixtureStore({ "users/uid-owner": { username: "owner", provisioning: { openclaw: { gatewayId: "b-owner" } } } });
  const readBlobMetadata = vi.fn(async () => metadata);
  const createBlobSignedUrl = vi.fn(async (input: { gcsPath: string; generation?: string }) => ({
    url: `https://storage.example/${input.gcsPath}?generation=${input.generation}`, method: "GET" as const,
    gcsPath: input.gcsPath, expiresAt: "2026-10-07T12:00:00Z",
  }));
  const app = express(); app.disable("x-powered-by"); app.use(express.json());
  app.use((req, _res, next) => { req.boundTenant = { kind: "gateway", gatewayId: "b-owner" }; next(); });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store, readBlobMetadata, createBlobSignedUrl }));
  return { app, readBlobMetadata, createBlobSignedUrl };
}

describe("tenant-bound project blob materialization", () => {
  it("signs create-only project uploads scoped to the assigned owner and checked payload", async () => {
    const h = harness();
    const body = { slug: "owner", projectSlug: "app", sha256: "a".repeat(64), size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==", mimeType: "application/octet-stream" };
    expect((await request(h.app).post("/internal/fleet/blob/project/upload-url").send(body)).status).toBe(200);
    expect(h.createBlobSignedUrl).toHaveBeenCalledWith({ gcsPath: `customers/owner/projects/app/.objects/${body.sha256}`, action: "write", contentType: body.mimeType, ifGenerationMatch: 0, contentMd5: body.md5Hash, contentLength: 3 });
  });
  it.each([
    { slug: "other" }, { projectSlug: "../other" }, { sha256: "../other" }, { md5Hash: "invalid" },
    { size: -1 }, { size: 0.5 }, { size: 536870913 },
  ])("rejects invalid project uploads before signing: %j", async changed => {
    const h = harness();
    const body = { slug: "owner", projectSlug: "app", sha256: "a".repeat(64), size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==", ...changed };
    expect([400, 403]).toContain((await request(h.app).post("/internal/fleet/blob/project/upload-url").send(body)).status);
    expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
  it("scopes immutable revisions to the assigned owner and project", async () => {
    const h = harness();
    const sha256 = "a".repeat(64);
    const result = await request(h.app).post("/internal/fleet/blob/materialization/read-url")
      .send({ slug: "owner", path: "projects/app/images/a.png", sha256, size: 3 });
    expect(result.status).toBe(200);
    expect(h.readBlobMetadata).toHaveBeenCalledWith(`customers/owner/projects/app/.objects/${sha256}`);
    h.readBlobMetadata.mockClear();
    const invalid = await request(h.app).post("/internal/fleet/blob/materialization/read-url")
      .send({ slug: "owner", path: "projects/app/a", sha256: "../other", size: 3 });
    expect(invalid.status).toBe(400);
    expect(h.readBlobMetadata).not.toHaveBeenCalled();
  });
  it("pins a size-checked object generation and returns its trusted checksum", async () => {
    const h = harness();
    const result = await request(h.app).post("/internal/fleet/blob/materialization/read-url")
      .send({ slug: "owner", path: "projects/app/images/a.png", size: 3, gcsPath: "customers/other/private" });
    expect(result.status).toBe(200);
    expect(h.readBlobMetadata).toHaveBeenCalledWith("customers/owner/projects/app/images/a.png");
    expect(h.createBlobSignedUrl).toHaveBeenCalledWith({ gcsPath: "customers/owner/projects/app/images/a.png", action: "read", generation: "17" });
    expect(result.body).toMatchObject({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==" });
  });
  it("refuses changed size and incomplete object identity before signing", async () => {
    for (const metadata of [{ generation: "17", size: "4", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" },
      { generation: "17", size: "3" }, { generation: "17", size: true, md5Hash: "kAFQmDzST7DWlj99KOF/cg==" }, { generation: "", size: "3", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" }]) {
      const h = harness(metadata);
      const result = await request(h.app).post("/internal/fleet/blob/materialization/read-url").send({ slug: "owner", path: "projects/app/a", size: 3 });
      expect(result.status).toBe(409); expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
    }
  });
  it("does not sign after metadata read errors", async () => {
    const h = harness(); h.readBlobMetadata.mockRejectedValueOnce(new Error("metadata unavailable"));
    const result = await request(h.app).post("/internal/fleet/blob/materialization/read-url").send({ slug: "owner", path: "projects/app/a", size: 3 });
    expect(result.status).toBe(502); expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
  it.each([{ slug: "other", path: "projects/app/a", size: 3 }, { slug: "owner", path: "../other/a", size: 3 },
    { slug: "owner", path: "runtime-state/a", size: 3 }, { slug: "owner", path: "a", size: -1 },
    { slug: "owner", path: "a", size: 536870913 }])("rejects foreign, unsafe and oversized requests without reading GCS", async body => {
    const h = harness();
    const result = await request(h.app).post("/internal/fleet/blob/materialization/read-url").send(body);
    expect([400, 403]).toContain(result.status); expect(h.readBlobMetadata).not.toHaveBeenCalled();
  });
  it("scopes project manifest reads to the assigned owner and rejects project traversal", async () => {
    const h = harness();
    const result = await request(h.app).post("/internal/fleet/blob/manifest/read-url").send({ slug: "owner", projectSlug: "app" });
    expect(result.status).toBe(200);
    expect(h.createBlobSignedUrl).toHaveBeenCalledWith({ gcsPath: "customers/owner/projects/app/.files/manifest.json", action: "read" });
    h.createBlobSignedUrl.mockClear();
    const invalid = await request(h.app).post("/internal/fleet/blob/manifest/read-url").send({ slug: "owner", projectSlug: "../other" });
    expect(invalid.status).toBe(400); expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
});


const JWT = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;

function preparingHarness(scenario = "valid") {
  const owner = { username: "owner", provisioning: { openclaw: { slug: "owner", gatewayId: "shared-source" } } };
  const gateway = { gatewayId: "b-owner", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "uid-owner", builderSlug: "owner", modelBrokerLimits: null, preemption: null };
  const runtime = { docKind: "runtime", release: 1, lifecycle: "running", gatewayId: "b-owner", runtime: "gce-vm", vm: { instanceId: "4242" }, vmInstance: { ownerUid: "uid-owner", builderSlug: "owner" } };
  const operation: Record<string, any> = { kind: "migrate-user", status: "running", input: { uid: "uid-owner", fromGatewayId: "shared-source", toGatewayId: "b-owner" } };
  if (scenario === "unrelated-target") operation.input.toGatewayId = "other";
  if (scenario === "ended-operation") operation.status = "failed";
  if (scenario === "cancelled") operation.cancellationRequestedAt = 1;
  if (scenario === "cutover") operation.cutoverCommittedAt = 1;
  if (scenario === "changed-instance") runtime.vm.instanceId = "4243";
  if (scenario === "changed-source") owner.provisioning.openclaw.gatewayId = "other-source";
  if (scenario === "retired") gateway.desiredStatus = "retired";
  const operationCount = scenario === "missing-operation" ? 0 : scenario === "duplicate-operation" ? 2 : 1;
  const docs: Record<string, Record<string, unknown>> = {
    "users/uid-owner": owner, "gateways/b-owner": gateway, "glmGateways/b-owner": runtime,
    ...Object.fromEntries(Array.from({ length: operationCount }, (_, index) => [`glmOperations/move-${index}`, operation])),
  };
  operation.inputUid = "uid-owner";
  const readBlobMetadata = vi.fn(async () => ({ generation: "17", size: "3", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" }));
  const createBlobSignedUrl = vi.fn(async (input: { gcsPath: string }) => ({ url: `https://signed.test/${input.gcsPath}`, method: "GET" as const, gcsPath: input.gcsPath, expiresAt: "2026-10-07T12:00:00Z" }));
  const app = express(); app.disable("x-powered-by"); app.use(express.json());
  app.use((req, _res, next) => { req.boundTenant = { kind: "gateway", gatewayId: "b-owner", ownerUid: "uid-owner", podUid: "4242", podName: gatewayVmPodName("b-owner", "4242"), saName: "octogee-gw-b-owner" }; next(); });
  app.use(createTenantEnforcementMiddleware({ readFlowGateway: async () => null, store: createDocumentFixtureStore(docs), onDenied: async () => {} }));
  const credentialAuth = createGatewayCredentialAuth({ namespace: "octogee-test",
    reviewer: async () => ({ authenticated: true, saName: "octogee-gw-b-owner", namespace: "octogee-test", audiences: [GATEWAY_CREDENTIAL_TOKEN_AUDIENCE],
      podName: gatewayVmPodName("b-owner", "4242"), podUid: scenario === "wrong-credential" ? "9999" : "4242" }),
    mapIdentity: async () => ({ kind: "gateway", gatewayId: "b-owner" }), logger: { warn: vi.fn() } });
  app.use((req, res, next) => GATEWAY_CREDENTIAL_ROUTES.has(req.path) ? credentialAuth(req, res, next) : next());
  app.use("/internal/fleet", createFleetBrokerRoutes({ store: createDocumentFixtureStore(docs), readBlobMetadata, createBlobSignedUrl }));
  return { app, owner, operation, readBlobMetadata, createBlobSignedUrl };
}

describe("source-owned held target project reads", () => {
  it("hydrates project manifests and blobs while the owner remains assigned to the source", async () => {
    const h = preparingHarness();
    for (const [route, body] of [["/blob/materialization/manifest/read-url", { projectSlug: "app" }], ["/blob/materialization/read-url", { path: "projects/app/a.png", size: 3 }]] as const) {
      const result = await request(h.app).post(`/internal/fleet${route}`).set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT).send({ slug: "owner", ...body });
      expect(result.status).toBe(200);
    }
    expect(h.owner.provisioning.openclaw.gatewayId).toBe("shared-source");
    expect(h.readBlobMetadata).toHaveBeenCalledOnce(); expect(h.createBlobSignedUrl).toHaveBeenCalledTimes(2);
  });
  it.each(["missing-operation", "duplicate-operation", "unrelated-target", "ended-operation", "cancelled", "cutover", "changed-instance", "changed-source", "retired", "wrong-credential"])("refuses %s before reading or signing GCS", async scenario => {
    const h = preparingHarness(scenario);
    for (const [route, body] of [["/blob/materialization/manifest/read-url", { projectSlug: "app" }], ["/blob/materialization/read-url", { path: "projects/app/a.png", size: 3 }]] as const) {
      expect((await request(h.app).post(`/internal/fleet${route}`).set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT).send({ slug: "owner", ...body })).status).toBe(403);
    }
    expect(h.readBlobMetadata).not.toHaveBeenCalled(); expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
  it("requires the purpose credential on both held project read routes", async () => {
    const h = preparingHarness();
    for (const [route, body] of [["/blob/materialization/manifest/read-url", { projectSlug: "app" }], ["/blob/materialization/read-url", { path: "projects/app/a.png", size: 3 }]] as const) {
      expect((await request(h.app).post(`/internal/fleet${route}`).send({ slug: "owner", ...body })).status).toBe(403);
    }
    expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
  it("rejects non-project blobs and project traversal on preparing read routes", async () => {
    const h = preparingHarness();
    for (const [route, body] of [["/blob/materialization/read-url", { path: "runtime-state/a", size: 3 }], ["/blob/materialization/manifest/read-url", { projectSlug: "../other" }]] as const) {
      expect((await request(h.app).post(`/internal/fleet${route}`).set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT).send({ slug: "owner", ...body })).status).toBe(400);
    }
    expect(h.readBlobMetadata).not.toHaveBeenCalled(); expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
  it("does not grant preparation authority to blob/manifest write routes or workspace-manifest reads", async () => {
    const h = preparingHarness();
    for (const [route, body] of [["/blob/project/upload-url", { projectSlug: "app", sha256: "a".repeat(64), size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==" }], ["/blob/upload-url", { path: "projects/app/a.png", size: 3 }], ["/blob/manifest/write-url", { ifGenerationMatch: "0" }], ["/blob/manifest/read-url", {}]] as const) {
      expect((await request(h.app).post(`/internal/fleet${route}`).set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT).send({ slug: "owner", ...body })).status).toBe(403);
    }
    expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
});


describe("cancelled forward user preparation", () => {
  function forward(kind: "v2" | "legacy") {
    const h = preparingHarness();
    Object.assign(h.operation, { startedAt: 50, cancellationRequestedAt: 60 });
    if (kind === "v2") h.operation.userMigrationV2 = {
      phase: "sourceQuiesced", operationId: "move-0", migrationId: "mig-move-0", uid: "uid-owner", slug: "owner",
      sourceGatewayId: "shared-source", targetGatewayId: "b-owner", sourceEpoch: 7,
    };
    else h.operation.schedulerHandoff = {
      migrationId: "mig-move-0:scheduler:1:claim:50", uid: "uid-owner", slug: "owner", fromGatewayId: "shared-source", toGatewayId: "b-owner",
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 7 },
    };
    return h;
  }
  const readManifest = (h: ReturnType<typeof preparingHarness>) => request(h.app)
    .post("/internal/fleet/blob/materialization/manifest/read-url").set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT).send({ slug: "owner", projectSlug: "app" });
  it.each(["v2", "legacy"] as const)("materializes the held target for the exact cancelled %s migration", async kind => {
    const h = forward(kind);
    expect((await readManifest(h)).status).toBe(200);
    expect(h.createBlobSignedUrl).toHaveBeenCalledOnce();
  });
  it.each(["phase", "operation", "migration", "uid", "slug", "source", "target", "epoch", "claim"])("rejects cancelled V2 preparation with changed %s authority", async change => {
    const h = forward("v2"), state = h.operation.userMigrationV2;
    if (change === "phase") state.phase = "preSynced";
    if (change === "operation") state.operationId = "other";
    if (change === "migration") state.migrationId = "mig-other";
    if (change === "uid") state.uid = "other";
    if (change === "slug") state.slug = "other";
    if (change === "source") state.sourceGatewayId = "other";
    if (change === "target") state.targetGatewayId = "other";
    if (change === "epoch") state.sourceEpoch = Number.NaN;
    if (change === "claim") h.operation.startedAt = null;
    expect((await readManifest(h)).status).toBe(403);
    expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
});
