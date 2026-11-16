import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementIsolatedRoutes, type AdminIsolatedCapabilities } from "./admin-placement-isolated-router.js";
import {
  advanceActivationLease,
  completeActivationLease,
  failActivationLease,
  unauditedLifecycleMutations,
  type IsolatedLifecycleDeps,
} from "./isolated-gateway-lifecycle/index.js";
import { assertClientOwnsPlacementAutomation } from "./placement-automation-owner.js";
import { accountSizingKeyReader } from "./sizing-key.js";
import {
  HomeComputeUnavailableError,
  type HomeCapabilities,
  type HomeCapabilitiesFactory,
  type HomeEffect,
  type UserHomeLocation,
} from "./isolated-gateway-lifecycle/index.js";

type Data = Record<string, unknown>;

const OWNER = "uid-alice";
const TARGET = "alice-xs-12345678";
const ACTIVATION = `builder-activate-${TARGET}-g1`;
const RETIREMENT = `placement-retire-${OWNER}-${TARGET}-g1`;
const CLIENT_OWNS = { placementAutomationOwner: "client", placementAutomationYieldedAt: 1_000 };

let docs = new Map<string, Data>();
const accounts = {
  get: async (uid: string) => ({ uid, username: "alice", email: null, displayName: null, lastActive: null, planInputs: {}, usage: {}, mattermostUsername: null }) as never,
};
const warn = vi.fn();
const capabilities: AdminIsolatedCapabilities = {
  namespace: "octogee-test",
  sourceRecoveryPending: () => false,
  ensureAuthSecret: vi.fn(async () => undefined),
  readGatewayPodDiagnostics: vi.fn(async () => ({ status: "missing", totalPods: 0 })),
};

function app(extra: Partial<AdminIsolatedCapabilities> = {}) {
  const store = createDocumentFixtureStore(docs, { serializeTransactions: true });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminPlacementIsolatedRoutes(server, {
    store,
    journal: createAdminFleetMutationRunner(store),
    accounts,
    capabilities: { ...capabilities, ...extra },
    log: vi.fn(),
    warn,
    now: () => 50_000,
  });
  server.use(respondToAdminFleetMutationError);
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

function lease(overrides: Data = {}): Data {
  return {
    leaseId: "lease-one", generation: 1, status: "activating", cause: "run-start", builderSlug: "alice",
    sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 4, entitlementTier: "default", sizingTier: "s",
    targetGatewayId: TARGET, requestedAt: 10_000, activationOperationId: ACTIVATION, ...overrides,
  };
}

function user(gatewayId: string, activationLease: Data): Data {
  return { username: "alice", provisioning: { status: "complete", openclaw: { gatewayId, slug: "alice", activationLease } } };
}

function isolatedRoot(overrides: Data = {}): Data {
  return {
    gatewayId: TARGET, createdAt: 1, createdBy: "test", updatedAt: 5, updatedBy: "test", latestRelease: 1, desiredRelease: 1,
    liveRelease: 1, desiredStatus: "paused", configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated",
    sizingTier: "s", sizingProfile: "default", gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
    serviceAccount: null, builderAccess: null, ownerUid: OWNER, builderSlug: "alice", modelBrokerLimits: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: OWNER },
    ...overrides,
  };
}

function seed(rows: Record<string, Data>, owner: Data | null = CLIENT_OWNS): void {
  docs = new Map(Object.entries({
    ...(owner ? { "config/orchestrator": { ...owner, sizingProfiles: { ...FIXTURE_SIZING_PROFILES, default: FIXTURE_SIZING_PROFILES.hobby } } } : {}),
    ...rows,
  }));
}

function migration(input: Data): Data {
  return { kind: "migrate-user", status: "running", createdBy: "test", createdAt: 1, startedAt: 2, completedAt: null, steps: [], inputUid: input.uid, input };
}

function storedLease(): Data {
  return ((docs.get(`users/${OWNER}`)!.provisioning as Data).openclaw as Data).activationLease as Data;
}

function audits(): Data[] {
  return [...docs.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);
}

function receipts(): string[] {
  return [...docs.keys()].filter((path) => path.includes("placement_receipts"));
}

const advanceBody = { leaseId: "lease-one", generation: 1, fromStatus: "activating", toStatus: "active" };
const advance = (body: Data = advanceBody, query = "") =>
  request(app()).post(`/users/${OWNER}/activation-lease/advance${query}`).send(body);

beforeEach(() => seed({ [`users/${OWNER}`]: user(TARGET, lease()) }));

describe("isolated verbs: owner fence", () => {
  it.each([
    ["no owner recorded", null],
    ["the fleet controller", { placementAutomationOwner: "fleet-controller", placementAutomationYieldedAt: null }],
    ["the client before the yield", { placementAutomationOwner: "client", placementAutomationYieldedAt: null }],
  ])("answers placement-owner and changes nothing while placement automation belongs to %s", async (_name, owner) => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease()) }, owner);

    const res = await advance().expect(409);

    expect(res.body).toMatchObject({ code: "placement-owner" });
    expect(storedLease().status).toBe("activating");
    expect(receipts()).toEqual([]);
    expect(audits()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`POST /users/${OWNER}/activation-lease/advance refused before journaling`));
  });

  it("answers placement-owner to a dry run as well", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease()) }, null);
    await advance(advanceBody, "?dryRun=true").expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
  });
});

