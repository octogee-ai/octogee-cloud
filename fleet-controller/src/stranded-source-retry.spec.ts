import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { MigrationRpcError } from "@octogee/core/fleet-migration-client";
import type { OperationRecord, Stored } from "@octogee/core/platform-state";
import type { ScheduleTransferRestored } from "@octogee/core/stranded-source-restore";
import { runStuckOpReaperTick } from "./stuck-op-reaper.js";
import {
  STRANDED_SOURCE_RESTORE_ATTEMPTS,
  STRANDED_SOURCE_RESUMES_PER_PASS,
  createStrandedSourceRetry,
  strandedSourceRestoreBackoffMs,
} from "./stranded-source-retry.js";

type Row = Record<string, unknown>;
type Records = Map<string, Row>;

const UID = "uid-ada", SLUG = "ada", SOURCE = "shared-a", TARGET = "ada-s-0a1b2c3d", OP = "op-move-1";
const ASSIGNMENT = `gateways/${SOURCE}/assignments/${UID}`;
const USER = `users/${UID}`;
const OPERATION = `glmOperations/${OP}`;
const ROOT = `gateways/${SOURCE}`;
const MINUTE = 60_000;

function strandedUser(uid: string, slug: string, operationId: string): Array<[string, Row]> {
  return [
    [`gateways/${SOURCE}/assignments/${uid}`, {
      uid, slug, gatewayId: SOURCE, source: "onboarding", state: "quiescing", epoch: 3,
      createdAt: 1, updatedAt: 1_500, updatedByOperationId: operationId,
    }],
    [`users/${uid}`, {
      username: slug,
      provisioning: { status: "complete", openclaw: {
        slug, status: "complete", gatewayId: SOURCE,
        migration: { state: "moving", phase: "transferring", operationId, startedAt: 1_000 },
      } },
    }],
    [`glmOperations/${operationId}`, {
      kind: "migrate-user", status: "failed", createdBy: "operator", createdAt: 1, startedAt: 1_000, completedAt: 2_000,
      error: "flush-source answered 500", input: { uid, userSlug: slug, fromGatewayId: SOURCE, toGatewayId: TARGET },
      steps: [
        { name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "done" },
        { name: "wait-for-active-work", status: "done" }, { name: "quiesce-source", status: "done" },
        { name: "flush-source", status: "failed", error: "flush answered 500" },
        { name: "rollback:unmount-target", status: "done" },
        { name: "rollback:resume-ingress", status: "failed", error: "resume failed" },
      ],
      gatewayId: TARGET, inputUid: uid, rolledBack: false,
    }],
  ];
}

