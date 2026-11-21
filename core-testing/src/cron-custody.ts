import { generateKeyPairSync } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ScheduleNameConflict, ScheduleRecord, ScheduleRestoreResult, ScheduleSkip } from "@octogee/shared/types/fleet-controller";
import { createMigrationClient, type MigrationClient } from "@octogee/core/fleet-migration-client";

export interface CustodyJob {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  schedule: { kind: string };
  runtimeAuthority?: true;
  declarationKey?: string;
  running?: true;
}

type Phase = "hold" | "export" | "stage" | "activate" | "resume" | "retire" | "abort";
export type CustodyStatus = "held" | "exported" | "staged" | "activated" | "resumed" | "retired" | "aborted";

interface Snapshot {
  version: 1;
  operationId: string;
  agentIds: string[];
  jobs: CustodyJob[];
  scratch: unknown[];
  retainedJobIds?: string[];
}

interface Migration {
  status: CustodyStatus;
  agentIds: string[];
  snapshot: Snapshot | null;
  digest: string | null;
}

export interface CustodyRequest {
  operationId: string;
  phase: Phase;
  agentIds?: string[];
  snapshot?: unknown;
  retainNonportable?: boolean;
}

export interface CustodyResult {
  operationId: string;
  phase: Phase;
  agentIds: string[];
  drained: boolean;
  snapshot?: Snapshot;
}

interface Step {
  request: CustodyRequest;
  row: Migration;
  agentIds: string[];
  result: (drained?: boolean, snapshot?: Snapshot) => CustodyResult;
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_AGENTS = 256;
const PORTABLE_KINDS = ["at", "every", "cron"];
const PROJECTED_DECLARATION = "memory-core:memory-dreaming-promotion";
const TRANSFER_KEY_PREFIX = "octogee:transfer:";

export class CronAgentMigrationHeldError extends Error {
  constructor(readonly agentId: string, readonly operationId: string) {
    super(`Cron agent ${agentId} is held for migration ${operationId}`);
    this.name = "CronAgentMigrationHeldError";
  }
}

class UnsettledRunsError extends Error {
  constructor() {
    super("Cron migration snapshot contains unsettled runs");
  }
}

export class CronCustodyStore {
  readonly jobs = new Map<string, CustodyJob>();
  readonly migrations = new Map<string, Migration>();
  readonly fences = new Map<string, string>();
  readonly runningAgents = new Set<string>();
  private nextId = 1;

  add(job: Omit<CustodyJob, "id" | "schedule"> & { id?: string; schedule?: { kind: string } }): CustodyJob {
    const stored: CustodyJob = { schedule: { kind: "cron" }, ...job, id: job.id ?? `job-${this.nextId++}` };
    this.jobs.set(stored.id, stored);
    return stored;
  }

  agentJobs(agentId: string): CustodyJob[] {
    return [...this.jobs.values()].filter(job => job.agentId === agentId);
  }

  status(operationId: string): CustodyStatus | undefined {
    return this.migrations.get(operationId)?.status;
  }

  runnable(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return job !== undefined && job.enabled && !this.fences.has(job.agentId);
  }

  assertAgentAdmitted(agentId: string): void {
    const fence = this.fences.get(agentId);
    if (fence) throw new CronAgentMigrationHeldError(agentId, fence);
  }

  cronAdd(job: Omit<CustodyJob, "id">): CustodyJob {
    this.assertAgentAdmitted(job.agentId);
    return this.add(job);
  }

