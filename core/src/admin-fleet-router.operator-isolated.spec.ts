import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_RELEASES_SUBCOLLECTION, releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

import { addAdminFleetRoutes } from "./admin-fleet-router.js";
import { isOperatorIssuedAllocation, OPERATOR_ISOLATED_GATEWAY_SOURCE } from "./operator-isolated-gateway.js";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "./testing/journal-store.js";
import { noUserAccounts } from "./user-account.js";

type Row = Record<string, unknown>;
type Seed = Record<string, Row>;

const SHARED = "shared-a";
const UID = "uid-lin";
const SLUG = "lin";
const OWNED = "lin-s-0a1b2c3d";
const PAYLOAD: ReleasePayload = {
  imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
  imageTag: "abc1234",
};

function gatewayRoot(gatewayId: string, overrides: Row = {}): Row {
  return {
    gatewayId, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null, coOwnerUids: [],
    ...overrides,
  };
}

function release(gatewayId: string): Seed {
  return {
    [`gateways/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]: {
      gatewayId, release: 1, createdAt: 1, createdBy: "operator", sourceRelease: null, note: null,
      payloadHash: releasePayloadHash(PAYLOAD), payload: PAYLOAD,
    },
  };
}

function runtime(gatewayId: string, status: string, extra: Row = {}): Seed {
  return {
    [`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`]: {
      docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", createdAt: 1, createdByOperationId: null, helm: {},
      heartbeat: { status, lastHeartbeatAt: Date.now(), version: "abc1234", startedAt: Date.now() - 1_000, mountedCustomers: [] },
      lastError: { message: null, at: null },
      ...extra,
    },
  };
}

function user(gatewayId: string | null, openclaw: Row = {}): Seed {
  return {
    [`users/${UID}`]: {
      username: SLUG,
      provisioning: { status: "complete", openclaw: { slug: SLUG, status: "complete", ...(gatewayId ? { gatewayId } : {}), ...openclaw } },
    },
    ...(gatewayId
      ? {
          [`gateways/${gatewayId}/assignments/${UID}`]: {
            uid: UID, slug: SLUG, gatewayId, source: "onboarding", state: "serving", epoch: 3,
            createdAt: 1, updatedAt: 1, updatedByOperationId: null,
          },
        }
      : {}),
  };
}

function ownedGateway(overrides: Row = {}, allocation: Row = {}): Seed {
  return {
    [`gateways/${OWNED}`]: gatewayRoot(OWNED, {
      gatewayClass: "isolated", imageProfile: "isolated", profile: null, sizingTier: "s", liveRelease: null,
      ownerUid: UID, builderSlug: SLUG,
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-issued", generation: 1, claimedByUid: UID, ...allocation },
      ...overrides,
    }),
    ...release(OWNED),
  };
}

function fleet(extra: Seed = {}): Seed {
  return {
    "config/orchestrator": { defaultGatewayId: SHARED, sharedGatewayIds: [SHARED], sizingProfiles: FIXTURE_SIZING_PROFILES },
    [`gateways/${SHARED}`]: gatewayRoot(SHARED),
    ...release(SHARED),
    ...runtime(SHARED, "ready"),
    ...user(SHARED),
    ...extra,
  };
}

function harness(seed: Seed, beforeRetirementClaim?: (records: Map<string, Row>) => void) {
  const records = new Map<string, Row>(Object.entries(structuredClone(seed)));
  const fixture = createDocumentFixtureStore(records);
  const store: typeof fixture = {
    ...fixture,
    transaction: (options, work) => {
      if (options.label === "gateway-retirement.claim") beforeRetirementClaim?.(records);
      return fixture.transaction(options, work);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator", isAdmin: true });
    next();
  });
  addAdminFleetRoutes(app, {
    accounts: noUserAccounts,
    store,
    logger: { info: vi.fn(), warn: vi.fn() },
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  const fleetState = () => JSON.stringify(
    [...records.entries()].filter(([path]) => !path.startsWith("operationAudits/")).sort(([a], [b]) => a.localeCompare(b)),
  );
  const operations = () => [...records.entries()].filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`)).map(([, row]) => row);
  return { app, store, records, fleetState, operations };
}