function stranded(): Records {
  return new Map<string, Row>([
    [ROOT, { gatewayId: SOURCE, desiredRelease: 1, latestRelease: 1, desiredStatus: "running" }],
    ...strandedUser(UID, SLUG, OP),
  ]);
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

function patchOpenclaw(records: Records, fields: Row): void {
  const user = records.get(USER)!;
  const provisioning = user.provisioning as { openclaw: Row };
  records.set(USER, { ...user, provisioning: { ...provisioning, openclaw: { ...provisioning.openclaw, ...fields } } });
}

function harness(records: Records, gatewayDown = true) {
  const clock = { now: 10 * MINUTE };
  const gateway: {
    down: boolean; hold: Promise<void> | null; schedules: ScheduleTransferRestored; duringResume: (() => void) | null;
    beforeTransaction: ((label: string) => void) | null;
  } = { down: gatewayDown, hold: null, schedules: "none", duringResume: null, beforeTransaction: null };
  const logs: string[] = [];
  const transactions: string[] = [];
  const resumeSourceIngress = vi.fn(async (_input: { operationId: string; gatewayId: string; slug: string }) => {
    if (gateway.hold) await gateway.hold;
    gateway.duringResume?.();
    if (gateway.down) throw new MigrationRpcError("/resume/shared-a failed: 500 resume failed", { status: 500 });
  });
  const restoreSourceSchedules = vi.fn(async () => gateway.schedules);
  const store = createDocumentFixtureStore(records, { serializeTransactions: true, beforeTransaction: (label) => {
    transactions.push(label);
    gateway.beforeTransaction?.(label);
  } });
  const retry = createStrandedSourceRetry({ store, resumeSourceIngress, restoreSourceSchedules, log: (line) => logs.push(line), now: () => clock.now });
  const tick = () => runStuckOpReaperTick({ store, log: (line) => logs.push(line), now: () => clock.now, stalenessMs: 15 * MINUTE, restoreStrandedSources: retry.start });
  const pass = async () => {
    await tick();
    await retry.idle();
  };
  const checks = () => transactions.filter((label) => label === "stranded-source.read").length;
  const retryLogs = () => logs.filter((line) => !line.includes("restored serving for") && !line.includes("stays quiescing under operation"));
  return { clock, gateway, logs, transactions, resumeSourceIngress, restoreSourceSchedules, store, retry, tick, pass, checks, retryLogs };
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

  const WAITS: Array<[string, string, (records: Records) => void, (records: Records) => void]> = [
    ["an operation on the source gateway is in flight", "restart-gateway operation op-restart is pending",
      (r) => r.set("glmOperations/op-restart", {
        kind: "restart-gateway", status: "pending", createdBy: "operator", createdAt: 1, startedAt: null, completedAt: null,
        input: { gatewayId: SOURCE }, steps: [], gatewayId: SOURCE,
      }),
      (r) => patch(r, "glmOperations/op-restart", { status: "succeeded", startedAt: 2, completedAt: 3 })],
    ["a restore of the user is unresolved", `user ${UID} restore outcome is unresolved`,
      (r) => patchOpenclaw(r, { restoreFence: { operationId: "restore-1" } }),
      (r) => patchOpenclaw(r, { restoreFence: undefined })],
    ["the source gateway is paused", `gateway ${SOURCE} is paused; its ingress cannot be resumed until it runs again`,
      (r) => patch(r, ROOT, { desiredStatus: "paused" }),
      (r) => patch(r, ROOT, { desiredStatus: "running" })],
    ["the account is suspended", `user ${UID} account is suspended; it is not served`,
      (r) => patch(r, USER, { accountLifecycle: { status: "suspended", suspendedAt: 1_700 } }),
      (r) => patch(r, USER, { accountLifecycle: { status: "active" } })],
  ];

  it.each(WAITS)("waits while %s, checking again with backoff, and restores once it clears", async (_name, reason, block, clear) => {
    const records = stranded();
    block(records);
    const h = harness(records, false);
    const waiting = `[stranded-source] ⚠ ${OP} is not restored automatically yet: ${reason}; it is checked again after a wait that grows to 30 minutes`;
    const checkedAt: number[] = [];

    for (let minute = 0; minute <= 16; minute += 1) {
      h.clock.now = 10 * MINUTE + minute * MINUTE;
      const before = h.checks();
      await h.pass();
      if (h.checks() > before) checkedAt.push(minute);
    }

    expect(checkedAt).toEqual([0, 1, 3, 7, 15]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.logs).toEqual([waiting]);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
    expect(audits(records)).toEqual([]);

    clear(records);
    h.clock.now = 10 * MINUTE + 31 * MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
    expect(h.retryLogs()).toEqual([waiting, `[stranded-source] ${OP} no longer waits: its checks pass, restoring ${SLUG} on ${SOURCE}`]);
  });

  it("keeps checking a wait past the attempt limit, which counts failed resumes only", async () => {
    const records = stranded();
    patchOpenclaw(records, { restoreFence: { operationId: "restore-1" } });
    const h = harness(records, false);

    for (let minute = 0; minute <= 400; minute += 1) {
      h.clock.now = 10 * MINUTE + minute * MINUTE;
      await h.pass();
    }

    expect(h.checks()).toBeGreaterThan(STRANDED_SOURCE_RESTORE_ATTEMPTS);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();

    patchOpenclaw(records, { restoreFence: undefined });
    h.clock.now += 31 * MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("acts only on the source it journaled: a source that changed after the journal entry is not resumed", async () => {
    const records = stranded();
    const h = harness(records, false);
    h.gateway.beforeTransaction = (label) => {
      if (label === "operation-audit.claim") patch(records, ASSIGNMENT, { updatedAt: 1_600 });
    };

    await h.pass();

    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
    expect(audits(records).map((audit) => [audit.status, audit.error])).toEqual([
      ["failed", `the quiescing assignment of ${UID} is no longer the one on ${SOURCE} left by operation ${OP}`],
    ]);
  });

  it("forgets a move that leaves the failed list, so a later failure of it starts a new count at once", async () => {
    const records = stranded();
    const h = harness(records);
    await h.pass();
    expect(h.retryLogs()).toEqual([expect.stringContaining("(attempt 1/12, operation op-move-1)")]);

    patch(records, OPERATION, { status: "pending" });
    await h.pass();
    patch(records, OPERATION, { status: "failed" });
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(2);
    expect(h.retryLogs()).toEqual([
      expect.stringContaining("(attempt 1/12, operation op-move-1)"),
      expect.stringContaining("(attempt 1/12, operation op-move-1)"),
    ]);
  });

  it("says once when a wait ends in a refusal that cannot pass later", async () => {
    const records = stranded();
    patchOpenclaw(records, { restoreFence: { operationId: "restore-1" } });
    const h = harness(records, false);
    await h.pass();

    patchOpenclaw(records, { restoreFence: undefined });
    patch(records, ROOT, { desiredStatus: "retired" });
    h.clock.now += MINUTE;
    await h.pass();
    h.clock.now += 60 * MINUTE;
    await h.pass();

    expect(h.logs.slice(1)).toEqual([`[stranded-source] ⚠ ${OP} is not restored automatically: gateway ${SOURCE} is retired; its ingress cannot be resumed`]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("says once when a wait ends because the source serves again without it", async () => {
    const records = stranded();
    patchOpenclaw(records, { restoreFence: { operationId: "restore-1" } });
    const h = harness(records, false);
    await h.pass();

    patchOpenclaw(records, { restoreFence: undefined });
    patch(records, ASSIGNMENT, { state: "serving" });
    h.clock.now += MINUTE;
    await h.pass();
    h.clock.now += 60 * MINUTE;
    await h.pass();

    expect(h.logs.slice(1)).toEqual([`[stranded-source] ${OP} no longer waits for an automatic restore: user ${UID} has no quiescing assignment; nothing to restore`]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("waits, without counting a failed attempt, when the checks stop holding while the ingress resumes", async () => {
    const records = stranded();
    const h = harness(records, false);
    h.gateway.duringResume = () => patchOpenclaw(records, { restoreFence: { operationId: "restore-1" } });

    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });
    expect(h.logs).toEqual([
      `[stranded-source] ❌ source ingress on ${SOURCE} resumed but the assignment was not restored for uid=${UID} slug=${SLUG}: user ${UID} restore outcome is unresolved`,
      `[stranded-source] ⚠ ${OP} is not restored automatically yet: user ${UID} restore outcome is unresolved; it is checked again after a wait that grows to 30 minutes`,
    ]);
    expect(audits(records).map((audit) => [audit.status, audit.error])).toEqual([["failed", `user ${UID} restore outcome is unresolved`]]);

    h.gateway.duringResume = null;
    h.clock.now += MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);

    patchOpenclaw(records, { restoreFence: undefined });
    h.clock.now += 2 * MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(2);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("leaves a source held by a later failed move to that move's own entry, so one pass tries it once", async () => {
    const records = stranded();
    const later = "op-move-2";
    records.set(`glmOperations/${later}`, { ...records.get(OPERATION)!, createdAt: 2, startedAt: 3_000, completedAt: 4_000 });
    patch(records, ASSIGNMENT, { updatedByOperationId: later });
    patchOpenclaw(records, { migration: { state: "moving", phase: "transferring", operationId: later, startedAt: 3_000 } });
    const h = harness(records);

    await h.pass();

    expect(h.resumeSourceIngress.mock.calls).toEqual([[{ operationId: later, gatewayId: SOURCE, slug: SLUG }]]);
    expect(audits(records).map((audit) => [audit.status, (audit.mutation as Row).failedMoveId])).toEqual([["failed", later]]);
    expect(h.retryLogs()).toEqual([expect.stringContaining(`(attempt 1/12, operation ${later})`)]);

    h.gateway.down = false;
    h.clock.now += MINUTE;
    await h.pass();

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(2);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving", updatedByOperationId: later });
  });

  it("says that a new wait starts when the checks stop holding again right after a wait ended", async () => {
    const records = stranded();
    patchOpenclaw(records, { restoreFence: { operationId: "restore-1" } });
    const h = harness(records, false);
    await h.pass();

    patchOpenclaw(records, { restoreFence: undefined });
    h.gateway.duringResume = () => patchOpenclaw(records, { restoreFence: { operationId: "restore-2" } });
    h.clock.now += MINUTE;
    await h.pass();

    const waiting = `[stranded-source] ⚠ ${OP} is not restored automatically yet: user ${UID} restore outcome is unresolved; it is checked again after a wait that grows to 30 minutes`;
    expect(h.logs).toEqual([
      waiting,
      `[stranded-source] ${OP} no longer waits: its checks pass, restoring ${SLUG} on ${SOURCE}`,
      expect.stringContaining("resumed but the assignment was not restored"),
      waiting,
    ]);
  });

  it("journals a partial outcome when the schedules the move took off the source are not restored", async () => {
    const records = stranded();
    const h = harness(records, false);
    h.gateway.schedules = false;

    await h.pass();

    expect(h.restoreSourceSchedules.mock.calls).toEqual([[{ uid: UID, operationId: OP, gatewayId: SOURCE, slug: SLUG }]]);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
    expect(audits(records).map((audit) => [audit.status, audit.outcome, audit.partialOutcome])).toEqual([
      ["completed", "partial", { summary: `${SLUG} serves again on ${SOURCE}; its schedules were not restored`, details: { schedulesRestored: false, sourceDraining: false } }],
    ]);
    expect(h.logs).toContainEqual(expect.stringContaining("❌ the schedules operation op-move-1 took off shared-a were not restored"));
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

describe("the pass over failed operations and the reaper tick that starts it", () => {
  it("does not hold the tick while a gateway answers, and a tick during a running pass starts no second one", async () => {
    const records = stranded();
    const h = harness(records, false);
    let release = () => {};
    h.gateway.hold = new Promise<void>((resolve) => { release = resolve; });

    await h.tick();
    await vi.waitFor(() => expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1));
    await h.tick();
    await h.tick();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
    expect(h.logs).toEqual([]);
    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "quiescing" });

    release();
    await h.retry.idle();

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);
  });

  it("starts at most five resumes in a pass and takes the users it has not tried first in the next", async () => {
    const records = stranded();
    const users = [1, 2, 3, 4, 5, 6].map((n) => `u${n}`);
    for (const slug of users) {
      for (const [path, row] of strandedUser(`uid-${slug}`, slug, `op-${slug}`)) records.set(path, row);
    }
    const h = harness(records);
    const resumed = () => h.resumeSourceIngress.mock.calls.map(([input]) => input.slug);

    await h.pass();

    const first = resumed();
    expect(first).toHaveLength(STRANDED_SOURCE_RESUMES_PER_PASS);
    const untried = [SLUG, ...users].filter((slug) => !first.includes(slug));
    expect(untried).toHaveLength(2);

    h.clock.now += MINUTE;
    await h.pass();

    const second = resumed().slice(first.length);
    expect(second).toHaveLength(STRANDED_SOURCE_RESUMES_PER_PASS);
    expect([...second.slice(0, 2)].sort()).toEqual([...untried].sort());
  });

  it("logs a failed row it cannot read and still restores the others", async () => {
    const records = stranded();
    const h = harness(records, false);
    const failed = await h.store.journal.operations.listByStatus(["failed"]);
    const unreadable = { id: "op-unreadable", kind: "migrate-user", status: "failed" } as unknown as Stored<OperationRecord>;

    h.retry.start([unreadable, ...failed]);
    await h.retry.idle();

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
    expect(h.retryLogs()).toEqual([expect.stringMatching(/^\[stranded-source\] ❌ op-unreadable could not be checked for a stranded source: /)]);
  });

  it("logs a list it cannot walk and is ready for the next one", async () => {
    const records = stranded();
    const h = harness(records, false);

    h.retry.start([null as unknown as Stored<OperationRecord>]);
    await h.retry.idle();

    expect(h.logs).toEqual([expect.stringMatching(/^\[stranded-source\] ❌ the pass over failed moves stopped: /)]);

    await h.pass();

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("says every 15 minutes that a pass has not ended, and starts no other", async () => {
    const records = stranded();
    const h = harness(records, false);
    let release = () => {};
    h.gateway.hold = new Promise<void>((resolve) => { release = resolve; });
    const start = h.clock.now;
    const hung = (minutes: number) =>
      `[stranded-source] ❌ the pass over failed moves has run for ${minutes} minutes without ending; no other pass starts until it does`;

    await h.tick();
    await vi.waitFor(() => expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1));
    const logged: string[][] = [];
    for (const minute of [14, 15, 16, 29, 30, 31]) {
      h.clock.now = start + minute * MINUTE;
      await h.tick();
      logged.push([...h.logs]);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(logged).toEqual([[], [hung(15)], [hung(15)], [hung(15)], [hung(15), hung(30)], [hung(15), hung(30)]]);
    expect(h.resumeSourceIngress).toHaveBeenCalledTimes(1);

    release();
    await h.retry.idle();

    expect(records.get(ASSIGNMENT)).toMatchObject({ state: "serving" });
  });

  it("names a source on a retired gateway once and never calls the gateway", async () => {
    const records = stranded();
    patch(records, ROOT, { desiredStatus: "retired" });
    const h = harness(records, false);

    for (let minute = 0; minute < 90; minute += 10) {
      h.clock.now = 10 * MINUTE + minute * MINUTE;
      await h.pass();
    }

    expect(h.logs).toEqual([`[stranded-source] ⚠ ${OP} is not restored automatically: gateway ${SOURCE} is retired; its ingress cannot be resumed`]);
    expect(h.resumeSourceIngress).not.toHaveBeenCalled();
    expect(audits(records)).toEqual([]);
  });
});

