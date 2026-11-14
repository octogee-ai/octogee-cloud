import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import type {
  ScheduleRecord,
  ScheduleRestoreFailureRecord,
  ScheduleTransferDoc,
} from "@octogee/shared/types/fleet-controller";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { createMigrationClient, type MigrationClient } from "@octogee/core/fleet-migration-client";
import { awaitsOnlyCustodyRelease, scheduleRestoreRecord } from "@octogee/core/fleet-migration-runner";
import { runWithOperationAuditIntent } from "@octogee/core/operation-audit";
import type { PlatformStateStore, PlatformUserRecord, UnrestoredScheduleTransfer } from "@octogee/core/platform-state";
import { releaseSchedulerCustody, type SchedulerFenceOutcome } from "@octogee/core/scheduler-custody";
import { scheduleName, transferKey } from "../lib/schedule-transfer.js";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";

export const REPAIR_UNRESTORED_SCHEDULES_USAGE =
  "Usage: npm run --prefix scripts with-platform-state -- --env=<test|prod> -- npx tsx ops/repair-unrestored-schedules.ts " +
  "--env=<test|prod> [--uid=<uid>] [--restore-unattempted] [--apply --gateway-url=<url of the user's gateway fleet port>]";

const IN_FLIGHT_KINDS: ReadonlySet<string> = new Set(["migrate-user", "suspend-user", "erase-user", "deprovision-user"]);
const IN_FLIGHT_STATUSES = ["pending", "running"] as const;
const ISOLATED_GATEWAY_CLASS = "isolated";
const FLAGS = ["--apply", "--restore-unattempted"];
const OPTIONS = ["--env=", "--uid=", "--gateway-url="];

export interface RepairUnrestoredSchedulesArgs {
  environment: "test" | "prod";
  apply: boolean;
  restoreUnattempted: boolean;
  uid?: string;
  gatewayUrl?: string;
}

export function parseRepairUnrestoredSchedulesArgs(argv: readonly string[]): RepairUnrestoredSchedulesArgs {
  const value = (flag: string) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const environment = value("--env");
  if (environment !== "test" && environment !== "prod") {
    throw new Error(`repair-unrestored-schedules needs --env=test|prod\n${REPAIR_UNRESTORED_SCHEDULES_USAGE}`);
  }
  const unknown = argv.filter((arg) => !OPTIONS.some((option) => arg.startsWith(option)) && !FLAGS.includes(arg));
  if (unknown.length > 0) {
    throw new Error(`repair-unrestored-schedules: unexpected arguments ${unknown.join(" ")}\n${REPAIR_UNRESTORED_SCHEDULES_USAGE}`);
  }
  const uid = value("--uid");
  const gatewayUrl = value("--gateway-url");
  const apply = argv.includes("--apply");
  if (gatewayUrl !== undefined && uid === undefined) {
    throw new Error(`repair-unrestored-schedules: --gateway-url reaches one user's gateway, so it needs --uid\n${REPAIR_UNRESTORED_SCHEDULES_USAGE}`);
  }
  if (apply && gatewayUrl === undefined) {
    throw new Error(`repair-unrestored-schedules: --apply needs --uid and the --gateway-url of that user's gateway\n${REPAIR_UNRESTORED_SCHEDULES_USAGE}`);
  }
  return {
    environment, apply, restoreUnattempted: argv.includes("--restore-unattempted"),
    ...(uid === undefined ? {} : { uid }), ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
  };
}

export interface TransferToRepair {
  migrationId: string;
  snapshotAt: number;
  unattempted: boolean;
  records: readonly ScheduleRecord[];
}

export interface ScheduleToRestore {
  key: string;
  record: ScheduleRecord;
  migrationId: string;
}

interface PlannedUser {
  uid: string;
  slug: string;
}

export type UnrestoredScheduleRepairPlan =
  | PlannedUser & { kind: "skip"; reason: string }
  | PlannedUser & { kind: "unresolved"; reasons: readonly string[] }
  | PlannedUser & {
    kind: "repair";
    gatewayId: string;
    isolated: boolean;
    agentIds: readonly string[];
    ownedSince: number;
    transfers: readonly TransferToRepair[];
    restore: readonly ScheduleToRestore[];
  };

type RepairPlan = Extract<UnrestoredScheduleRepairPlan, { kind: "repair" }>;

type RepairStore = Pick<PlatformStateStore, "users" | "gateways" | "journal">;

export interface PlanOptions {
  uid?: string;
  restoreUnattempted?: boolean;
  now: number;
}