describe("POST /users/:uid/activation-lease/advance", () => {
  it("advances the exact lease, writes the receipt and journals the request", async () => {
    const res = await advance().expect(200);

    expect(res.body).toEqual({ uid: OWNER, leaseId: "lease-one", generation: 1, status: "active" });
    expect(storedLease()).toMatchObject({ status: "active", activeAt: 50_000 });
    expect(receipts()).toEqual([`users/${OWNER}/placement_receipts/lease-one-1-activated`]);
    expect(audits()).toEqual([expect.objectContaining({ what: "advance user activation lease", status: "completed" })]);
  });

  it("treats a repeat of an applied advance as done without a second receipt", async () => {
    await advance().expect(200);
    await advance().expect(200);
    expect(receipts()).toHaveLength(1);
  });

  it("refuses a replayed Idempotency-Key", async () => {
    await advance().set("Idempotency-Key", "tick-7").expect(200);
    const res = await advance().set("Idempotency-Key", "tick-7").expect(409);
    expect(res.body).toMatchObject({ status: "completed" });
  });

  it("answers precondition-failed with the reason and changes nothing when the lease moved on", async () => {
    const res = await advance({ ...advanceBody, generation: 2 }).expect(409);

    expect(res.body).toEqual({
      code: "precondition-failed",
      reason: `activation lease for ${OWNER} changed`,
      error: `activation lease for ${OWNER} changed`,
      reasonCode: "isolated-fence",
    });
    expect(storedLease().status).toBe("activating");
    expect(receipts()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("plans a dry run without writing, and refuses one whose fence fails", async () => {
    const planned = await advance(advanceBody, "?dryRun=true").expect(200);
    expect(planned.body).toMatchObject({ dryRun: true, plans: [{ what: "advance user activation lease", kind: "advance-activation-lease" }] });
    expect(storedLease().status).toBe("activating");
    expect(audits()).toEqual([]);

    await advance({ ...advanceBody, generation: 2 }, "?dryRun=true").expect(409)
      .expect((res) => expect(res.body.code).toBe("precondition-failed"));
  });

  it.each([
    ["provisioning", "activating", "activationOperationId", ACTIVATION],
    ["active", "returning", "returnOperationId", `builder-return-${TARGET}-g1`],
  ])("derives the canonical operation id when advancing %s to %s without one", async (fromStatus, toStatus, field, operationId) => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: fromStatus, activationOperationId: undefined })) });

    await advance({ leaseId: "lease-one", generation: 1, fromStatus, toStatus }).expect(200);

    expect(storedLease()).toMatchObject({ status: toStatus, [field]: operationId });
  });

  it.each([
    [{ ...advanceBody, leaseId: "" }, "leaseId is required"],
    [{ ...advanceBody, generation: 0 }, "generation must be a positive integer"],
    [{ ...advanceBody, toStatus: "returning" }, "fromStatus and toStatus must be"],
    [{ ...advanceBody, fromStatus: "provisioning", toStatus: "activating", operationId: "" }, "operationId must be a non-empty string"],
  ])("rejects a malformed request %#", async (body, error) => {
    const res = await advance(body).expect(400);
    expect(res.body.error).toContain(error);
  });

  it.each([
    ["an id that names no operation", "chosen-by-client"],
    ["the canonical id of another generation", `builder-activate-${TARGET}-g2`],
    ["the canonical id of another gateway", "builder-activate-other-gateway-g1"],
    ["another user's operation", "migration-bob"],
    ["the user's operation on another gateway", "migration-elsewhere"],
  ])("answers 400 and journals nothing for %s", async (_name, operationId) => {
    seed({
      [`users/${OWNER}`]: user("shared-blue", lease({ status: "provisioning", activationOperationId: undefined })),
      "glmOperations/migration-bob": migration({ uid: "uid-bob", fromGatewayId: "shared-blue", toGatewayId: TARGET }),
      "glmOperations/migration-elsewhere": migration({ uid: OWNER, fromGatewayId: "shared-blue", toGatewayId: "shared-green" }),
    });

    const res = await advance({ leaseId: "lease-one", generation: 1, fromStatus: "provisioning", toStatus: "activating", operationId }).expect(400);

    expect(res.body.error).toContain(`operationId ${operationId} is not an operation of ${OWNER} on ${TARGET}`);
    expect(storedLease().status).toBe("provisioning");
    expect(audits()).toEqual([]);
  });

  it("answers 400 for a given operation id when the lease has no target gateway", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "provisioning", targetGatewayId: null, activationOperationId: undefined })) });

    const res = await advance({ leaseId: "lease-one", generation: 1, fromStatus: "provisioning", toStatus: "activating", operationId: ACTIVATION }).expect(400);

    expect(res.body.error).toContain("needs the lease's target gateway");
  });
});

describe("POST /users/:uid/activation-lease/complete", () => {
  const complete = (body: Data) => request(app()).post(`/users/${OWNER}/activation-lease/complete`).send(body);

  it("parks the returned lease and records the return", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "returning", activeAt: 30_000, returnOperationId: `builder-return-${TARGET}-g1` })) });

    const res = await complete({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET }).expect(200);

    expect(res.body).toEqual({ uid: OWNER, lease: { leaseId: "lease-one", generation: 1, status: "parked" } });
    expect(docs.get(`users/${OWNER}/placement_receipts/lease-one-1-returned`)).toMatchObject({ retirementOperationId: RETIREMENT });
  });

  it("refuses while the user still runs on the isolated gateway", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: "returning" })) });

    const res = await complete({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET }).expect(409);

    expect(res.body.reason).toBe(`User ${OWNER} has not returned from ${TARGET}`);
    expect(storedLease().status).toBe("returning");
  });
});

