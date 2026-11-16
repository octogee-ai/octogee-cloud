import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

import { addAdminFleetRoutes, createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminStrandedSourceRoutes } from "./admin-stranded-source-router.js";
import { MigrationRpcError, MigrationTransportError } from "./fleet-migration-client.js";
import { noUserAccounts } from "./user-account.js";

type Row = Record<string, unknown>;
type Records = Map<string, Row>;

const UID = "uid-ada", SLUG = "ada", SOURCE = "shared-a", TARGET = "shared-b", OP = "op-move-1";
const ASSIGNMENT = `gateways/${SOURCE}/assignments/${UID}`;
const USER = `users/${UID}`;
const OPERATION = `${GLM_OPERATIONS_COLLECTION}/${OP}`;
const PATH = `/users/${UID}/restore-serving`;

function stranded(): Records {
  return new Map<string, Row>(Object.entries({
    "config/orchestrator": { defaultGatewayId: SOURCE, sharedGatewayIds: [SOURCE, TARGET] },
    [ASSIGNMENT]: {
      uid: UID, slug: SLUG, gatewayId: SOURCE, source: "onboarding", state: "quiescing", epoch: 3,
      createdAt: 1, updatedAt: 1_500, updatedByOperationId: OP,
    },
    [USER]: {
      username: SLUG,
      provisioning: { status: "complete", openclaw: {
        slug: SLUG, status: "complete", gatewayId: SOURCE,
        migration: { state: "moving", phase: "transferring", operationId: OP, startedAt: 1_000 },
      } },
    },
    [OPERATION]: {
      kind: "migrate-user", status: "failed", createdBy: "operator", createdAt: 1, startedAt: 1_000, completedAt: 2_000,
      error: "flush-source answered 500", input: { uid: UID, userSlug: SLUG, fromGatewayId: SOURCE, toGatewayId: TARGET },
      steps: [
        { name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "done" },
        { name: "wait-for-active-work", status: "done" }, { name: "quiesce-source", status: "done" },
        { name: "flush-source", status: "failed", error: "flush answered 500" },
        { name: "rollback:unmount-target", status: "done" },
        { name: "rollback:resume-ingress", status: "failed", error: "resume failed" },
      ],
      gatewayId: TARGET, inputUid: UID, rolledBack: false,
    },
  }));
}

function patch(records: Records, path: string, fields: Row): void {
  records.set(path, { ...records.get(path)!, ...fields });
}

