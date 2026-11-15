import { createHash } from "node:crypto";
import type {
  ScheduleCheckResult,
  ScheduleRecord,
  ScheduleRemoveResult,
  ScheduleRestoreResult,
  ScheduleSkip,
  ScheduleSnapshotResult,
  ScheduleTransferRequestBody,
} from "@octogee/shared/types/fleet-controller";
import type { ScheduleTransferCronMethod } from "./gateway-rpc.js";
import { schedulerHandoffAgentIds } from "./agent-roster-deletion.js";
import { isRetryableSchedulerFailure, SchedulerRefusal } from "./scheduler-failure.js";

export type GatewayCall = (method: ScheduleTransferCronMethod, params: Record<string, unknown>) => Promise<unknown>;

export interface ScheduleTransferDeps {
  readConfig: () => Promise<unknown>;
  localAgentIds: (slug: string) => readonly string[];
  connect: () => Promise<{ request: GatewayCall; close: () => void }>;
  log: (msg: string) => void;
}

type CronJob = Record<string, unknown>;

export interface FenceTiming {
  waitMs?: number;
  pollMs?: number;
}

const LIST_PAGE_SIZE = 200;
const FENCE_WAIT_MS = 30_000;
const FENCE_POLL_MS = 1_000;
const TRANSFER_KEY_PREFIX = "octogee:transfer:";
const CARRIED_DECLARATION_PREFIXES = [TRANSFER_KEY_PREFIX, "octogee:coach-monitor:", "octogee:owner-automation:"] as const;
const CRON_ADD_FIELDS = [
  "name", "declarationKey", "displayName", "owner", "agentId", "sessionKey", "description", "enabled", "deleteAfterRun",
  "schedule", "pacing", "activeHours", "idleOnly", "trigger", "sessionTarget", "wakeMode", "payload",
  "delivery", "failureAlert", "scheduledToolPolicy", "toolsAllowProvenance",
] as const;

export type ScheduleTransferResult = ScheduleSnapshotResult | ScheduleRestoreResult | ScheduleRemoveResult | ScheduleCheckResult;

export function createScheduleTransfer(deps: ScheduleTransferDeps) {
  return async (body: ScheduleTransferRequestBody): Promise<ScheduleTransferResult> => {
    const config = await deps.readConfig();
    const agentIds = new Set(schedulerHandoffAgentIds(config, body.slug, deps.localAgentIds(body.slug), false));
    const connection = await deps.connect();
    try {
      const envelope = { migrationId: body.migrationId, slug: body.slug };
      if (body.op === "snapshot") {
        return { ...envelope, op: "snapshot", ...await snapshotSchedules(connection.request, agentIds, deps.log) };
      }
      if (body.op === "remove") {
        return { ...envelope, op: "remove", ...await removeSchedules(connection.request, agentIds, body.jobIds, deps.log) };
      }
      if (body.op === "check") {
        return { ...envelope, op: "check", ...await checkSchedules(connection.request, agentIds, body.records) };
      }
      return { ...envelope, op: "restore", ...await restoreSchedules(connection.request, agentIds, body.records, deps.log) };
    } finally {
      connection.close();
    }
  };
}