describe("POST /users/:uid/activation-lease/fail", () => {
  const fail = (body: Data) => request(app()).post(`/users/${OWNER}/activation-lease/fail`).send(body);
  const failure = { leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, message: "target prepare failed" };

  it("fails the exact lease once and answers the repeat as done", async () => {
    await fail(failure).expect(200).expect((res) => expect(res.body.status).toBe("failed"));
    await fail(failure).expect(200);
    expect(storedLease()).toMatchObject({ status: "failed", lastError: { code: "activation-migration-failed", operationId: ACTIVATION } });
    expect(receipts()).toEqual([`users/${OWNER}/placement_receipts/lease-one-1-activation-failed`]);
  });

  it("refuses a lease that is not provisioning or activating", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: "active" })) });
    await fail(failure).expect(409).expect((res) => expect(res.body.code).toBe("precondition-failed"));
    expect(storedLease().status).toBe("active");
  });

  describe("while the failed activation is still recovering its source", () => {
    const recovering = { sourceRecoveryPending: (operation: { id: string; schedulerHandoffReleased?: unknown }) =>
      operation.id === ACTIVATION && operation.schedulerHandoffReleased === false };
    const failVia = (body: Data, query = "") =>
      request(app(recovering)).post(`/users/${OWNER}/activation-lease/fail${query}`).send(body);
    const activation = (released: boolean) => ({ ...migration({ uid: OWNER }), status: "failed", completedAt: 3, schedulerHandoffReleased: released });

    it.each(["", "?dryRun=true"])("refuses with source-recovery-pending (query %j) and leaves the lease activating", async (query) => {
      seed({ [`users/${OWNER}`]: user("shared-blue", lease()), [`glmOperations/${ACTIVATION}`]: activation(false) });

      const res = await failVia(failure, query).expect(409);

      expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "source-recovery-pending", error: `operation ${ACTIVATION} is still recovering its source` });
      expect(storedLease().status).toBe("activating");
      expect(receipts()).toEqual([]);
    });

    it("fails the lease once the source recovery is released", async () => {
      seed({ [`users/${OWNER}`]: user("shared-blue", lease()), [`glmOperations/${ACTIVATION}`]: activation(true) });

      await failVia(failure).expect(200);

      expect(storedLease().status).toBe("failed");
    });
  });

  it("answers 400 and journals nothing for an operation id that is not the lease's", async () => {
    const res = await fail({ ...failure, operationId: `builder-activate-${TARGET}-g2` }).expect(400);

    expect(res.body.error).toContain(`is not an operation of ${OWNER} on ${TARGET} generation 1`);
    expect(storedLease().status).toBe("activating");
    expect(audits()).toEqual([]);
  });
});

describe("POST /users/:uid/activation-lease/sizing-transition", () => {
  const transition = (body: Data, query = "") => request(app()).post(`/users/${OWNER}/activation-lease/sizing-transition${query}`).send(body);

  it("asks an active lease to return so the next one uses the current profile", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: "active" })) });

    await transition({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, sizingKey: "default" }).expect(200);

    expect(storedLease()).toMatchObject({ status: "active", returnReason: "tier-change", pendingDemand: { cause: "manual", eventKey: "tier:lease-one:1:default" } });
  });

  it("writes the verb's single journal entry", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: "active" })) });

    await transition({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, sizingKey: "default" }).expect(200);

    expect(audits()).toEqual([expect.objectContaining({ what: "request user sizing transition", status: "completed" })]);
  });

  it("refuses a dry run, as the real call does, when the sizing key's profile is not isolated", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: "active" })) });
    docs.set("config/orchestrator", { ...CLIENT_OWNS, sizingProfiles: { ...FIXTURE_SIZING_PROFILES, default: { isolation: "shared" } } });

    for (const query of ["?dryRun=true", ""]) {
      const res = await transition({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, sizingKey: "default" }, query).expect(409);
      expect(res.body.reason).toBe("User tier requires an operator-selected VM policy");
    }
    expect(storedLease().returnReason).toBeUndefined();
  });

  it("refuses a sizing key the user is not entitled to", async () => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: "active" })) });

    const res = await transition({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, sizingKey: "pro" }).expect(409);

    expect(res.body.reason).toBe("User tier transition authority changed");
    expect(storedLease().returnReason).toBeUndefined();
  });
});

describe("POST /isolated-gateways/:id/retire-owned", () => {
  const retire = (body: Data, query = "") => request(app()).post(`/isolated-gateways/${TARGET}/retire-owned${query}`).send(body);
  const body = { ownerUid: OWNER, generation: 1, leaseId: "lease-one", reason: "builder-returned" };

  it("claims the retirement under the deterministic operation id", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })), [`gateways/${TARGET}`]: isolatedRoot() });

    const res = await retire(body).expect(200);

    expect(res.body).toEqual({ gatewayId: TARGET, operationId: RETIREMENT, retired: true });
    expect(docs.get(`gateways/${TARGET}`)).toMatchObject({ desiredStatus: "retired", retirementClaim: { operationId: RETIREMENT } });
    expect(docs.get(`glmOperations/${RETIREMENT}`)).toMatchObject({ kind: "retire-gateway", input: { userSlug: "alice", reason: "builder-returned" } });
  });

  it("answers the blocking reason and changes nothing when the allocation moved on", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })), [`gateways/${TARGET}`]: isolatedRoot() });

    const res = await retire({ ...body, leaseId: "lease-two" }).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reason: `gateway ${TARGET} no longer matches isolated allocation for ${OWNER}` });
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
  });

  it("refuses a gateway owned by someone else", async () => {
    seed({ [`gateways/${TARGET}`]: isolatedRoot({ ownerUid: "uid-bob" }) });
    await retire(body).expect(409).expect((res) => expect(res.body).toMatchObject({
      reason: `gateway ${TARGET} is not owned by ${OWNER}`, reasonCode: "gateway-not-owned",
    }));
  });

  it("answers retirement-blocked when a retirement fence fails", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })), [`gateways/${TARGET}`]: isolatedRoot() });

    const res = await retire({ ...body, leaseId: "lease-two" }).expect(409);

    expect(res.body.reasonCode).toBe("retirement-blocked");
  });

  describe("for a failed activation still recovering its source", () => {
    const recovering = { sourceRecoveryPending: (operation: { id: string; schedulerHandoffReleased?: unknown }) =>
      operation.id === ACTIVATION && operation.schedulerHandoffReleased === false };
    const retireVia = (query = "") => request(app(recovering)).post(`/isolated-gateways/${TARGET}/retire-owned${query}`)
      .send({ ...body, reason: "activation-failed" });
    const activation = (released: boolean) => ({ ...migration({ uid: OWNER }), status: "failed", completedAt: 3, schedulerHandoffReleased: released });

    it.each(["", "?dryRun=true"])("refuses with source-recovery-pending (query %j) and claims nothing", async (query) => {
      seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "failed" })), [`gateways/${TARGET}`]: isolatedRoot(),
        [`glmOperations/${ACTIVATION}`]: activation(false) });

      const res = await retireVia(query).expect(409);

      expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "source-recovery-pending" });
      expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
      expect(docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
    });

    it("retires once the source recovery is released", async () => {
      seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "failed" })), [`gateways/${TARGET}`]: isolatedRoot(),
        [`glmOperations/${ACTIVATION}`]: activation(true) });

      await retireVia().expect(200);

      expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("retired");
    });
  });

  it.each([
    ["the lease identity", { leaseId: "lease-two" }],
    ["the authority fence", { authoritativeGatewayId: "shared-green", authoritativeLeaseStatus: "returning" }],
    ["the zero-workload receipt", { zeroWorkloadRecoveryOperationId: `builder-recover-${TARGET}-g1` }],
    ["the telemetry fence", { telemetryFenceOperationId: `builder-return-${TARGET}-g1`, telemetryFenceStatus: "succeeded" }],
  ])("refuses a dry run on %s, as the real call does, and claims nothing", async (_name, fence) => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })), [`gateways/${TARGET}`]: isolatedRoot() });

    const planned = await retire({ ...body, ...fence }, "?dryRun=true").expect(409);
    const real = await retire({ ...body, ...fence }).expect(409);

    expect(planned.body).toMatchObject({ code: "precondition-failed" });
    expect(planned.body.reason).toBe(real.body.reason);
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
  });

  it("answers 400 and writes nothing when the telemetry fence names another user's finished operation", async () => {
    seed({
      [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })),
      [`gateways/${TARGET}`]: isolatedRoot(),
      "glmOperations/return-bob": { ...migration({ uid: "uid-bob", fromGatewayId: "bob-xs-1", toGatewayId: "shared-blue" }), status: "succeeded", completedAt: 40_000 },
    });

    const res = await retire({ ...body, telemetryFenceOperationId: "return-bob", telemetryFenceStatus: "succeeded" }).expect(400);

    expect(res.body.error).toContain(`operationId return-bob is not an operation of ${OWNER} on ${TARGET} generation 1`);
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
    expect(audits()).toEqual([]);
  });

  it.each([
    ["the canonical return operation", `builder-return-${TARGET}-g1`],
    ["an adopted return migration of the user on the gateway", "return-9"],
  ])("retires behind %s once it has finished", async (_name, operationId) => {
    seed({
      [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })),
      [`gateways/${TARGET}`]: isolatedRoot(),
      [`glmOperations/${operationId}`]: { ...migration({ uid: OWNER, fromGatewayId: TARGET, toGatewayId: "shared-blue" }), status: "succeeded", completedAt: 40_000 },
    });

    await retire({ ...body, telemetryFenceOperationId: operationId, telemetryFenceStatus: "succeeded" }).expect(200);

    expect(docs.get(`gateways/${TARGET}`)).toMatchObject({ desiredStatus: "retired", retirementClaim: { operationId: RETIREMENT } });
  });

  it("plans a dry run without claiming", async () => {
    seed({ [`gateways/${TARGET}`]: isolatedRoot() });
    await retire(body, "?dryRun=true").expect(200).expect((res) => expect(res.body.dryRun).toBe(true));
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
  });

  it("rejects an unknown reason", async () => {
    const res = await retire({ ...body, reason: "because" }).expect(400);
    expect(res.body.error).toMatch(/^reason must be one of /);
  });
});

