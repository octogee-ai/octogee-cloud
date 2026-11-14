import { describe, expect, it, vi } from "vitest";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createCronCustodyGateways } from "@octogee/core/testing/cron-custody";
import type { ScheduleRecord, ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";

import {
  applyUnrestoredScheduleRepair,
  parseRepairUnrestoredSchedulesArgs,
  planUnrestoredScheduleRepairs,
  repairUnrestoredSchedules,
} from "../ops/repair-unrestored-schedules.js";

const VM = "alice-vm", SHARED = "shared-1", COACH = "octogee-alice-coach", SITE = "octogee-alice-site";
const RETURN_ID = "builder-return-alice-vm-g1", RETURN_HOLD = `mig-${RETURN_ID}:scheduler:1:claim:100`;
const ACTIVATION_ID = "builder-activate-alice-vm-g2", ACTIVATION_TRANSFER = `mig-${ACTIVATION_ID}`;
const NOW = 9_000;
const HELD = `CronAgentMigrationHeldError: Cron agent ${COACH} is held for migration ${RETURN_HOLD}`;
const COOLDOWN = 'invalid cron.add params: Auth profile "platform-openai:default" is temporarily unavailable for platform-openai/gpt-6.1-terra.';
const MONITOR_KEY = `octogee:coach-monitor:${COACH}`;
const MONITOR: ScheduleRecord = {
  sourceJobId: "job-monitor", agentId: COACH, scratch: null,
  job: { name: "Coach monitor", enabled: true, declarationKey: MONITOR_KEY, schedule: { kind: "every", everyMs: 3_600_000 } },
};
const DIGEST: ScheduleRecord = {
  sourceJobId: "job-digest", agentId: SITE, scratch: null, job: { name: "Site digest", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" } },
};
const TRANSFERS = "users/uid-alice/scheduleTransfers";

function transfer(overrides: Partial<ScheduleTransferDoc> = {}): ScheduleTransferDoc {
  return {
    migrationId: ACTIVATION_TRANSFER, slug: "alice", sourceGatewayId: SHARED, targetGatewayId: VM, records: [DIGEST, MONITOR], skipped: [],
    snapshotAt: 4_900, restoreAttemptedTo: VM, restoreAttemptedAt: 5_050,
    restoreFailures: [{ name: "Coach monitor", agentId: COACH, sourceJobId: "job-monitor", error: HELD }],
    ...overrides,
  };
}

function operation(id: string, fields: Record<string, unknown>) {
  return {
    [`glmOperations/${id}`]: {
      kind: "migrate-user", status: "succeeded", createdBy: "cowboy", createdAt: 100, startedAt: 100, steps: [], inputUid: "uid-alice", ...fields,
    },
  };
}

function world(options: { gatewayId?: string; returnJournaled?: boolean; fence?: "retired" | "exported" } = {}) {
  const gatewayId = options.gatewayId ?? VM;
  const records: Record<string, Record<string, unknown>> = {
    "users/uid-alice": { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId, agentId: COACH, agentIds: [COACH, SITE] } } },
    [`gateways/${VM}`]: {
      gatewayId: VM, gatewayClass: "isolated", ownerUid: "uid-alice", builderSlug: "alice", desiredStatus: "running", desiredRelease: 1, liveRelease: 1, latestRelease: 1,
    },
    [`gateways/${SHARED}`]: { gatewayId: SHARED, gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, liveRelease: 1, latestRelease: 1 },
    ...(options.returnJournaled === false ? {} : operation(RETURN_ID, {
      input: { uid: "uid-alice", fromGatewayId: VM, toGatewayId: SHARED }, cutoverCommittedAt: 1_000, completedAt: 1_200,
    })),
    ...operation(ACTIVATION_ID, { input: { uid: "uid-alice", toGatewayId: VM }, cutoverCommittedAt: 5_000, completedAt: 5_100 }),
    [`${TRANSFERS}/${ACTIVATION_TRANSFER}`]: transfer() as unknown as Record<string, unknown>,
  };
  const store = createDocumentFixtureStore(records);
  const custody = createCronCustodyGateways({ alice: [COACH, SITE] });
  const vm = custody.store(VM);
  const watch = vm.add({ agentId: COACH, name: "Inbox watch", enabled: true, schedule: { kind: "event" } });
  vm.migrate({ operationId: RETURN_HOLD, phase: "hold", agentIds: [COACH], retainNonportable: true });
  vm.migrate({ operationId: RETURN_HOLD, phase: "export", retainNonportable: true });
  if ((options.fence ?? "retired") === "retired") vm.migrate({ operationId: RETURN_HOLD, phase: "retire" });
  const client = custody.client({ transferState: vi.fn() } as unknown as MigrationClient, gateway => `http://${gateway}.fixture:3003`);
  const log = vi.fn(), error = vi.fn();
  const deps = { store, client, actor: "operator:test", runId: "run-1", now: () => NOW, log, error };
  const row = (migrationId = ACTIVATION_TRANSFER) => records[`${TRANSFERS}/${migrationId}`];
  const addTransfer = (doc: ScheduleTransferDoc) => { records[`${TRANSFERS}/${doc.migrationId}`] = doc as unknown as Record<string, unknown>; };
  const audits = () => Object.entries(records).filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, audit]) => audit);
  const output = () => [...log.mock.calls, ...error.mock.calls].flat().map(String);
  return { records, store, custody, vm, watch, client, deps, row, addTransfer, audits, output, log, error };
}

