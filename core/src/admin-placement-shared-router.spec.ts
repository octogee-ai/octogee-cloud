import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { releasePayloadHash, type GatewayKubernetesObservation } from "@octogee/shared/types/gateway-releases";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { addAdminFleetRoutes, createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementSharedRoutes, type AdminPlacementSharedCapabilities } from "./admin-placement-shared-router.js";
import { continuousPlacementMigrationOperationId } from "./placement-migrations.js";
import { noUserAccounts } from "./user-account.js";

type Data = Record<string, unknown>;

const NOW = 1_762_500_000_000;
const UID = "uid-alice";
const SLUG = "alice";
const SOURCE = "shared-a";
const TARGET = "shared-b";
const OWNED = { placementAutomationOwner: "client", placementAutomationYieldedAt: NOW - 60_000 };
const PAYLOAD = { imageRepository: "registry.example/gateway", imageTag: "abc1234" };

const MISSING: GatewayKubernetesObservation = { status: "missing", totalPods: 0, readyPods: 0, observedAt: NOW - 1_000 };
const NOT_READY: GatewayKubernetesObservation = { status: "not-ready", totalPods: 1, readyPods: 0, observedAt: NOW - 1_000 };
const READY: GatewayKubernetesObservation = { status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW - 1_000 };

let observation: GatewayKubernetesObservation | null = null;
let observeFailure: Error | null = null;
let observed: string[] = [];
let duringObservation: () => void = () => undefined;

const capabilities: AdminPlacementSharedCapabilities = {
  observeGatewayKubernetes: async (gatewayId) => {
    observed.push(gatewayId);
    duringObservation();
    if (observeFailure !== null) throw observeFailure;
    return observation;
  },
  platformArtifact: PAYLOAD,
  operationJournalRetentionMs: 1_000,
  operationFailureIsTransient: (error) => error.startsWith("transient:"),
  gatewayStartupUnavailable: (error) => error === "gateway starting; retry shortly",
  sourceRecoveryForwardRetryable: () => false,
};

class RecordedDocuments extends Map<string, Data> {
  readonly events: string[] = [];

  override set(path: string, row: Data): this {
    this.events?.push(`set:${path}`);
    return super.set(path, row);
  }

  override delete(path: string): boolean {
    if (this.has(path)) this.events.push(`delete:${path}`);
    return super.delete(path);
  }
}

let records = new RecordedDocuments();

function app() {
  const store = createDocumentFixtureStore(records, { serializeTransactions: true });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminPlacementSharedRoutes(server, { ...capabilities, store, journal: createAdminFleetMutationRunner(store), now: () => NOW });
  server.use(respondToAdminFleetMutationError);
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

function sharedRoot(gatewayId: string, overrides: Data = {}): Data {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: null,
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
    addedBy: "automation",
    ...overrides,
  };
}

function runtime(gatewayId: string, overrides: Data = {}): Data {
  return {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    heartbeat: { status: "ready", lastHeartbeatAt: NOW - 1_000, mountedCustomers: [] },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW - 1_000 },
    ...overrides,
  };
}

function assignment(gatewayId: string, uid: string, overrides: Data = {}): Data {
  return {
    uid,
    gatewayId,
    slug: uid === UID ? SLUG : uid,
    source: "onboarding",
    state: "serving",
    epoch: 3,
    createdAt: 1,
    updatedAt: 1,
    updatedByOperationId: null,
    ...overrides,
  };
}

function user(gatewayId: string, openclaw: Data = {}): Data {
  return { username: SLUG, slug: SLUG, provisioning: { openclaw: { gatewayId, slug: SLUG, status: "complete", ...openclaw } } };
}

function pool(): Record<string, Data> {
  return {
    "config/orchestrator": { ...OWNED },
    [`gateways/${SOURCE}`]: sharedRoot(SOURCE),
    [`gateways/${TARGET}`]: sharedRoot(TARGET),
    [`glmGateways/${TARGET}`]: runtime(TARGET),
    [`gateways/${SOURCE}/assignments/${UID}`]: assignment(SOURCE, UID),
    [`users/${UID}`]: user(SOURCE),
  };
}

function seed(rows: Record<string, Data>): void {
  records = new RecordedDocuments(Object.entries(rows));
}

function fleetEvents(): string[] {
  return records.events.filter((event) => !event.includes("glmOperations/audit-"));
}

function audits(): Data[] {
  return [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);
}

beforeEach(() => {
  observation = null;
  observeFailure = null;
  observed = [];
  duringObservation = () => undefined;
  seed({});
});

const RECOVERY = `recover-shared-${UID}-${SOURCE}-3`;
const recoverBody = (overrides: Data = {}) => ({ slug: SLUG, toGatewayId: TARGET, expectedSourceEpoch: 3, expectedTargetUsersAtMost: 5, ...overrides });
const recover = (body: Data = recoverBody(), query = "") =>
  request(app()).post(`/shared-gateways/${SOURCE}/users/${UID}/recover${query}`).send(body);