function sharedRoot(): Data {
  return {
    gatewayId: "shared-blue", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test", latestRelease: 3, desiredRelease: 3,
    liveRelease: 3, desiredStatus: "running", configSchemaVersion: 1, profile: "standard", gatewayClass: "shared", imageProfile: "standard",
    sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
    builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, allocation: null,
  };
}

const sharedAssignment = (epoch: number): Data =>
  ({ uid: OWNER, slug: "alice", gatewayId: "shared-blue", source: "onboarding", state: "serving", epoch, createdAt: 1, updatedAt: 1 });

describe("POST /users/:uid/isolated-gateway/allocate", () => {
  const releasePayload = {
    imageRepository: "registry/images/octogee-gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}`,
    profileImages: { builder: { imageRepository: "registry/images/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } },
    gatewayEdgeImage: { imageRepository: "registry/images/gateway-edge", imageTag: `abc1234@sha256:${"c".repeat(64)}` },
  };
  const requested = lease({ status: "requested", targetGatewayId: undefined, activationOperationId: undefined });
  const body = { leaseId: "lease-one", generation: 1, sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 4, sizingKey: "default", sizingTier: "s" };
  const allocate = (payload: Data = body, query = "") => request(app()).post(`/users/${OWNER}/isolated-gateway/allocate${query}`).send(payload);
  const isolatedRoots = () => [...docs.keys()].filter((path) => /^gateways\/alice-[^/]+$/.test(path));
  const preparedFor = { leaseId: "lease-one", generation: 1, sizingKey: "default" };
  const withHome = (homeMigration: Data | null): Data => {
    const record = user("shared-blue", requested);
    return homeMigration ? { ...record, provisioning: { ...(record.provisioning as Data), homeMigration } } : record;
  };

  beforeEach(() => {
    vi.mocked(capabilities.ensureAuthSecret).mockClear();
    seed({
      [`users/${OWNER}`]: withHome({ id: "home-copy-1", phase: "complete", tier: "default", preparedFor }),
      "gateways/shared-blue": sharedRoot(),
      "gateways/shared-blue/releases/3": { gatewayId: "shared-blue", release: 3, payload: releasePayload },
      [`gateways/shared-blue/assignments/${OWNER}`]: sharedAssignment(4),
    });
  });

  it("creates the auth secret, writes the isolated gateway and moves the lease to provisioning", async () => {
    const res = await allocate().expect(200);

    expect(res.body).toEqual({ uid: OWNER, gatewayId: expect.stringMatching(/^alice-/), outcome: "allocated" });
    const gatewayId = res.body.gatewayId as string;
    expect(capabilities.ensureAuthSecret).toHaveBeenCalledWith({ namespace: "octogee-test", gatewayId });
    expect(docs.get(`gateways/${gatewayId}`)).toMatchObject({ gatewayClass: "isolated", ownerUid: OWNER, desiredStatus: "running" });
    expect(storedLease()).toMatchObject({ status: "provisioning", targetGatewayId: gatewayId });
  });

  it("answers the same allocation when repeated", async () => {
    const first = await allocate().expect(200);
    const second = await allocate().expect(200);

    expect(second.body).toEqual(first.body);
    expect(isolatedRoots()).toEqual([`gateways/${first.body.gatewayId}`]);
  });

  it("answers the committed allocation when repeated after the home record was replaced", async () => {
    const first = await allocate().expect(200);
    const stored = docs.get(`users/${OWNER}`)!;
    docs.set(`users/${OWNER}`, { ...stored, provisioning: { ...(stored.provisioning as Data), homeMigration: { id: "home-copy-2", phase: "copying", tier: "default" } } });

    const second = await allocate().expect(200);

    expect(second.body).toEqual(first.body);
    expect(isolatedRoots()).toEqual([`gateways/${first.body.gatewayId}`]);
  });

  it("refreshes a lease whose source assignment moved and allocates nothing", async () => {
    docs.set(`gateways/shared-blue/assignments/${OWNER}`, sharedAssignment(5));

    const res = await allocate().expect(200);

    expect(res.body).toEqual({ uid: OWNER, gatewayId: null, outcome: "refreshed" });
    expect(storedLease()).toMatchObject({ status: "requested", sourceAssignmentEpoch: 5 });
    expect(audits()).toEqual([expect.objectContaining({ what: "allocate isolated gateway", status: "completed" })]);
    expect(isolatedRoots()).toEqual([]);
    expect(capabilities.ensureAuthSecret).not.toHaveBeenCalled();
  });

  it("answers precondition-failed and writes nothing when the lease is another lease", async () => {
    docs.set(`users/${OWNER}`, withHome({ id: "home-copy-1", phase: "complete", tier: "default", preparedFor: { ...preparedFor, leaseId: "lease-two" } }));

    const res = await allocate({ ...body, leaseId: "lease-two" }).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reason: `isolated gateway demand fence changed for ${OWNER}` });
    expect(storedLease().status).toBe("requested");
    expect(isolatedRoots()).toEqual([]);
  });

  it.each([
    ["no home preparation is stored", null],
    ["the home copy is still running", { id: "home-copy-1", phase: "copying", tier: "default", preparedFor }],
    ["the home was prepared for another lease", { id: "home-copy-1", phase: "complete", tier: "default", preparedFor: { ...preparedFor, leaseId: "lease-zero" } }],
    ["the home was prepared for another generation", { id: "home-copy-1", phase: "complete", tier: "default", preparedFor: { ...preparedFor, generation: 2 } }],
    ["the home was prepared for another sizing key", { id: "home-copy-1", phase: "complete", tier: "pro", preparedFor: { ...preparedFor, sizingKey: "pro" } }],
    ["a migration completed without a preparation record", { id: "home-copy-1", phase: "complete", tier: "default" }],
  ])("refuses a VM-sized user, before any effect, when %s", async (_name, homeMigration) => {
    docs.set(`users/${OWNER}`, withHome(homeMigration));
    const before = structuredClone([...docs.entries()]);

    for (const query of ["?dryRun=true", ""]) {
      const res = await allocate(body, query).expect(409);
      expect(res.body).toMatchObject({
        code: "precondition-failed",
        reason: `home for ${OWNER} is not prepared for lease lease-one generation 1 sizing key default`,
      });
    }

    expect(capabilities.ensureAuthSecret).not.toHaveBeenCalled();
    expect([...docs.entries()].filter(([path]) => !path.startsWith("glmOperations/audit-"))).toEqual(before);
    expect(audits()).toEqual([expect.objectContaining({ what: "allocate isolated gateway", status: "failed" })]);
  });

  it("plans a dry run without creating the secret or the gateway", async () => {
    await allocate(body, "?dryRun=true").expect(200).expect((res) => expect(res.body.dryRun).toBe(true));

    expect(capabilities.ensureAuthSecret).not.toHaveBeenCalled();
    expect(isolatedRoots()).toEqual([]);
  });

  it("plans a dry run of a repeat after the allocation committed", async () => {
    await allocate().expect(200);
    await allocate(body, "?dryRun=true").expect(200).expect((res) => expect(res.body.dryRun).toBe(true));
  });

  it("refuses a dry run the fence would refuse", async () => {
    await allocate({ ...body, leaseId: "lease-two" }, "?dryRun=true").expect(409)
      .expect((res) => expect(res.body.code).toBe("precondition-failed"));
  });

  it("answers placement-owner before the fleet controller yields", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", requested) }, { placementAutomationOwner: "client", placementAutomationYieldedAt: null });
    await allocate().expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
    expect(capabilities.ensureAuthSecret).not.toHaveBeenCalled();
  });

  it("rejects an unknown sizing tier", async () => {
    const res = await allocate({ ...body, sizingTier: "xl" }).expect(400);
    expect(res.body.error).toBe("sizingTier must be s, m or l");
  });
});

