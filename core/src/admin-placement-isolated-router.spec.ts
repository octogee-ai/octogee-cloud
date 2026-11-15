import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementIsolatedRoutes, type AdminIsolatedCapabilities } from "./admin-placement-isolated-router.js";

type Data = Record<string, unknown>;

const OWNER = "uid-alice";
const TARGET = "alice-xs-12345678";
const ACTIVATION = `builder-activate-${TARGET}-g1`;
const RETIREMENT = `placement-retire-${OWNER}-${TARGET}-g1`;
const CLIENT_OWNS = { placementAutomationOwner: "client", placementAutomationYieldedAt: 1_000 };

let docs = new Map<string, Data>();
const warn = vi.fn();
const capabilities: AdminIsolatedCapabilities = {
  namespace: "octogee-test",
  ensureAuthSecret: vi.fn(async () => undefined),
  readGatewayPodDiagnostics: vi.fn(async () => ({ status: "missing", totalPods: 0 })),
};

function app() {
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
    accounts: { get: async (uid) => ({ uid, username: "alice", email: null, displayName: null, lastActive: null, planInputs: {}, usage: {}, mattermostUsername: null }) as never },
    capabilities,
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
  ])("records the canonical operation id when advancing %s to %s", async (fromStatus, toStatus, field, operationId) => {
    seed({ [`users/${OWNER}`]: user(TARGET, lease({ status: fromStatus, activationOperationId: undefined })) });

    await advance({ leaseId: "lease-one", generation: 1, fromStatus, toStatus }).expect(200);

    expect(storedLease()).toMatchObject({ status: toStatus, [field]: operationId });
  });

  it.each([
    [{ ...advanceBody, leaseId: "" }, "leaseId is required"],
    [{ ...advanceBody, generation: 0 }, "generation must be a positive integer"],
    [{ ...advanceBody, toStatus: "returning" }, "fromStatus and toStatus must be"],
    [{ ...advanceBody, fromStatus: "provisioning", toStatus: "activating", operationId: "chosen-by-client" }, "operationId is derived from the lease; omit it"],
  ])("rejects a malformed request %#", async (body, error) => {
    const res = await advance(body).expect(400);
    expect(res.body.error).toContain(error);
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
    await retire(body).expect(409).expect((res) => expect(res.body.reason).toBe(`gateway ${TARGET} is not owned by ${OWNER}`));
  });

  it.each([
    ["the lease identity", { leaseId: "lease-two" }],
    ["the authority fence", { authoritativeGatewayId: "shared-green", authoritativeLeaseStatus: "returning" }],
    ["the zero-workload receipt", { zeroWorkloadRecoveryOperationId: `builder-recover-${TARGET}-g1` }],
    ["the telemetry fence", { telemetryFenceOperationId: "builder-return-unknown", telemetryFenceStatus: "succeeded" }],
  ])("refuses a dry run on %s, as the real call does, and claims nothing", async (_name, fence) => {
    seed({ [`users/${OWNER}`]: user("shared-blue", lease({ status: "parked" })), [`gateways/${TARGET}`]: isolatedRoot() });

    const planned = await retire({ ...body, ...fence }, "?dryRun=true").expect(409);
    const real = await retire({ ...body, ...fence }).expect(409);

    expect(planned.body).toMatchObject({ code: "precondition-failed" });
    expect(planned.body.reason).toBe(real.body.reason);
    expect(docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
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

  beforeEach(() => {
    vi.mocked(capabilities.ensureAuthSecret).mockClear();
    seed({
      [`users/${OWNER}`]: user("shared-blue", requested),
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
    const res = await allocate({ ...body, leaseId: "lease-two" }).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reason: `isolated gateway demand fence changed for ${OWNER}` });
    expect(storedLease().status).toBe("requested");
    expect(isolatedRoots()).toEqual([]);
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