const UNUSABLE_OBSERVATIONS: [string, GatewayKubernetesObservation | null][] = [
  ["absent", null],
  ["unknown", { status: "unknown", totalPods: 0, readyPods: 0, observedAt: NOW }],
  ["of an unrecognised status", { ...MISSING, status: "gone" } as unknown as GatewayKubernetesObservation],
  ["without pod counts", { ...MISSING, totalPods: "0" } as unknown as GatewayKubernetesObservation],
];

describe("POST /shared-gateways/:id/users/:uid/recover", () => {
  beforeEach(() => {
    observation = MISSING;
  });

  it("moves the user's assignment to the target under the same operation id the in-process pass uses", async () => {
    seed(pool());

    const res = await recover().expect(200);

    expect(res.body).toEqual({ operationId: RECOVERY, outcome: "committed", sourceKubernetesStatus: "missing" });
    expect(records.has(`gateways/${SOURCE}/assignments/${UID}`)).toBe(false);
    expect(records.get(`gateways/${TARGET}/assignments/${UID}`)).toMatchObject({ epoch: 4, source: "repair", updatedByOperationId: RECOVERY });
    expect(records.get(`glmOperations/${RECOVERY}`)).toMatchObject({
      kind: "migrate-user", status: "succeeded", createdBy: "glm-controller-placement-policy",
    });
    expect(audits()).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("refuses a source the server observes as not ready, because it still has pods", async () => {
    seed(pool());
    observation = NOT_READY;

    const res = await recover().expect(409);

    expect(res.body).toEqual({
      code: "precondition-failed",
      error: `shared source ${SOURCE} still has Kubernetes pods; retaining assignments until it is missing`,
      reasonCode: "source-not-proven-unavailable",
    });
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses a missing source that still has a fresh runtime heartbeat", async () => {
    seed({ ...pool(), [`glmGateways/${SOURCE}`]: runtime(SOURCE, { kubernetes: MISSING }) });

    const res = await recover().expect(409);

    expect(res.body).toEqual({
      code: "precondition-failed",
      error: `source ${SOURCE} still has a fresh runtime heartbeat while Kubernetes reports missing`,
      reasonCode: "source-not-proven-unavailable",
    });
    expect(fleetEvents()).toEqual([]);
  });

  it("recovers from a missing source whose runtime heartbeat has gone stale", async () => {
    const stale = { status: "ready", lastHeartbeatAt: NOW - 10 * 60_000, mountedCustomers: [] };
    seed({ ...pool(), [`glmGateways/${SOURCE}`]: runtime(SOURCE, { heartbeat: stale, kubernetes: MISSING }) });

    const res = await recover().expect(200);

    expect(res.body).toEqual({ operationId: RECOVERY, outcome: "committed", sourceKubernetesStatus: "missing" });
  });

  it("refuses a source changed more recently than the caller's grace", async () => {
    seed({ ...pool(), [`gateways/${SOURCE}`]: sharedRoot(SOURCE, { updatedAt: NOW - 1_000 }) });

    const res = await recover(recoverBody({ sourceUnchangedForAtLeastMs: 60_000 })).expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `shared source ${SOURCE} changed 1000 ms ago, less than 60000 ms`, reasonCode: "source-not-proven-unavailable" });
    expect(fleetEvents()).toEqual([]);
  });

  it("recovers from a source unchanged for at least the caller's grace", async () => {
    seed({ ...pool(), [`gateways/${SOURCE}`]: sharedRoot(SOURCE, { updatedAt: NOW - 1_000 }) });

    const res = await recover(recoverBody({ sourceUnchangedForAtLeastMs: 1_000 })).expect(200);

    expect(res.body.outcome).toBe("committed");
  });

  it("applies no grace of its own when the caller sends none", async () => {
    seed({ ...pool(), [`gateways/${SOURCE}`]: sharedRoot(SOURCE, { updatedAt: NOW }) });

    expect((await recover().expect(200)).body.outcome).toBe("committed");
  });

  it("answers observation-unknown for a source that does not run as pods", async () => {
    const stale = { status: "ready", lastHeartbeatAt: NOW - 10 * 60_000, mountedCustomers: [] };
    seed({ ...pool(), [`glmGateways/${SOURCE}`]: runtime(SOURCE, { runtime: "gce-vm", heartbeat: stale }) });

    const res = await recover().expect(409);

    expect(res.body).toEqual({
      code: "observation-unknown",
      error: `${SOURCE} runs as gce-vm, not as pods; its Kubernetes status is unknown`,
    });
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses a source in an active roll", async () => {
    seed({ ...pool(), [`gateways/${SOURCE}`]: sharedRoot(SOURCE, { latestRelease: 2, desiredRelease: 2 }) });

    const res = await recover().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `shared source ${SOURCE} is in an active roll`, reasonCode: "source-not-proven-unavailable" });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers observation-unknown and writes nothing when the Kubernetes read fails", async () => {
    seed(pool());
    observeFailure = new Error("pods is forbidden");

    const res = await recover().expect(409);

    expect(res.body).toEqual({ code: "observation-unknown", error: `the Kubernetes status of ${SOURCE} is unknown: pods is forbidden` });
    expect(fleetEvents()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("answers placement-owner without reading Kubernetes while the fleet controller owns placement", async () => {
    const rows = pool();
    delete rows["config/orchestrator"];
    seed(rows);
    observeFailure = new Error("must not be read");

    const res = await recover().expect(409);

    expect(res.body.code).toBe("placement-owner");
    expect(observed).toEqual([]);
  });

  it("answers placement-owner and writes nothing when the owner changes between the first check and the write", async () => {
    seed(pool());
    duringObservation = () => records.set("config/orchestrator", { placementAutomationOwner: "fleet-controller" });

    const res = await recover().expect(409);

    expect(res.body.code).toBe("placement-owner");
    expect(observed).toEqual([SOURCE]);
    expect(records.has(`gateways/${SOURCE}/assignments/${UID}`)).toBe(true);
    expect(records.has(`glmOperations/${RECOVERY}`)).toBe(false);
  });

  it("answers a repeat as already committed after the source came back and the target filled", async () => {
    seed(pool());
    await recover().expect(200);
    observation = READY;
    records.set(`gateways/${TARGET}/assignments/uid-bob`, assignment(TARGET, "uid-bob"));
    records.set(`gateways/${TARGET}/assignments/uid-carol`, assignment(TARGET, "uid-carol"));

    const res = await recover(recoverBody({ expectedTargetUsersAtMost: 0 })).expect(200);

    expect(res.body).toEqual({ operationId: RECOVERY, outcome: "already-committed" });
  });

  it("never recovers from a source the server observes as ready, even when every other fence holds", async () => {
    seed(pool());
    observation = READY;

    const res = await recover().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `source ${SOURCE} is observed ready by Kubernetes`, reasonCode: "source-not-proven-unavailable" });
    expect(fleetEvents()).toEqual([]);
    expect(records.has(`gateways/${SOURCE}/assignments/${UID}`)).toBe(true);
  });

  it.each(UNUSABLE_OBSERVATIONS)("answers observation-unknown and writes nothing when the source observation is %s", async (_, unusable) => {
    seed(pool());
    observation = unusable;

    const res = await recover().expect(409);

    expect(res.body).toEqual({ code: "observation-unknown", error: `the Kubernetes status of ${SOURCE} is unknown` });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers a dry run with the same Kubernetes refusals, writing nothing", async () => {
    seed(pool());
    observation = READY;
    const ready = await recover(recoverBody(), "?dryRun=true").expect(409);
    observation = null;
    const unknown = await recover(recoverBody(), "?dryRun=true").expect(409);

    expect([ready.body.code, unknown.body.code]).toEqual(["precondition-failed", "observation-unknown"]);
    expect(records.events).toEqual([]);
  });

  it("answers a repeat after the commit as already committed and writes nothing", async () => {
    seed(pool());
    await recover().expect(200);
    const before = fleetEvents().length;

    const res = await recover().expect(200);

    expect(res.body).toEqual({ operationId: RECOVERY, outcome: "already-committed" });
    expect(fleetEvents()).toHaveLength(before);
  });

  it("is refused with placement-owner while the fleet controller owns placement, which is the default", async () => {
    const rows = pool();
    delete rows["config/orchestrator"];
    seed(rows);

    const res = await recover().expect(409);

    expect(res.body).toEqual({ code: "placement-owner", error: "placement automation is owned by fleet-controller" });
    expect(fleetEvents()).toEqual([]);
  });

  it("is refused with placement-owner before the fleet controller has yielded", async () => {
    seed({ ...pool(), "config/orchestrator": { placementAutomationOwner: "client" } });

    const res = await recover().expect(409);

    expect(res.body.code).toBe("placement-owner");
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses when the target already holds more users than the caller's cap", async () => {
    seed({
      ...pool(),
      [`gateways/${TARGET}/assignments/uid-bob`]: assignment(TARGET, "uid-bob"),
      [`gateways/${TARGET}/assignments/uid-carol`]: assignment(TARGET, "uid-carol"),
    });

    const res = await recover(recoverBody({ expectedTargetUsersAtMost: 1 })).expect(409);

    expect(res.body).toEqual({
      code: "precondition-failed",
      error: `target ${TARGET} has 2 other users assigned or arriving, expected at most 1`,
      reasonCode: "target-capacity",
    });
    expect(fleetEvents()).toEqual([]);
  });

  it("counts a user still arriving on the target against the cap", async () => {
    seed({
      ...pool(),
      "glmOperations/placement-inbound": {
        kind: "migrate-user", status: "pending", input: { uid: "uid-bob", toGatewayId: TARGET, fromGatewayId: SOURCE }, steps: [],
      },
    });

    const res = await recover(recoverBody({ expectedTargetUsersAtMost: 0 })).expect(409);

    expect(res.body.error).toContain("has 1 other users");
  });

  it("refuses when the source assignment epoch moved", async () => {
    seed(pool());

    const res = await recover(recoverBody({ expectedSourceEpoch: 2 })).expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: "unavailable gateway recovery source changed before cutover", reasonCode: "fleet-state-changed" });
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses when the target heartbeat is stale", async () => {
    seed({ ...pool(), [`glmGateways/${TARGET}`]: runtime(TARGET, { heartbeat: { status: "ready", lastHeartbeatAt: NOW - 10 * 60_000, mountedCustomers: [] } }) });

    const res = await recover().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `recovery target runtime is not freshly ready: ${TARGET}`, reasonCode: "fleet-state-changed" });
  });

  it("refuses a target outside the shared gateway pool", async () => {
    seed({ ...pool(), [`gateways/${TARGET}`]: sharedRoot(TARGET, { gatewayClass: "isolated" }) });

    const res = await recover().expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(fleetEvents()).toEqual([]);
  });

  it("plans a dry run that would commit, writing nothing", async () => {
    seed(pool());

    const res = await recover(recoverBody(), "?dryRun=true").expect(200);

    expect(res.body).toMatchObject({ dryRun: true, plans: [expect.objectContaining({ kind: "recover-shared-user" })] });
    expect(records.events).toEqual([]);
  });

  it("answers a dry run that would be refused with the refusal, writing nothing", async () => {
    seed({ ...pool(), "config/orchestrator": { placementAutomationOwner: "fleet-controller" } });

    const res = await recover(recoverBody(), "?dryRun=true").expect(409);

    expect(res.body.code).toBe("placement-owner");
    expect(records.events).toEqual([]);
  });

  it("answers a replay with the same Idempotency-Key with its audit instead of acting twice", async () => {
    seed(pool());
    await recover().set("Idempotency-Key", "key-1").expect(200);

    const replay = await request(app()).post(`/shared-gateways/${SOURCE}/users/${UID}/recover`).set("Idempotency-Key", "key-1").send(recoverBody());

    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ auditId: expect.any(String) });
    expect(audits()).toHaveLength(1);
  });

  it("rejects a malformed request", async () => {
    const responses = await Promise.all([
      recover(recoverBody({ slug: "" })),
      recover(recoverBody({ toGatewayId: SOURCE })),
      recover(recoverBody({ expectedSourceEpoch: -1 })),
      recover(recoverBody({ expectedTargetUsersAtMost: undefined })),
      recover(recoverBody({ sourceUnchangedForAtLeastMs: -1 })),
    ]);

    expect(responses.map((res) => res.status)).toEqual([400, 400, 400, 400, 400]);
    expect(records.events).toEqual([]);
  });
});