export async function planUnrestoredScheduleRepairs(store: RepairStore, options: PlanOptions): Promise<UnrestoredScheduleRepairPlan[]> {
  const byUser = new Map<string, UnrestoredScheduleTransfer[]>();
  for (const row of await store.users.scheduleTransfers.listUnrestored()) {
    if (options.uid !== undefined && row.uid !== options.uid) continue;
    byUser.set(row.uid, [...(byUser.get(row.uid) ?? []), row]);
  }
  const plans: UnrestoredScheduleRepairPlan[] = [];
  for (const [uid, rows] of byUser) plans.push(await planUser(store, uid, rows.map((row) => row.transfer), options));
  return plans;
}

async function planUser(
  store: RepairStore, uid: string, transfers: readonly ScheduleTransferDoc[], options: PlanOptions,
): Promise<UnrestoredScheduleRepairPlan> {
  const user = await store.users.records.get(uid);
  const slug = user?.slug ?? transfers[0].slug;
  if (user === null) return { kind: "skip", uid, slug, reason: "no user record" };
  const busy = await inFlightOperation(store, uid);
  if (busy !== null) return { kind: "skip", uid, slug, reason: busy };
  const gatewayId = user.gateway?.gatewayId;
  if (gatewayId === undefined) return { kind: "skip", uid, slug, reason: "no gateway is assigned" };
  const gateway = await store.gateways.roots.get(gatewayId);
  if (gateway === null) return { kind: "skip", uid, slug, reason: `gateway ${gatewayId} is not registered` };
  const isolated = gateway.gatewayClass === ISOLATED_GATEWAY_CLASS;
  if (isolated && gateway.ownerUid !== uid) {
    return { kind: "skip", uid, slug, reason: `isolated gateway ${gatewayId} belongs to ${gateway.ownerUid ?? "no user"}` };
  }
  const selected: TransferToRepair[] = [];
  const reasons: string[] = [];
  for (const transfer of transfers) {
    const selection = selectRecords(transfer, options);
    if ("reason" in selection) reasons.push(selection.reason);
    else selected.push({ migrationId: transfer.migrationId, snapshotAt: transfer.snapshotAt, ...selection });
  }
  if (reasons.length > 0) return { kind: "unresolved", uid, slug, reasons };
  const restore = new Map<string, ScheduleToRestore>();
  for (const { migrationId, records } of selected) {
    for (const record of records) {
      const key = restoreKey(record);
      restore.delete(key);
      restore.set(key, { key, record, migrationId });
    }
  }
  const duplicates = duplicateNames([...restore.values()]);
  if (duplicates.length > 0) return { kind: "unresolved", uid, slug, reasons: duplicates };
  return {
    kind: "repair", uid, slug, gatewayId, isolated,
    agentIds: userAgentIds(user),
    ownedSince: await ownedSince(store, uid, gatewayId),
    transfers: selected,
    restore: [...restore.values()],
  };
}

type Selection = { records: readonly ScheduleRecord[]; unattempted: boolean } | { reason: string };

function selectRecords(transfer: ScheduleTransferDoc, options: PlanOptions): Selection {
  const failures = transfer.restoreFailures ?? [];
  if (transfer.records.length === 0 || awaitsOnlyCustodyRelease(transfer)) return { records: [], unattempted: false };
  if (failures.length === 0) {
    if (options.restoreUnattempted === true) return { records: transfer.records, unattempted: true };
    return {
      reason: `${transfer.migrationId} was never attempted: ${snapshotAge(transfer.snapshotAt, options.now)}, ` +
        `${plural(transfer.records.length, "schedule", "schedules")}: ${scheduleList(transfer.records)}; ` +
        "rerun with --restore-unattempted to restore all of them",
    };
  }
  const named = new Set<ScheduleRecord>();
  for (const failure of failures) {
    const matches = failure.agentId !== undefined && failure.sourceJobId !== undefined
      ? transfer.records.filter((record) => record.agentId === failure.agentId && record.sourceJobId === failure.sourceJobId)
      : transfer.records.filter((record) => scheduleName(record) === failure.name);
    if (matches.length === 0) return { reason: `a restore failure of ${transfer.migrationId} names no schedule of that transfer; inspect it` };
    if (matches.length > 1) {
      return { reason: `a restore failure of ${transfer.migrationId} names ${matches.length} schedules called "${failure.name}"; inspect it` };
    }
    named.add(matches[0]);
  }
  return { records: transfer.records.filter((record) => named.has(record)), unattempted: false };
}