const give = (h: ReturnType<typeof harness>, body: Row, dryRun = false) =>
  request(h.app).post(`/users/${UID}/isolated-gateway${dryRun ? "?dryRun=true" : ""}`).send(body);

describe("giving a user an isolated gateway", () => {
  it("creates the gateway without a lease, holds the user for the operator and starts the move", async () => {
    const h = harness(fleet());

    const res = await give(h, { sizingProfile: "hobby" }).expect(202);

    const { gatewayId, operationId } = res.body as { gatewayId: string; operationId: string };
    expect(res.body).toEqual({ uid: UID, gatewayId, operationId, sizingProfile: "hobby", fromGatewayId: SHARED, managedBy: "operator" });
    expect(h.records.get(`gateways/${gatewayId}`)).toMatchObject({
      gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", desiredStatus: "running", liveRelease: null,
      ownerUid: UID, builderSlug: SLUG, createdBy: "operator",
      allocation: { kind: "disposable-builder", generation: 1, claimedByUid: UID, leaseId: expect.stringMatching(/^operator-[0-9a-f-]{36}$/u) },
    });
    expect(isOperatorIssuedAllocation((h.records.get(`gateways/${gatewayId}`) as { allocation: Row }).allocation)).toBe(true);
    expect(isOperatorIssuedAllocation({ leaseId: "0b8f6f0e-6f0a-4a57-9a43-1f6f3a1c2d10" })).toBe(false);
    expect(h.records.get(`gateways/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toMatchObject({ payload: PAYLOAD });
    const openclaw = (h.records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw;
    expect(openclaw).toMatchObject({ managedBy: "operator", gatewayId: SHARED });
    expect(openclaw.activationLease).toBeUndefined();
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/${operationId}`)).toMatchObject({
      kind: "migrate-user", status: "pending", createdBy: "operator", gatewayId,
      input: { uid: UID, userSlug: SLUG, fromGatewayId: SHARED, toGatewayId: gatewayId, source: OPERATOR_ISOLATED_GATEWAY_SOURCE },
    });
  });

  it("uses the sizing tier of the named profile", async () => {
    const h = harness(fleet());

    const res = await give(h, { sizingProfile: "team" }).expect(202);

    expect(h.records.get(`gateways/${res.body.gatewayId}`)).toMatchObject({ sizingTier: "l" });
  });

  it("gives a gateway from a profile that runs it as a Kubernetes pod", async () => {
    const h = harness(fleet({ "config/orchestrator": { defaultGatewayId: SHARED, sharedGatewayIds: [SHARED], sizingProfiles: {
      ...FIXTURE_SIZING_PROFILES,
      pod: { isolation: "isolated", sizingTier: "s", fallbackStorageGb: null, computer: { runtime: "cluster", homeSizeGiB: 10 } },
    } } }));

    const res = await give(h, { sizingProfile: "pod" }).expect(202);

    expect(h.records.get(`gateways/${res.body.gatewayId}`)).toMatchObject({
      gatewayClass: "isolated", sizingTier: "s", ownerUid: UID, builderAccess: { controlIdentity: "per-user" },
    });
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/${res.body.operationId}`)).toMatchObject({ kind: "migrate-user", status: "pending" });
  });

  it("answers a dry run with the plan and writes nothing", async () => {
    const h = harness(fleet());
    const before = h.fleetState();

    const res = await give(h, { sizingProfile: "hobby" }, true).expect(200);

    expect(res.body).toMatchObject({
      dryRun: true,
      plans: [{ what: "move user to an isolated gateway", mutation: { kind: "move-to-isolated-gateway", uid: UID, sizingProfile: "hobby", fromGatewayId: SHARED } }],
    });
    expect(h.fleetState()).toBe(before);
  });

  it("records a new request as moving the user to an isolated gateway", async () => {
    const h = harness(fleet());

    await give(h, { sizingProfile: "hobby" }).set("Idempotency-Key", "move-1").expect(202);

    expect(h.operations()).toContainEqual(expect.objectContaining({
      what: "move user to an isolated gateway",
      idempotencyKey: "move-1:give user an isolated gateway",
      mutation: { kind: "move-to-isolated-gateway", uid: UID, sizingProfile: "hobby", fromGatewayId: SHARED },
    }));
  });

  it("gives a second gateway a new id once the first is retired and gone", async () => {
    const h = harness(fleet());
    const first = (await give(h, { sizingProfile: "hobby" }).expect(202)).body as { gatewayId: string; operationId: string };
    h.records.set(`gateways/${first.gatewayId}`, { ...h.records.get(`gateways/${first.gatewayId}`)!, desiredStatus: "retired" });
    h.records.set(`${GLM_OPERATIONS_COLLECTION}/${first.operationId}`, {
      ...h.records.get(`${GLM_OPERATIONS_COLLECTION}/${first.operationId}`)!, status: "failed", completedAt: 2,
    });

    const second = (await give(h, { sizingProfile: "hobby" }).expect(202)).body as { gatewayId: string };

    expect(second.gatewayId).not.toBe(first.gatewayId);
  });

  const refusals: Array<[name: string, seed: () => Seed, body: Row, status: number, code: string, extra?: Row]> = [
    ["no sizing profile", fleet, {}, 400, "sizing-profile-invalid", { sizingProfiles: ["hobby", "pro", "team"] }],
    ["an unknown sizing profile", fleet, { sizingProfile: "huge" }, 400, "sizing-profile-unknown", { error: "unknown sizing profile huge", sizingProfiles: ["hobby", "pro", "team"] }],
    ["a shared sizing profile", fleet, { sizingProfile: "enterprise" }, 400, "sizing-profile-not-isolated", { sizingProfiles: ["hobby", "pro", "team"] }],
    ["an unknown user", () => fleet({ [`users/${UID}`]: undefined as unknown as Row }), { sizingProfile: "hobby" }, 404, "user-not-found"],
    ["a user who already has one", () => fleet(ownedGateway()), { sizingProfile: "hobby" }, 409, "user-has-isolated-gateway", { gatewayId: OWNED }],
    [
      "a user whose retired gateway is still being removed",
      () => fleet({ ...ownedGateway({ desiredStatus: "retired" }), ...runtime(OWNED, "ready", { runtime: "gce-vm" }) }),
      { sizingProfile: "hobby" }, 409, "isolated-gateway-retiring", { gatewayId: OWNED },
    ],
    ["a user on no gateway", () => ({ ...fleet(), ...user(null) }), { sizingProfile: "hobby" }, 409, "user-not-on-shared-gateway"],
    [
      "a user with a migration in flight",
      () => fleet({ [`${GLM_OPERATIONS_COLLECTION}/move-1`]: {
        kind: "migrate-user", status: "running", createdBy: "operator", createdAt: 1, startedAt: 2, completedAt: null,
        input: { uid: UID, toGatewayId: "shared-b" }, inputUid: UID, steps: [],
      } }),
      { sizingProfile: "hobby" }, 409, "user-migration-in-flight", { operationId: "move-1" },
    ],
    [
      "a user with no workspace yet",
      () => fleet({ [`users/${UID}`]: { provisioning: { status: "complete", openclaw: { status: "complete", gatewayId: SHARED } } } }),
      { sizingProfile: "hobby" }, 409, "user-not-provisioned",
    ],
    [
      "a suspended user",
      () => { const seed = fleet(); seed[`users/${UID}`].accountLifecycle = { status: "suspended" }; return seed; },
      { sizingProfile: "hobby" }, 409, "user-not-active",
    ],
    [
      "a user whose restore is unresolved",
      () => fleet(user(SHARED, { restoreFence: { operationId: "restore-1" } })),
      { sizingProfile: "hobby" }, 409, "user-recovery-unresolved",
    ],
    [
      "a profile with no machine to build",
      () => fleet({ "config/orchestrator": { defaultGatewayId: SHARED, sharedGatewayIds: [SHARED], sizingProfiles: {
        ...FIXTURE_SIZING_PROFILES,
        bare: { isolation: "isolated", sizingTier: "s", fallbackStorageGb: null,
          computer: { runtime: "gce-vm", desktop: "x11", machineType: null, provisioningModel: null, bootDisk: null, homeSizeGiB: 10 } },
      } } }),
      { sizingProfile: "bare" }, 400, "sizing-profile-no-vm",
    ],
    [
      "a shared gateway whose live release cannot be read",
      () => fleet({ [`gateways/${SHARED}/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]: undefined as unknown as Row }),
      { sizingProfile: "hobby" }, 409, "source-release-unreadable",
    ],
    [
      "a user whose roster state is not settled",
      () => fleet({ [`gateways/${SHARED}/assignments/${UID}`]: {
        uid: UID, slug: SLUG, gatewayId: SHARED, source: "onboarding", state: "quiescing", epoch: 3, createdAt: 1, updatedAt: 1, updatedByOperationId: null,
      } }),
      { sizingProfile: "hobby" }, 409, "user-assignment-unsettled",
    ],
    [
      "a shared gateway between releases",
      () => fleet({ [`gateways/${SHARED}`]: gatewayRoot(SHARED, { latestRelease: 2, desiredRelease: 2 }) }),
      { sizingProfile: "hobby" }, 409, "source-gateway-rolling",
    ],
  ];

  it("does not read the user's lease: a user with a live lease and no gateway yet is given one all the same", async () => {
    const h = harness(fleet(user(SHARED, { activationLease: { leaseId: "lease-1", generation: 2, status: "requested" } })));

    const res = await give(h, { sizingProfile: "hobby" }).expect(202);

    const openclaw = (h.records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw;
    expect(openclaw).toMatchObject({ managedBy: "operator", activationLease: { leaseId: "lease-1", status: "requested" } });
    expect(h.records.get(`gateways/${res.body.gatewayId}`)).toMatchObject({ ownerUid: UID });
  });

  it.each(refusals)("refuses %s, with the same answer from a dry run, and writes nothing", async (_name, seed, body, status, code, extra = {}) => {
    const rows = Object.fromEntries(Object.entries(seed()).filter(([, row]) => row !== undefined));
    const applied = harness(rows);
    const planned = harness(rows);
    const before = applied.fleetState();

    const apply = await give(applied, body).expect(status);
    const dryRun = await give(planned, body, true).expect(status);

    expect(apply.body).toMatchObject({ code, ...extra });
    expect(dryRun.body).toEqual(apply.body);
    expect(applied.fleetState()).toBe(before);
    expect(planned.fleetState()).toBe(before);
  });
});