const PREVIOUS_RECOVERY = `recover-disposable-${UID}-alice-xs-1-0`;
const RESET = `recover-disposable-reset-${UID}-${TARGET}-4`;
const resetBody = (overrides: Data = {}) => ({
  slug: SLUG, targetGatewayId: TARGET, expectedAssignmentEpoch: 4, previousRecoveryOperationId: PREVIOUS_RECOVERY, ...overrides,
});
const reset = (body: Data = resetBody(), query = "") => request(app()).post(`/users/${UID}/runtime-reset${query}`).send(body);

function recoveredSeed(): Record<string, Data> {
  return {
    "config/orchestrator": { ...OWNED },
    [`gateways/${TARGET}`]: sharedRoot(TARGET),
    [`glmGateways/${TARGET}`]: runtime(TARGET),
    [`gateways/${TARGET}/assignments/${UID}`]: assignment(TARGET, UID, { epoch: 4, source: "repair", updatedByOperationId: PREVIOUS_RECOVERY }),
    [`users/${UID}`]: user(TARGET),
    [`glmOperations/${PREVIOUS_RECOVERY}`]: {
      kind: "migrate-user",
      status: "succeeded",
      origin: "automatic",
      createdBy: "glm-controller-placement-policy",
      gatewayId: TARGET,
      inputUid: UID,
      input: {
        uid: UID, slug: SLUG, recoveryKind: "recover-disposable-customer", fromGatewayId: "alice-xs-1", toGatewayId: TARGET,
        sourceEpoch: 3, disposableLease: { leaseId: "lease-one", generation: 1 },
      },
      steps: [],
    },
  };
}