  cronUpdate(id: string, patch: { enabled: boolean }): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown cron job ${id}`);
    this.assertAgentAdmitted(job.agentId);
    job.enabled = patch.enabled;
  }

  cronRemove(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.assertAgentAdmitted(job.agentId);
    this.jobs.delete(id);
  }

  migrate(request: CustodyRequest): CustodyResult {
    const jobs = structuredClone([...this.jobs]), migrations = structuredClone([...this.migrations]), fences = [...this.fences];
    try {
      return this.apply(request);
    } catch (error) {
      this.jobs.clear();
      for (const [id, job] of jobs) this.jobs.set(id, job);
      this.migrations.clear();
      for (const [id, row] of migrations) this.migrations.set(id, row);
      this.fences.clear();
      for (const [agentId, owner] of fences) this.fences.set(agentId, owner);
      throw error;
    }
  }

  private apply(request: CustodyRequest): CustodyResult {
    const { operationId, phase } = request;
    if (!OPERATION_ID.test(operationId)) throw new Error("Invalid cron migration operationId");
    if (request.retainNonportable === true && !["hold", "export", "stage"].includes(phase)) {
      throw new Error("Cron migration can retain nonportable jobs only while holding, exporting, or staging");
    }
    const existing = this.migrations.get(operationId);
    if (!existing && (phase === "resume" || phase === "abort")) return this.settleUnknown(request);
    if (existing && (existing.status === "resumed" || existing.status === "aborted")) return this.repeatSettled(request, existing);
    const agentIds = existing ? existing.agentIds : scope(request.agentIds);
    if (request.agentIds && !isDeepStrictEqual(agentIds, scope(request.agentIds))) throw new Error("Cron migration scope changed");
    const row = existing ?? this.acquire(request, agentIds);
    const step: Step = {
      request, row, agentIds,
      result: (drained = true, snapshot) => ({ operationId, phase, agentIds, drained, ...(snapshot ? { snapshot } : {}) }),
    };
    return this.phases[phase](step);
  }

  private readonly phases: Record<Phase, (step: Step) => CustodyResult> = {
    hold: step => this.hold(step),
    export: step => this.export(step),
    stage: step => this.stage(step),
    activate: step => this.activate(step),
    resume: step => this.resume(step),
    retire: step => this.retireOrAbort(step),
    abort: step => this.retireOrAbort(step),
  };

  private settleUnknown({ operationId, phase, agentIds: requested }: CustodyRequest): CustodyResult {
    const agentIds = requested ? scope(requested) : [];
    this.migrations.set(operationId, { status: phase === "resume" ? "resumed" : "aborted", agentIds, snapshot: null, digest: null });
    return { operationId, phase, agentIds, drained: true };
  }

  private repeatSettled({ operationId, phase }: CustodyRequest, row: Migration): CustodyResult {
    if (phase !== (row.status === "resumed" ? "resume" : "abort")) throw new Error(`Cron migration already ${row.status}`);
    return { operationId, phase, agentIds: row.agentIds, drained: true };
  }

  private acquire({ operationId, phase, retainNonportable }: CustodyRequest, agentIds: string[]): Migration {
    if (phase !== "hold" && phase !== "stage") throw new Error("Cron migration must acquire hold before this phase");
    if (retainNonportable !== true) partitionPortable(this.owned(agentIds));
    for (const agentId of agentIds) {
      const previous = this.fences.get(agentId);
      if (previous && this.status(previous) !== "retired") throw new CronAgentMigrationHeldError(agentId, previous);
    }
    const row: Migration = { status: "held", agentIds, snapshot: null, digest: null };
    this.migrations.set(operationId, row);
    for (const agentId of agentIds) this.fences.set(agentId, operationId);
    return row;
  }

  private hold({ row, agentIds, result }: Step): CustodyResult {
    if (!["held", "exported", "staged"].includes(row.status)) throw new Error(`Cron migration already ${row.status}`);
    return result(this.drained(agentIds, this.owned(agentIds)));
  }

  private export({ request, row, agentIds, result }: Step): CustodyResult {
    if (row.status === "exported") return result(true, row.snapshot!);
    if (row.status !== "held") throw new Error(`Cannot export ${row.status} cron migration`);
    const retainNonportable = request.retainNonportable === true;
    const owned = this.owned(agentIds);
    const { portable, retained } = partitionPortable(owned, retainNonportable);
    if (!this.drained(agentIds, owned)) return result(false);
    const snapshot: Snapshot = {
      version: 1, operationId: request.operationId, agentIds, jobs: portable.map(job => ({ ...job })), scratch: [],
      ...(retainNonportable ? { retainedJobIds: retained.map(job => job.id).sort() } : {}),
    };
    Object.assign(row, { status: "exported", snapshot, digest: JSON.stringify(snapshot) });
    return result(true, snapshot);
  }

  private stage({ request, row, agentIds, result }: Step): CustodyResult {
    const snapshot = parseSnapshot(request.snapshot);
    if (snapshot.operationId !== request.operationId || !isDeepStrictEqual(snapshot.agentIds, agentIds)) {
      throw new Error("Invalid cron migration snapshot: operation or scope mismatch");
    }
    if (row.status === "staged" || row.status === "activated") {
      if (row.digest !== JSON.stringify(snapshot)) throw new Error("Cron migration snapshot changed");
      return result();
    }
    if (row.status !== "held") throw new Error(`Cannot stage ${row.status} cron migration`);
    partitionPortable(snapshot.jobs);
    if (snapshot.jobs.some(job => !agentIds.includes(job.agentId))) throw new Error("Cron migration snapshot contains another agent's job");
    if (snapshot.jobs.some(job => this.jobs.has(job.id))) throw new Error("Cron migration target job conflict");
    this.assertTargetRetained(request, agentIds);
    if (!this.drained(agentIds, snapshot.jobs)) throw new UnsettledRunsError();
    for (const job of snapshot.jobs.filter(job => !projected(job))) this.jobs.set(job.id, { ...job });
    Object.assign(row, { status: "staged", snapshot, digest: JSON.stringify(snapshot) });
    return result();
  }

  private assertTargetRetained({ operationId, retainNonportable }: CustodyRequest, agentIds: string[]): void {
    const remaining = this.owned(agentIds).filter(job => !projected(job));
    if (remaining.length === 0) return;
    if (retainNonportable !== true) throw new Error("Cron migration target job conflict");
    const retired = this.retiredMigrations(agentIds, operationId);
    const unretained = remaining.find(job => !retired.has(job.agentId));
    if (unretained) throw new Error(`Cron job ${unretained.id} on the target was not retained by a retired migration`);
  }

  private activate({ request, row, agentIds, result }: Step): CustodyResult {
    if (row.status === "activated") return result();
    if (row.status !== "staged") throw new Error(`Cannot activate ${row.status} cron migration`);
    if (!this.drained(agentIds, [])) return result(false);
    for (const job of row.snapshot!.jobs.filter(projected)) this.jobs.set(job.id, { ...job });
    Object.assign(row, { status: "activated", snapshot: null });
    this.release(request.operationId);
    return result();
  }

  private resume({ request, row, agentIds, result }: Step): CustodyResult {
    if (row.status !== "held" && row.status !== "exported") throw new Error(`Cannot resume ${row.status} cron migration`);
    Object.assign(row, { status: "resumed", snapshot: null });
    this.release(request.operationId, this.retiredMigrations(agentIds, request.operationId));
    return result();
  }

  private retireOrAbort({ request, row, agentIds, result }: Step): CustodyResult {
    const { operationId, phase } = request;
    const next = phase === "retire" ? "retired" : "aborted";
    if (row.status === next) return result();
    if (!(phase === "retire" ? ["exported"] : ["held", "staged"]).includes(row.status)) {
      throw new Error(`Cannot ${phase} ${row.status} cron migration`);
    }
    if (row.snapshot) {
      if (!this.drained(agentIds, this.owned(agentIds))) return result(false);
      for (const job of row.snapshot.jobs.filter(job => phase === "retire" || !projected(job))) this.jobs.delete(job.id);
    }
    Object.assign(row, { status: next, snapshot: null });
    if (phase === "abort") this.release(operationId, this.retiredMigrations(agentIds, operationId));
    return result();
  }

  private drained(agentIds: readonly string[], jobs: readonly CustodyJob[]): boolean {
    return !agentIds.some(agentId => this.runningAgents.has(agentId)) && jobs.every(job => !job.running);
  }

  private owned(agentIds: readonly string[]): CustodyJob[] {
    return [...this.jobs.values()].filter(job => agentIds.includes(job.agentId));
  }

  private retiredMigrations(agentIds: readonly string[], operationId: string): Map<string, string> {
    const retired = new Map<string, string>();
    for (const [id, row] of this.migrations) {
      if (id === operationId || row.status === "aborted" || row.status === "resumed") continue;
      for (const agentId of row.agentIds) {
        if (!agentIds.includes(agentId)) continue;
        if (row.status === "retired") retired.set(agentId, id);
        else retired.delete(agentId);
      }
    }
    return retired;
  }

  private release(operationId: string, prior?: ReadonlyMap<string, string>): void {
    for (const [agentId, owner] of [...this.fences]) {
      if (owner !== operationId) continue;
      const retirement = prior?.get(agentId);
      if (retirement) this.fences.set(agentId, retirement);
      else this.fences.delete(agentId);
    }
  }
}

function scope(agentIds: unknown): string[] {
  if (!Array.isArray(agentIds) || agentIds.length === 0 || agentIds.length > MAX_AGENTS ||
      agentIds.some(id => typeof id !== "string" || !AGENT_ID.test(id))) {
    throw new Error("Cron migration requires an exact nonempty agentIds scope");
  }
  const unique = [...new Set(agentIds as string[])].sort();
  if (unique.length !== agentIds.length) throw new Error("Cron migration scope contains duplicate agents");
  return unique;
}

function projected(job: CustodyJob): boolean {
  return job.declarationKey === PROJECTED_DECLARATION;
}

function nonportableReason(job: CustodyJob): string | undefined {
  if (!PORTABLE_KINDS.includes(job.schedule.kind)) return `nonportable ${job.schedule.kind} schedule`;
  if (job.runtimeAuthority) return "runtime or host-bound authority that cannot be migrated safely";
  return undefined;
}

function partitionPortable(jobs: readonly CustodyJob[], retainNonportable = false) {
  const portable: CustodyJob[] = [], retained: CustodyJob[] = [];
  for (const job of jobs) {
    const reason = nonportableReason(job);
    if (reason && !retainNonportable) throw new Error(`Cron job ${job.id} has ${reason}`);
    (reason ? retained : portable).push(job);
  }
  return { portable, retained };
}

function parseSnapshot(value: unknown): Snapshot {
  const snapshot = value as Snapshot | undefined;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.scratch) || typeof snapshot.operationId !== "string") {
    throw new Error("Invalid cron migration snapshot");
  }
  return { ...snapshot, agentIds: scope(snapshot.agentIds) };
}

function rpcError(error: unknown): string {
  if (error instanceof CronAgentMigrationHeldError) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function snapshotSchedules(cron: CronCustodyStore, agentIds: ReadonlySet<string>): { records: ScheduleRecord[]; skipped: ScheduleSkip[] } {
  const records: ScheduleRecord[] = [], skipped: ScheduleSkip[] = [];
  for (const job of [...cron.jobs.values()].filter(job => agentIds.has(job.agentId))) {
    try {
      const reason = nonportableReason(job);
      if (reason) throw new Error(reason);
      if (job.enabled) cron.cronUpdate(job.id, { enabled: false });
      records.push({
        sourceJobId: job.id, agentId: job.agentId, scratch: null,
        job: { name: job.name, enabled: true, schedule: job.schedule, ...(job.declarationKey ? { declarationKey: job.declarationKey } : {}) },
      });
    } catch (error) {
      skipped.push({ jobId: job.id, name: job.name, reason: rpcError(error) });
    }
  }
  return { records, skipped };
}

function removeSchedules(cron: CronCustodyStore, jobIds: readonly string[]): { removed: number; failed: Array<{ jobId: string; error: string }> } {
  const failed: Array<{ jobId: string; error: string }> = [];
  let removed = 0;
  for (const jobId of jobIds) {
    try {
      cron.cronRemove(jobId);
      removed++;
    } catch (error) {
      failed.push({ jobId, error: rpcError(error) });
    }
  }
  return { removed, failed };
}

function restoreSchedules(
  cron: CronCustodyStore, agentIds: ReadonlySet<string>, records: readonly ScheduleRecord[],
): Pick<ScheduleRestoreResult, "created" | "existing" | "failed"> {
  const result: Pick<ScheduleRestoreResult, "created" | "existing" | "failed"> = { created: 0, existing: 0, failed: [] };
  for (const record of records) {
    const name = typeof record.job.name === "string" ? record.job.name : record.sourceJobId;
    try {
      if (restoreRecord(cron, agentIds, record, name)) result.created++;
      else result.existing++;
    } catch (error) {
      result.failed.push({ name, agentId: record.agentId, sourceJobId: record.sourceJobId, error: rpcError(error), retryable: false });
    }
  }
  return result;
}

function checkSchedules(cron: CronCustodyStore, records: readonly ScheduleRecord[]): { conflicts: ScheduleNameConflict[] } {
  const pending = records.flatMap(record =>
    typeof record.job.name !== "string" || presentJob(cron, record) ? [] : [{ record, name: record.job.name }]);
  const sameName = (agentId: string, name: string) =>
    new Set(pending.filter(other => other.record.agentId === agentId && other.name === name).map(other => transferKey(other.record)));
  const conflicts: ScheduleNameConflict[] = [];
  for (const { record, name } of pending) {
    const live = cron.agentJobs(record.agentId).find(job => job.name === name);
    if (live || sameName(record.agentId, name).size > 1) {
      conflicts.push({ name, agentId: record.agentId, sourceJobId: record.sourceJobId, jobId: live?.id ?? null });
    }
  }
  return { conflicts };
}

function transferKey(record: ScheduleRecord): string {
  const carried = typeof record.job.declarationKey === "string" ? record.job.declarationKey : undefined;
  return carried ?? `${TRANSFER_KEY_PREFIX}${record.agentId}:${record.sourceJobId}`;
}

function presentJob(cron: CronCustodyStore, record: ScheduleRecord): CustodyJob | undefined {
  const declarationKey = transferKey(record);
  return cron.agentJobs(record.agentId).find(job => job.declarationKey === declarationKey || job.id === record.sourceJobId);
}

function restoreRecord(cron: CronCustodyStore, agentIds: ReadonlySet<string>, record: ScheduleRecord, name: string): boolean {
  if (!agentIds.has(record.agentId)) throw new Error(`agent ${record.agentId} is not this user's agent on this gateway`);
  const declarationKey = transferKey(record);
  const present = presentJob(cron, record);
  if (present) {
    if (present.id === record.sourceJobId && !present.enabled && record.job.enabled !== false) cron.cronUpdate(present.id, { enabled: true });
    return false;
  }
  const schedule = (record.job.schedule as { kind: string } | undefined) ?? { kind: "cron" };
  cron.cronAdd({ agentId: record.agentId, name, enabled: record.job.enabled !== false, schedule, declarationKey });
  return true;
}

export interface CronCustodyGateways {
  store(gatewayId: string): CronCustodyStore;
  calls: string[];
  fetch: typeof globalThis.fetch;
  client(base: MigrationClient, resolveGatewayUrl: (transportId: string) => string): MigrationClient;
}

type Reply = readonly [number, unknown];

export function createCronCustodyGateways(agentScopes: Record<string, string[]>): CronCustodyGateways {
  const stores = new Map<string, CronCustodyStore>();
  const calls: string[] = [];
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const store = (gatewayId: string) => {
    if (!stores.has(gatewayId)) stores.set(gatewayId, new CronCustodyStore());
    return stores.get(gatewayId)!;
  };
  const agentsOf = (slug: string) => {
    const agentIds = agentScopes[slug];
    if (!agentIds) throw new Error(`no agents for ${slug}`);
    return agentIds;
  };

  const scheduler = (gatewayId: string, body: Record<string, unknown>): Reply => {
    if (body.phase === "stage-requester") {
      return [200, { operationId: body.migrationId, phase: body.phase, agentIds: [], drained: true, stageRequesterProfileId: null }];
    }
    const phase = body.phase as Phase;
    const agentIds = body.resolveAgentScope === true ? agentsOf(String(body.slug)) : body.agentIds as string[] | undefined;
    if (phase === "stage" && (agentIds === undefined || body.snapshot === undefined)) return [400, { error: "invalid scheduler migration request" }];
    calls.push(`scheduler:${gatewayId}:${phase}:${String(body.migrationId)}`);
    try {
      const result = store(gatewayId).migrate({
        operationId: String(body.migrationId), phase, ...(agentIds ? { agentIds } : {}),
        ...(body.snapshot === undefined ? {} : { snapshot: body.snapshot }),
        ...(body.retainNonportable === undefined ? {} : { retainNonportable: body.retainNonportable as boolean }),
      });
      return [result.drained ? 200 : 409, result];
    } catch (error) {
      return [500, { error: "scheduler migration failed", message: rpcError(error), retryable: error instanceof UnsettledRunsError }];
    }
  };

  const quiesce = (gatewayId: string, body: Record<string, unknown>): Reply => {
    const envelope = { migrationId: body.migrationId, slug: body.slug };
    if (body.schedulerHandoff !== true) return [200, { ...envelope, drained: true, runningCount: 0 }];
    const operationId = String(body.schedulerMigrationId ?? body.migrationId);
    calls.push(`quiesce:${gatewayId}:hold:${operationId}`);
    try {
      const { drained } = store(gatewayId).migrate({
        operationId, phase: "hold", agentIds: agentsOf(String(body.slug)),
        ...(body.retainNonportable === true ? { retainNonportable: true } : {}),
      });
      return [200, { ...envelope, drained, runningCount: drained ? 0 : 1 }];
    } catch (error) {
      return [500, { error: "quiesce failed", message: rpcError(error) }];
    }
  };

  const schedules = (gatewayId: string, body: Record<string, unknown>): Reply => {
    const slug = String(body.slug);
    const agentIds = new Set(agentsOf(slug));
    const cron = store(gatewayId);
    const envelope = { migrationId: body.migrationId, slug, op: body.op };
    calls.push(`schedules:${gatewayId}:${String(body.op)}`);
    if (body.op === "snapshot") return [200, { ...envelope, ...snapshotSchedules(cron, agentIds) }];
    if (body.op === "remove") return [200, { ...envelope, ...removeSchedules(cron, body.jobIds as string[]) }];
    if (body.op === "check") return [200, { ...envelope, ...checkSchedules(cron, body.records as ScheduleRecord[]) }];
    return [200, { ...envelope, ...restoreSchedules(cron, agentIds, body.records as ScheduleRecord[]) }];
  };

  const routes: Record<string, (gatewayId: string, body: Record<string, unknown>) => Reply> = { scheduler, quiesce, schedules };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const [, route, gatewayId] = new URL(String(input)).pathname.split("/");
    const handler = routes[route];
    if (!handler || !gatewayId) throw new Error(`unexpected migration RPC ${String(input)}`);
    const [status, reply] = handler(gatewayId, JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status });
  };

  return {
    store,
    calls,
    fetch,
    client(base, resolveGatewayUrl) {
      const live = createMigrationClient({ privateKey, resolveGatewayUrl, fetch, transferState: base.transferState });
      return { ...base, scheduler: live.scheduler, schedules: live.schedules, quiesce: live.quiesce };
    },
  };
}