export async function snapshotSchedules(
  call: GatewayCall,
  agentIds: ReadonlySet<string>,
  log: (msg: string) => void,
  timing: FenceTiming = {},
): Promise<Pick<ScheduleSnapshotResult, "records" | "skipped">> {
  const skipped: ScheduleSkip[] = [];
  const fenced: Array<{ job: CronJob; agentId: string; captured: Record<string, unknown> }> = [];
  for (const job of await listJobs(call)) {
    const agentId = runningAgentId(job);
    if (!agentId || !agentIds.has(agentId)) continue;
    try {
      const reason = unmovableReason(job);
      if (reason) throw new Error(reason);
      const captured = cronAddJob(job, agentId);
      if (captured.enabled !== false) await call("cron.update", { id: job.id, patch: { enabled: false } });
      fenced.push({ job, agentId, captured });
    } catch (error) {
      skipped.push(skipOf(job, error));
    }
  }
  await waitForFencedRuns(call, new Set(fenced.map(({ job }) => String(job.id))), log, timing);
  const records: ScheduleRecord[] = [];
  for (const { job, agentId, captured } of fenced) {
    try {
      records.push({ sourceJobId: String(job.id), agentId, job: captured, scratch: await readScratch(call, job) });
    } catch (error) {
      skipped.push(skipOf(job, error));
      if (captured.enabled !== false) await call("cron.update", { id: job.id, patch: { enabled: true } }).catch((liftError: unknown) => {
        log(`🔴 [schedule-transfer] ${String(job.id)} stays disabled; lifting its fence failed: ${errorMessage(liftError)}`);
      });
    }
  }
  return { records, skipped };
}

export async function removeSchedules(
  call: GatewayCall,
  agentIds: ReadonlySet<string>,
  jobIds: readonly string[],
  log: (msg: string) => void,
): Promise<Pick<ScheduleRemoveResult, "removed" | "failed">> {
  const owners = new Map((await listJobs(call)).map(job => [String(job.id), runningAgentId(job)]));
  const result: Pick<ScheduleRemoveResult, "removed" | "failed"> = { removed: 0, failed: [] };
  for (const jobId of jobIds) {
    try {
      if (owners.has(jobId)) {
        const owner = owners.get(jobId);
        if (!owner || !agentIds.has(owner)) throw new Error("not this user's job");
        await call("cron.remove", { id: jobId });
      }
      result.removed++;
    } catch (error) {
      log(`🔴 [schedule-transfer] cron.remove ${jobId} failed; it stays disabled here: ${errorMessage(error)}`);
      result.failed.push({ jobId, error: errorMessage(error) });
    }
  }
  return result;
}

export async function checkSchedules(
  call: GatewayCall,
  agentIds: ReadonlySet<string>,
  records: readonly ScheduleRecord[],
): Promise<Pick<ScheduleCheckResult, "conflicts">> {
  const jobs = await listJobs(call);
  const present = presentJobs(jobs);
  const named = new Map<string, CronJob>();
  for (const job of jobs) {
    const agentId = runningAgentId(job);
    if (agentId && agentIds.has(agentId) && typeof job.name === "string") named.set(identityKey(agentId, job.name), job);
  }
  const pending = records.flatMap((record) =>
    presentJob(present, record) || typeof record.job.name !== "string" ? [] : [{ record, name: record.job.name }]);
  const identities = new Map<string, Set<string>>();
  for (const { record, name } of pending) {
    const key = identityKey(record.agentId, name);
    identities.set(key, (identities.get(key) ?? new Set()).add(transferKey(record)));
  }
  const conflicts: ScheduleCheckResult["conflicts"] = [];
  for (const { record, name } of pending) {
    const key = identityKey(record.agentId, name);
    const live = named.get(key);
    if (live || identities.get(key)!.size > 1) {
      conflicts.push({ name, agentId: record.agentId, sourceJobId: record.sourceJobId, jobId: live ? String(live.id) : null });
    }
  }
  return { conflicts };
}

export async function restoreSchedules(
  call: GatewayCall,
  agentIds: ReadonlySet<string>,
  records: readonly ScheduleRecord[],
  log: (msg: string) => void,
): Promise<Pick<ScheduleRestoreResult, "created" | "existing" | "failed">> {
  const present = presentJobs(await listJobs(call));
  const result: Pick<ScheduleRestoreResult, "created" | "existing" | "failed"> = { created: 0, existing: 0, failed: [] };
  for (const record of records) {
    const name = scheduleName(record);
    try {
      if (await restoreRecord(call, agentIds, present, record)) result.created++;
      else result.existing++;
    } catch (error) {
      log(`🔴 [schedule-transfer] cron.add "${name}" failed: ${errorMessage(error)}`);
      result.failed.push({
        name, agentId: record.agentId, sourceJobId: record.sourceJobId, error: errorMessage(error), retryable: isRetryableSchedulerFailure(error),
      });
    }
  }
  return result;
}