describe("POST /users/:uid/runtime-reset", () => {
  it("bumps the assignment epoch and records the pending runtime reset", async () => {
    seed(recoveredSeed());

    const res = await reset().expect(200);

    expect(res.body).toEqual({ operationId: RESET, outcome: "committed" });
    expect(records.get(`gateways/${TARGET}/assignments/${UID}`)).toMatchObject({ epoch: 5, updatedByOperationId: RESET });
    expect(records.get(`glmOperations/${RESET}`)).toMatchObject({ kind: "migrate-user", status: "succeeded" });
  });

  it("answers a repeat as already committed", async () => {
    seed(recoveredSeed());
    await reset().expect(200);

    const res = await reset().expect(200);

    expect(res.body).toEqual({ operationId: RESET, outcome: "already-committed" });
  });

  it("is refused with placement-owner by default", async () => {
    const rows = recoveredSeed();
    delete rows["config/orchestrator"];
    seed(rows);

    expect((await reset().expect(409)).body.code).toBe("placement-owner");
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses when the previous recovery no longer matches the assignment", async () => {
    seed(recoveredSeed());

    const res = await reset(resetBody({ expectedAssignmentEpoch: 5 })).expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: "previous disposable recovery fence changed", reasonCode: "fleet-state-changed" });
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses a target outside the shared gateway pool", async () => {
    seed({ ...recoveredSeed(), [`gateways/${TARGET}`]: sharedRoot(TARGET, { desiredStatus: "retired" }) });

    expect((await reset().expect(409)).body.code).toBe("precondition-failed");
  });

  it("plans a dry run without writing", async () => {
    seed(recoveredSeed());

    await reset(resetBody(), "?dryRun=true").expect(200);

    expect(records.events).toEqual([]);
  });
});

