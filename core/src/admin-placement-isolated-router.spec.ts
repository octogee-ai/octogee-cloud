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