async function restoreRecord(
  call: GatewayCall,
  agentIds: ReadonlySet<string>,
  present: Map<string, CronJob>,
  record: ScheduleRecord,
): Promise<boolean> {
  if (!agentIds.has(record.agentId)) {
    throw new SchedulerRefusal(`agent ${record.agentId} is not this user's agent on this gateway`);
  }
  const declarationKey = transferKey(record);
  const key = identityKey(record.agentId, declarationKey);
  const existing = presentJob(present, record);
  if (existing) {
    await reconcileExisting(call, existing, record);
    return false;
  }
  const reason = unmovableReason({ ...record.job, declarationKey });
  if (reason) throw new SchedulerRefusal(reason);
  const job: CronJob = { ...cronAddJob(record.job, record.agentId), declarationKey };
  const hasScratch = typeof record.scratch === "string";
  const response = await call("cron.add", hasScratch ? { ...job, enabled: false } : job);
  const restored = isRecord(response) && isRecord(response.job) ? response.job : response;
  if (!isRecord(restored) || typeof restored.id !== "string") throw new Error("cron.add returned no job id");
  if (hasScratch) {
    const written = await call("cron.scratch.set", { id: restored.id, content: record.scratch, expectedRevision: 0 });
    if (!isRecord(written) || written.ok !== true) throw new SchedulerRefusal("cron.scratch.set did not restore scratch");
    if (job.enabled !== false) {
      await call("cron.update", { id: restored.id, patch: { enabled: true } });
      restored.enabled = true;
    }
  }
  present.set(key, restored);
  return !isRecord(response) || response.created !== false;
}

function presentJobs(jobs: readonly CronJob[]): Map<string, CronJob> {
  const present = new Map<string, CronJob>();
  for (const job of jobs) {
    const agentId = runningAgentId(job);
    if (agentId) {
      present.set(identityKey(agentId, String(job.id)), job);
      if (typeof job.declarationKey === "string") present.set(identityKey(agentId, job.declarationKey), job);
    }
  }
  return present;
}

function presentJob(present: ReadonlyMap<string, CronJob>, record: ScheduleRecord): CronJob | undefined {
  return present.get(identityKey(record.agentId, transferKey(record))) ?? present.get(identityKey(record.agentId, record.sourceJobId));
}

async function reconcileExisting(call: GatewayCall, existing: CronJob, record: ScheduleRecord): Promise<void> {
  if (existing.id !== record.sourceJobId) return assertExistingScratchComplete(call, existing, record);
  if (existing.enabled === false && record.job.enabled !== false) await call("cron.update", { id: existing.id, patch: { enabled: true } });
}

async function assertExistingScratchComplete(call: GatewayCall, existing: CronJob, record: ScheduleRecord): Promise<void> {
  if (typeof record.scratch !== "string" || existing.enabled !== false) return;
  const state = await call("cron.scratch.get", { id: existing.id });
  if (record.job.enabled !== false || !isRecord(state) || !isRecord(state.scratch)) {
    throw new SchedulerRefusal("existing job is disabled with an incomplete scratch restore; inspect it before enabling");
  }
}

async function waitForFencedRuns(call: GatewayCall, ids: ReadonlySet<string>, log: (msg: string) => void, timing: FenceTiming): Promise<void> {
  if (ids.size === 0) return;
  const deadline = Date.now() + (timing.waitMs ?? FENCE_WAIT_MS);
  for (;;) {
    const running = (await listJobs(call)).filter(job => ids.has(String(job.id)) && isRunning(job)).map(job => String(job.id));
    if (running.length === 0) return;
    if (Date.now() >= deadline) {
      log(`⚠ [schedule-transfer] ${running.join(", ")} still running after the fence; reading scratch anyway`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, timing.pollMs ?? FENCE_POLL_MS));
  }
}