const ROLL_BODY = { targetGatewayId: TARGET, expectedLiveRelease: 1, expectedDesiredRelease: 2 };
const ROLL_OPERATION = `recover-shared-roll-${SOURCE}-to-${TARGET}-r2-to-r1`;
const rollRecovery = (body: Data = ROLL_BODY, query = "") =>
  request(app()).post(`/shared-gateways/${SOURCE}/roll-recovery${query}`).send(body);

function rollingSeed(): Record<string, Data> {
  return {
    "config/orchestrator": { ...OWNED },
    [`gateways/${SOURCE}`]: sharedRoot(SOURCE),
    [`glmGateways/${SOURCE}`]: runtime(SOURCE, { kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW - 1_000 } }),
    [`gateways/${TARGET}`]: sharedRoot(TARGET, { latestRelease: 2, desiredRelease: 2, liveRelease: 1 }),
    [`glmGateways/${TARGET}`]: runtime(TARGET),
    [`gateways/${TARGET}/releases/1`]: { gatewayId: TARGET, release: 1, payload: PAYLOAD, payloadHash: releasePayloadHash(PAYLOAD) },
  };
}

describe("POST /shared-gateways/:id/roll-recovery", () => {
  it("schedules the rollback from the server's own Kubernetes read, not the stored observation", async () => {
    seed(rollingSeed());
    observation = MISSING;

    const res = await rollRecovery().expect(200);

    expect(res.body).toEqual({ kind: "scheduled", release: 3, operationId: ROLL_OPERATION, sourceKubernetesStatus: "missing" });
    expect(records.get(`glmOperations/${ROLL_OPERATION}`)).toMatchObject({
      kind: "rollout", status: "pending", createdBy: "glm-controller-placement-policy", input: { gatewayId: TARGET, targetRelease: 3 },
    });
    expect(records.has(`gateways/${TARGET}/releases/3`)).toBe(true);
  });

  it("answers a repeat as already scheduled", async () => {
    seed(rollingSeed());
    observation = MISSING;
    await rollRecovery().expect(200);

    const res = await rollRecovery().expect(200);

    expect(res.body).toMatchObject({ kind: "already-scheduled", release: 3, operationId: ROLL_OPERATION });
  });

  it("refuses when the server sees source pods, whatever the caller saw", async () => {
    seed(rollingSeed());
    observation = { status: "not-ready", totalPods: 1, readyPods: 0, observedAt: NOW - 1_000 };

    const res = await rollRecovery().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `source ${SOURCE} has no fresh missing Kubernetes observation`, reasonCode: "roll-not-eligible" });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers observation-unknown and changes nothing when the server cannot read Kubernetes", async () => {
    seed(rollingSeed());
    observation = { status: "unknown", totalPods: 0, readyPods: 0, observedAt: NOW };

    const res = await rollRecovery().expect(409);

    expect(res.body).toEqual({ code: "observation-unknown", error: `the Kubernetes status of ${SOURCE} is unknown` });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers observation-unknown for a source that does not run as pods", async () => {
    const rows = rollingSeed();
    seed({ ...rows, [`glmGateways/${SOURCE}`]: { ...rows[`glmGateways/${SOURCE}`], runtime: "gce-vm" } });
    observation = MISSING;

    const res = await rollRecovery().expect(409);

    expect(res.body).toEqual({
      code: "observation-unknown",
      error: `${SOURCE} runs as gce-vm, not as pods; its Kubernetes status is unknown`,
    });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers a repeat as already scheduled while the Kubernetes read fails", async () => {
    seed(rollingSeed());
    observation = MISSING;
    await rollRecovery().expect(200);
    const before = fleetEvents().length;
    observeFailure = new Error("connection refused");

    const res = await rollRecovery().set("Idempotency-Key", "retry-after-lost-response").expect(200);

    expect(res.body).toMatchObject({ kind: "already-scheduled", release: 3, operationId: ROLL_OPERATION });
    expect(fleetEvents()).toHaveLength(before);
  });

  it("answers observation-unknown and changes nothing when the Kubernetes read fails", async () => {
    seed(rollingSeed());
    observeFailure = new Error("connection refused");

    const res = await rollRecovery().expect(409);

    expect(res.body).toEqual({ code: "observation-unknown", error: `the Kubernetes status of ${SOURCE} is unknown: connection refused` });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers placement-owner without reading Kubernetes while the fleet controller owns placement", async () => {
    const rows = rollingSeed();
    delete rows["config/orchestrator"];
    seed(rows);

    expect((await rollRecovery().expect(409)).body.code).toBe("placement-owner");
    expect(observed).toEqual([]);
  });

  it("refuses when the target's releases moved", async () => {
    seed(rollingSeed());
    observation = MISSING;

    const res = await rollRecovery({ ...ROLL_BODY, expectedDesiredRelease: 3 }).expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: "target desired release is 2, expected 3", reasonCode: "roll-not-eligible" });
  });

  it("is refused with placement-owner by default", async () => {
    const rows = rollingSeed();
    delete rows["config/orchestrator"];
    seed(rows);
    observation = MISSING;

    expect((await rollRecovery().expect(409)).body.code).toBe("placement-owner");
    expect(fleetEvents()).toEqual([]);
  });

  it("plans a dry run without writing", async () => {
    seed(rollingSeed());
    observation = MISSING;

    await rollRecovery(ROLL_BODY, "?dryRun=true").expect(200);

    expect(records.events).toEqual([]);
  });
});

