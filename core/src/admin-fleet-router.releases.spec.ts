import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { ERR_SHARED_GATEWAY_NOT_ROLLED_IN_PLACE } from "./admin-fleet-router.js";
import { isPlainObject } from "./platform-state/documents/secrets.js";
import {
  REPO,
  auditsIn,
  mkApp,
  opsIn,
  PLATFORM_BUILD,
  readyHeartbeat,
  seedNewSchemaGateway,
  seedServingGateway,
  sharedPayload,
  userAuthRecord,
} from "./testing/admin-fleet-releases-app.js";
import type {
  CentralReleaseAuthority,
  ReleaseDigestManifest,
} from "./artifact-registry.js";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";

describe("normal fleet mutation admission", () => {
  it("journals a gateway restart with its pre-action state", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));

    await request(app).post("/gateways/beta/restart").expect(202);

    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      actor: "unknown",
      forced: false,
      what: "restart gateway",
      why: "Admin fleet request",
      target: { gatewayId: "beta" },
      preActionStatus: { desiredStatus: "running", desiredRelease: 1 },
      mutation: { kind: "restart-gateway", gatewayId: "beta" },
    }));
  });
});

function immutableBuild(sourceSha = "a".repeat(40)): ReleaseDigestManifest {
  return {
    sourceSha,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    openclawVersion: "2026.8.1",
    openclawSourceSha: "f".repeat(40),
    repository: "us-central1-docker.pkg.dev/octogee/octogee",
    surfaces: {
      gateway: {
        "octogee-gateway": `sha256:${"c".repeat(64)}`,
        "octogee-gateway-builder": `sha256:${"d".repeat(64)}`,
        "gateway-edge": `sha256:${"e".repeat(64)}`,
      },
      platform: {},
    },
  };
}

function buildAuthority(manifest: ReleaseDigestManifest): CentralReleaseAuthority {
  return {
    resolveManifest: vi.fn(async () => manifest),
    aliasesFor: vi.fn(() => []),
    keepTagsFor: vi.fn(() => []),
    ensureAliases: vi.fn(async () => []),
  };
}

