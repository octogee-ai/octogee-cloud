import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { MigrationRpcError } from "@octogee/core/fleet-migration-client";
import { runStuckOpReaperTick } from "./stuck-op-reaper.js";
import { STRANDED_SOURCE_RESTORE_ATTEMPTS, createStrandedSourceRetry, strandedSourceRestoreBackoffMs } from "./stranded-source-retry.js";

type Row = Record<string, unknown>;
type Records = Map<string, Row>;

const UID = "uid-ada", SLUG = "ada", SOURCE = "shared-a", TARGET = "ada-s-0a1b2c3d", OP = "op-move-1";
const ASSIGNMENT = `gateways/${SOURCE}/assignments/${UID}`;
const USER = `users/${UID}`;
const OPERATION = `glmOperations/${OP}`;
const MINUTE = 60_000;

function stranded(): Records {
  return new Map<string, Row>(Object.entries({
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
  return [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);
}

function migrationFence(records: Records): unknown {
  return (records.get(USER)!.provisioning as { openclaw: Row }).openclaw.migration;
}

function harness(records: Records, gatewayDown = true) {
  const clock = { now: 10 * MINUTE };
  const gateway = { down: gatewayDown };
  const logs: string[] = [];
  const transactions: string[] = [];
  const resumeSourceIngress = vi.fn(async () => {
    if (gateway.down) throw new MigrationRpcError("/resume/shared-a failed: 500 resume failed", { status: 500 });
  });
  const store = createDocumentFixtureStore(records, { serializeTransactions: true, beforeTransaction: (label) => { transactions.push(label); } });
  const restoreStrandedSources = createStrandedSourceRetry({ store, resumeSourceIngress, log: (line) => logs.push(line), now: () => clock.now });
  const pass = () => runStuckOpReaperTick({ store, log: (line) => logs.push(line), now: () => clock.now, stalenessMs: 15 * MINUTE, restoreStrandedSources });
  return { clock, gateway, logs, transactions, resumeSourceIngress, pass };
}

describe("the pass over failed operations, for a move that left its source closed", () => {
  it("restores the user once the source gateway resumes, and journals each attempt", async () => {
    const records = stranded();
    const h = harness(records);

    await h.pass();

    expect(h.resumeSourceIngress.mock.calls).toEqual([[{ operationId: OP, gatewayId: SOURCE, slug: SLUG }]]);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing", updatedAt: 1_500 });
    expect(migrationFence(records)).toMatchObject({ operationId: OP });
    expect(h.logs).toContainEqual(expect.stringMatching(
      /❌ automatic restore of ada on shared-a failed \(attempt 1\/12, operation op-move-1\): source ingress on shared-a not resumed for ada: .*500 resume failed; next attempt in 60s/,
    ));

    h.gateway.down = false;
    h.clock.now += MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(2);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving", updatedByOperationId: OP });
    expect(migrationFence(records)).toBeUndefined();
    expect(audits(records).map((audit) => [audit.status, audit.actor, audit.what, (audit.mutation as Row).automatic])).toEqual([
      ["failed", "fleet-controller", "restore stranded source to serving", true],
      ["completed", "fleet-controller", "restore stranded source to serving", true],
    ]);

    h.clock.now += 60 * MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(2);
    expect(audits(records)).toHaveLength(2);
  });

  it("waits longer after each failed resume and stops after the last attempt", async () => {
    const records = stranded();
    const h = harness(records);
    const attemptedAt: number[] = [];
    const start = h.clock.now;

    for (let elapsed = 0; elapsed <= 12 * 60 * MINUTE; elapsed += MINUTE) {
      h.clock.now = start + elapsed;
      const before = h.resumeSourceIngress.mock.calls.length;
      await h.pass();
      if (h.resumeSourceIngress.mock.calls.length > before) attemptedAt.push(elapsed / MINUTE);
    }

    expect(attemptedAt).toEqual([0, 1, 3, 7, 15, 31, 61, 91, 121, 151, 181, 211]);
    expect(attemptedAt).toHaveLength(STRANDED_SOURCE_RESTORE_ATTEMPTS);
    expect(h.logs.filter((line) => line.includes("❌ automatic restore"))).toHaveLength(STRANDED_SOURCE_RESTORE_ATTEMPTS);
    expect(h.logs.at(-1)).toContain(
      `attempt 12/12, operation ${OP}): source ingress on ${SOURCE} not resumed for ${SLUG}: /resume/shared-a failed: 500 resume failed; ` +
      `no further automatic attempt until the fleet controller restarts; POST /users/${UID}/restore-serving repairs it`,
    );
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
    expect(audits(records)).toHaveLength(STRANDED_SOURCE_RESTORE_ATTEMPTS);
  });

  it.each([[1, MINUTE], [2, 2 * MINUTE], [5, 16 * MINUTE], [6, 30 * MINUTE], [11, 30 * MINUTE]])(
    "waits after failure %i for %i ms", (failures, expected) => {
      expect(strandedSourceRestoreBackoffMs(failures)).toBe(expected);
    });

  it("waits without logging while another operation for the user is in flight, then restores", async () => {
    const records = stranded();
    records.set("glmOperations/op-suspend", {
      kind: "suspend-user", status: "running", createdBy: "operator", createdAt: 1, startedAt: 2, completedAt: null,
      input: { uid: UID }, steps: [], inputUid: UID,
    });
    const h = harness(records, false);

    await h.pass();
    await h.pass();

    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);

    patch(records, "glmOperations/op-suspend", { status: "succeeded", completedAt: 3 });
    await h.pass();

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("names once why a stranded source is not restored, and does not act", async () => {
    const records = stranded();
    patch(records, OPERATION, { cutoverCommittedAt: 1_900 });
    const h = harness(records, false);

    await h.pass();
    await h.pass();
    await h.pass();

    expect(h.logs).toEqual([`[stranded-source] ⚠ ${OP} is not restored automatically: operation ${OP} committed its cutover`]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
    expect(audits(records)).toEqual([]);
  });

  it("checks a move whose rollback finished once, quietly, and not again", async () => {
    const records = stranded();
    patch(records, ASSIGNMENT, { state: "serving" });
    const h = harness(records, false);

    await h.pass();
    const checkedOnce = h.transactions.filter((label) => label === "stranded-source.read").length;
    await h.pass();

    expect(checkedOnce).toBe(1);
    expect(h.transactions.filter((label) => label === "stranded-source.read")).toHaveLength(1);
    expect(h.logs).toEqual([]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("does not look at a failed move whose rollback never reached the source ingress", async () => {
    const records = stranded();
    patch(records, OPERATION, { steps: [{ name: "keys-sync-state", status: "failed", error: "request timed out" }] });
    const h = harness(records, false);

    await h.pass();

    expect(h.transactions).not.toContain("stranded-source.read");
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
  });
});
