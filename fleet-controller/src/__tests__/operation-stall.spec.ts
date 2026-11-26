import { beforeEach, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { isOperationAuditRecord, type Operation, type OperationAttemptRecord } from "@octogee/shared/types/glm";
import { PARKED_OPERATION_WAITING_ON, resumeParkedOperationInTransaction } from "@octogee/core/operation-stall-park";
import { buildOperationCompletionUpdate } from "../operation-retry.js";
import { decideOperationClaim } from "../operation-queue.js";
import {
  OPERATION_STALL_RECORD_SCHEMA,
  STALLED_OPERATION_HOLD_MS,
  STALLED_OPERATION_PARK_AFTER_MS,
  STALLED_OPERATION_REPEATED_FAILURES,
  findStalledOperations,
  runStalledOperationObserverTick,
  type OperationStallRecord,
} from "../operation-stall.js";
import { renderMetrics, resetMetrics } from "../metrics.js";

const MINUTE = 60_000;
const START = 1_764_122_496_000;
const RETURN_ID = "builder-return-user-a-iso-a-g52";
const TARGET = "shared-target";
const SOURCE = "iso-a";
const NOT_CONFIRMED =
  'migration forward recovery pending: status 503: /finish-rsync-import/shared-target: 500 {"error":"import failed","message":"Agent configuration was saved but its application to the active Gateway was not confirmed (failed); run config.get, then apply the saved config or restart the Gateway."}';

function attempt(index: number, error: string, startedAt: number): OperationAttemptRecord {
  return { attempt: index, startedAt, completedAt: startedAt + 4 * MINUTE, error, classification: "transient", steps: [] };
}

function returnMove(history: OperationAttemptRecord[], overrides: Partial<Operation> = {}): Operation {
  return {
    id: RETURN_ID,
    kind: "migrate-user",
    status: "pending",
    origin: "automatic",
    createdAt: START,
    createdBy: "fleet-controller",
    startedAt: null,
    completedAt: null,
    firstStartedAt: START,
    steps: [],
    attempts: history.length,
    attemptHistory: history,
    input: { uid: "user-a", fromGatewayId: SOURCE, toGatewayId: TARGET, source: "builder-activation-lease" },
    error: `attempt ${history.length} failed (transient): ${history.at(-1)?.error ?? ""} — retrying in 480s`,
    ...overrides,
  } as Operation;
}

function queuedMove(id: string, from: string, to: string, createdAt = START + MINUTE): Operation {
  return {
    id,
    kind: "migrate-user",
    status: "pending",
    origin: "automatic",
    createdAt,
    createdBy: "fleet-controller",
    startedAt: null,
    completedAt: null,
    steps: [],
    input: { uid: `${id}-uid`, fromGatewayId: from, toGatewayId: to },
    waitingOn: `migration ${from} → ${to}`,
  } as Operation;
}

function repeated(count: number, error = NOT_CONFIRMED): OperationAttemptRecord[] {
  return Array.from({ length: count }, (_, index) => attempt(index + 1, error, START + index * 9 * MINUTE));
}

describe("the 2026-11-26 shared roll stall", () => {
  it("keeps retrying the not-confirmed import as transient forward recovery, so nothing else stops it", () => {
    const op = returnMove(repeated(31), {
      status: "running",
      startedAt: START + 11 * 60 * MINUTE,
      schedulerHandoff: { fromGatewayId: SOURCE, toGatewayId: TARGET, forwardRecovery: { schemaVersion: 1, phase: "source-flushed" } },
    } as Partial<Operation>);
    const completion = buildOperationCompletionUpdate({
      op, result: { success: false, steps: [], error: NOT_CONFIRMED, rolledBack: false }, steps: [], now: START + 11 * 60 * MINUTE + 5 * MINUTE,
    });
    expect(completion).toMatchObject({ status: "pending", attempts: 32 });
  });

  it("reports the move as stalled once the same failure repeats as often as the ordinary attempt cap allows", () => {
    const queued = [
      queuedMove("placement-a", "shared-other", TARGET),
      queuedMove("placement-b", SOURCE, "shared-other"),
    ];
    const unrelated = queuedMove("placement-c", "shared-x", "shared-y");
    const now = START + 22 * MINUTE;
    const [stall, ...rest] = findStalledOperations(
      [returnMove(repeated(STALLED_OPERATION_REPEATED_FAILURES)), ...queued, unrelated], now);
    expect(rest).toEqual([]);
    expect(stall).toMatchObject({
      operationId: RETURN_ID,
      reason: "repeated-failure",
      repeatedError: NOT_CONFIRMED,
      consecutiveFailures: 3,
      attempts: 3,
      stuckSince: START,
      stalledSince: START + 22 * MINUTE,
      stuckForMs: 22 * MINUTE,
      fromGatewayId: SOURCE,
      toGatewayId: TARGET,
    });
    expect(stall.queuedBehind.map((entry) => entry.id)).toEqual(["placement-a", "placement-b"]);
  });

  it("counts a streak that fills the retained attempt history as at least that long, from the first start", () => {
    const history = repeated(31).slice(-20);
    const now = START + 11 * 60 * MINUTE;
    const [stall] = findStalledOperations([returnMove(history, { attempts: 31 })], now);
    expect(stall).toMatchObject({ consecutiveFailures: 20, consecutiveFailuresTruncated: true, attempts: 31,
      stuckSince: START, stuckForMs: 11 * 60 * MINUTE });
  });

  it("does not report a move whose failures have not yet repeated enough, or have changed", () => {
    const now = START + 22 * MINUTE;
    expect(findStalledOperations([returnMove(repeated(STALLED_OPERATION_REPEATED_FAILURES - 1))], now)).toEqual([]);
    const changed = [...repeated(2), attempt(3, "migration forward recovery pending: status 503: fetch failed", START + 18 * MINUTE)];
    expect(findStalledOperations([returnMove(changed)], now)).toEqual([]);
  });
});

describe("operations holding a queue", () => {
  const alternating = [
    attempt(1, "fetch failed", START),
    attempt(2, NOT_CONFIRMED, START + 9 * MINUTE),
    attempt(3, "fetch failed", START + 18 * MINUTE),
  ];

  it("reports a failing operation that has kept a conflicting operation queued past the hold bound", () => {
    const now = START + STALLED_OPERATION_HOLD_MS;
    const [stall] = findStalledOperations([returnMove(alternating), queuedMove("placement-a", "shared-other", TARGET)], now);
    expect(stall).toMatchObject({ reason: "holding-queue", repeatedError: null, lastError: "fetch failed", stuckSince: START,
      stalledSince: START + STALLED_OPERATION_HOLD_MS, stuckForMs: STALLED_OPERATION_HOLD_MS });
  });

  it("leaves it alone before the bound, or when nothing waits on it", () => {
    expect(findStalledOperations([returnMove(alternating), queuedMove("placement-a", "shared-other", TARGET)],
      START + STALLED_OPERATION_HOLD_MS - 1)).toEqual([]);
    expect(findStalledOperations([returnMove(alternating)], START + 10 * STALLED_OPERATION_HOLD_MS)).toEqual([]);
  });

  it("does not count an operation that waits on its own condition as queued behind it", () => {
    const idle = { ...queuedMove("placement-a", "shared-other", TARGET), waitingOn: "builder-idle" } as Operation;
    expect(findStalledOperations([returnMove(alternating), idle], START + STALLED_OPERATION_HOLD_MS)).toEqual([]);
  });

  it("does not report a move that is waiting for its gateway to become compatible", () => {
    const waiting = returnMove(repeated(5, "gateway compatibility pending"), { output: { gatewayCompatibilityPending: true } });
    expect(findStalledOperations([waiting, queuedMove("placement-a", "shared-other", TARGET)],
      START + 10 * STALLED_OPERATION_HOLD_MS)).toEqual([]);
  });
});

describe("parking a stalled operation", () => {
  const DETECTED = START + 22 * MINUTE;
  const PARKS = DETECTED + STALLED_OPERATION_PARK_AFTER_MS;
  let records: Record<string, Record<string, unknown>>;
  let emitted: OperationStallRecord[];
  let now: number;
  const store = () => createDocumentFixtureStore(records);
  const tick = () => runStalledOperationObserverTick({
    store: store(), namespace: "octogee", now: () => now, log: () => {},
    emit: (record) => emitted.push(record),
  });
  const tickAt = async (at: number) => { now = at; return tick(); };
  const row = (id: string) => ({ id, ...records[`glmOperations/${id}`] }) as Operation;
  const audits = (kind: string) => Object.values(records).filter((record) =>
    isOperationAuditRecord(record) && (record.mutation as { kind?: string } | undefined)?.kind === kind);
  const update = (id: string, patch: Record<string, unknown>) => {
    const merged: Record<string, unknown> = { ...records[`glmOperations/${id}`], ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "object" && value !== null && (value as { clear?: unknown }).clear === true) delete merged[key];
    }
    records[`glmOperations/${id}`] = merged;
  };
  const claimDecision = (id: string) => {
    const op = row(id);
    const others = Object.keys(records)
      .filter((key) => key.startsWith("glmOperations/") && key !== `glmOperations/${id}`)
      .map((key) => row(key.slice("glmOperations/".length)))
      .filter((other) => other.kind === op.kind);
    return decideOperationClaim({
      op, now,
      runningOpsSameKind: others.filter((other) => other.status === "running"),
      pendingOpsSameKind: others.filter((other) => other.status === "pending"),
    });
  };
  const fail = (error: string) => {
    const startedAt = now;
    now += 4 * MINUTE;
    update(RETURN_ID, buildOperationCompletionUpdate({
      op: { ...row(RETURN_ID), startedAt },
      result: { success: false, steps: [], error, rolledBack: false }, steps: [], now,
    }) as Record<string, unknown>);
    now += 5 * MINUTE;
  };
  const resume = (reason: string) => store().transaction({ label: "test.resume" }, (tx) =>
    resumeParkedOperationInTransaction(tx, {
      operationId: RETURN_ID, parkedAt: row(RETURN_ID).stallPark!.parkedAt, actor: "operator", reason,
      auditId: "audit-resume", now,
    }));

  beforeEach(() => {
    resetMetrics();
    emitted = [];
    now = DETECTED;
    const { id: _returnId, ...stalled } = returnMove(repeated(3), {
      schedulerHandoff: { fromGatewayId: SOURCE, toGatewayId: TARGET, forwardRecovery: { schemaVersion: 1, phase: "source-flushed" } },
      nextAttemptAt: DETECTED + 8 * MINUTE,
    } as Partial<Operation>);
    const { id: _queuedId, ...queued } = queuedMove("placement-a", "shared-other", TARGET);
    records = { [`glmOperations/${RETURN_ID}`]: stalled, "glmOperations/placement-a": queued };
  });

  it("reports the stall at the bound and keeps retrying it", async () => {
    await tickAt(DETECTED);
    await tickAt(DETECTED + MINUTE);

    expect(row(RETURN_ID).stallPark).toBeUndefined();
    expect(row(RETURN_ID).waitingOn).toBeUndefined();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      schema: OPERATION_STALL_RECORD_SCHEMA,
      namespace: "octogee",
      operationId: RETURN_ID,
      reason: "repeated-failure",
      repeatedError: NOT_CONFIRMED,
      attempts: 3,
      parked: false,
      parkedAt: null,
      stalledSince: new Date(DETECTED).toISOString(),
      parkAt: new Date(PARKS).toISOString(),
      queuedBehind: [{ id: "placement-a", kind: "migrate-user", waitingOn: `migration shared-other → ${TARGET}` }],
    });
    expect(audits("operation-stalled")).toEqual([expect.objectContaining({
      actor: "fleet-controller", status: "completed", target: expect.objectContaining({ operationId: RETURN_ID }),
      preActionStatus: { status: "pending", attempts: 3, lastError: NOT_CONFIRMED, queuedBehind: ["placement-a"] },
    })]);
    expect(renderMetrics()).toContain(
      `glm_operation_stalled{operation_id="${RETURN_ID}",kind="migrate-user",reason="repeated-failure",state="retrying"} 1`);
    now = DETECTED + 8 * MINUTE;
    expect(claimDecision(RETURN_ID)).toEqual({ outcome: "claim" });
  });

  it("parks the November 26 move once it has stayed stalled for 30 minutes, keeping it pending with its lock", async () => {
    await tickAt(DETECTED);
    await tickAt(PARKS - 1);
    expect(row(RETURN_ID).stallPark).toBeUndefined();

    await tickAt(PARKS);
    const parked = row(RETURN_ID);
    expect(parked).toMatchObject({
      status: "pending",
      attempts: 3,
      startedAt: null,
      waitingOn: PARKED_OPERATION_WAITING_ON,
      stallPark: { reason: "repeated-failure", repeatedError: NOT_CONFIRMED, attempts: 3, consecutiveFailures: 3,
        stuckSince: START, stalledSince: DETECTED, queuedBehind: ["placement-a"], parkedAt: PARKS },
      input: { uid: "user-a", fromGatewayId: SOURCE, toGatewayId: TARGET },
    });
    expect(parked.nextAttemptAt).toBeUndefined();
    expect(audits("park-operation")).toEqual([records[`glmOperations/${parked.stallPark!.auditId}`]]);
    expect(audits("park-operation")).toEqual([expect.objectContaining({
      actor: "fleet-controller",
      status: "completed",
      what: "park a fleet operation that is not making progress",
      why: `the same failure repeated 3 times and it stayed stalled for 30 minutes: ${NOT_CONFIRMED}`,
      target: expect.objectContaining({ operationId: RETURN_ID, toGatewayId: TARGET }),
    })]);
    expect(emitted.map((record) => record.parked)).toEqual([false, true]);
    expect(emitted[1]).toMatchObject({ parkedAt: new Date(PARKS).toISOString(), auditId: parked.stallPark!.auditId });
    expect(renderMetrics()).toContain(`reason="repeated-failure",state="parked"} 1`);
    expect(renderMetrics()).toContain(`glm_operation_stalled_queued_operations{operation_id="${RETURN_ID}"} 1`);
  });

  it.each([10, 26])("does not park a stall that clears by itself after %i minutes", async (minutes) => {
    await tickAt(DETECTED);
    await tickAt(DETECTED + (minutes - 1) * MINUTE);
    update(RETURN_ID, { status: "running", startedAt: DETECTED + (minutes - 1) * MINUTE });
    await tickAt(DETECTED + minutes * MINUTE);
    update(RETURN_ID, { status: "succeeded", completedAt: now });
    await tickAt(PARKS + MINUTE);

    expect(row(RETURN_ID).stallPark).toBeUndefined();
    expect(audits("park-operation")).toEqual([]);
    expect(emitted.map((record) => record.parked)).toEqual([false]);
    expect(renderMetrics()).not.toContain("glm_operation_stalled{");
  });

  it("does not park an attempt that is still running, and parks it once it is pending again", async () => {
    update(RETURN_ID, { status: "running", startedAt: DETECTED });
    await tickAt(PARKS + MINUTE);
    expect(row(RETURN_ID).stallPark).toBeUndefined();
    expect(renderMetrics()).toContain(`state="retrying"} 1`);

    update(RETURN_ID, { status: "pending", startedAt: null });
    await tickAt(PARKS + 2 * MINUTE);
    expect(row(RETURN_ID).stallPark).toMatchObject({ stalledSince: DETECTED, parkedAt: PARKS + 2 * MINUTE });
  });

  it("parks an operation that has held the queue for the hold bound and then 30 more minutes", async () => {
    const alternating = [attempt(1, "fetch failed", START), attempt(2, NOT_CONFIRMED, START + 9 * MINUTE)];
    const { id: _id, ...holding } = returnMove(alternating);
    records[`glmOperations/${RETURN_ID}`] = holding;
    await tickAt(START + STALLED_OPERATION_HOLD_MS);
    expect(row(RETURN_ID).stallPark).toBeUndefined();
    await tickAt(START + STALLED_OPERATION_HOLD_MS + STALLED_OPERATION_PARK_AFTER_MS);
    expect(row(RETURN_ID).stallPark).toMatchObject({ reason: "holding-queue", stalledSince: START + STALLED_OPERATION_HOLD_MS });
  });

  it("refuses to claim the parked move even once its backoff would have elapsed, and keeps the queue behind it", async () => {
    await tickAt(DETECTED);
    await tickAt(PARKS);
    now += 60 * MINUTE;

    expect(claimDecision(RETURN_ID)).toEqual({ outcome: "skip" });
    expect(claimDecision("placement-a")).toEqual({ outcome: "queue", waitingOn: expect.stringContaining(SOURCE) });
  });

  it("resumes by the operator's command, retries, and parks again on the same rule", async () => {
    await tickAt(DETECTED);
    await tickAt(PARKS);
    now += 60 * MINUTE;
    await resume("restarted the target gateway");

    expect(row(RETURN_ID)).toMatchObject({ stallPark: { resumedBy: "operator", resumeReason: "restarted the target gateway",
      resumeAuditId: "audit-resume" } });
    expect(row(RETURN_ID).waitingOn).toBeUndefined();
    expect(claimDecision(RETURN_ID)).toEqual({ outcome: "claim" });

    fail(NOT_CONFIRMED);
    fail(NOT_CONFIRMED);
    await tick();
    expect(claimDecision(RETURN_ID)).toEqual({ outcome: "skip" });
    expect(renderMetrics()).not.toContain("glm_operation_stalled{");

    fail(NOT_CONFIRMED);
    const redetected = now - 5 * MINUTE;
    await tick();
    expect(row(RETURN_ID).stallPark?.resumedAt).toEqual(expect.any(Number));
    expect(row(RETURN_ID).waitingOn).toBeUndefined();

    await tickAt(redetected + STALLED_OPERATION_PARK_AFTER_MS);
    const reparked = row(RETURN_ID);
    expect(reparked).toMatchObject({ attempts: 6, waitingOn: PARKED_OPERATION_WAITING_ON,
      stallPark: { attempts: 6, consecutiveFailures: 3, stalledSince: redetected, parkedAt: now } });
    expect(reparked.stallPark?.resumedAt).toBeUndefined();
    expect(audits("park-operation")).toHaveLength(2);
    expect(claimDecision(RETURN_ID)).toEqual({ outcome: "skip" });
  });

  it("still emits the stall record when the journal cannot be written, and does not park", async () => {
    const fixture = store();
    const logged: string[] = [];
    await runStalledOperationObserverTick({
      store: { ...fixture, transaction: async () => { throw new Error("database unavailable"); } } as typeof fixture,
      namespace: "octogee", now: () => PARKS, log: (line) => logged.push(line), emit: (record) => emitted.push(record),
    });
    expect(emitted).toMatchObject([{ operationId: RETURN_ID, reason: "repeated-failure", parked: false, auditId: null }]);
    expect(logged).toEqual([expect.stringContaining("database unavailable"), expect.stringContaining("could not be parked")]);
    expect(row(RETURN_ID).stallPark).toBeUndefined();
    expect(renderMetrics()).toContain(`state="retrying"} 1`);
  });

  it("lowers the gauge once the operation finishes", async () => {
    await tickAt(DETECTED);
    update(RETURN_ID, { status: "succeeded", completedAt: now });
    await tick();
    expect(renderMetrics()).not.toContain("glm_operation_stalled{");
  });
});