describe('POST /gateways/:id/recover-restore', () => {
  function failedRecoverySeed() {
    const manifest = immutableBuild();
    const receipt = { uid: 'u', attemptId: 'retained-1', gatewayId: 'shared-0', assignmentEpoch: 3, claimStartedAt: 200, dispatchedAt: 100 };
    const seed = seedNewSchemaGateway('shared-0', sharedPayload());
    const recovery = { operationId: 'return-1', sourceSha: 'b'.repeat(40), images: { gateway: 'old-gateway', 'gateway-edge': 'old-edge' }, reauthorize: receipt };
    const fence = { kind: 'restore-recovery', attemptId: 'failed-recovery', gatewayId: 'shared-0', phase: 'dispatched',
      target: { podUid: 'retained-pod', restoreOperationId: 'return-1', images: recovery.images } };
    seed['gateways/shared-0'].runtimeRestartFence = fence;
    seed['glmOperations/return-1'] = { restoreAttempt: receipt };
    seed['glmOperations/failed-recovery'] = { kind: 'restart-gateway', status: 'failed', completedAt: 500, input: { gatewayId: 'shared-0', restoreRecovery: recovery } };
    const body = { sourceSha: manifest.sourceSha, operationId: 'return-1', reauthorizeAttemptId: 'retained-1', supersedeRecoveryId: 'failed-recovery' };
    return { seed, manifest, receipt, fence, body };
  }
  it('journals an explicit failed predecessor without changing its operation or held fence', async () => {
    const { seed, manifest, fence, body } = failedRecoverySeed();
    const previous = structuredClone(seed['glmOperations/failed-recovery']);
    const { app, store } = mkApp(seed, { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-restore').send(body).expect(202);
    expect(opsIn(store, 'restart-gateway').find(op => op.status === 'pending')).toMatchObject({ input: { restoreRecovery: {
      supersede: { operationId: 'failed-recovery', input: previous.input, completedAt: 500, fence },
    } } });
    expect(store.get('glmOperations/failed-recovery')).toEqual(previous);
    expect(store.get('gateways/shared-0')?.runtimeRestartFence).toEqual(fence);
    expect(auditsIn(store)).toHaveLength(1);
  });
  it.each(['running', 'succeeded', 'missing-fence', 'foreign-fence', 'custody', 'completed', 'unknown'])('refuses to queue successor for %s predecessor', async change => {
    const { seed, manifest, body } = failedRecoverySeed();
    if (change === 'running' || change === 'succeeded') seed['glmOperations/failed-recovery'].status = change;
    if (change === 'missing-fence') delete seed['gateways/shared-0'].runtimeRestartFence;
    if (change === 'foreign-fence') (seed['gateways/shared-0'].runtimeRestartFence as any).attemptId = 'foreign';
    if (change === 'custody') (seed['glmOperations/return-1'].restoreAttempt as any) = { ...(seed['glmOperations/return-1'].restoreAttempt as object), claimStartedAt: 201 };
    if (change === 'completed') seed['glmOperations/failed-recovery'].restoreRuntimeRecovery = { completedAt: 500 };
    if (change === 'unknown') delete seed['glmOperations/failed-recovery'];
    const { app, store } = mkApp(seed, { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-restore').send(body).expect(409);
    expect(opsIn(store, 'restart-gateway').filter(op => op.status === 'pending')).toHaveLength(0);
    expect(auditsIn(store)).toHaveLength(0);
  });
  it('captures the exact retained attempt only when the operator explicitly reauthorizes its ID', async () => {
    const manifest = immutableBuild();
    const receipt = { uid: 'u', attemptId: 'retained-1', gatewayId: 'shared-0', assignmentEpoch: 3, claimStartedAt: 200, dispatchedAt: 100 };
    const seed = seedNewSchemaGateway('shared-0', sharedPayload());
    seed['glmOperations/return-1'] = { restoreAttempt: receipt };
    const { app, store } = mkApp(seed, { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-restore').send({ sourceSha: manifest.sourceSha,
      operationId: 'return-1', reauthorizeAttemptId: 'retained-1' }).expect(202);
    expect(opsIn(store, 'restart-gateway')[0]).toMatchObject({ input: { restoreRecovery: { reauthorize: receipt } } });
    expect(store.get('glmOperations/return-1')).toEqual({ restoreAttempt: receipt });
  });
  it('does not queue reauthorization for a changed retained attempt', async () => {
    const manifest = immutableBuild();
    const seed = seedNewSchemaGateway('shared-0', sharedPayload());
    seed['glmOperations/return-1'] = { restoreAttempt: { attemptId: 'changed' } };
    const { app, store } = mkApp(seed, { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-restore').send({ sourceSha: manifest.sourceSha,
      operationId: 'return-1', reauthorizeAttemptId: 'retained-1' }).expect(409);
    expect(opsIn(store, 'restart-gateway')).toHaveLength(0);
  });
  it('journals exact immutable same-pod recovery inputs without appending a Shared release', async () => {
    const manifest = immutableBuild();
    const { app, store } = mkApp(seedNewSchemaGateway('shared-0', sharedPayload()), { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-restore').send({ sourceSha: manifest.sourceSha, operationId: 'return-1' }).expect(202);
    expect(opsIn(store, 'restart-gateway')[0]).toMatchObject({ input: { gatewayId: 'shared-0', restoreRecovery: {
      operationId: 'return-1', sourceSha: manifest.sourceSha, images: {
        gateway: `us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway:aaaaaaa-oc2026.8.1@sha256:${'c'.repeat(64)}`,
        'gateway-edge': `us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:aaaaaaa-oc2026.8.1@sha256:${'e'.repeat(64)}`,
      },
    } } });
    expect(store.get('gateways/shared-0')).toMatchObject({ latestRelease: 1 });
    expect(opsIn(store, 'rollout')).toHaveLength(0);
    expect(auditsIn(store)).toHaveLength(1);
  });
  it.each([{ sourceSha: 'short', operationId: 'return' }, { sourceSha: 'a'.repeat(40), operationId: 'foreign/path' },
    { sourceSha: 'a'.repeat(40), operationId: 'return', images: {} },
    { sourceSha: 'a'.repeat(40), operationId: 'return', reauthorizeAttemptId: 'retained', supersedeRecoveryId: 'foreign/path' }])('rejects malformed recovery input %j', async body => {
    const { app, store } = mkApp(seedNewSchemaGateway('shared-0', sharedPayload()));
    await request(app).post('/gateways/shared-0/recover-restore').send(body).expect(400);
    expect(opsIn(store, 'restart-gateway')).toHaveLength(0);
  });
});

describe("POST /gateways/:id/deploy", () => {
  it("refuses to deploy a build to a shared gateway and says how to move to a new build", async () => {
    const manifest = immutableBuild();
    const authority = buildAuthority(manifest);
    const { app, store } = mkApp(seedNewSchemaGateway("shared-0", sharedPayload()), {
      releaseAuthority: authority,
    });

    const res = await request(app)
      .post("/gateways/shared-0/deploy")
      .send({ sourceSha: manifest.sourceSha })
      .expect(409);

    expect(res.body).toEqual({
      error: "a shared gateway is not rolled in place; add a shared gateway on the new build, move its users to it, then retire this one",
      gatewayId: "shared-0",
    });
    expect(store.get("gateways/shared-0")).toMatchObject({ latestRelease: 1 });
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(authority.resolveManifest).not.toHaveBeenCalled();
  });

  it("deploys an existing paired build to exactly the operator-selected gateway", async () => {
    const manifest = immutableBuild();
    const authority = buildAuthority(manifest);
    const user = (slug: string) => ({
      gatewayClass: "builder",
      imageProfile: "builder",
      profile: "builder",
      ownerUid: `uid-${slug}`,
      builderSlug: slug,
    });
    const seed = {
      ...seedNewSchemaGateway("gw-alice", sharedPayload(), user("alice")),
      ...seedNewSchemaGateway("gw-bob", sharedPayload(), user("bob")),
      [`${GLM_OPERATIONS_COLLECTION}/existing`]: {
        kind: "restart-gateway",
        status: "running",
        input: { gatewayId: "gw-alice" },
      },
    };
    const { app, store } = mkApp(seed, { releaseAuthority: authority });

    await request(app)
      .post("/gateways/gw-alice/deploy")
      .send({ sourceSha: manifest.sourceSha })
      .expect(202);

    expect(store.get("gateways/gw-alice")).toMatchObject({ latestRelease: 2 });
    expect(store.get("gateways/gw-bob")).toMatchObject({ latestRelease: 1 });
    expect(store.get(`gateways/gw-alice/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toMatchObject({
      payload: {
        imageTag: `aaaaaaa-oc2026.8.1@sha256:${"c".repeat(64)}`,
        openclawSourceSha: "f".repeat(40),
        profileImages: {
          isolated: { imageTag: `aaaaaaa-oc2026.8.1@sha256:${"d".repeat(64)}` },
        },
        gatewayEdgeImage: { imageTag: `aaaaaaa-oc2026.8.1@sha256:${"e".repeat(64)}` },
      },
    });
    expect(opsIn(store, "rollout")).toMatchObject([{ origin: "operator", input: { gatewayId: "gw-alice" } }]);
    expect(authority.resolveManifest).toHaveBeenCalledWith(manifest.sourceSha);
  });

  it("requires one exact full build SHA", async () => {
    const { app } = mkApp(seedNewSchemaGateway("shared-a", sharedPayload()), {
      releaseAuthority: buildAuthority(immutableBuild()),
    });

    const abbreviated = await request(app)
      .post("/gateways/shared-a/deploy")
      .send({ sourceSha: "deadbeef" });
    const missing = await request(app).post("/gateways/shared-a/deploy").send({});

    expect(abbreviated.status).toBe(400);
    expect(missing.status).toBe(400);
  });
});


describe("manual gateway migrations", () => {
  it.each([
    ["/users/uid-alice/migrate", { to: "legacy-owner" }, {
      code: "migration-target-not-own-isolated-gateway",
      error: "manual migration target must be a shared gateway or the user's own isolated gateway",
    }],
  ])("rejects an owner gateway that is not the user's isolated runtime for %s", async (path, body, refusal) => {
    const { app, store } = mkApp({
      "users/uid-alice": userAuthRecord("source"),
      ...seedServingGateway("legacy-owner", sharedPayload(), readyHeartbeat(), {
        profile: "builder",
        gatewayClass: "builder",
        imageProfile: "builder",
        ownerUid: "uid-alice",
        builderSlug: "alice",
      }),
    });

    await request(app)
      .post(path)
      .send(body)
      .expect(400)
      .expect({ ...refusal, gatewayId: "legacy-owner" });

    expect(opsIn(store, "migrate-user")).toHaveLength(0);
  });
});

beforeEach(() => vi.stubEnv("GATEWAY_SERVICE_ACCOUNT", "gw@octogee.iam.gserviceaccount.com"));
afterEach(() => vi.unstubAllEnvs());

describe("POST /gateways — creates only the durable root and immutable release", () => {
  it("refuses image references in place of a build before creating a durable release", async () => {
    const { app, store } = mkApp();

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha", imageRepository: REPO, imageTag: "latest" })
      .expect(400);

    expect(store.get("gateways/shared-alpha")).toBeUndefined();
    expect(store.get(`gateways/shared-alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });

  it("writes gateways/{id}, release 1, and an add-gateway op without a bare glm desired doc", async () => {
    const { app, store } = mkApp();

    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha" })
      .expect(202);
    expect(res.body).toMatchObject({ gatewayId: "shared-alpha" });

    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/shared-alpha`)).toBeUndefined();

    // New durable identity.
    const gw = store.get("gateways/shared-alpha");
    expect(gw).toMatchObject({
      gatewayId: "shared-alpha",
      latestRelease: 1,
      desiredRelease: 1,
      desiredStatus: "running",
      configSchemaVersion: 1,
      gatewayClass: "shared",
      sizingTier: null,
    });

    // Immutable release 1.
    const rel = store.get(`gateways/shared-alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`);
    expect(rel).toMatchObject({ release: 1, sourceRelease: null });
    expect(rel?.payload).toEqual(PLATFORM_BUILD);
    expect(rel?.payloadHash).toBe(releasePayloadHash(rel?.payload as ReleasePayload));

    expect(opsIn(store, "add-gateway")).toHaveLength(1);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      what: "add gateway",
      target: { gatewayId: "shared-alpha" },
    }));
  });

  it("records a failed audit when gateway secret provisioning fails", async () => {
    const { app, store } = mkApp({}, {
      provisionGatewayAuthSecret: async () => {
        throw new Error("secret manager unavailable");
      },
    });

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha" })
      .expect(502);

    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "failed",
      what: "add gateway",
      error: "secret manager unavailable",
    }));
    expect(store.get("gateways/shared-alpha")).toBeUndefined();
  });

  it("does not leave a bare desired doc when durable-root creation fails atomically", async () => {
    const { app, store } = mkApp({}, { failTransactions: true });

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha" })
      .expect(500);

    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/shared-alpha`)).toBeUndefined();
    expect(store.get("gateways/shared-alpha")).toBeUndefined();
    expect(store.get(`gateways/shared-alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });

  it("refuses a shared gateway id the store would reject, before provisioning its auth secret", async () => {
    const provisionGatewayAuthSecret = vi.fn(async () => ({}));
    const { app, store } = mkApp({}, { provisionGatewayAuthSecret });

    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "fleet-live-teau", gatewayClass: "shared" })
      .expect(400);

    expect(res.body).toEqual({
      error: 'a shared gatewayId must be "shared-" followed by lowercase letters or digits',
      got: "fleet-live-teau",
    });
    expect(provisionGatewayAuthSecret).not.toHaveBeenCalled();
    expect(auditsIn(store)).toEqual([]);
    expect(store.get("gateways/fleet-live-teau")).toBeUndefined();
  });

  it("provisions no auth secret when the store refuses the gateway record", async () => {
    const provisionGatewayAuthSecret = vi.fn(async () => ({}));
    const { app, store } = mkApp({}, {
      provisionGatewayAuthSecret,
      beforeFirstTransaction: () => {
        throw new Error("store refused the gateway record");
      },
    });

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha" })
      .expect(500);

    expect(provisionGatewayAuthSecret).not.toHaveBeenCalled();
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "failed",
      what: "add gateway",
      error: "store refused the gateway record",
    }));
    expect(store.get("gateways/shared-alpha")).toBeUndefined();
  });

  it("provisions no auth secret when another creator wins the gateway id first", async () => {
    const provisionGatewayAuthSecret = vi.fn(async () => ({}));
    const { app, store } = mkApp({}, {
      provisionGatewayAuthSecret,
      beforeFirstTransaction: (state) => {
        const won = seedNewSchemaGateway("shared-alpha", { imageRepository: REPO, imageTag: "abc1234" }, { createdBy: "other-creator" });
        for (const [path, record] of Object.entries(won)) state.set(path, record);
      },
    });

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha" })
      .expect(409);

    expect(provisionGatewayAuthSecret).not.toHaveBeenCalled();
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed", what: "add gateway" }));
    expect(store.get("gateways/shared-alpha")).toMatchObject({ createdBy: "other-creator" });
  });

  it("journals a partial outcome when the gateway record cannot be committed after its auth secret exists", async () => {
    let state = new Map<string, Record<string, unknown>>();
    const { app, store } = mkApp({}, {
      provisionGatewayAuthSecret: async () => {
        vi.spyOn(state, "set").mockImplementationOnce(() => {
          throw new Error("commit failed");
        });
        return {};
      },
    });
    state = store;

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "shared-alpha" })
      .expect(500);

    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      what: "add gateway",
      partialOutcome: {
        summary: "gateway auth secret was provisioned but its initial release was not created",
        details: { gatewayId: "shared-alpha", failedStep: "initial-release" },
      },
    }));
    expect(store.get("gateways/shared-alpha")).toBeUndefined();
  });

  it("rejects an invalid new gatewayId (reserved -blue/-green) via isValidNewGatewayId", async () => {
    const { app } = mkApp();
    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha-blue" });
    expect(res.status).toBe(400);
  });

  it("rejects gateway-scoped BYOSUB input instead of persisting credentials with a release", async () => {
    const { app } = mkApp();
    const res = await request(app).post("/gateways").send({
      gatewayId: "shared-alpha",
      byosub: { openai: { secretName: "forbidden" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/credential|BYOSUB/i);
  });

  it.each(["profile", "gatewayClass", "imageProfile"] as const)(
    "rejects the retired operator value for %s",
    async (field) => {
      const { app } = mkApp();
      const res = await request(app).post("/gateways").send({
        gatewayId: "shared-alpha",
        [field]: "operator",
      });

      expect(res.status).toBe(400);
      expect(res.body.got).toBe("operator");
    },
  );

  it("rejects a manual isolated gateway before provisioning any runtime state", async () => {
    const { app, store } = mkApp();
    const res = await request(app).post("/gateways").send({
      gatewayId: "operator",
      gatewayClass: "isolated",
      imageProfile: "builder",
      ownerUid: "uid-owner",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disposable lifecycle/);
    expect(store.get("gateways/operator")).toBeUndefined();
  });
});

describe("admin target resolution", () => {
  it("rejects manual assignment when only a bare glm desired doc claims readiness", async () => {
    const { app } = mkApp({
      "users/uid-alice": { username: "alice" },
      [`${GLM_GATEWAYS_COLLECTION}/legacy`]: {
        gatewayId: "legacy",
        desiredStatus: "running",
        heartbeat: { status: "ready" },
      },
    });

    const res = await request(app)
      .post("/users/uid-alice/assign")
      .send({ gatewayId: "legacy" });
    expect(res.status).toBe(404);
  });

  it("refuses an isolated target, even the user's own", async () => {
    const { app, store } = mkApp({
      ...seedServingGateway(
        "operator",
        sharedPayload(),
        undefined,
        {
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          builderAccess: { controlUiEnabled: true, reason: "owned-runtime-gateway" },
        },
      ),
      "users/uid-alice": { username: "alice" },
    });

    const res = await request(app)
      .post("/users/uid-alice/assign")
      .send({ gatewayId: "operator" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: "gateway-not-shared", error: expect.stringMatching(/isolated/) });
    expect(store.get("gateways/operator/assignments/uid-alice")).toBeUndefined();
  });

  function assignSeed(openclaw: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}) {
    const seed = seedNewSchemaGateway("target", sharedPayload());
    seed["gateways/target"] = { ...seed["gateways/target"], liveRelease: 1 };
    seed["users/uid-alice"] = {
      username: "alice", onboardingStep: "complete",
      provisioning: { status: "complete", openclaw: { slug: "alice", ...openclaw } },
    };
    return { ...seed, ...extra };
  }

  it("assigns a user held by the operator and leaves the hold in place", async () => {
    const { app, store } = mkApp(assignSeed({ managedBy: "operator" }));

    const res = await request(app).post("/users/uid-alice/assign").send({ gatewayId: "target" });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(store.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { managedBy: "operator", gatewayId: "target" } } });
  });

  it.each([
    ["a held migration fence", { migration: { state: "moving", operationId: "migrate-7", startedAt: 1 } }, {}, "migration-in-progress", "migrate-7"],
    ["an assignment on another gateway behind no mirror", {}, {
      "gateways/other/assignments/uid-alice": { uid: "uid-alice", slug: "alice", gatewayId: "other", source: "onboarding", state: "serving", epoch: 1, createdAt: 1, updatedAt: 1, updatedByOperationId: null },
    }, "assigned-elsewhere", "other"],
  ])("refuses a user with %s", async (_case, openclaw, extra, reason, named) => {
    const { app, store } = mkApp(assignSeed(openclaw, extra));

    const res = await request(app).post("/users/uid-alice/assign").send({ gatewayId: "target" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason, error: expect.stringContaining(named) });
    expect(store.get("gateways/target/assignments/uid-alice")).toBeUndefined();
  });

  it("assigns onto a running gateway that is not ready yet and records the placement", async () => {
    const seed = seedNewSchemaGateway("target", sharedPayload());
    seed["gateways/target"] = {
      ...seed["gateways/target"],
      liveRelease: 1,
    };
    seed["users/uid-alice"] = {
      username: "alice", onboardingStep: "complete",
      provisioning: { status: "complete", openclaw: { slug: "alice" } },
    };
    const { app, store } = mkApp(seed);

    const res = await request(app)
      .post("/users/uid-alice/assign")
      .send({ gatewayId: "target" });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(store.get("gateways/target/assignments/uid-alice")).toMatchObject({ uid: "uid-alice", gatewayId: "target", state: "serving" });
  });

});

describe("POST /gateways/:id/releases/:n/rollback — cut a NEW release from release n's payload", () => {
  const isolatedGateway = { gatewayClass: "builder", imageProfile: "builder", profile: "builder", ownerUid: "uid-user", builderSlug: "builder", sizingTier: "s" };

  it.each([
    { fence: { sourceGatewayId: "gamma", executionId: "transfer-1" }, mirror: "other" },
    { fence: { sourceGatewayId: "source", targetGatewayId: "gamma", executionId: "transfer-1" }, mirror: "other" },
    { fence: {}, mirror: "gamma" },
    { fence: null, mirror: "gamma", malformed: true },
    { fence: false, mirror: "gamma", malformed: true },
  ])("rejects rollback append with retained source fence $fence after operation failure", async ({ fence, mirror, malformed }) => {
    const seed = seedNewSchemaGateway("gamma", sharedPayload(), isolatedGateway);
    seed["gateways/gamma"].latestRelease = 2;
    seed["gateways/gamma"].desiredRelease = 2;
    seed[`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "gamma", release: 2, sourceRelease: 1, note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    seed["users/u1"] = { provisioning: { openclaw: { gatewayId: mirror, sourceTransferFence: fence } } };
    seed[`${GLM_OPERATIONS_COLLECTION}/transfer-1`] = {
      kind: "migrate-user", status: "failed",
      input: { uid: "u1", fromGatewayId: "gamma", toGatewayId: "other" },
    };
    const { app, store } = mkApp(seed);
    const original = structuredClone(store.get("gateways/gamma"));
    const response = await request(app).post("/gateways/gamma/releases/1/rollback").send({});
    if (malformed) {
      expect(response.status).toBe(500);
    } else {
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/source transfer outcome is unresolved/);
    }
    expect(store.get("gateways/gamma")).toEqual(original);
    expect(store.has(`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/3`)).toBe(false);
    expect([...store.values()].filter(doc => doc.kind === "rollout")).toHaveLength(0);
  });

  it("cuts release 3 whose payload equals release 1, never mutating history", async () => {
    // Seed gateway at release 2 (tag deadbee), with release 1 = abc1234 retained.
    const seed = seedNewSchemaGateway("gamma", sharedPayload({ imageTag: "deadbee" }), isolatedGateway);
    seed["gateways/gamma"].latestRelease = 2;
    seed["gateways/gamma"].desiredRelease = 2;
    seed[`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "gamma",
      release: 2,
      sourceRelease: 1,
      note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    seed[`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/1`] = {
      gatewayId: "gamma",
      release: 1,
      sourceRelease: null,
      note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "abc1234" })),
      payload: sharedPayload({ imageTag: "abc1234" }),
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).post("/gateways/gamma/releases/1/rollback").send({}).expect(202);
    expect(res.body).toMatchObject({ gatewayId: "gamma", release: 3, rolledBackFrom: 1 });

    const rel3 = store.get(`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/3`);
    expect((rel3?.payload as ReleasePayload).imageTag).toBe("abc1234");
    expect(rel3).toMatchObject({ sourceRelease: 1 });
    expect(rel3?.note).toMatch(/rollback to release 1/);

    // History untouched: release 1 and 2 unchanged.
    expect(
      (store.get(`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)?.payload as ReleasePayload)
        .imageTag,
    ).toBe("abc1234");
    expect(store.get("gateways/gamma")).toMatchObject({ latestRelease: 3, desiredRelease: 2 });
    expect(opsIn(store, "rollout")).toMatchObject([{ origin: "operator", input: { gatewayId: "gamma" } }]);
  });

  it("refuses to roll back a shared gateway in place", async () => {
    const seed = seedNewSchemaGateway("shared-0", sharedPayload({ imageTag: "deadbee" }), {
      gatewayClass: "shared",
    });
    seed["gateways/shared-0"].latestRelease = 2;
    seed["gateways/shared-0"].desiredRelease = 2;
    seed[`gateways/shared-0/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "shared-0", release: 2, sourceRelease: null, note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    seed[`gateways/shared-0/${GATEWAY_RELEASES_SUBCOLLECTION}/1`] = {
      gatewayId: "shared-0", release: 1, sourceRelease: null, note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "abc1234" })),
      payload: sharedPayload({ imageTag: "abc1234" }),
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).post("/gateways/shared-0/releases/1/rollback").send({}).expect(409);

    expect(res.body).toEqual({ error: ERR_SHARED_GATEWAY_NOT_ROLLED_IN_PLACE, gatewayId: "shared-0" });
    expect(store.get("gateways/shared-0")).toMatchObject({ latestRelease: 2, desiredRelease: 2 });
    expect(store.has(`gateways/shared-0/${GATEWAY_RELEASES_SUBCOLLECTION}/3`)).toBe(false);
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("rejects rolling back to the payload the gateway is already on (no-op)", async () => {
    const { app } = mkApp(seedNewSchemaGateway("gamma", sharedPayload(), isolatedGateway));
    const res = await request(app).post("/gateways/gamma/releases/1/rollback").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no-op rollback/);
  });

  it("404s for an unknown release number", async () => {
    const { app } = mkApp(seedNewSchemaGateway("gamma", sharedPayload(), isolatedGateway));
    const res = await request(app).post("/gateways/gamma/releases/9/rollback").send({});
    expect(res.status).toBe(404);
  });
});

describe("GET /gateways/:id/releases — lists retained release docs", () => {
  it("returns releases newest-first with gateway release bookkeeping", async () => {
    const seed = seedNewSchemaGateway("delta", sharedPayload());
    seed["gateways/delta"].latestRelease = 2;
    seed["gateways/delta"].desiredRelease = 2;
    seed[`gateways/delta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "delta",
      release: 2,
      createdAt: 2000,
      createdBy: "op",
      sourceRelease: 1,
      note: "bump",
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    const { app } = mkApp(seed);

    const res = await request(app).get("/gateways/delta/releases").expect(200);
    expect(res.body).toMatchObject({ gatewayId: "delta", latestRelease: 2, desiredRelease: 2 });
    expect(res.body.releases.map((r: { release: number }) => r.release)).toEqual([2, 1]);
    expect(res.body.releases[0]).toMatchObject({ note: "bump" });
  });

  it("404s for a gateway with no GatewayDoc", async () => {
    const { app } = mkApp();
    const res = await request(app).get("/gateways/nope/releases");
    expect(res.status).toBe(404);
  });
});


describe("PATCH /gateways/:id — updates durable lifecycle", () => {
  it.each([null, false, {}, { attemptId: "restart-1" }])("rejects PATCH while a runtime restart fence remains: %j", async (runtimeRestartFence) => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    seed["gateways/zeta"].runtimeRestartFence = runtimeRestartFence;
    const { app, store } = mkApp(seed);
    const original = structuredClone(store.get("gateways/zeta"));
    const response = await request(app).patch("/gateways/zeta").send({ desiredStatus: "paused" });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/runtime restart outcome is unresolved/);
    expect(store.get("gateways/zeta")).toEqual(original);
  });

  it("pauses only the durable root", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("zeta", sharedPayload()));
    await request(app).patch("/gateways/zeta").send({ desiredStatus: "paused" }).expect(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zeta`)).toBeUndefined();
    expect(store.get("gateways/zeta")?.desiredStatus).toBe("paused");
  });

  it.each([
    { fence: { sourceGatewayId: "zeta", executionId: "transfer-1" }, mirror: "other" },
    { fence: { sourceGatewayId: "source", targetGatewayId: "zeta", executionId: "transfer-1" }, mirror: "other" },
    { fence: {}, mirror: "zeta" },
  ])("blocks root PATCH with a retained transfer fence $fence after operation failure", async ({ fence, mirror }) => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    seed["users/u1"] = { provisioning: { openclaw: { gatewayId: mirror, sourceTransferFence: fence } } };
    seed[`${GLM_OPERATIONS_COLLECTION}/transfer-1`] = {
      kind: "migrate-user", status: "failed",
      input: { uid: "u1", fromGatewayId: "zeta", toGatewayId: "other" },
    };
    const original = structuredClone(seed["gateways/zeta"]);
    const { app, store } = mkApp(seed);
    const response = await request(app).patch("/gateways/zeta").send({ desiredStatus: "paused" });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/source transfer outcome is unresolved/);
    expect(store.get("gateways/zeta")).toEqual(original);
  });

  it.each([null, false])("fails closed on a malformed transfer fence %s without touching the root", async (fence) => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    seed["users/u1"] = { provisioning: { openclaw: { gatewayId: "zeta", sourceTransferFence: fence } } };
    const original = structuredClone(seed["gateways/zeta"]);
    const { app, store } = mkApp(seed);
    const response = await request(app).patch("/gateways/zeta").send({ desiredStatus: "paused" });
    expect(response.status).toBe(500);
    expect(store.get("gateways/zeta")).toEqual(original);
  });

  it("rejects direct ownership PATCHes so they cannot create a standing owner gateway", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("bench", sharedPayload()));

    const res = await request(app)
      .patch("/gateways/bench")
      .send({ gatewayClass: "isolated", ownerUid: "uid-new", userSlug: "new" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disposable lifecycle/);
    expect(res.body.fields).toEqual(["gatewayClass", "ownerUid", "userSlug"]);
    expect(store.get("gateways/bench")).toMatchObject({ gatewayClass: "shared" });
  });

  it("rejects a sizing tier that does not exist before saving or journaling a release", async () => {
    const seed = seedNewSchemaGateway("builder", sharedPayload(), { gatewayClass: "builder", imageProfile: "builder", profile: "builder", ownerUid: "uid-user", builderSlug: "builder", sizingTier: "s" });
    const { app, store } = mkApp(seed);
    const before = { ...store.get("gateways/builder") };
    await request(app).patch("/gateways/builder").send({ sizingTier: "xs" }).expect(400);
    expect(store.get("gateways/builder")).toEqual(before);
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("refuses a malformed durable root rather than mutating it", async () => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    seed["gateways/zeta"] = { ...seed["gateways/zeta"], gatewayId: "other" };
    const { app, store } = mkApp(seed);

    const res = await request(app).patch("/gateways/zeta").send({ sizingTier: "m" });

    expect(res.status).toBe(500);
    expect(store.get("gateways/zeta")?.sizingTier).toBeNull();
  });

  it.each(["pending", "running"])(
    "refuses root config mutation while a %s user migration owns the gateway",
    async (status) => {
      const seed = seedNewSchemaGateway("zeta", sharedPayload());
      seed[`${GLM_OPERATIONS_COLLECTION}/migration-live`] = {
        kind: "migrate-user",
        status,
        input: { fromGatewayId: "source", toGatewayId: "zeta" },
      };
      const { app, store } = mkApp(seed);

      const response = await request(app)
        .patch("/gateways/zeta")
        .send({ sizingTier: "m" });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/user migration.*in flight/i);
      expect(store.get("gateways/zeta")?.sizingTier).toBeNull();
    },
  );

  it("does not overwrite a retirement claim that lands after the route reads the root", async () => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    const { app, store } = mkApp(seed, {
      beforeFirstTransaction: (current) => {
        current.set("gateways/zeta", {
          ...current.get("gateways/zeta"),
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: { operationId: "retire-1", version: 1 },
        });
      },
    });

    const response = await request(app)
      .patch("/gateways/zeta")
      .send({ desiredStatus: "paused" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "gateway has a current retirement claim",
      gatewayId: "zeta",
    });
    expect(store.get("gateways/zeta")?.desiredStatus).toBe("retired");
  });
});

describe("DELETE /gateways/:id — retirement claim", () => {
  it("atomically marks the root retired, binds the intent, and retains release history", async () => {
    const { app, store } = mkApp(seedServingGateway("zed", sharedPayload()));
    const res = await request(app).delete("/gateways/zed");
    expect(res.status).toBe(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zed`)).not.toMatchObject({ desiredStatus: expect.anything() });
    const [retirePath] = [...store.entries()]
      .filter(([path, data]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`) && data.kind === "retire-gateway")
      .map(([path]) => path);
    expect(store.get("gateways/zed")).toMatchObject({
      desiredStatus: "retired",
      retirementVersion: 1,
      retirementClaim: { operationId: retirePath?.split("/")[1], version: 1 },
    });
    expect(opsIn(store, "retire-gateway")[0]?.input).toMatchObject({
      retirementClaimVersion: 1,
    });
    expect(store.get(`gateways/zed/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeDefined();
  });

  it.each(["pending", "running"])(
    "refuses retirement while a %s user migration owns the empty target",
    async (status) => {
      const seed = seedServingGateway("target", sharedPayload());
      seed[`${GLM_OPERATIONS_COLLECTION}/migration-live`] = {
        kind: "migrate-user",
        status,
        input: { fromGatewayId: "source", toGatewayId: "target" },
      };
      const { app, store } = mkApp(seed);

      const response = await request(app).delete("/gateways/target");

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/user migration.*in flight/i);
      expect(store.get("gateways/target")?.desiredStatus).toBe("running");
      expect(opsIn(store, "retire-gateway")).toHaveLength(0);
    },
  );

  it("rejects a legacy-only gateway without a durable root", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/leg`]: { gatewayId: "leg", imageTag: "abc1234" },
    });
    const res = await request(app).delete("/gateways/leg");
    expect(res.status).toBe(404);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/leg`)?.desiredStatus).toBeUndefined();
  });

  it("retires a strict durable root with no bare glm desired doc", async () => {
    const { app, store } = mkApp(seedServingGateway("back", sharedPayload()));
    const res = await request(app).delete("/gateways/back");
    expect(res.status).toBe(202);
    expect(store.get("gateways/back")).toMatchObject({
      desiredStatus: "retired",
      retirementClaim: { version: 1 },
    });
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/back`)).not.toMatchObject({ desiredStatus: expect.anything() });
    // A retire-gateway op is queued for the controller.
    expect(opsIn(store, "retire-gateway")).toHaveLength(1);
  });

  it("refuses retirement when the root's exact live revision still mounts users", async () => {
    const { app, store } = mkApp(
      seedServingGateway("mounted", sharedPayload(), {
        status: "ready",
        mountedCustomers: ["alice"],
      }),
    );

    const res = await request(app).delete("/gateways/mounted").expect(409);

    expect(res.body.mountedUsers).toEqual(["alice"]);
    expect(store.get("gateways/mounted")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("refuses retirement while the desired release has not converged to live", async () => {
    const seed = seedServingGateway("rolling", sharedPayload());
    seed["gateways/rolling"] = {
      ...seed["gateways/rolling"],
      desiredRelease: 2,
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/rolling").expect(409);

    expect(res.body.error).toMatch(/not converged to live/i);
    expect(store.get("gateways/rolling")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("rejects when a new release lands after retirement preflight but before its transactional claim", async () => {
    const { app, store } = mkApp(seedServingGateway("racing-roll", sharedPayload()), {
      beforeFirstTransaction: (state) => {
        state.set("gateways/racing-roll", {
          ...state.get("gateways/racing-roll"),
          desiredRelease: 2,
        });
      },
    });

    await request(app).delete("/gateways/racing-roll").expect(409);

    expect(store.get("gateways/racing-roll")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("refuses retirement when a running root has no runtime realization", async () => {
    const seed = seedNewSchemaGateway("missing-live", sharedPayload());
    seed["gateways/missing-live"] = {
      ...seed["gateways/missing-live"],
      liveRelease: 1,
    };
    seed[`${GLM_GATEWAYS_COLLECTION}/missing-live`] = {
      gatewayId: "missing-live",
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/missing-live").expect(409);

    expect(res.body.error).toContain("runtime telemetry");
    expect(store.get("gateways/missing-live")?.desiredStatus).toBe("running");
  });

  it("refuses (409) with the assigned slugs while assignment docs still exist", async () => {
    const { app, store } = mkApp({
      ...seedNewSchemaGateway("assn", sharedPayload()),
      "gateways/assn/assignments/u1": {
        uid: "u1",
        slug: "alice",
        gatewayId: "assn",
        source: "onboarding",
        state: "serving",
        epoch: 0,
      },
    });
    const res = await request(app).delete("/gateways/assn");
    expect(res.status).toBe(409);
    expect(res.body.assignedUsers).toEqual(["alice"]);
    // Nothing was marked retired and no op was queued.
    expect(store.get("gateways/assn")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });
});

describe("PATCH /gateways/:id — build artifacts remain deploy-only", () => {
  it("updates sizingTier directly on the durable root without cutting a release", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ sizingTier: "m" }).expect(202);
    expect(res.body.updated).toContain("sizingTier");
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/beta`)?.sizingTier).toBeUndefined();
    expect(store.get("gateways/beta")?.sizingTier).toBe("m");
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });

  it("rejects an imageTag PATCH on a gateway with a GatewayDoc", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deploy/);
  });

  it("rejects a sizingTier PATCH on a legacy-only gateway", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/leg`]: {
        gatewayId: "leg",
        imageTag: "abc1234",
        gatewayClass: "shared",
      },
    });
    const res = await request(app).patch("/gateways/leg").send({ sizingTier: "m" });
    expect(res.status).toBe(404);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/leg`)?.sizingTier).toBeUndefined();
  });
});