describe("POST /isolated-gateways/:id/recover-unreachable", () => {
  const RECOVERY = `builder-recover-${TARGET}-g1`;
  const body = { ownerUid: OWNER, leaseId: "lease-one", generation: 1, authoritativeGatewayId: "shared-blue", sourceUnavailable: true };
  const recover = (payload: Data = body, query = "") =>
    request(app()).post(`/isolated-gateways/${TARGET}/recover-unreachable${query}`).send(payload);
  const diagnostics = vi.mocked(capabilities.readGatewayPodDiagnostics);
  const receipt = () => docs.get(`gatewayRecoveryReceipts/${RECOVERY}`) ?? null;

  beforeEach(() => {
    diagnostics.mockReset();
    diagnostics.mockResolvedValue({ status: "missing", totalPods: 0 });
    seed({
      [`users/${OWNER}`]: user("shared-blue", lease({ status: "returning", returnReason: "source-unavailable" })),
      [`gateways/${TARGET}`]: isolatedRoot({ desiredStatus: "running" }),
      [`gateways/shared-blue/assignments/${OWNER}`]: sharedAssignment(4),
    });
  });

  it("pauses the gateway and records the recovery once no pods remain", async () => {
    const res = await recover().expect(200);

    expect(res.body).toEqual({ gatewayId: TARGET, state: "recovered", operationId: RECOVERY });
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(receipt()).toMatchObject({ status: "succeeded", recoveryReceipt: { schemaVersion: 1, pods: 0 } });
  });

  it.each(["", "?dryRun=true"])("refuses with source-recovery-pending (query %j) while the failed activation recovers its source", async (query) => {
    docs.set(`glmOperations/${ACTIVATION}`, { ...migration({ uid: OWNER }), status: "failed", completedAt: 3, schedulerHandoffReleased: false });
    const recovering = { sourceRecoveryPending: (operation: { id: string; schedulerHandoffReleased?: unknown }) =>
      operation.id === ACTIVATION && operation.schedulerHandoffReleased === false };

    const res = await request(app(recovering)).post(`/isolated-gateways/${TARGET}/recover-unreachable${query}`).send(body).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "source-recovery-pending" });
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("running");
    expect(receipt()).toBeNull();
  });

  it("answers precondition-failed and writes nothing when the reservation fence fails", async () => {
    const res = await recover({ ...body, authoritativeGatewayId: "shared-green" }).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reason: `User ${OWNER} is no longer authoritative on shared-green` });
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("running");
    expect(receipt()).toBeNull();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it.each([
    ["the pods cannot be observed", async () => ({ status: "unknown", totalPods: 0 }), "observation-unknown"],
    ["the diagnostics read fails", async () => { throw new Error("kubectl timed out"); }, "observation-unknown"],
    ["pods remain", async () => ({ status: "running", totalPods: 1 }), "pods-present"],
  ])("keeps the reservation and answers waiting when %s, then recovers on the repeat call", async (_name, read, reason) => {
    diagnostics.mockImplementationOnce(read as never);

    const waiting = await recover().expect(200);

    expect(waiting.body).toEqual({ gatewayId: TARGET, state: "waiting", reason, operationId: RECOVERY });
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(receipt()).toMatchObject({ status: "pending" });

    const repeated = await recover().expect(200);

    expect(repeated.body).toEqual({ gatewayId: TARGET, state: "recovered", operationId: RECOVERY });
    expect(receipt()).toMatchObject({ status: "succeeded" });
    expect(audits().map((audit) => [audit.outcome, audit.partialOutcome ?? null])).toEqual([
      ["partial", { summary: `waiting: ${reason}`, details: { state: "waiting", reason, operationId: RECOVERY } }],
      ["completed", null],
    ]);
  });

  it("answers precondition-failed and leaves the reservation when the fence fails after reserving", async () => {
    diagnostics.mockImplementationOnce(async () => {
      docs.set(`gateways/shared-blue/assignments/${OWNER}`, { ...sharedAssignment(4), state: "migrating" });
      return { status: "missing", totalPods: 0 };
    });

    const res = await recover().expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reason: `User ${OWNER} is no longer authoritative on shared-blue` });
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(receipt()).toMatchObject({ status: "pending" });
  });

  it("plans a dry run without reserving or reading the pods", async () => {
    await recover(body, "?dryRun=true").expect(200).expect((res) => expect(res.body.dryRun).toBe(true));

    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("running");
    expect(receipt()).toBeNull();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("refuses a dry run the reservation fence would refuse", async () => {
    await recover({ ...body, authoritativeGatewayId: "shared-green" }, "?dryRun=true").expect(409)
      .expect((res) => expect(res.body.code).toBe("precondition-failed"));
    expect(receipt()).toBeNull();
  });

  it("answers placement-owner and does not reserve before the fleet controller yields", async () => {
    seed({ [`gateways/${TARGET}`]: isolatedRoot({ desiredStatus: "running" }) }, null);
    await recover().expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("running");
    expect(diagnostics).not.toHaveBeenCalled();
  });
});