describe("repair-unrestored-schedules", () => {
  it("is a dry run by default, needs an environment, and acts on one user at the gateway address it is given", () => {
    expect(parseRepairUnrestoredSchedulesArgs(["--env=test"])).toEqual({ environment: "test", apply: false, restoreUnattempted: false });
    expect(parseRepairUnrestoredSchedulesArgs(["--env=test", "--uid=uid-alice"]))
      .toEqual({ environment: "test", apply: false, restoreUnattempted: false, uid: "uid-alice" });
    expect(parseRepairUnrestoredSchedulesArgs(["--env=prod", "--apply", "--restore-unattempted", "--uid=uid-alice", "--gateway-url=http://127.0.0.1:13003"]))
      .toEqual({ environment: "prod", apply: true, restoreUnattempted: true, uid: "uid-alice", gatewayUrl: "http://127.0.0.1:13003" });
    expect(() => parseRepairUnrestoredSchedulesArgs([])).toThrow(/--env/);
    expect(() => parseRepairUnrestoredSchedulesArgs(["--env=test", "--force"])).toThrow(/--force/);
    expect(() => parseRepairUnrestoredSchedulesArgs(["--env=test", "--gateway-url=http://127.0.0.1:13003"])).toThrow(/--uid/);
    expect(() => parseRepairUnrestoredSchedulesArgs(["--env=test", "--apply", "--uid=uid-alice"])).toThrow(/--gateway-url/);
  });

  it("says what it would do without calling a gateway or writing anything", async () => {
    const w = world();
    const before = structuredClone(w.records);

    expect(await repairUnrestoredSchedules(w.deps, { apply: false })).toEqual({ ok: true });

    expect(w.custody.calls).toEqual([]);
    expect(w.records).toEqual(before);
    expect(w.output()).toEqual([
      `alice (uid-alice) on ${VM}: would release the scheduler custody of ${COACH}, ${SITE}, then restore 1 schedule`,
      `  ${ACTIVATION_TRANSFER}, snapshot taken 4s ago: restore 1 schedule: "Coach monitor" of ${COACH}`,
      "dry run, nothing changed: 1 user to repair, 0 skipped; rerun with --apply to repair",
    ]);
  });

  it("releases the VM's leftover fence, restores only the schedules the transfer names, records the restore and journals it", async () => {
    const w = world();

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: true });

    expect(w.vm.fences.has(COACH)).toBe(false);
    expect(w.vm.runnable(w.watch.id)).toBe(true);
    expect(w.vm.agentJobs(COACH).map(job => [job.name, job.declarationKey])).toEqual([["Inbox watch", undefined], ["Coach monitor", MONITOR_KEY]]);
    expect(w.vm.agentJobs(SITE)).toEqual([]);
    expect(w.row()).toMatchObject({ restoreAttemptedTo: VM, restoreAttemptedAt: NOW, restoredTo: VM, restoredAt: NOW, restoreFailures: [] });
    expect(w.audits()).toEqual([expect.objectContaining({
      what: "repair unrestored schedules", actor: "operator:test", status: "completed", outcome: "completed",
      target: { uid: "uid-alice", slug: "alice", gatewayId: VM },
    })]);
    expect(w.error).not.toHaveBeenCalled();
    expect(w.output()).toEqual(expect.arrayContaining([
      expect.stringContaining(`released the scheduler custody of ${COACH} on ${VM}`),
      `alice (uid-alice) on ${VM}: restored 1 of 1 schedule (1 created, 0 existing)`,
      `alice (uid-alice): recorded ${ACTIVATION_TRANSFER} as restored on ${VM}`,
      "applied: 1 user repaired, 0 failed, 0 skipped",
    ]));
  });

  it.each([
    ["migrate-user", "running"],
    ["suspend-user", "pending"],
    ["erase-user", "running"],
    ["deprovision-user", "pending"],
  ])("skips a user with a %s that is %s, says why, and exits non-zero", async (kind, status) => {
    const w = world();
    Object.assign(w.records, operation("op-live", { kind, status, input: { uid: "uid-alice", fromGatewayId: VM, toGatewayId: SHARED } }));

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.custody.calls).toEqual([]);
    expect(w.audits()).toEqual([]);
    expect(w.output()).toEqual([
      `alice (uid-alice): skipped: ${kind} op-live is ${status}`,
      "applied: 0 users repaired, 0 failed, 1 skipped",
    ]);
  });

  it("skips a user whose isolated gateway belongs to someone else, and exits non-zero", async () => {
    const w = world();
    w.records[`gateways/${VM}`].ownerUid = "uid-bob";

    expect(await repairUnrestoredSchedules(w.deps, { apply: false })).toEqual({ ok: false });

    expect(w.output()).toEqual([
      `alice (uid-alice): skipped: isolated gateway ${VM} belongs to uid-bob`,
      "dry run, nothing changed: 0 users to repair, 1 skipped; rerun with --apply to repair",
    ]);
  });

  it("keeps a fence it cannot attribute, records the schedule still held, journals the failure and exits non-zero", async () => {
    const w = world({ fence: "exported", returnJournaled: false });

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.vm.fences.get(COACH)).toBe(RETURN_HOLD);
    expect(w.vm.status(RETURN_HOLD)).toBe("exported");
    expect(w.row()).toMatchObject({
      restoreAttemptedTo: VM, restoreAttemptedAt: NOW,
      restoreFailures: [{ name: "Coach monitor", agentId: COACH, sourceJobId: "job-monitor", error: expect.stringContaining(HELD) }],
    });
    expect(w.row()).not.toHaveProperty("restoredTo");
    expect(w.audits()).toEqual([expect.objectContaining({
      status: "failed", outcome: "failed", error: "1 scheduler fence not released, 1 schedule not restored",
    })]);
    expect(w.error.mock.calls.flat()).toEqual(expect.arrayContaining([
      `❌ alice (uid-alice): the scheduler fence of ${COACH} on ${VM} was not released: ${RETURN_HOLD} is not retired and ${RETURN_ID} has left the journal`,
      expect.stringMatching(new RegExp(`^❌ alice \\(uid-alice\\): schedule "Coach monitor" of ${COACH} was not restored on ${VM}: .*is held for migration`)),
    ]));
    expect(w.output()).toContain("applied: 0 users repaired, 1 failed, 0 skipped");
  });

  it("keeps a transfer whose schedules restored unrestored while its fence is kept, and finishes it without restoring again once the fence is released", async () => {
    const w = world({ fence: "exported", returnJournaled: false });
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({
      restoreFailures: [{ name: "Site digest", agentId: SITE, sourceJobId: "job-digest", error: COOLDOWN }],
    }) as unknown as Record<string, unknown>;
    const restores = () => w.custody.calls.filter(call => call === `schedules:${VM}:restore`).length;

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.vm.fences.get(COACH)).toBe(RETURN_HOLD);
    expect(w.vm.agentJobs(SITE).map(job => job.name)).toEqual(["Site digest"]);
    expect(w.row()).toMatchObject({ restoreAttemptedTo: VM, restoreAttemptedAt: NOW, restoreFailures: [] });
    expect(w.row()).not.toHaveProperty("restoredTo");
    expect(w.audits()).toEqual([expect.objectContaining({ status: "failed", error: "1 scheduler fence not released, 0 schedules not restored" })]);
    expect(w.error.mock.calls.flat()).toEqual([
      `❌ alice (uid-alice): the scheduler fence of ${COACH} on ${VM} was not released: ${RETURN_HOLD} is not retired and ${RETURN_ID} has left the journal`,
      "❌ alice (uid-alice): 1 scheduler fence not released, 0 schedules not restored",
    ]);
    expect(w.output()).toContain("applied: 0 users repaired, 1 failed, 0 skipped");
    expect(restores()).toBe(1);

    w.vm.migrate({ operationId: RETURN_HOLD, phase: "retire" });
    Object.assign(w.records, operation(RETURN_ID, {
      input: { uid: "uid-alice", fromGatewayId: VM, toGatewayId: SHARED }, cutoverCommittedAt: 1_000, completedAt: 1_200,
    }));
    w.log.mockClear();
    w.error.mockClear();
    const retry = { ...w.deps, runId: "run-2" };

    expect(await repairUnrestoredSchedules(retry, { apply: false })).toEqual({ ok: true });
    expect(w.output()).toEqual([
      `alice (uid-alice) on ${VM}: would release the scheduler custody of ${COACH}, ${SITE}`,
      `  ${ACTIVATION_TRANSFER}, snapshot taken 4s ago: nothing to restore`,
      "dry run, nothing changed: 1 user to repair, 0 skipped; rerun with --apply to repair",
    ]);

    expect(await repairUnrestoredSchedules(retry, { apply: true })).toEqual({ ok: true });

    expect(w.vm.fences.has(COACH)).toBe(false);
    expect(w.vm.runnable(w.watch.id)).toBe(true);
    expect(restores()).toBe(1);
    expect(w.vm.agentJobs(SITE).map(job => job.name)).toEqual(["Site digest"]);
    expect(w.row()).toMatchObject({ restoredTo: VM, restoredAt: NOW, restoreFailures: [] });
    expect(w.error).not.toHaveBeenCalled();
  });

  it("restores a user on a shared gateway without touching custody, once per declaration across transfers, from the newest snapshot", async () => {
    const w = world({ gatewayId: SHARED });
    const older = "mig-builder-activate-alice-vm-g1";
    w.addTransfer(transfer({
      migrationId: older, snapshotAt: 2_000,
      records: [{ ...MONITOR, sourceJobId: "job-monitor-old", job: { ...MONITOR.job, enabled: false, schedule: { kind: "every", everyMs: 60_000 } } }],
      restoreFailures: [{ name: "Coach monitor", agentId: COACH, sourceJobId: "job-monitor-old", error: HELD }],
    }));
    w.addTransfer(transfer({ migrationId: "mig-restored", restoredTo: VM, restoredAt: 3_000, restoreFailures: [] }));

    expect(await repairUnrestoredSchedules(w.deps, { apply: false })).toEqual({ ok: true });
    expect(w.output()).toEqual([
      `alice (uid-alice) on ${SHARED}: would restore 1 schedule`,
      `  ${older}, snapshot taken 7s ago: restore 1 schedule: "Coach monitor" of ${COACH} (superseded by ${ACTIVATION_TRANSFER})`,
      `  ${ACTIVATION_TRANSFER}, snapshot taken 4s ago: restore 1 schedule: "Coach monitor" of ${COACH}`,
      "dry run, nothing changed: 1 user to repair, 0 skipped; rerun with --apply to repair",
    ]);

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: true });

    expect(w.custody.calls).toEqual([`schedules:${SHARED}:check`, `schedules:${SHARED}:restore`]);
    expect(w.custody.store(SHARED).agentJobs(COACH).map(job => [job.declarationKey, job.enabled, job.schedule]))
      .toEqual([[MONITOR_KEY, true, MONITOR.job.schedule]]);
    expect(w.output()).toContain(`alice (uid-alice) on ${SHARED}: restored 1 of 1 schedule (1 created, 0 existing)`);
    for (const migrationId of [older, ACTIVATION_TRANSFER]) {
      expect(w.row(migrationId)).toMatchObject({ restoredTo: SHARED, restoredAt: NOW, restoreFailures: [] });
    }
    expect(w.row("mig-restored")).toMatchObject({ restoredTo: VM, restoredAt: 3_000 });
  });

  it("refuses a schedule its agent already has under the same name, restores the rest, records why and exits non-zero", async () => {
    const w = world({ gatewayId: SHARED });
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({
      restoreAttemptedTo: SHARED,
      restoreFailures: [
        { name: "Site digest", agentId: SITE, sourceJobId: "job-digest", error: COOLDOWN },
        { name: "Coach monitor", agentId: COACH, sourceJobId: "job-monitor", error: COOLDOWN },
      ],
    }) as unknown as Record<string, unknown>;
    const remade = w.custody.store(SHARED).add({ agentId: SITE, name: "Site digest", enabled: true, schedule: { kind: "cron" } });
    const refusal = `${SITE} already has a schedule named "Site digest" (${remade.id}); restoring this one would make a second`;

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.custody.store(SHARED).agentJobs(SITE).map(job => job.id)).toEqual([remade.id]);
    expect(w.custody.store(SHARED).agentJobs(COACH).map(job => job.declarationKey)).toEqual([MONITOR_KEY]);
    expect(w.row()).toMatchObject({
      restoreAttemptedTo: SHARED, restoreAttemptedAt: NOW, restoreFailures: [{ name: "Site digest", agentId: SITE, sourceJobId: "job-digest", error: refusal }],
    });
    expect(w.row()).not.toHaveProperty("restoredTo");
    expect(w.error.mock.calls.flat()).toEqual([
      `❌ alice (uid-alice): schedule "Site digest" of ${SITE} was not restored on ${SHARED}: ${refusal}`,
      "❌ alice (uid-alice): 0 scheduler fences not released, 1 schedule not restored",
    ]);
  });

  it("leaves a transfer that was never attempted unresolved unless asked to restore all of it, and says how old and large it is", async () => {
    const w = world({ gatewayId: SHARED });
    w.addTransfer(transfer({
      migrationId: "mig-never", snapshotAt: 6_000, records: [MONITOR, DIGEST], restoreAttemptedTo: undefined, restoreAttemptedAt: undefined, restoreFailures: undefined,
    }));
    const before = structuredClone(w.records);

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.custody.calls).toEqual([]);
    expect(w.records).toEqual(before);
    expect(w.error.mock.calls.flat()).toEqual([
      `❌ alice (uid-alice): mig-never was never attempted: snapshot taken 3s ago, 2 schedules: "Coach monitor" of ${COACH}, "Site digest" of ${SITE}; ` +
      "rerun with --restore-unattempted to restore all of them",
    ]);
  });

  it("repairs every kind of unrestored transfer: one never attempted, one refused for another cause by name only, and one with nothing to restore", async () => {
    const w = world({ gatewayId: SHARED });
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({
      migrationId: ACTIVATION_TRANSFER, sourceGatewayId: "shared-2", targetGatewayId: SHARED, restoreAttemptedTo: SHARED,
      restoreFailures: [{ name: "Site digest", error: COOLDOWN }],
    }) as unknown as Record<string, unknown>;
    w.addTransfer(transfer({
      migrationId: "mig-never", snapshotAt: 6_000, records: [MONITOR], restoreAttemptedTo: undefined, restoreAttemptedAt: undefined, restoreFailures: undefined,
    }));
    w.addTransfer(transfer({
      migrationId: "mig-empty", snapshotAt: 7_000, records: [], restoreAttemptedTo: undefined, restoreAttemptedAt: undefined, restoreFailures: undefined,
    }));

    expect(await repairUnrestoredSchedules(w.deps, { apply: false, restoreUnattempted: true })).toEqual({ ok: true });
    expect(w.output()).toEqual([
      `alice (uid-alice) on ${SHARED}: would restore 2 schedules`,
      `  ${ACTIVATION_TRANSFER}, snapshot taken 4s ago: restore 1 schedule: "Site digest" of ${SITE}`,
      `  mig-never, snapshot taken 3s ago, never attempted: restore all 1 schedule: "Coach monitor" of ${COACH}`,
      "  mig-empty, snapshot taken 2s ago: nothing to restore",
      "dry run, nothing changed: 1 user to repair, 0 skipped; rerun with --apply to repair",
    ]);

    expect(await repairUnrestoredSchedules(w.deps, { apply: true, restoreUnattempted: true })).toEqual({ ok: true });

    expect(w.custody.store(SHARED).agentJobs(SITE).map(job => job.name)).toEqual(["Site digest"]);
    expect(w.custody.store(SHARED).agentJobs(COACH).map(job => job.declarationKey)).toEqual([MONITOR_KEY]);
    for (const migrationId of [ACTIVATION_TRANSFER, "mig-never", "mig-empty"]) {
      expect(w.row(migrationId)).toMatchObject({ restoreAttemptedTo: SHARED, restoreAttemptedAt: NOW, restoredTo: SHARED, restoredAt: NOW, restoreFailures: [] });
    }
  });

  it("restores only the schedule a failure names by agent and source job when another agent's schedule shares its name", async () => {
    const w = world({ gatewayId: SHARED });
    const siteMonitor: ScheduleRecord = { ...MONITOR, sourceJobId: "job-site-monitor", agentId: SITE, job: { ...MONITOR.job, declarationKey: undefined } };
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({
      records: [MONITOR, siteMonitor], restoreFailures: [{ name: "Coach monitor", agentId: SITE, sourceJobId: "job-site-monitor", error: COOLDOWN }],
    }) as unknown as Record<string, unknown>;

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: true });

    expect(w.custody.store(SHARED).agentJobs(SITE).map(job => job.name)).toEqual(["Coach monitor"]);
    expect(w.custody.store(SHARED).agentJobs(COACH)).toEqual([]);
  });

  it("leaves a user unresolved when two different schedules of one agent with the same name would both be restored", async () => {
    const w = world({ gatewayId: SHARED });
    const recreated: ScheduleRecord = { ...DIGEST, sourceJobId: "job-digest-2" };
    w.addTransfer(transfer({
      migrationId: "mig-later", snapshotAt: 6_000, records: [recreated], restoreAttemptedTo: SHARED,
      restoreFailures: [{ name: "Site digest", agentId: SITE, sourceJobId: "job-digest-2", error: COOLDOWN }],
    }));
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({
      restoreFailures: [{ name: "Site digest", agentId: SITE, sourceJobId: "job-digest", error: COOLDOWN }],
    }) as unknown as Record<string, unknown>;
    const before = structuredClone(w.records);

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.custody.calls).toEqual([]);
    expect(w.records).toEqual(before);
    expect(w.error.mock.calls.flat()).toEqual([
      `❌ alice (uid-alice): 2 different schedules named "Site digest" of ${SITE} would be restored ` +
      `(job-digest from ${ACTIVATION_TRANSFER}, job-digest-2 from mig-later); inspect them`,
    ]);
  });

  it("records a schedule the gateway reports as duplicated within the request, and restores nothing for it", async () => {
    const w = world({ gatewayId: SHARED });
    const reporting = {
      ...w.client,
      schedules: vi.fn(async (request: { op: string; migrationId: string; slug: string }) => {
        if (request.op !== "check") return w.client.schedules(request as Parameters<MigrationClient["schedules"]>[0]);
        return { migrationId: request.migrationId, slug: request.slug, op: "check", conflicts: [{ name: "Coach monitor", agentId: COACH, sourceJobId: "job-monitor", jobId: null }] };
      }),
    };

    expect(await repairUnrestoredSchedules({ ...w.deps, client: reporting as unknown as MigrationClient }, { apply: true })).toEqual({ ok: false });

    expect(reporting.schedules.mock.calls.map(([request]) => request.op)).toEqual(["check"]);
    expect(w.row()).toMatchObject({
      restoreAttemptedTo: SHARED, restoreAttemptedAt: NOW,
      restoreFailures: [{
        name: "Coach monitor", agentId: COACH, sourceJobId: "job-monitor",
        error: `another schedule named "Coach monitor" of ${COACH} was sent with it; restoring both would make a second`,
      }],
    });
  });

  it("leaves a transfer unresolved when a failure's name matches more than one of its schedules", async () => {
    const w = world({ gatewayId: SHARED });
    const siteMonitor: ScheduleRecord = { ...MONITOR, sourceJobId: "job-site-monitor", agentId: SITE, job: { ...MONITOR.job, declarationKey: undefined } };
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({
      records: [MONITOR, siteMonitor], restoreFailures: [{ name: "Coach monitor", error: COOLDOWN }],
    }) as unknown as Record<string, unknown>;
    const before = structuredClone(w.records);

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.custody.calls).toEqual([]);
    expect(w.records).toEqual(before);
    expect(w.error.mock.calls.flat()).toEqual([
      `❌ alice (uid-alice): a restore failure of ${ACTIVATION_TRANSFER} names 2 schedules called "Coach monitor"; inspect it`,
    ]);
  });

  it("leaves every transfer as it was when the gateway refuses the restore call as a whole, journals it, and exits non-zero", async () => {
    const w = world({ gatewayId: SHARED });
    const before = structuredClone(w.row());
    const refusal = "/schedules/shared-1: 401 invalid signature";
    const refusing = {
      ...w.client,
      schedules: vi.fn(async (request: { op: string }) => {
        if (request.op === "restore") throw new Error(refusal);
        return w.client.schedules(request as Parameters<MigrationClient["schedules"]>[0]);
      }),
    };

    expect(await repairUnrestoredSchedules({ ...w.deps, client: refusing as unknown as MigrationClient }, { apply: true })).toEqual({ ok: false });

    expect(w.row()).toEqual(before);
    const error = `the schedules restore on ${SHARED} failed, so no transfer was recorded: ${refusal}`;
    expect(w.audits()).toEqual([expect.objectContaining({ status: "failed", error })]);
    expect(w.error.mock.calls.flat()).toEqual([`❌ alice (uid-alice): ${error}`]);
  });

  it("touches nothing on a shared gateway once the user has moved off it or started another move", async () => {
    for (const change of ["moved", "moving"] as const) {
      const w = world({ gatewayId: SHARED });
      const [plan] = await planUnrestoredScheduleRepairs(w.store, { now: NOW });
      if (change === "moved") (w.records["users/uid-alice"].provisioning as { openclaw: Record<string, unknown> }).openclaw.gatewayId = VM;
      else Object.assign(w.records, operation("op-live", { status: "pending", input: { uid: "uid-alice", fromGatewayId: SHARED, toGatewayId: VM } }));
      const before = structuredClone(w.row());

      expect(await applyUnrestoredScheduleRepair(w.deps, plan!)).toBe(false);

      expect(w.custody.calls).toEqual([]);
      expect(w.row()).toEqual(before);
      const error = change === "moved" ? `alice is no longer on ${SHARED}` : "migrate-user op-live is pending";
      expect(w.audits()).toEqual([expect.objectContaining({ status: "failed", error })]);
      expect(w.error.mock.calls.flat()).toEqual([`❌ alice (uid-alice): ${error}`]);
    }
  });

  it.each([
    ["check", []],
    ["restore", [MONITOR_KEY]],
  ])("stops and records no transfer once the user moves during the schedules %s", async (movedDuring, restoredKeys) => {
    const w = world({ gatewayId: SHARED });
    const before = structuredClone(w.row());
    const moving = {
      ...w.client,
      schedules: vi.fn(async (request: { op: string }) => {
        const result = await w.client.schedules(request as Parameters<MigrationClient["schedules"]>[0]);
        if (request.op === movedDuring) (w.records["users/uid-alice"].provisioning as { openclaw: Record<string, unknown> }).openclaw.gatewayId = VM;
        return result;
      }),
    };

    expect(await repairUnrestoredSchedules({ ...w.deps, client: moving as unknown as MigrationClient }, { apply: true })).toEqual({ ok: false });

    expect(w.custody.store(SHARED).agentJobs(COACH).map(job => job.declarationKey)).toEqual(restoredKeys);
    expect(w.row()).toEqual(before);
    expect(w.audits()).toEqual([expect.objectContaining({ status: "failed", error: `alice is no longer on ${SHARED}` })]);
  });

  it("touches nothing once the user has moved off the gateway it planned for", async () => {
    const w = world();
    const [plan] = await planUnrestoredScheduleRepairs(w.store, { now: NOW });
    (w.records["users/uid-alice"].provisioning as { openclaw: Record<string, unknown> }).openclaw.gatewayId = SHARED;

    expect(await applyUnrestoredScheduleRepair(w.deps, plan!)).toBe(false);

    expect(w.custody.calls).toEqual([]);
    expect(w.row()).toMatchObject({ restoreAttemptedAt: 5_050 });
    expect(w.audits()).toEqual([expect.objectContaining({ status: "failed", error: `alice is no longer on ${VM}` })]);
    expect(w.error.mock.calls.flat()).toEqual([`❌ alice (uid-alice): alice is no longer on ${VM}`]);
  });

  it("leaves a transfer whose failure names none of its schedules for inspection, and exits non-zero", async () => {
    const w = world({ gatewayId: SHARED });
    w.records[`${TRANSFERS}/${ACTIVATION_TRANSFER}`] = transfer({ restoreFailures: [{ name: "Weekly review", error: COOLDOWN }] }) as unknown as Record<string, unknown>;
    const before = structuredClone(w.records);

    expect(await repairUnrestoredSchedules(w.deps, { apply: true })).toEqual({ ok: false });

    expect(w.custody.calls).toEqual([]);
    expect(w.records).toEqual(before);
    expect(w.error.mock.calls.flat()).toEqual([
      `❌ alice (uid-alice): a restore failure of ${ACTIVATION_TRANSFER} names no schedule of that transfer; inspect it`,
    ]);
    expect(w.log.mock.calls.flat()).toEqual(["applied: 0 users repaired, 1 failed, 0 skipped"]);
  });

  it("skips a user who has no gateway, says why, and exits non-zero", async () => {
    const w = world();
    delete (w.records["users/uid-alice"].provisioning as { openclaw: Record<string, unknown> }).openclaw.gatewayId;

    expect(await repairUnrestoredSchedules(w.deps, { apply: false })).toEqual({ ok: false });

    expect(w.output()).toEqual([
      "alice (uid-alice): skipped: no gateway is assigned",
      "dry run, nothing changed: 0 users to repair, 1 skipped; rerun with --apply to repair",
    ]);
  });

  it("repairs only the user it is asked to", async () => {
    const w = world({ gatewayId: SHARED });

    expect(await repairUnrestoredSchedules(w.deps, { apply: false, uid: "uid-bob" })).toEqual({ ok: true });

    expect(w.output()).toEqual(["dry run, nothing changed: 0 users to repair, 0 skipped; rerun with --apply to repair"]);
  });
});
