import { beforeEach, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { isOperationAuditRecord, type Operation, type OperationAttemptRecord } from "@octogee/shared/types/glm";
import { buildOperationCompletionUpdate } from "../operation-retry.js";
import {
  OPERATION_STALL_RECORD_SCHEMA,
  STALLED_OPERATION_HOLD_MS,
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
      stuckForMs: 22 * MINUTE,
      fromGatewayId: SOURCE,
      toGatewayId: TARGET,
    });
    expect(stall.queuedBehind.map((entry) => entry.id)).toEqual(["placement-a", "placement-b"]);
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
      stuckForMs: STALLED_OPERATION_HOLD_MS });
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

describe("stalled operation observer", () => {
  let records: Record<string, Record<string, unknown>>;
  let emitted: OperationStallRecord[];
  let now: number;
  const tick = () => runStalledOperationObserverTick({
    store: createDocumentFixtureStore(records), namespace: "octogee", now: () => now, log: () => {},
    emit: (record) => emitted.push(record),
  });

  beforeEach(() => {
    resetMetrics();
    emitted = [];
    now = START + 22 * MINUTE;
    const { id: _returnId, ...stalled } = returnMove(repeated(3));
    const { id: _queuedId, ...queued } = queuedMove("placement-a", "shared-other", TARGET);
    records = { [`glmOperations/${RETURN_ID}`]: stalled, "glmOperations/placement-a": queued };
  });

  it("journals and logs the stall once, and keeps the gauge raised while it lasts", async () => {
    await tick();
    now += MINUTE;
    await tick();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      schema: OPERATION_STALL_RECORD_SCHEMA,
      namespace: "octogee",
      operationId: RETURN_ID,
      reason: "repeated-failure",
      repeatedError: NOT_CONFIRMED,
      attempts: 3,
      stuckSince: new Date(START).toISOString(),
      stuckForMs: 22 * MINUTE,
      queuedBehind: [{ id: "placement-a", kind: "migrate-user", waitingOn: `migration shared-other → ${TARGET}` }],
    });
    const audit = records[`glmOperations/${emitted[0].auditId}`];
    expect(isOperationAuditRecord(audit)).toBe(true);
    expect(audit).toMatchObject({
      actor: "fleet-controller",
      status: "completed",
      target: { operationId: RETURN_ID, toGatewayId: TARGET },
      preActionStatus: { attempts: 3, lastError: NOT_CONFIRMED, queuedBehind: ["placement-a"] },
      mutation: { kind: "operation-stalled", operationId: RETURN_ID, reason: "repeated-failure" },
    });
    expect(renderMetrics()).toContain(
      `glm_operation_stalled{operation_id="${RETURN_ID}",kind="migrate-user",reason="repeated-failure"} 1`);
    expect(renderMetrics()).toContain(`glm_operation_stalled_queued_operations{operation_id="${RETURN_ID}"} 1`);
  });

  it("lowers the gauge once the operation finishes", async () => {
    await tick();
    records[`glmOperations/${RETURN_ID}`] = { ...records[`glmOperations/${RETURN_ID}`], status: "succeeded", completedAt: now };
    await tick();
    expect(renderMetrics()).not.toContain("glm_operation_stalled{");
  });
});