describe("the verbs express every in-process lease call", () => {
  const RETURN = `builder-return-${TARGET}-g1`;
  const RECOVERY = `builder-recover-${TARGET}-g1`;
  type Verb = "advance" | "complete" | "fail";
  interface CallSite { site: string; current: string; lease: Data; operations?: Record<string, Data>; verb: Verb; body: Data }

  const provisioning = lease({ status: "provisioning", activationOperationId: undefined });
  const active = lease({ status: "active", activeAt: 30_000 });
  const returning = lease({ status: "returning", activeAt: 30_000, returnOperationId: RETURN });
  const identity = { leaseId: "lease-one", generation: 1 };
  const adoptedMove = { "glmOperations/move-in-7": migration({ uid: OWNER, fromGatewayId: "shared-blue", toGatewayId: TARGET }) };
  const adoptedReturn = { "glmOperations/return-9": migration({ uid: OWNER, fromGatewayId: TARGET, toGatewayId: "shared-blue" }) };

  const sites: CallSite[] = [
    { site: "adopted move-in migration (policy :710)", current: "shared-blue", lease: provisioning, operations: adoptedMove, verb: "advance",
      body: { ...identity, fromStatus: "provisioning", toStatus: "activating", operationId: "move-in-7" } },
    { site: "enqueued move-in migration (policy :729)", current: "shared-blue", lease: provisioning, verb: "advance",
      body: { ...identity, fromStatus: "provisioning", toStatus: "activating", operationId: ACTIVATION } },
    { site: "already on the target while provisioning (policy :766)", current: TARGET, lease: provisioning, verb: "advance",
      body: { ...identity, fromStatus: "provisioning", toStatus: "active" } },
    { site: "activation cutover observed (policy :851)", current: TARGET, lease: lease(), verb: "advance",
      body: { ...identity, fromStatus: "activating", toStatus: "active" } },
    { site: "adopted return migration (policy :932)", current: TARGET, lease: active, operations: adoptedReturn, verb: "advance",
      body: { ...identity, fromStatus: "active", toStatus: "returning", operationId: "return-9" } },
    { site: "enqueued return migration (policy :963)", current: TARGET, lease: active, verb: "advance",
      body: { ...identity, fromStatus: "active", toStatus: "returning", operationId: RETURN } },
    { site: "completed return observed (policy :1025)", current: "shared-blue", lease: active, verb: "advance",
      body: { ...identity, fromStatus: "active", toStatus: "returning", operationId: RETURN } },
    { site: "unreachable target recovered (policy :517)", current: "shared-blue", lease: provisioning, verb: "fail",
      body: { ...identity, targetGatewayId: TARGET, operationId: RECOVERY, message: "disposable gateway did not become reachable before timeout" } },
    { site: "authorization ended (policy :624)", current: "shared-blue", lease: provisioning, verb: "fail",
      body: { ...identity, targetGatewayId: TARGET, operationId: `builder-authorization-ended-${TARGET}`, message: "User authorization ended before activation cutover" } },
    { site: "target retired before cutover (policy :776)", current: "shared-blue", lease: provisioning, verb: "fail",
      body: { ...identity, targetGatewayId: TARGET, operationId: RETIREMENT, message: "disposable gateway retired before activation cutover completed" } },
    { site: "activation migration failed (policy :896)", current: "shared-blue", lease: lease(), verb: "fail",
      body: { ...identity, targetGatewayId: TARGET, operationId: ACTIVATION, message: "activation migration failed" } },
    { site: "target already retired (policy :1181)", current: "shared-blue", lease: returning, verb: "complete",
      body: { ...identity, targetGatewayId: TARGET } },
    { site: "returned computer stays parked (policy :1190)", current: "shared-blue", lease: returning, verb: "complete",
      body: { ...identity, targetGatewayId: TARGET, parked: true } },
    { site: "unreachable target recovered on return (policy :1206)", current: "shared-blue", lease: returning, verb: "complete",
      body: { ...identity, targetGatewayId: TARGET } },
    { site: "target retired after return (policy :1252)", current: "shared-blue", lease: returning, verb: "complete",
      body: { ...identity, targetGatewayId: TARGET } },
  ];

  function inProcess(verb: Verb, deps: IsolatedLifecycleDeps, body: Data): Promise<void> {
    const call = { uid: OWNER, ...body } as never;
    if (verb === "advance") return advanceActivationLease(deps, call);
    if (verb === "fail") return failActivationLease(deps, call);
    return completeActivationLease(deps, call);
  }

  function stored(rows: Map<string, Data>): [string, Data][] {
    return [...rows.entries()].filter(([path]) => !path.startsWith("glmOperations/audit-")).sort(([a], [b]) => a.localeCompare(b));
  }

  it.each(sites)("$site stores what the in-process call stores", async ({ current, lease: seeded, operations, verb, body }) => {
    seed({ [`users/${OWNER}`]: user(current, seeded), ...operations });
    const twin = new Map(structuredClone([...docs.entries()]));
    const twinStore = createDocumentFixtureStore(twin, { serializeTransactions: true });
    const before = structuredClone(stored(twin));

    await request(app()).post(`/users/${OWNER}/activation-lease/${verb}`).send(body).expect(200);
    await inProcess(verb, {
      store: twinStore,
      readSizingKey: accountSizingKeyReader(accounts),
      requireOwner: async (transaction) => { await assertClientOwnsPlacementAutomation(transaction); },
      mutations: unauditedLifecycleMutations,
      now: () => 50_000,
      log: vi.fn(),
      sourceRecoveryPending: () => false,
    }, body);

    expect(stored(docs)).toEqual(stored(twin));
    expect(stored(docs)).not.toEqual(before);
  });
});