function duplicateNames(restore: readonly ScheduleToRestore[]): string[] {
  const byName = new Map<string, ScheduleToRestore[]>();
  for (const schedule of restore) {
    const name = schedule.record.job.name;
    if (typeof name !== "string") continue;
    const key = JSON.stringify([schedule.record.agentId, name]);
    byName.set(key, [...(byName.get(key) ?? []), schedule]);
  }
  return [...byName.values()].filter((group) => group.length > 1).map((group) => {
    const { record } = group[0];
    const sources = group.map((schedule) => `${schedule.record.sourceJobId} from ${schedule.migrationId}`).join(", ");
    return `${group.length} different schedules named "${scheduleName(record)}" of ${record.agentId} would be restored (${sources}); inspect them`;
  });
}

async function inFlightOperation(store: Pick<PlatformStateStore, "journal">, uid: string): Promise<string | null> {
  const operations = await store.journal.operations.listForUid(uid, { statuses: IN_FLIGHT_STATUSES });
  const live = operations.find((operation) => IN_FLIGHT_KINDS.has(operation.kind));
  return live === undefined ? null : `${live.kind} ${live.id} is ${live.status}`;
}

function restoreKey(record: ScheduleRecord): string {
  return JSON.stringify([record.agentId, transferKey(record)]);
}