const PLACEMENT = continuousPlacementMigrationOperationId({ uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, sourceAssignmentEpoch: 3 });
const enqueueBody = (overrides: Data = {}) => ({
  slug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, source: "continuous-placement-policy", operationId: PLACEMENT,
  expectedTargetUsersAtMost: 5, ...overrides,
});
const OTHER_TARGET = "shared-c";
const OTHER_PLACEMENT = continuousPlacementMigrationOperationId({
  uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: OTHER_TARGET, sourceAssignmentEpoch: 3,
});
const enqueue = (body: Data = enqueueBody(), query = "") => request(app()).post(`/users/${UID}/placement-migrations${query}`).send(body);

describe("POST /users/:uid/placement-migrations", () => {
  it("creates the pending migration the operation runner drives", async () => {
    seed(pool());

    const res = await enqueue().expect(200);

    expect(res.body).toEqual({ operationId: PLACEMENT, outcome: "created" });
    expect(records.get(`glmOperations/${PLACEMENT}`)).toMatchObject({
      kind: "migrate-user",
      status: "pending",
      origin: "automatic",
      createdBy: "glm-controller-placement-policy",
      gatewayId: TARGET,
      input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, source: "continuous-placement-policy" },
    });
  });

  it("answers a repeat while the migration is pending as already enqueued", async () => {
    seed(pool());
    await enqueue().expect(200);

    expect((await enqueue().expect(200)).body).toEqual({ operationId: PLACEMENT, outcome: "already-enqueued" });
  });

  it("re-arms a rolled-back migration that failed transiently", async () => {
    seed({
      ...pool(),
      [`glmOperations/${PLACEMENT}`]: {
        kind: "migrate-user", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy",
        rolledBack: true, completedAt: NOW - 5_000, startedAt: NOW - 10_000, error: "transient: socket hang up", attempts: 1,
        attemptHistory: [{ attempt: 1, error: "transient: socket hang up", steps: [] }],
        input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, source: "continuous-placement-policy" },
        steps: [{ name: "keys-sync-state", status: "failed" }],
      },
    });

    const res = await enqueue().expect(200);

    expect(res.body.outcome).toBe("rearmed");
    expect(records.get(`glmOperations/${PLACEMENT}`)).toMatchObject({ status: "pending", startedAt: null, steps: [] });
  });

  it("refuses to re-arm a migration that ended on its own merits", async () => {
    seed({
      ...pool(),
      [`glmOperations/${PLACEMENT}`]: {
        kind: "migrate-user", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy",
        rolledBack: true, completedAt: NOW - 5_000, startedAt: NOW - 10_000, error: "target rejected the workspace",
        input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, source: "continuous-placement-policy" },
        steps: [],
      },
    });

    const res = await enqueue().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `migration operation ${PLACEMENT} ended with status failed`, reasonCode: "migration-terminal" });
  });

  it("refuses an operation id that does not match the user's current source assignment", async () => {
    seed({ ...pool(), [`gateways/${SOURCE}/assignments/${UID}`]: assignment(SOURCE, UID, { epoch: 4 }) });

    const res = await enqueue().expect(409);

    expect(res.body.error).toBe(`operation ${PLACEMENT} does not match the user's current assignment on ${SOURCE}`);
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses while the user has another pending migration, naming it", async () => {
    seed({
      ...pool(),
      "glmOperations/placement-earlier": {
        kind: "migrate-user", status: "pending", inputUid: UID, input: { uid: UID, toGatewayId: OTHER_TARGET, fromGatewayId: SOURCE }, steps: [],
      },
    });

    const res = await enqueue().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `user ${UID} already has pending migration placement-earlier`, reasonCode: "migration-authority" });
    expect(fleetEvents()).toEqual([]);
  });

  it("creates only one of two concurrent migrations for the same user", async () => {
    seed({ ...pool(), [`gateways/${OTHER_TARGET}`]: sharedRoot(OTHER_TARGET) });

    const responses = await Promise.all([enqueue(), enqueue(enqueueBody({ toGatewayId: OTHER_TARGET, operationId: OTHER_PLACEMENT }))]);

    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const refused = responses.find((res) => res.status === 409);
    expect(refused?.body.error).toMatch(new RegExp(`^user ${UID} already has pending migration `));
    const created = [PLACEMENT, OTHER_PLACEMENT].filter((id) => records.has(`glmOperations/${id}`));
    expect(created).toHaveLength(1);
  });

  it("refuses a slug that does not match the user's record", async () => {
    seed(pool());
    const wrong = continuousPlacementMigrationOperationId({ uid: UID, builderSlug: "mallory", fromGatewayId: SOURCE, toGatewayId: TARGET, sourceAssignmentEpoch: 3 });

    const res = await enqueue(enqueueBody({ slug: "mallory", operationId: wrong })).expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `slug mallory does not match user ${UID}'s slug ${SLUG}`, reasonCode: "migration-authority" });
    expect(fleetEvents()).toEqual([]);
  });

  it("answers a repeat as already enqueued after the target filled", async () => {
    seed(pool());
    await enqueue().expect(200);
    records.set(`gateways/${TARGET}/assignments/uid-bob`, assignment(TARGET, "uid-bob"));

    const res = await enqueue(enqueueBody({ expectedTargetUsersAtMost: 0 })).expect(200);

    expect(res.body).toEqual({ operationId: PLACEMENT, outcome: "already-enqueued" });
  });

  it("refuses when the target is at the caller's cap", async () => {
    seed({ ...pool(), [`gateways/${TARGET}/assignments/uid-bob`]: assignment(TARGET, "uid-bob") });

    const res = await enqueue(enqueueBody({ expectedTargetUsersAtMost: 0 })).expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses a user an operator holds", async () => {
    seed({ ...pool(), [`users/${UID}`]: user(SOURCE, { managedBy: "operator" }) });

    const res = await enqueue().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `user ${UID} is operator-managed`, reasonCode: "user-held" });
  });

  it("refuses a drain move once the source is no longer draining", async () => {
    seed(pool());

    const res = await enqueue(enqueueBody({ sharedDrain: { pairedTargetGatewayId: null } })).expect(409);

    expect(res.body).toEqual({
      code: "precondition-failed",
      error: `shared drain of ${SOURCE} no longer authorizes this migration: the source is no longer draining`,
      reasonCode: "shared-drain-superseded",
    });
  });

  it("creates a drain move while the source drains", async () => {
    seed({ ...pool(), [`gateways/${SOURCE}`]: sharedRoot(SOURCE, { desiredStatus: "draining" }) });

    expect((await enqueue(enqueueBody({ sharedDrain: { pairedTargetGatewayId: null } })).expect(200)).body.outcome).toBe("created");
  });

  it("is refused with placement-owner by default", async () => {
    const rows = pool();
    delete rows["config/orchestrator"];
    seed(rows);

    expect((await enqueue().expect(409)).body.code).toBe("placement-owner");
    expect(fleetEvents()).toEqual([]);
  });

  it("plans a dry run without writing", async () => {
    seed(pool());

    await enqueue(enqueueBody(), "?dryRun=true").expect(200);

    expect(records.events).toEqual([]);
  });

  it("answers a replay with the same Idempotency-Key with its audit", async () => {
    seed(pool());
    await enqueue().set("Idempotency-Key", "key-1").expect(200);

    const replay = await request(app()).post(`/users/${UID}/placement-migrations`).set("Idempotency-Key", "key-1").send(enqueueBody());

    expect(replay.status).toBe(409);
    expect(audits()).toHaveLength(1);
  });

  it("rejects an unknown source, a lease migration under another id and a malformed drain", async () => {
    const responses = await Promise.all([
      enqueue(enqueueBody({ source: "operator" })),
      enqueue(enqueueBody({ source: "builder-activation-lease" })),
      enqueue(enqueueBody({ sharedDrain: { pairedTargetGatewayId: 7 } })),
      enqueue(enqueueBody({ toGatewayId: SOURCE })),
    ]);

    expect(responses.map((res) => res.status)).toEqual([400, 400, 400, 400]);
    expect(records.events).toEqual([]);
  });
});