describe("retiring an isolated gateway", () => {
  const retire = (h: ReturnType<typeof harness>, query = "") => request(h.app).delete(`/gateways/${OWNED}${query}`);

  it("retires one that has no user assigned, including after a create that never served", async () => {
    const h = harness(fleet({ ...ownedGateway(), ...user(SHARED, { managedBy: "operator" }) }));

    const res = await retire(h).expect(202);

    expect(res.body).toMatchObject({ gatewayId: OWNED, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({
      desiredStatus: "retired", retirementClaim: { operationId: res.body.operationId },
    });
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/${res.body.operationId}`)).toMatchObject({ kind: "retire-gateway", gatewayId: OWNED });
  });

  const lastHeartbeatStillListsUser = (root: Row, runtimeKind: Row) => {
    const seed = fleet({ ...ownedGateway({ liveRelease: 1, ...root }), ...runtime(OWNED, "ready", runtimeKind), ...user(SHARED, { managedBy: "operator" }) });
    (seed[`${GLM_GATEWAYS_COLLECTION}/${OWNED}`].heartbeat as Row).mountedCustomers = [SLUG];
    return seed;
  };

  it.each([
    ["VM", "gce-vm"],
    ["pod", "cluster"],
  ] as const)("retires a returned gateway whose parked %s left a last heartbeat that still lists the user", async (_name, runtimeKind) => {
    const h = harness(lastHeartbeatStillListsUser({ desiredStatus: "paused" }, { runtime: runtimeKind }));

    const res = await retire(h).expect(202);

    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({
      desiredStatus: "retired",
      retirementClaim: { operationId: res.body.operationId, previousDesiredStatus: "paused", phase: "claimed", version: expect.any(Number) },
    });
  });

  it.each([
    ["a running VM gateway", { desiredStatus: "running" }, { runtime: "gce-vm" }],
    ["a paused gateway with no runtime stamp", { desiredStatus: "paused" }, {}],
    ["a running pod gateway", { desiredStatus: "running" }, { runtime: "cluster" }],
  ] as const)("still refuses %s whose heartbeat lists a mounted user", async (_name, root, runtimeKind) => {
    const h = harness(lastHeartbeatStillListsUser(root, runtimeKind));

    const res = await retire(h).expect(409);

    expect(res.body).toMatchObject({ gatewayId: OWNED, mountedUsers: [SLUG] });
    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: root.desiredStatus });
  });

  const giveMove = (row: Row = {}): Seed => ({
    [`${GLM_OPERATIONS_COLLECTION}/give-move`]: {
      kind: "migrate-user", status: "pending", createdBy: "operator", createdAt: 1, startedAt: null, completedAt: null,
      output: { isolatedGatewayReadinessChecks: 3 },
      error: `waiting for isolated gateway ${OWNED} to become ready (check 3 of 30): placement rejected for ${OWNED}: no-live-revision`,
      input: { uid: UID, userSlug: SLUG, fromGatewayId: SHARED, toGatewayId: OWNED, source: OPERATOR_ISOLATED_GATEWAY_SOURCE },
      inputUid: UID, gatewayId: OWNED, steps: [], ...row,
    },
  });
  const waitingGive = (move: Row = {}) => fleet({ ...ownedGateway(), ...user(SHARED, { managedBy: "operator" }), ...giveMove(move) });

  it("retires a gateway whose give is still waiting for the VM, and cancels that move", async () => {
    const h = harness(waitingGive());

    const res = await retire(h).expect(202);

    expect(res.body).toMatchObject({ gatewayId: OWNED, cancelledOperations: ["give-move"] });
    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: "retired" });
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/give-move`)).toMatchObject({
      status: "failed", error: `cancelled: gateway ${OWNED} was retired by operator`,
    });
    await request(harness(waitingGive()).app).delete(`/gateways/${OWNED}?dryRun=true`).expect(200);
  });

  it("leaves the waiting move alone when the retirement cannot be claimed", async () => {
    const seed = waitingGive();
    (seed[`gateways/${OWNED}`] as Row).retirementClaim = { operationId: "another-retire", version: 1, phase: "claimed", previousDesiredStatus: "running" };
    const h = harness(seed);

    const res = await retire(h).expect(409);

    expect(res.body).toMatchObject({ gatewayId: OWNED, error: `gateway ${OWNED} already has a retirement claim` });
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/give-move`)).toMatchObject({ status: "pending" });
    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: "running" });
  });

  it.each([
    ["was attempted and requeued for a retry", { attempts: 1, error: "attempt 1 failed (transient): connect ETIMEDOUT — retrying in 30s" }],
    ["began, persisted a scheduler handoff and is waiting for the user to go idle", {
      waitingOn: "builder-idle",
      schedulerHandoff: { migrationId: "mig-give-move:scheduler:1", fromGatewayId: SHARED, toGatewayId: OWNED, uid: UID, slug: SLUG },
    }],
    ["reported a step and was requeued", { steps: [{ name: "keys-sync-state", status: "done" }] }],
  ])("does not cancel a move that %s between the route's read and the claim", async (_name, begun) => {
    const h = harness(waitingGive(), (records) => {
      const path = `${GLM_OPERATIONS_COLLECTION}/give-move`;
      records.set(path, { ...records.get(path)!, ...begun });
    });

    const res = await retire(h).expect(409);

    expect(res.body).toEqual({ error: `user migration is in flight for gateway ${OWNED}`, gatewayId: OWNED });
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/give-move`)).toMatchObject({ status: "pending", ...begun });
    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: "running" });
  });

  it("refuses while a move onto the gateway is running, with the same answer from a dry run", async () => {
    const running = { status: "running", startedAt: 5, error: undefined };
    const applied = harness(waitingGive(running));

    const apply = await retire(applied).expect(409);
    const dryRun = await request(harness(waitingGive(running)).app).delete(`/gateways/${OWNED}?dryRun=true`).expect(409);

    expect(apply.body).toEqual({ error: `user migration is in flight for gateway ${OWNED}`, gatewayId: OWNED });
    expect(dryRun.body).toEqual(apply.body);
    expect(applied.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: "running" });
  });

  const failedRetire = (status: string): Seed => ({
    ...fleet({
      ...ownedGateway({ desiredStatus: "retired", retirementVersion: 1,
        retirementClaim: { operationId: "retire-1", version: 1, phase: "claimed", previousDesiredStatus: "paused" } }),
      ...user(SHARED, { managedBy: "operator" }),
    }),
    [`${GLM_OPERATIONS_COLLECTION}/retire-1`]: {
      kind: "retire-gateway", status, createdBy: "operator", createdAt: 1, startedAt: 2, completedAt: status === "running" ? null : 3,
      error: status === "failed" ? "gateway lin-s-0a1b2c3d still has 1 mounted user(s)" : undefined,
      input: { gatewayId: OWNED }, gatewayId: OWNED, steps: [], attempts: 3,
    },
  });

  it("drives a failed retire again under the same operation", async () => {
    const h = harness(failedRetire("failed"));

    const res = await retire(h).expect(202);

    expect(res.body).toMatchObject({ gatewayId: OWNED, operationId: "retire-1", retried: true });
    const operation = h.records.get(`${GLM_OPERATIONS_COLLECTION}/retire-1`)!;
    expect(operation).toMatchObject({ status: "pending", startedAt: null, completedAt: null });
    expect(operation.error).toBeUndefined();
    await request(harness(failedRetire("failed")).app).delete(`/gateways/${OWNED}?dryRun=true`).expect(200);
  });

  it.each(["force", "deleteHome", "retainData", "retainServiceAccount"])("does not drive a failed retire again when the request carries %s, which it would ignore", async (flag) => {
    const h = harness(failedRetire("failed"));

    const res = await retire(h, `?${flag}=true`).expect(409);

    expect(res.body).toMatchObject({ code: "retire-retry-takes-no-options", gatewayId: OWNED, operationId: "retire-1" });
    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/retire-1`)).toMatchObject({ status: "failed" });
  });

  it.each(["running", "succeeded"])("answers that the gateway is already retired while its retire is %s", async (status) => {
    const res = await retire(harness(failedRetire(status))).expect(409);

    expect(res.body).toMatchObject({ gatewayId: OWNED, error: `gateway ${OWNED} is already retired` });
  });

  const occupied = () => fleet({ ...ownedGateway({ liveRelease: 1 }), ...runtime(OWNED, "ready", { runtime: "gce-vm" }), ...user(OWNED, { managedBy: "operator" }) });
  const leased = () => fleet({
    ...ownedGateway({}, { leaseId: "lease-1", generation: 2 }),
    ...user(SHARED, { activationLease: { leaseId: "lease-1", generation: 2, status: "provisioning", targetGatewayId: OWNED } }),
  });
  const refusals: Array<[name: string, seed: () => Seed, query: string, code: string, extra: Row]> = [
    ["while its user is still on it", occupied, "", "isolated-gateway-has-user", { error: "return the user to a shared gateway first", assignedUsers: [SLUG] }],
    ["by force while its user is still on it", occupied, "?force=true", "isolated-gateway-forced-return-undecided", { assignedUsers: [SLUG] }],
    ["with its home deleted", () => fleet(ownedGateway()), "?deleteHome=true", "isolated-gateway-home-delete-undecided", {}],
    ["keeping its data, a pod gateway option", () => fleet(ownedGateway()), "?retainData=true", "isolated-gateway-retain-data-unsupported", {}],
  ];

  it("does not read the owner's lease: a gateway a live lease names is retired when no user is assigned", async () => {
    const h = harness(leased());

    await retire(h).expect(202);

    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: "retired" });
  });

  it.each(refusals)("refuses %s, with the same answer from a dry run", async (_name, seed, query, code, extra) => {
    const applied = harness(seed());
    const planned = harness(seed());
    const before = applied.fleetState();

    const apply = await retire(applied, query).expect(409);
    const dryRun = await request(planned.app).delete(`/gateways/${OWNED}${query ? `${query}&` : "?"}dryRun=true`).expect(409);

    expect(apply.body).toMatchObject({ code, gatewayId: OWNED, ...extra });
    expect(dryRun.body).toEqual(apply.body);
    expect(applied.fleetState()).toBe(before);
  });
});

describe("moving a user by hand", () => {
  const migrate = (h: ReturnType<typeof harness>, to: string) => request(h.app).post(`/users/${UID}/migrate`).send({ to });
  const readyOwned = (root: Row = {}, allocation: Row = {}) => ({ ...ownedGateway({ liveRelease: 1, ...root }, allocation), ...runtime(OWNED, "ready", { runtime: "gce-vm" }) });

  it("moves a user onto their own isolated gateway once it is ready", async () => {
    const h = harness(fleet({ ...readyOwned(), ...user(SHARED, { managedBy: "operator" }) }));

    const res = await migrate(h, OWNED).expect(202);

    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/${res.body.operationId}`)).toMatchObject({
      kind: "migrate-user", input: { uid: UID, fromGatewayId: SHARED, toGatewayId: OWNED },
    });
  });

  it("returns a user from their isolated gateway to a shared one", async () => {
    const h = harness(fleet({ ...readyOwned(), ...user(OWNED, { managedBy: "operator" }) }));

    const res = await migrate(h, SHARED).expect(202);

    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/${res.body.operationId}`)).toMatchObject({
      kind: "migrate-user", input: { uid: UID, fromGatewayId: OWNED, toGatewayId: SHARED },
    });
  });

  it("refuses another user's isolated gateway", async () => {
    const h = harness(fleet(readyOwned({ ownerUid: "uid-else", builderSlug: "else" }, { claimedByUid: "uid-else" })));

    const res = await migrate(h, OWNED).expect(400);

    expect(res.body).toMatchObject({ code: "migration-target-not-own-isolated-gateway", gatewayId: OWNED });
    expect(h.operations()).toEqual([]);
  });

  it("moves a user onto their own isolated gateway whatever lease they have", async () => {
    const h = harness(fleet({
      ...readyOwned({}, { leaseId: "lease-1", generation: 2 }),
      ...user(SHARED, { activationLease: { leaseId: "lease-1", generation: 2, status: "activating", targetGatewayId: OWNED } }),
    }));

    const res = await migrate(h, OWNED).expect(202);

    expect(h.records.get(`${GLM_OPERATIONS_COLLECTION}/${res.body.operationId}`)).toMatchObject({
      kind: "migrate-user", input: { uid: UID, toGatewayId: OWNED },
    });
  });

  it("refuses an isolated gateway with no allocation tag, which could not hold the user's agent state", async () => {
    const seed = fleet({ ...readyOwned(), ...user(SHARED) });
    delete (seed[`gateways/${OWNED}`] as Row).allocation;
    const h = harness(seed);

    const res = await migrate(h, OWNED).expect(400);

    expect(res.body).toMatchObject({ code: "migration-target-not-own-isolated-gateway" });
  });

  it("still refuses to assign a user to an isolated gateway without a handover", async () => {
    const h = harness(fleet({ ...readyOwned(), ...user(SHARED, { managedBy: "operator" }) }));

    const res = await request(h.app).post(`/users/${UID}/assign`).send({ gatewayId: OWNED });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.records.get(`gateways/${OWNED}/assignments/${UID}`)).toBeUndefined();
  });
});

describe("releasing the operator hold", () => {
  const release = (h: ReturnType<typeof harness>) => request(h.app).patch(`/users/${UID}/placement`).send({ managedBy: "cowboy" });
  const managedBy = (h: ReturnType<typeof harness>) =>
    (h.records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw.managedBy;
  const servingOwned = (allocation: Row = {}) => ({ ...ownedGateway({ liveRelease: 1 }, allocation), ...runtime(OWNED, "ready", { runtime: "gce-vm" }) });

  it("is allowed while the user is on the given gateway: what follows is the product's to define", async () => {
    const h = harness(fleet({ ...servingOwned(), ...user(OWNED, { managedBy: "operator" }) }));

    await release(h).expect(200);

    expect(managedBy(h)).toBe("cowboy");
    expect(h.records.get(`gateways/${OWNED}`)).toMatchObject({ desiredStatus: "running" });
  });

  it("is allowed once the user is back on a shared gateway", async () => {
    const h = harness(fleet({ ...servingOwned(), ...user(SHARED, { managedBy: "operator" }) }));

    await release(h).expect(200);

    expect(managedBy(h)).toBe("cowboy");
  });

  it("is allowed on an isolated gateway that the user's lease owns", async () => {
    const h = harness(fleet({
      ...servingOwned({ leaseId: "lease-1", generation: 2 }),
      ...user(OWNED, { managedBy: "operator", activationLease: { leaseId: "lease-1", generation: 2, status: "active", targetGatewayId: OWNED } }),
    }));

    await release(h).expect(200);

    expect(managedBy(h)).toBe("cowboy");
  });
});

describe("holding a user for the operator", () => {
  it("does not read the user's lease: a user whose lease is requested is held all the same", async () => {
    const h = harness(fleet(user(SHARED, { activationLease: { leaseId: "lease-1", generation: 2, status: "requested" } })));

    const res = await request(h.app).patch(`/users/${UID}/placement`).send({ managedBy: "operator", gatewayId: null }).expect(200);

    expect(res.body).toMatchObject({ uid: UID, parked: true, managedBy: "operator" });
    const openclaw = (h.records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw;
    expect(openclaw).toMatchObject({ managedBy: "operator", activationLease: { leaseId: "lease-1", status: "requested" } });
    expect(h.records.get(`gateways/${SHARED}/assignments/${UID}`)).toBeUndefined();
  });
});

describe("listing an isolated gateway that has not started", () => {
  it("shows why it has not started before its first heartbeat", async () => {
    const message = "the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node";
    const seed = fleet({ ...ownedGateway(), ...runtime(OWNED, "starting", { runtime: "cluster", lastError: { message, at: 5_000 } }) });
    seed[`${GLM_GATEWAYS_COLLECTION}/${OWNED}`].heartbeat = {};
    const h = harness(seed);

    const res = await request(h.app).get("/gateways").expect(200);

    const listed = (res.body.gateways as Row[]).find((gateway) => gateway.gatewayId === OWNED);
    expect(listed).toMatchObject({ lastError: { message, at: new Date(5_000).toISOString() } });
  });
});