function userAgentIds(user: PlatformUserRecord): string[] {
  const ids = [user.openclaw.agentId, ...user.agents.agentIds].filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

async function ownedSince(store: RepairStore, uid: string, gatewayId: string): Promise<number> {
  const moves = await store.journal.operations.listForUid(uid, { kind: "migrate-user" });
  const onto = moves.flatMap((move) =>
    move.input?.toGatewayId === gatewayId && typeof move.cutoverCommittedAt === "number" ? [move.cutoverCommittedAt] : []);
  return onto.length === 0 ? 0 : Math.max(...onto);
}

export interface RepairUnrestoredSchedulesDeps {
  store: PlatformStateStore;
  client: Pick<MigrationClient, "scheduler" | "schedules">;
  actor: string;
  runId: string;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function label(plan: PlannedUser): string {
  return `${plan.slug} (${plan.uid})`;
}

function scheduleList(records: readonly ScheduleRecord[]): string {
  return records.map((record) => `"${scheduleName(record)}" of ${record.agentId}`).join(", ");
}

function snapshotAge(snapshotAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - snapshotAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const age = seconds < 60 ? `${seconds}s`
    : minutes < 60 ? `${minutes}m`
      : hours < 48 ? `${hours}h ${minutes % 60}m`
        : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `snapshot taken ${age} ago`;
}

function describeRepair(plan: RepairPlan, now: number): string[] {
  const actions: string[] = [];
  if (plan.isolated) actions.push(`release the scheduler custody of ${plan.agentIds.join(", ")}`);
  if (plan.restore.length > 0) actions.push(`restore ${plural(plan.restore.length, "schedule", "schedules")}`);
  const action = actions.length > 0 ? actions.join(", then ") : `record ${plural(plan.transfers.length, "transfer", "transfers")} as restored`;
  return [`${label(plan)} on ${plan.gatewayId}: would ${action}`, ...plan.transfers.map((transfer) => `  ${describeTransfer(plan, transfer, now)}`)];
}

function describeTransfer(plan: RepairPlan, transfer: TransferToRepair, now: number): string {
  const head = `${transfer.migrationId}, ${snapshotAge(transfer.snapshotAt, now)}${transfer.unattempted ? ", never attempted" : ""}`;
  if (transfer.records.length === 0) return `${head}: nothing to restore`;
  const schedules = transfer.records.map((record) => {
    const winner = plan.restore.find(({ key }) => key === restoreKey(record));
    const superseded = winner !== undefined && winner.migrationId !== transfer.migrationId ? ` (superseded by ${winner.migrationId})` : "";
    return `"${scheduleName(record)}" of ${record.agentId}${superseded}`;
  });
  const count = plural(transfer.records.length, "schedule", "schedules");
  return `${head}: restore ${transfer.unattempted ? `all ${count}` : count}: ${schedules.join(", ")}`;
}

export async function repairUnrestoredSchedules(
  deps: RepairUnrestoredSchedulesDeps,
  args: { apply: boolean; uid?: string; restoreUnattempted?: boolean },
): Promise<{ ok: boolean }> {
  const now = deps.now();
  const plans = await planUnrestoredScheduleRepairs(deps.store, {
    ...(args.uid === undefined ? {} : { uid: args.uid }), restoreUnattempted: args.restoreUnattempted === true, now,
  });
  const counts = { toRepair: 0, repaired: 0, failed: 0, skipped: 0 };
  for (const plan of plans) {
    if (plan.kind === "skip") {
      deps.log(`${label(plan)}: skipped: ${plan.reason}`);
      counts.skipped += 1;
    } else if (plan.kind === "unresolved") {
      for (const reason of plan.reasons) deps.error(`❌ ${label(plan)}: ${reason}`);
      counts.failed += 1;
    } else if (!args.apply) {
      for (const line of describeRepair(plan, now)) deps.log(line);
      counts.toRepair += 1;
    } else if (await applyUnrestoredScheduleRepair(deps, plan)) {
      counts.repaired += 1;
    } else {
      counts.failed += 1;
    }
  }
  deps.log(args.apply
    ? `applied: ${plural(counts.repaired, "user", "users")} repaired, ${counts.failed} failed, ${counts.skipped} skipped`
    : `dry run, nothing changed: ${plural(counts.toRepair, "user", "users")} to repair, ${counts.skipped} skipped` +
      `${counts.failed > 0 ? `, ${counts.failed} unresolved` : ""}; rerun with --apply to repair`);
  return { ok: counts.failed === 0 && counts.skipped === 0 };
}

export async function applyUnrestoredScheduleRepair(deps: RepairUnrestoredSchedulesDeps, plan: RepairPlan): Promise<boolean> {
  const operationId = `repair-schedules-${deps.runId}`;
  try {
    await runWithOperationAuditIntent(deps.store, {
      actor: deps.actor,
      forced: false,
      what: "repair unrestored schedules",
      why: `restore the schedules a move left unrestored for ${plan.slug} on ${plan.gatewayId}`,
      target: { uid: plan.uid, slug: plan.slug, gatewayId: plan.gatewayId },
      preActionStatus: { transfers: plan.transfers.map(({ migrationId, records }) => ({ migrationId, schedules: records.length })) },
      mutation: {
        runId: deps.runId,
        release: plan.isolated ? plan.agentIds : [],
        restore: plan.restore.map(({ record, migrationId }) => ({ migrationId, agentId: record.agentId, sourceJobId: record.sourceJobId })),
      },
      now: deps.now,
    }, { claimId: `${deps.runId}:${plan.uid}`, now: deps.now }, () => repair(deps, plan, operationId));
    return true;
  } catch (error) {
    deps.error(`❌ ${label(plan)}: ${errorText(error)}`);
    return false;
  }
}

async function repair(deps: RepairUnrestoredSchedulesDeps, plan: RepairPlan, operationId: string): Promise<void> {
  const assertOwner = async () => {
    const user = await deps.store.users.records.get(plan.uid);
    if (user?.gateway?.gatewayId !== plan.gatewayId) throw new Error(`${plan.slug} is no longer on ${plan.gatewayId}`);
    const busy = await inFlightOperation(deps.store, plan.uid);
    if (busy !== null) throw new Error(busy);
  };
  await assertOwner();
  const unreleased = plan.isolated ? await releaseFences(deps, plan, operationId, assertOwner) : [];
  const failed = await restoreSchedules(deps, plan, operationId, assertOwner);
  await assertOwner();
  await recordRestores(deps, plan, failed, unreleased.length === 0);
  if (unreleased.length > 0 || failed.size > 0) {
    throw new Error(
      `${plural(unreleased.length, "scheduler fence", "scheduler fences")} not released, ${plural(failed.size, "schedule", "schedules")} not restored`);
  }
}

async function releaseFences(
  deps: RepairUnrestoredSchedulesDeps, plan: RepairPlan, operationId: string, assertOwner: () => Promise<void>,
): Promise<SchedulerFenceOutcome[]> {
  const outcomes = await releaseSchedulerCustody({
    scheduler: (request) => deps.client.scheduler(request),
    readOperation: (id) => deps.store.journal.operations.get(id),
    assertOwner,
    log: deps.log,
  }, { uid: plan.uid, slug: plan.slug, gatewayId: plan.gatewayId, operationId, ownedSince: plan.ownedSince }, plan.agentIds);
  const unreleased = outcomes.filter((outcome) => outcome.outcome === "kept" || outcome.outcome === "failed");
  for (const fence of unreleased) {
    const reason = fence.outcome === "kept" ? fence.reason : fence.error;
    deps.error(`❌ ${label(plan)}: the scheduler fence of ${fence.agentId} on ${plan.gatewayId} was not released: ${reason}`);
  }
  return unreleased;
}

async function restoreSchedules(
  deps: RepairUnrestoredSchedulesDeps, plan: RepairPlan, operationId: string, assertOwner: () => Promise<void>,
): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  if (plan.restore.length === 0) return failed;
  const address = { migrationId: operationId, slug: plan.slug, gatewayId: plan.gatewayId };
  const sent = (agentId: string, sourceJobId: string, name: string) => {
    const schedule = plan.restore.find(({ record }) => record.agentId === agentId && record.sourceJobId === sourceJobId);
    if (schedule === undefined) throw new Error(`${plan.gatewayId} answered for a schedule it was not sent: "${name}" of ${agentId}`);
    return schedule;
  };
  const { conflicts } = await wholeCall(plan, "check", () =>
    deps.client.schedules({ ...address, op: "check", records: plan.restore.map(({ record }) => record) }));
  for (const conflict of conflicts) {
    failed.set(sent(conflict.agentId, conflict.sourceJobId, conflict.name).key, conflict.jobId === null
      ? `another schedule named "${conflict.name}" of ${conflict.agentId} was sent with it; restoring both would make a second`
      : `${conflict.agentId} already has a schedule named "${conflict.name}" (${conflict.jobId}); restoring this one would make a second`);
  }
  const toRestore = plan.restore.filter(({ key }) => !failed.has(key));
  if (toRestore.length > 0) {
    await assertOwner();
    const result = await wholeCall(plan, "restore", () =>
      deps.client.schedules({ ...address, op: "restore", records: toRestore.map(({ record }) => record) }));
    deps.log(
      `${label(plan)} on ${plan.gatewayId}: restored ${toRestore.length - result.failed.length} of ${plural(toRestore.length, "schedule", "schedules")} ` +
      `(${result.created} created, ${result.existing} existing)`,
    );
    for (const failure of result.failed) failed.set(sent(failure.agentId, failure.sourceJobId, failure.name).key, failure.error);
  }
  for (const { key, record } of plan.restore) {
    const error = failed.get(key);
    if (error !== undefined) {
      deps.error(`❌ ${label(plan)}: schedule "${scheduleName(record)}" of ${record.agentId} was not restored on ${plan.gatewayId}: ${error}`);
    }
  }
  return failed;
}

async function wholeCall<T>(plan: RepairPlan, op: "check" | "restore", call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new Error(`the schedules ${op} on ${plan.gatewayId} failed, so no transfer was recorded: ${errorText(error)}`);
  }
}