const DRAIN_MOVE = "placement-drain-move";
const ACTIVATION = "builder-activate-alice-xs-1-g1";
const supersedeBody = (overrides: Data = {}) => ({
  uid: UID, slug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, leaseId: "lease-one", generation: 1,
  targetGatewayId: "alice-xs-1", activationOperationId: ACTIVATION, ...overrides,
});
const supersede = (body: Data = supersedeBody(), query = "") =>
  request(app()).post(`/placement-migrations/${DRAIN_MOVE}/supersede${query}`).send(body);

function drainMoveSeed(): Record<string, Data> {
  return {
    "config/orchestrator": { ...OWNED },
    [`gateways/${SOURCE}`]: sharedRoot(SOURCE, { desiredStatus: "draining" }),
    [`users/${UID}`]: user(SOURCE, {
      activationLease: { leaseId: "lease-one", generation: 1, status: "provisioning", targetGatewayId: "alice-xs-1" },
    }),
    [`glmOperations/${DRAIN_MOVE}`]: {
      kind: "migrate-user", status: "pending", origin: "automatic", createdBy: "glm-controller-placement-policy",
      startedAt: null, completedAt: null, createdAt: NOW - 1_000,
      input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET, source: "continuous-placement-policy" },
      steps: [],
    },
  };
}