describe("durable config PATCHes", () => {
  it("updates isolated access and security context on the root without changing a legacy desired doc", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway(
        "bench",
        sharedPayload(),
        {
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          ownerUid: "uid-1",
          builderSlug: "chris",
        },
      ),
    );
    const res = await request(app)
      .patch("/gateways/bench")
      .send({
        userAccess: { controlUiEnabled: true, reason: "debug" },
        gatewayContainerSecurityContext: { runAsNonRoot: true },
      });
    expect(res.status).toBe(202);
    const root = store.get("gateways/bench") as Record<string, unknown>;
    expect(root.builderAccess).toEqual({ controlUiEnabled: true, reason: "debug" });
    expect(root.gatewayContainerSecurityContext).toEqual({ runAsNonRoot: true });
    expect(root.ownerUid).toBe("uid-1");
    expect(root.builderSlug).toBe("chris");
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/bench`)?.builderAccess).toBeUndefined();
  });

  it("rejects an openclawOverrides PATCH because no gateway applies it", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .patch("/gateways/beta")
      .send({ openclawOverrides: { session: { dmScope: "per-channel-peer" } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no updatable fields provided");
    expect(store.get("gateways/beta")?.updatedAt).toBe(1000);
  });

  it("applies explicit null-clears to the root without a release", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway("beta", sharedPayload(), { sizingTier: "l" }),
    );
    const res = await request(app)
      .patch("/gateways/beta")
      .send({ sizingTier: null });
    expect(res.status).toBe(202);
    const root = store.get("gateways/beta") as Record<string, unknown>;
    expect(root.sizingTier).toBeNull();
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });
});

// P1-5: endpoint gaps — create rejects persistence, and the rollout wrapper
// refuses a retired gateway.
describe("P1-5 endpoint gaps", () => {
  it("POST /gateways rejects a submitted persistence spec outright", async () => {
    const { app } = mkApp();
    const res = await request(app).post("/gateways").send({
      gatewayId: "pvc",
      persistence: { enabled: true },
    });
    expect(res.status).toBe(400);
  });

});


describe('POST /gateways/:id/recover-source', () => {
  function sourceRecoveryOf(operation: Record<string, unknown> | undefined): Record<string, unknown> {
    const input = operation?.input;
    if (!isPlainObject(input) || !isPlainObject(input.sourceRecovery)) throw new Error('operation has no input.sourceRecovery');
    return input.sourceRecovery;
  }
  function sourceSeed() {
    const seed = seedNewSchemaGateway('shared-0', sharedPayload());
    seed['gateways/shared-0'].desiredStatus = 'draining';
    seed['gateways/shared-0'].liveRelease = 1;
    for (const [index, slug] of ['jdog99', 'oct01'].entries()) {
      const uid = `source-user-${index}`, agentId = `octogee-${slug}-coach`;
      seed[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: 'shared-0', status: 'complete' } } };
      seed[`gateways/shared-0/assignments/${uid}`] = { uid, slug, gatewayId: 'shared-0', source: 'onboarding', state: 'serving', epoch: index + 1,
        createdAt: 1, updatedAt: 1, updatedByOperationId: null };
      seed[`users/${uid}/agentStores/${agentId}`] = { agentId, gatewayId: 'shared-0', assignmentEpoch: index + 1,
        storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, schema: `source_${index}`, recordedAt: 1 };
    }
    return seed;
  }
  it('journals current complete custody without requiring a failed export', async () => {
    const seed = sourceSeed(), manifest = immutableBuild(), before = structuredClone(seed);
    const { app, store } = mkApp(seed, { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-source').send({ sourceSha: manifest.sourceSha }).expect(202);
    const recovery = sourceRecoveryOf(opsIn(store, 'restart-gateway')[0]);
    expect(recovery.assignments).toHaveLength(2);
    expect(recovery.postgresAgentStores).toHaveLength(2);
    expect(recovery.failedExports).toBeUndefined();
    for (const [key, value] of Object.entries(before)) expect(store.get(key)).toEqual(value);
  });
  it.each(['assignment', 'user', 'anchor', 'active-operation', 'active-transfer'])('rejects changed %s custody before journaling', async change => {
    const seed = sourceSeed(), manifest = immutableBuild();
    if (change === 'assignment') seed['gateways/shared-0/assignments/source-user-0'] = { ...seed['gateways/shared-0/assignments/source-user-0'], epoch: 2 };
    if (change === 'user') seed['users/source-user-0'].username = 'other';
    if (change === 'anchor') delete seed['users/source-user-0/agentStores/octogee-jdog99-coach'];
    if (change === 'active-operation') seed['glmOperations/active'] = { kind: 'migrate-user', status: 'running', input: { fromGatewayId: 'shared-0' } };
    if (change === 'active-transfer') seed['glmMigrationTransferTasks/active'] = { status: 'running', sourceGatewayId: 'shared-0' };
    const { app, store } = mkApp(seed, { releaseAuthority: buildAuthority(manifest) });
    await request(app).post('/gateways/shared-0/recover-source').send({ sourceSha: manifest.sourceSha }).expect(409);
    expect(opsIn(store, 'restart-gateway')).toHaveLength(0);
  });
  it.each([{ sourceSha: 'short' }, { sourceSha: 'a'.repeat(40), restoreAttempt: {} }])('rejects malformed source repair %j', async body => {
    const { app } = mkApp(sourceSeed());
    await request(app).post('/gateways/shared-0/recover-source').send(body).expect(400);
  });
});