async function recordRestores(
  deps: RepairUnrestoredSchedulesDeps, plan: RepairPlan, failed: ReadonlyMap<string, string>, custodyReleased: boolean,
): Promise<void> {
  const at = deps.now();
  for (const transfer of plan.transfers) {
    const failures: ScheduleRestoreFailureRecord[] = transfer.records.flatMap((record) => {
      const error = failed.get(restoreKey(record));
      return error === undefined ? [] : [{ name: scheduleName(record), agentId: record.agentId, sourceJobId: record.sourceJobId, error }];
    });
    const restore = scheduleRestoreRecord(plan.gatewayId, at, failures, custodyReleased);
    await deps.store.users.scheduleTransfers.patch(plan.uid, transfer.migrationId, restore);
    if (restore.restoredTo !== undefined) deps.log(`${label(plan)}: recorded ${transfer.migrationId} as restored on ${plan.gatewayId}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dryRunClient(): Pick<MigrationClient, "scheduler" | "schedules"> {
  const refuse = async (): Promise<never> => { throw new Error("a dry run calls no gateway"); };
  return { scheduler: refuse, schedules: refuse };
}

function fleetClient(gatewayUrl: string): Pick<MigrationClient, "scheduler" | "schedules"> {
  const privateKey = process.env.FLEET_CONTROLLER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("repair-unrestored-schedules --apply needs FLEET_CONTROLLER_PRIVATE_KEY (secret octogee-fleet-controller, key private-key)");
  }
  return createMigrationClient({
    privateKey,
    resolveGatewayUrl: () => gatewayUrl,
    transferState: async () => { throw new Error("repair-unrestored-schedules transfers no state"); },
    log: console.log,
  });
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseRepairUnrestoredSchedulesArgs(argv);
  const settings = deploymentEnvironmentSettings(args.environment);
  const client = args.gatewayUrl === undefined ? dryRunClient() : fleetClient(args.gatewayUrl);
  const store = await operatorPlatformStateStore(settings.targetId);
  try {
    const result = await repairUnrestoredSchedules({
      store, client, actor: `operator:${userInfo().username}`, runId: randomUUID(), now: Date.now, log: console.log, error: console.error,
    }, args);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