function isRunning(job: CronJob): boolean {
  return job.runningAtMs != null || (isRecord(job.state) && job.state.runningAtMs != null);
}

async function readScratch(call: GatewayCall, job: CronJob): Promise<string | null> {
  const scratch = await call("cron.scratch.get", { id: job.id });
  if (!isRecord(scratch) || (scratch.scratch !== null &&
      (!isRecord(scratch.scratch) || typeof scratch.scratch.content !== "string"))) {
    throw new Error("cron.scratch.get returned no scratch state");
  }
  return scratch.scratch === null ? null : scratch.scratch.content as string;
}

function skipOf(job: CronJob, error: unknown): ScheduleSkip {
  return { jobId: String(job.id), name: String(job.name), reason: errorMessage(error) };
}

async function listJobs(call: GatewayCall): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  let offset = 0;
  for (;;) {
    const page = await call("cron.list", { includeDisabled: true, limit: LIST_PAGE_SIZE, offset });
    if (!isRecord(page) || !Array.isArray(page.jobs)) throw new Error("cron.list returned no jobs page");
    jobs.push(...page.jobs.filter(isRecord));
    if (page.hasMore !== true) return jobs;
    if (typeof page.nextOffset !== "number" || page.nextOffset <= offset) {
      throw new Error("cron.list returned an invalid nextOffset");
    }
    offset = page.nextOffset;
  }
}

function runningAgentId(job: CronJob): string | undefined {
  const agentId = typeof job.agentId === "string" ? job.agentId : job.effectiveAgentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

function unmovableReason(job: CronJob): string | null {
  const scheduleKind = isRecord(job.schedule) ? job.schedule.kind : undefined;
  const payloadKind = isRecord(job.payload) ? job.payload.kind : undefined;
  if (typeof job.declarationKey === "string" && !carriedDeclaration(job.declarationKey)) return "declared job; the platform recreates it on the target";
  if (job.payloadSource !== undefined) return "plugin command job";
  if (job.streamExecutionHost !== undefined || scheduleKind === "stream" || scheduleKind === "on-exit") {
    return "host-bound process schedule";
  }
  if (payloadKind === "command" || payloadKind === "script") return "host exec payload";
  if (hasDormantToolPolicy(job, payloadKind)) {
    return "dormant tool policy cannot be restored by this OpenClaw build";
  }
  return null;
}

function hasDormantToolPolicy(job: CronJob, payloadKind: unknown): boolean {
  const usesTools = payloadKind === "agentTurn" ||
    (isRecord(job.trigger) && typeof job.trigger.script === "string" && job.trigger.script.trim().length > 0);
  return !usesTools && (job.scheduledToolPolicy !== undefined || job.toolsAllowProvenance !== undefined);
}

function cronAddJob(job: CronJob, agentId: string): Record<string, unknown> {
  const fields = Object.fromEntries(CRON_ADD_FIELDS.map((field) => [field, job[field]]));
  return JSON.parse(JSON.stringify({ ...fields, agentId })) as Record<string, unknown>;
}

function identityKey(agentId: string, id: string): string {
  return JSON.stringify([agentId, id]);
}

function carriedDeclaration(key: unknown): key is string {
  return typeof key === "string" && CARRIED_DECLARATION_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function scheduleName(record: ScheduleRecord): string {
  return typeof record.job.name === "string" ? record.job.name : record.sourceJobId;
}

export function transferKey(record: ScheduleRecord): string {
  const key = record.job.declarationKey;
  if (carriedDeclaration(key)) return key;
  return TRANSFER_KEY_PREFIX + createHash("sha256").update(identityKey(record.agentId, record.sourceJobId)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