describe("POST /placement-migrations/:operationId/supersede", () => {
  it("fails the never-claimed drain move in favour of the activation", async () => {
    seed(drainMoveSeed());

    const res = await supersede().expect(200);

    expect(res.body).toEqual({ operationId: DRAIN_MOVE, outcome: "superseded" });
    expect(records.get(`glmOperations/${DRAIN_MOVE}`)).toMatchObject({
      status: "failed",
      completedAt: NOW,
      expireAt: NOW + 1_000,
      rolledBack: false,
      supersededBy: { kind: "builder-activation", leaseId: "lease-one", generation: 1, targetGatewayId: "alice-xs-1", operationId: ACTIVATION, at: NOW },
    });
  });

  it("answers a repeat as already superseded", async () => {
    seed(drainMoveSeed());
    await supersede().expect(200);

    expect((await supersede().expect(200)).body).toEqual({ operationId: DRAIN_MOVE, outcome: "already-superseded" });
  });

  it("refuses once the operation runner has claimed the move", async () => {
    const rows = drainMoveSeed();
    rows[`glmOperations/${DRAIN_MOVE}`] = { ...rows[`glmOperations/${DRAIN_MOVE}`], status: "running", startedAt: NOW - 500 };
    seed(rows);

    const res = await supersede().expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", error: `operation ${DRAIN_MOVE} is not a pending, never-claimed drain move of this user`, reasonCode: "drain-move-not-supersedable" });
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses when the user's lease moved on", async () => {
    seed(drainMoveSeed());

    const res = await supersede(supersedeBody({ generation: 2 })).expect(409);

    expect(res.body.error).toContain("does not hold provisioning lease lease-one generation 2");
  });

  it("refuses when the source stopped draining", async () => {
    seed({ ...drainMoveSeed(), [`gateways/${SOURCE}`]: sharedRoot(SOURCE) });

    expect((await supersede().expect(409)).body.error).toBe(`source ${SOURCE} is not draining`);
  });

  it("is refused with placement-owner by default", async () => {
    const rows = drainMoveSeed();
    delete rows["config/orchestrator"];
    seed(rows);

    expect((await supersede().expect(409)).body.code).toBe("placement-owner");
    expect(fleetEvents()).toEqual([]);
  });

  it("plans a dry run without writing", async () => {
    seed(drainMoveSeed());

    await supersede(supersedeBody(), "?dryRun=true").expect(200);

    expect(records.events).toEqual([]);
  });
});

describe("mounting", () => {
  const fleetApp = (placementShared?: AdminPlacementSharedCapabilities) => {
    const store = createDocumentFixtureStore(records, { serializeTransactions: true });
    const server = express();
    server.use(express.json());
    addAdminFleetRoutes(server, {
      accounts: noUserAccounts,
      store,
      logger: { info: () => undefined, warn: () => undefined },
      provisionGatewayAuthSecret: async () => ({}),
      listGatewayBuilds: async () => [],
      suspendAuthUser: async () => undefined,
      revokeConnectorGrantsForUser: async () => undefined,
      ...(placementShared ? { placementShared } : {}),
    });
    return server;
  };

  it("mounts the shared placement verbs only when the fleet controller passes their capabilities", async () => {
    seed({});

    const without = await request(fleetApp()).post(`/users/${UID}/placement-migrations`).send(enqueueBody());
    const withCapabilities = await request(fleetApp(capabilities)).post(`/users/${UID}/placement-migrations`).send(enqueueBody());

    expect(without.status).toBe(404);
    expect(withCapabilities.status).toBe(409);
    expect(withCapabilities.body.code).toBe("placement-owner");
  });
});