describe("POST /users/:uid/home/prepare", () => {
  const source = { runtime: "gce-vm" as const, layout: "portable" as const, disk: { projectId: "octogee-test", zone: "us-central1-a", name: "old-home", source: "projects/octogee-test/zones/us-central1-a/disks/old-home", id: "100", sizeGb: 100, diskType: "pd-balanced" as const } };
  const target = { ...source.disk, name: "new-home", id: "200", sizeGb: 10, source: "projects/octogee-test/zones/us-central1-a/disks/new-home" };
  const body = { leaseId: "lease-one", generation: 1, sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 4, sizingKey: "default", sizingTier: "s" };
  const requested = lease({ status: "requested", targetGatewayId: undefined, activationOperationId: undefined });
  let home: ReturnType<typeof fakeHome>;

  function fakeHome() {
    let record: ((effect: HomeEffect) => void) | null = null;
    const effect = <T>(name: string, resource: string, value: T) => async () => { record?.({ name, resource }); return value; };
    const capabilities = {
      environment: "test", subnetwork: "subnet", nativeZones: ["us-central1-a"] as readonly string[],
      nativeZone: vi.fn(async (): Promise<string | null> => null),
      inventory: vi.fn(async (): Promise<UserHomeLocation | null> =>
        ((docs.get(`users/${OWNER}`)!.provisioning as Data).homeStorage as UserHomeLocation | undefined) ?? source),
      verifyStopped: vi.fn(async () => undefined),
      copy: {
        advance: vi.fn(effect("start-builder-home-copy", "zones/us-central1-a/instances/home-copy", {
          progress: { status: "ready" as const, filesystem: "btrfs" as const, usedBytes: 1024, proof: { "volumes/data": "a".repeat(64), "desktop-home": "b".repeat(64) } }, target,
        }) as HomeCapabilities["copy"]["advance"]),
        release: vi.fn(effect("remove-home-copy-helper", "zones/us-central1-a/instances/home-copy", true)),
        abort: vi.fn(async () => true),
      },
      adopt: vi.fn(effect("attach-verified-builder-home", "zones/us-central1-a/instances/alice-vm", true)),
      removeStoppedHome: vi.fn(async () => true),
    };
    const calls = () => [capabilities.nativeZone, capabilities.inventory, capabilities.verifyStopped, capabilities.copy.advance, capabilities.copy.release,
      capabilities.copy.abort, capabilities.adopt, capabilities.removeStoppedHome].reduce((total, call) => total + call.mock.calls.length, 0);
    const factory: HomeCapabilitiesFactory = (recorder) => { record = recorder; return capabilities; };
    return { capabilities, calls, factory };
  }

  const prepare = (payload: Data = body, query = "") => request(app({ home: home.factory })).post(`/users/${OWNER}/home/prepare${query}`).send(payload);
  const homeMigration = () => ((docs.get(`users/${OWNER}`)!.provisioning as Data).homeMigration ?? null) as Data | null;

  beforeEach(() => {
    home = fakeHome();
    seed({ [`users/${OWNER}`]: user("shared-blue", requested) });
  });

  it("is not mounted without the home capabilities", async () => {
    const response = await request(app()).post(`/users/${OWNER}/home/prepare`).send(body);

    expect(response.status).toBe(404);
    expect(home.calls()).toBe(0);
  });

  it("answers placement-owner before any Compute Engine call", async () => {
    seed({ [`users/${OWNER}`]: user("shared-blue", requested) }, null);
    await prepare().expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
    expect(home.calls()).toBe(0);
    expect(audits()).toEqual([]);
  });

  it("advances one step per call, journaling the step and its effects, until the home is ready for the lease", async () => {
    const first = await prepare().expect(200);
    expect(first.body).toEqual({ uid: OWNER, state: "in-progress", step: "releasing", effects: [{ name: "start-builder-home-copy", resource: "zones/us-central1-a/instances/home-copy" }] });
    await prepare().expect(200).expect((res) => expect(res.body).toMatchObject({ state: "in-progress", step: "adopting" }));
    await prepare().expect(200).expect((res) => expect(res.body).toMatchObject({ state: "ready", effects: [{ name: "attach-verified-builder-home" }] }));
    await prepare().expect(200).expect((res) => expect(res.body).toEqual({ uid: OWNER, state: "ready", effects: [] }));

    expect(homeMigration()).toMatchObject({ phase: "complete", preparedFor: { leaseId: "lease-one", generation: 1, sizingKey: "default" } });
    expect(audits().map((audit) => [audit.outcome, (audit.partialOutcome as Data | undefined)?.summary ?? null])).toEqual([
      ["partial", "in-progress: releasing"],
      ["partial", "in-progress: adopting"],
      ["partial", "ready"],
      ["completed", null],
    ]);
    expect((audits()[0]!.partialOutcome as Data).details).toMatchObject({ step: "releasing", effects: [{ name: "start-builder-home-copy" }] });
  });

  it("answers in-progress with the error code, journaled as failed, when Compute Engine is unavailable", async () => {
    await prepare().expect(200);
    home.capabilities.copy.release.mockRejectedValueOnce(new HomeComputeUnavailableError("http-503", "remove-home-copy-helper: HTTP 503"));

    const res = await prepare().expect(200);

    expect(res.body).toEqual({ uid: OWNER, state: "in-progress", step: "releasing", lastError: { code: "http-503" }, effects: [] });
    expect(homeMigration()).toMatchObject({ phase: "releasing" });
    expect(audits().at(-1)).toMatchObject({ status: "failed", error: "compute unavailable at releasing: http-503" });
  });

  it("answers 500, journaled as failed with the effects it performed, when the state it left is unknown", async () => {
    home.capabilities.copy.advance.mockImplementationOnce(async () => {
      throw new Error("home copy target identity/capacity differs");
    });

    await prepare().expect(500);

    expect(audits().at(-1)).toMatchObject({ status: "failed", error: "home copy target identity/capacity differs" });
  });

  it("answers precondition-failed and journals the effects it performed when a fence fails after a Compute Engine effect", async () => {
    await prepare().expect(200);
    await prepare().expect(200);
    const adopt = home.capabilities.adopt.getMockImplementation()!;
    home.capabilities.adopt.mockImplementationOnce(async () => {
      const result = await adopt();
      storedLease().generation = 2;
      return result;
    });

    const res = await prepare().expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reason: "home migration activation authority changed" });
    expect(audits().at(-1)).toMatchObject({
      status: "failed",
      partialOutcome: { summary: "refused after compute effects", details: { effects: [{ name: "attach-verified-builder-home", resource: "zones/us-central1-a/instances/alice-vm" }] } },
    });
  });

  it("answers blocked with the reason and attempts after three failed copies", async () => {
    docs.set(`users/${OWNER}`, { ...user("shared-blue", requested), provisioning: { ...(user("shared-blue", requested).provisioning as Data), homeMigration: {
      id: "home-copy-test-1", tier: "default", source, phase: "blocked", attempt: 3, error: "copy failed", startedAt: 1,
      copy: { operationId: "home-copy-test-1", ownerUid: OWNER, source: source.disk, sourceLayout: "portable", targetZone: "us-central1-a", desiredGiB: 10, subnetwork: "subnet" },
    } } });

    const res = await prepare().expect(200);

    expect(res.body).toMatchObject({ state: "blocked", attempts: 3, reason: expect.stringContaining("three failed copies") });
    expect(audits().at(-1)).toMatchObject({ status: "failed" });
  });

  it("plans a dry run without any Compute Engine call, and refuses one whose lease moved", async () => {
    await prepare(body, "?dryRun=true").expect(200).expect((res) => expect(res.body.dryRun).toBe(true));
    await prepare({ ...body, generation: 2 }, "?dryRun=true").expect(409).expect((res) => expect(res.body.code).toBe("precondition-failed"));
    expect(home.calls()).toBe(0);
    expect(homeMigration()).toBeNull();
  });

  it("lets allocation through the home fence once prepare answered ready for the lease", async () => {
    home.capabilities.inventory.mockResolvedValue(null);
    docs.set("gateways/shared-blue", sharedRoot());
    docs.set("gateways/shared-blue/releases/3", { gatewayId: "shared-blue", release: 3, payload: {
      imageRepository: "registry/images/octogee-gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}`,
      profileImages: { builder: { imageRepository: "registry/images/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } },
      gatewayEdgeImage: { imageRepository: "registry/images/gateway-edge", imageTag: `abc1234@sha256:${"c".repeat(64)}` },
    } });
    docs.set(`gateways/shared-blue/assignments/${OWNER}`, sharedAssignment(4));
    const allocate = () => request(app({ home: home.factory })).post(`/users/${OWNER}/isolated-gateway/allocate`).send(body);

    await allocate().expect(409).expect((res) => expect(res.body.reason).toContain("is not prepared"));
    await prepare().expect(200).expect((res) => expect(res.body.state).toBe("ready"));
    await allocate().expect(200).expect((res) => expect(res.body.outcome).toBe("allocated"));
  });
});