function audits(records: Records): Row[] {
  return [...records.entries()].filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/audit-`))
    .map(([path, row]) => ({ ...row, id: path.slice(GLM_OPERATIONS_COLLECTION.length + 1) }));
}

function withoutAudits(records: Records): string {
  return JSON.stringify([...records.entries()].filter(([path]) => !path.startsWith(`${GLM_OPERATIONS_COLLECTION}/audit-`))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function harness(records: Records, resume: () => Promise<void> = async () => undefined) {
  const resumeSourceIngress = vi.fn(resume);
  const log = vi.fn();
  const store = createDocumentFixtureStore(records, { serializeTransactions: true });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "operator@example.com";
    next();
  });
  addAdminStrandedSourceRoutes(app, { store, journal: createAdminFleetMutationRunner(store), resumeSourceIngress, log, now: () => 5_000 });
  app.use(respondToAdminFleetMutationError);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, resumeSourceIngress, log };
}

describe("POST /users/:uid/restore-serving", () => {
  it("resumes the source, serves the user again and answers with the journal entry", async () => {
    const records = stranded();
    const h = harness(records);

    const res = await request(h.app).post(PATH).expect(200);

    expect(res.body).toEqual({
      uid: UID, slug: SLUG, gatewayId: SOURCE, state: "serving", failedMoveId: OP, targetGatewayId: TARGET,
      operationId: expect.stringMatching(/^audit-/),
    });
    expect(h.resumeSourceIngress.mock.calls).toEqual([[{ operationId: OP, gatewayId: SOURCE, slug: SLUG }]]);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving", updatedByOperationId: OP, updatedAt: 5_000 });
    expect((records.get(USER)!.provisioning as { openclaw: Row }).openclaw.migration).toBeUndefined();
  });

  it("journals the repair as its own entry, naming the user, the gateway and the failed move", async () => {
    const records = stranded();

    const res = await request(harness(records).app).post(PATH).expect(200);

    expect(audits(records)).toEqual([expect.objectContaining({
      id: res.body.operationId, status: "completed", actor: "operator@example.com",
      what: "restore stranded source to serving",
      target: { uid: UID, gatewayId: SOURCE },
      preActionStatus: { gatewayId: SOURCE, assignmentState: "quiescing", failedMoveId: OP },
      mutation: { kind: "restore-source-serving", uid: UID, gatewayId: SOURCE, failedMoveId: OP },
    })]);
  });

  it("answers 404 for an unknown user without journaling or resuming", async () => {
    const records = stranded();
    records.delete(USER);
    const h = harness(records);

    const res = await request(h.app).post(PATH).expect(404);

    expect(res.body).toEqual({ error: "user not found", uid: UID });
    expect(audits(records)).toEqual([]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it.each<[string, (records: Records) => void, string]>([
    ["the user already serves", (r) => patch(r, ASSIGNMENT, { state: "serving" }), "source-not-stranded"],
    ["the move is running again", (r) => patch(r, OPERATION, { status: "running", completedAt: null }), "migration-in-flight"],
    ["the cutover committed", (r) => patch(r, OPERATION, { cutoverCommittedAt: 1_900 }), "rollback-not-proven"],
    ["the user holds an assignment on the target", (r) => r.set(`gateways/${TARGET}/assignments/${UID}`, {
      uid: UID, slug: SLUG, gatewayId: TARGET, source: "migrate-user", state: "serving", epoch: 4, createdAt: 1_900, updatedAt: 1_900, updatedByOperationId: OP,
    }), "fleet-state-changed"],
  ])("answers 409 with the reason and changes nothing when %s", async (_name, violate, reasonCode) => {
    const records = stranded();
    violate(records);
    const before = withoutAudits(records);
    const h = harness(records);

    const res = await request(h.app).post(PATH).expect(409);

    expect(res.body).toEqual({ code: "precondition-failed", reasonCode, error: expect.any(String), uid: UID });
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(withoutAudits(records)).toBe(before);
    expect(audits(records)).toEqual([]);
  });

  it("journals a refusal that only shows at the write", async () => {
    const records = stranded();
    const h = harness(records, async () => patch(records, OPERATION, { status: "pending", startedAt: null, completedAt: null }));

    const res = await request(h.app).post(PATH).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "migration-in-flight" });
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
    expect(audits(records)).toEqual([expect.objectContaining({ status: "failed", error: `operation ${OP} is pending` })]);
  });

  it.each<[string, Error, number]>([
    ["502 when the source gateway answers the resume with an error", new MigrationRpcError("/resume/shared-a failed: 500 resume failed", { status: 500 }), 502],
    ["503 when the source gateway cannot be reached", new MigrationTransportError("/resume/shared-a transport failed: connect ECONNREFUSED"), 503],
  ])("answers %s, changes nothing and journals the failure", async (_name, cause, status) => {
    const records = stranded();
    const before = withoutAudits(records);
    const h = harness(records, async () => { throw cause; });

    const res = await request(h.app).post(PATH).expect(status);

    expect(res.body).toEqual({
      code: "source-resume-failed", uid: UID, gatewayId: SOURCE, failedMoveId: OP,
      error: `source ingress on ${SOURCE} not resumed for ${SLUG}: ${cause.message}`,
    });
    expect(withoutAudits(records)).toBe(before);
    expect(audits(records)).toEqual([expect.objectContaining({ status: "failed", error: res.body.error })]);
  });

  it("answers a repeat after the repair with 409 source-not-stranded", async () => {
    const records = stranded();
    const h = harness(records);
    await request(h.app).post(PATH).expect(200);

    const res = await request(h.app).post(PATH).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "source-not-stranded" });
    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
  });

  it("plans a dry run without resuming or writing", async () => {
    const records = stranded();
    const before = withoutAudits(records);
    const h = harness(records);

    const res = await request(h.app).post(`${PATH}?dryRun=true`).expect(200);

    expect(res.body).toMatchObject({ dryRun: true, plans: [{
      what: "restore stranded source to serving", kind: "restore-source-serving",
      target: { uid: UID, gatewayId: SOURCE },
      preActionStatus: { gatewayId: SOURCE, assignmentState: "quiescing", failedMoveId: OP },
    }] });
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(withoutAudits(records)).toBe(before);
    expect(audits(records)).toEqual([]);
  });

  it("answers a dry run of a refused repair with the same 409", async () => {
    const records = stranded();
    patch(records, OPERATION, { cutoverCommittedAt: 1_900 });

    const res = await request(harness(records).app).post(`${PATH}?dryRun=true`).expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "rollback-not-proven" });
  });

  it("answers a replay of a failed resume with the same Idempotency-Key with its audit instead of resuming twice", async () => {
    const records = stranded();
    const h = harness(records, async () => { throw new MigrationRpcError("/resume/shared-a failed: 500 resume failed", { status: 500 }); });
    await request(h.app).post(PATH).set("Idempotency-Key", "repair-1").expect(502);

    const replay = await request(h.app).post(PATH).set("Idempotency-Key", "repair-1").expect(409);

    expect(replay.body).toMatchObject({ auditId: expect.stringMatching(/^audit-/), status: "failed" });
    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(audits(records)).toHaveLength(1);
  });
});

describe("the fleet routes", () => {
  function fleetApp(records: Records, resumeSourceIngress?: () => Promise<void>) {
    const app = express();
    app.use(express.json());
    addAdminFleetRoutes(app, {
      accounts: noUserAccounts,
      store: createDocumentFixtureStore(records, { serializeTransactions: true }),
      logger: { info: vi.fn(), warn: vi.fn() },
      provisionGatewayAuthSecret: async () => undefined,
      listGatewayBuilds: async () => [],
      suspendAuthUser: async () => undefined,
      revokeConnectorGrantsForUser: async () => undefined,
      ...(resumeSourceIngress ? { strandedSource: { resumeSourceIngress } } : {}),
    });
    return app;
  }

  it("serve the repair when the host can resume a gateway's ingress", async () => {
    const records = stranded();
    const resume = vi.fn(async () => undefined);

    await request(fleetApp(records, resume)).post(PATH).expect(200);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("do not serve it on a host that cannot", async () => {
    const records = stranded();

    await request(fleetApp(records)).post(PATH).expect(404);

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
  });
});
