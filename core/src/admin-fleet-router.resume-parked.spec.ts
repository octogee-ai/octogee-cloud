import request from "supertest";
import { describe, expect, it } from "vitest";
import { FLEET, harness, operation, send, type Seed } from "@octogee/core-testing/admin-dry-run-app";
import { PARKED_OPERATION_WAITING_ON } from "./operation-stall-park.js";

const RETURN_ID = "builder-return-ada-iso-ada-g52";
const NOT_CONFIRMED = "migration forward recovery pending: status 503: /finish-rsync-import/shared-b: 500 import failed";
const PARKED_AT = 1_000_000;

function parkedFleet(overrides: Record<string, unknown> = {}): Seed {
  return {
    ...FLEET,
    ...operation(RETURN_ID, {
      kind: "migrate-user", status: "pending", origin: "automatic", createdBy: "fleet-controller", createdAt: 1,
      startedAt: null, completedAt: null, firstStartedAt: 10, steps: [], attempts: 3,
      input: { uid: "uid-ada", fromGatewayId: "iso-ada", toGatewayId: "shared-b" },
      waitingOn: PARKED_OPERATION_WAITING_ON,
      stallPark: {
        parkedAt: PARKED_AT, reason: "repeated-failure", repeatedError: NOT_CONFIRMED, lastError: NOT_CONFIRMED,
        attempts: 3, consecutiveFailures: 3, stuckSince: 10, stalledSince: 20, queuedBehind: ["placement-a"], auditId: "audit-park",
      },
      ...overrides,
    }),
    ...operation("placement-a", {
      kind: "migrate-user", status: "pending", origin: "automatic", createdBy: "fleet-controller", createdAt: 20,
      startedAt: null, completedAt: null, steps: [],
      input: { uid: "uid-other", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
      waitingOn: "migration iso-ada → shared-b",
    }),
  };
}

const resume = (body: Record<string, unknown> = { reason: "restarted the target gateway" }) =>
  ({ method: "post" as const, path: `/operations/${RETURN_ID}/resume-parked`, body });

describe("parked operations", () => {
  it("lists each parked operation with its repeated error, attempts, how long, and what waits behind it", async () => {
    const h = harness(parkedFleet());
    const res = await request(h.app).get("/operations/parked").expect(200);
    expect(res.body.operations).toEqual([expect.objectContaining({
      operationId: RETURN_ID,
      kind: "migrate-user",
      fromGatewayId: "iso-ada",
      toGatewayId: "shared-b",
      park: expect.objectContaining({ repeatedError: NOT_CONFIRMED, attempts: 3, parkedAt: PARKED_AT }),
      parkedForMs: expect.any(Number),
      queuedBehind: [{ id: "placement-a", kind: "migrate-user", waitingOn: "migration iso-ada → shared-b" }],
    })]);
  });

  it("plans a resume in a dry run without changing anything", async () => {
    const h = harness(parkedFleet());
    const before = h.snapshot();
    const res = await send(h.app, resume(), true).expect(200);
    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "resume a parked operation",
      why: "restarted the target gateway",
      kind: "resume-parked-operation",
      target: { operationId: RETURN_ID },
      mutation: { kind: "resume-parked-operation", operationId: RETURN_ID, parkedAt: PARKED_AT },
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("re-arms the operation and journals who resumed it and why", async () => {
    const h = harness(parkedFleet());
    const res = await send(h.app, resume(), false).expect(202);
    const row = h.records.get(`glmOperations/${RETURN_ID}`)!;
    expect(row).toMatchObject({
      status: "pending",
      attempts: 3,
      nextAttemptAt: expect.any(Number),
      stallPark: { parkedAt: PARKED_AT, resumedBy: "operator", resumeReason: "restarted the target gateway",
        resumeAuditId: expect.any(String), resumedAt: expect.any(Number) },
    });
    expect(row).not.toHaveProperty("waitingOn");
    const audit = h.records.get(`glmOperations/${res.body.park.resumeAuditId}`);
    expect(audit).toMatchObject({ recordType: "audit", actor: "operator", why: "restarted the target gateway",
      status: "completed", mutation: { kind: "resume-parked-operation", operationId: RETURN_ID } });
    const listed = await request(h.app).get("/operations/parked").expect(200);
    expect(listed.body.operations).toEqual([]);
  });

  it("requires a reason", async () => {
    const h = harness(parkedFleet());
    const before = h.snapshot();
    await send(h.app, resume({ reason: "  " }), false).expect(400);
    await send(h.app, resume({}), true).expect(400);
    expect(h.snapshot()).toBe(before);
  });

  it("refuses an operation that is not parked, already resumed, or missing", async () => {
    const retrying = harness(parkedFleet({ stallPark: undefined, waitingOn: undefined }));
    const refused = await send(retrying.app, resume(), false).expect(409);
    expect(refused.body.error).toContain("is not parked");
    const resumed = harness(parkedFleet({ stallPark: {
      parkedAt: PARKED_AT, reason: "repeated-failure", repeatedError: NOT_CONFIRMED, lastError: NOT_CONFIRMED, attempts: 3,
      consecutiveFailures: 3, stuckSince: 10, stalledSince: 20, queuedBehind: [], auditId: "audit-park", resumedAt: PARKED_AT + 1,
    } }));
    await send(resumed.app, resume(), true).expect(409);
    const running = harness(parkedFleet({ status: "running", startedAt: 5 }));
    await send(running.app, resume(), false).expect(409);
    await send(harness(FLEET).app, resume(), false).expect(404);
  });
});
