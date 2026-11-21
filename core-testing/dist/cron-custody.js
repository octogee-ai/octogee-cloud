import { generateKeyPairSync } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createMigrationClient } from "@octogee/core/fleet-migration-client";
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_AGENTS = 256;
const PORTABLE_KINDS = ["at", "every", "cron"];
const PROJECTED_DECLARATION = "memory-core:memory-dreaming-promotion";
const TRANSFER_KEY_PREFIX = "octogee:transfer:";
export class CronAgentMigrationHeldError extends Error {
    agentId;
    operationId;
    constructor(agentId, operationId) {
        super(`Cron agent ${agentId} is held for migration ${operationId}`);
        this.agentId = agentId;
        this.operationId = operationId;
        this.name = "CronAgentMigrationHeldError";
    }
}
class UnsettledRunsError extends Error {
    constructor() {
        super("Cron migration snapshot contains unsettled runs");
    }
}
export class CronCustodyStore {
    jobs = new Map();
    migrations = new Map();
    fences = new Map();
    runningAgents = new Set();
    nextId = 1;
    add(job) {
        const stored = { schedule: { kind: "cron" }, ...job, id: job.id ?? `job-${this.nextId++}` };
        this.jobs.set(stored.id, stored);
        return stored;
    }
    agentJobs(agentId) {
        return [...this.jobs.values()].filter(job => job.agentId === agentId);
    }
    status(operationId) {
        return this.migrations.get(operationId)?.status;
    }
    runnable(jobId) {
        const job = this.jobs.get(jobId);
        return job !== undefined && job.enabled && !this.fences.has(job.agentId);
    }
    assertAgentAdmitted(agentId) {
        const fence = this.fences.get(agentId);
        if (fence)
            throw new CronAgentMigrationHeldError(agentId, fence);
    }
    cronAdd(job) {
        this.assertAgentAdmitted(job.agentId);
        return this.add(job);
    }
    cronUpdate(id, patch) {
        const job = this.jobs.get(id);
        if (!job)
            throw new Error(`unknown cron job ${id}`);
        this.assertAgentAdmitted(job.agentId);
        job.enabled = patch.enabled;
    }
    cronRemove(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        this.assertAgentAdmitted(job.agentId);
        this.jobs.delete(id);
    }
    migrate(request) {
        const jobs = structuredClone([...this.jobs]), migrations = structuredClone([...this.migrations]), fences = [...this.fences];
        try {
            return this.apply(request);
        }
        catch (error) {
            this.jobs.clear();
            for (const [id, job] of jobs)
                this.jobs.set(id, job);
            this.migrations.clear();
            for (const [id, row] of migrations)
                this.migrations.set(id, row);
            this.fences.clear();
            for (const [agentId, owner] of fences)
                this.fences.set(agentId, owner);
            throw error;
        }
    }
    apply(request) {
        const { operationId, phase } = request;
        if (!OPERATION_ID.test(operationId))
            throw new Error("Invalid cron migration operationId");
        if (request.retainNonportable === true && !["hold", "export", "stage"].includes(phase)) {
            throw new Error("Cron migration can retain nonportable jobs only while holding, exporting, or staging");
        }
        const existing = this.migrations.get(operationId);
        if (!existing && (phase === "resume" || phase === "abort"))
            return this.settleUnknown(request);
        if (existing && (existing.status === "resumed" || existing.status === "aborted"))
            return this.repeatSettled(request, existing);
        const agentIds = existing ? existing.agentIds : scope(request.agentIds);
        if (request.agentIds && !isDeepStrictEqual(agentIds, scope(request.agentIds)))
            throw new Error("Cron migration scope changed");
        const row = existing ?? this.acquire(request, agentIds);
        const step = {
            request, row, agentIds,
            result: (drained = true, snapshot) => ({ operationId, phase, agentIds, drained, ...(snapshot ? { snapshot } : {}) }),
        };
        return this.phases[phase](step);
    }
    phases = {
        hold: step => this.hold(step),
        export: step => this.export(step),
        stage: step => this.stage(step),
        activate: step => this.activate(step),
        resume: step => this.resume(step),
        retire: step => this.retireOrAbort(step),
        abort: step => this.retireOrAbort(step),
    };
    settleUnknown({ operationId, phase, agentIds: requested }) {
        const agentIds = requested ? scope(requested) : [];
        this.migrations.set(operationId, { status: phase === "resume" ? "resumed" : "aborted", agentIds, snapshot: null, digest: null });
        return { operationId, phase, agentIds, drained: true };
    }
    repeatSettled({ operationId, phase }, row) {
        if (phase !== (row.status === "resumed" ? "resume" : "abort"))
            throw new Error(`Cron migration already ${row.status}`);
        return { operationId, phase, agentIds: row.agentIds, drained: true };
    }
    acquire({ operationId, phase, retainNonportable }, agentIds) {
        if (phase !== "hold" && phase !== "stage")
            throw new Error("Cron migration must acquire hold before this phase");
        if (retainNonportable !== true)
            partitionPortable(this.owned(agentIds));
        for (const agentId of agentIds) {
            const previous = this.fences.get(agentId);
            if (previous && this.status(previous) !== "retired")
                throw new CronAgentMigrationHeldError(agentId, previous);
        }
        const row = { status: "held", agentIds, snapshot: null, digest: null };
        this.migrations.set(operationId, row);
        for (const agentId of agentIds)
            this.fences.set(agentId, operationId);
        return row;
    }
    hold({ row, agentIds, result }) {
        if (!["held", "exported", "staged"].includes(row.status))
            throw new Error(`Cron migration already ${row.status}`);
        return result(this.drained(agentIds, this.owned(agentIds)));
    }
    export({ request, row, agentIds, result }) {
        if (row.status === "exported")
            return result(true, row.snapshot);
        if (row.status !== "held")
            throw new Error(`Cannot export ${row.status} cron migration`);
        const retainNonportable = request.retainNonportable === true;
        const owned = this.owned(agentIds);
        const { portable, retained } = partitionPortable(owned, retainNonportable);
        if (!this.drained(agentIds, owned))
            return result(false);
        const snapshot = {
            version: 1, operationId: request.operationId, agentIds, jobs: portable.map(job => ({ ...job })), scratch: [],
            ...(retainNonportable ? { retainedJobIds: retained.map(job => job.id).sort() } : {}),
        };
        Object.assign(row, { status: "exported", snapshot, digest: JSON.stringify(snapshot) });
        return result(true, snapshot);
    }
    stage({ request, row, agentIds, result }) {
        const snapshot = parseSnapshot(request.snapshot);
        if (snapshot.operationId !== request.operationId || !isDeepStrictEqual(snapshot.agentIds, agentIds)) {
            throw new Error("Invalid cron migration snapshot: operation or scope mismatch");
        }
        if (row.status === "staged" || row.status === "activated") {
            if (row.digest !== JSON.stringify(snapshot))
                throw new Error("Cron migration snapshot changed");
            return result();
        }
        if (row.status !== "held")
            throw new Error(`Cannot stage ${row.status} cron migration`);
        partitionPortable(snapshot.jobs);
        if (snapshot.jobs.some(job => !agentIds.includes(job.agentId)))
            throw new Error("Cron migration snapshot contains another agent's job");
        if (snapshot.jobs.some(job => this.jobs.has(job.id)))
            throw new Error("Cron migration target job conflict");
        this.assertTargetRetained(request, agentIds);
        if (!this.drained(agentIds, snapshot.jobs))
            throw new UnsettledRunsError();
        for (const job of snapshot.jobs.filter(job => !projected(job)))
            this.jobs.set(job.id, { ...job });
        Object.assign(row, { status: "staged", snapshot, digest: JSON.stringify(snapshot) });
        return result();
    }
    assertTargetRetained({ operationId, retainNonportable }, agentIds) {
        const remaining = this.owned(agentIds).filter(job => !projected(job));
        if (remaining.length === 0)
            return;
        if (retainNonportable !== true)
            throw new Error("Cron migration target job conflict");
        const retired = this.retiredMigrations(agentIds, operationId);
        const unretained = remaining.find(job => !retired.has(job.agentId));
        if (unretained)
            throw new Error(`Cron job ${unretained.id} on the target was not retained by a retired migration`);
    }
    activate({ request, row, agentIds, result }) {
        if (row.status === "activated")
            return result();
        if (row.status !== "staged")
            throw new Error(`Cannot activate ${row.status} cron migration`);
        if (!this.drained(agentIds, []))
            return result(false);
        for (const job of row.snapshot.jobs.filter(projected))
            this.jobs.set(job.id, { ...job });
        Object.assign(row, { status: "activated", snapshot: null });
        this.release(request.operationId);
        return result();
    }
    resume({ request, row, agentIds, result }) {
        if (row.status !== "held" && row.status !== "exported")
            throw new Error(`Cannot resume ${row.status} cron migration`);
        Object.assign(row, { status: "resumed", snapshot: null });
        this.release(request.operationId, this.retiredMigrations(agentIds, request.operationId));
        return result();
    }
    retireOrAbort({ request, row, agentIds, result }) {
        const { operationId, phase } = request;
        const next = phase === "retire" ? "retired" : "aborted";
        if (row.status === next)
            return result();
        if (!(phase === "retire" ? ["exported"] : ["held", "staged"]).includes(row.status)) {
            throw new Error(`Cannot ${phase} ${row.status} cron migration`);
        }
        if (row.snapshot) {
            if (!this.drained(agentIds, this.owned(agentIds)))
                return result(false);
            for (const job of row.snapshot.jobs.filter(job => phase === "retire" || !projected(job)))
                this.jobs.delete(job.id);
        }
        Object.assign(row, { status: next, snapshot: null });
        if (phase === "abort")
            this.release(operationId, this.retiredMigrations(agentIds, operationId));
        return result();
    }
    drained(agentIds, jobs) {
        return !agentIds.some(agentId => this.runningAgents.has(agentId)) && jobs.every(job => !job.running);
    }
    owned(agentIds) {
        return [...this.jobs.values()].filter(job => agentIds.includes(job.agentId));
    }
    retiredMigrations(agentIds, operationId) {
        const retired = new Map();
        for (const [id, row] of this.migrations) {
            if (id === operationId || row.status === "aborted" || row.status === "resumed")
                continue;
            for (const agentId of row.agentIds) {
                if (!agentIds.includes(agentId))
                    continue;
                if (row.status === "retired")
                    retired.set(agentId, id);
                else
                    retired.delete(agentId);
            }
        }
        return retired;
    }
    release(operationId, prior) {
        for (const [agentId, owner] of [...this.fences]) {
            if (owner !== operationId)
                continue;
            const retirement = prior?.get(agentId);
            if (retirement)
                this.fences.set(agentId, retirement);
            else
                this.fences.delete(agentId);
        }
    }
}
function scope(agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0 || agentIds.length > MAX_AGENTS ||
        agentIds.some(id => typeof id !== "string" || !AGENT_ID.test(id))) {
        throw new Error("Cron migration requires an exact nonempty agentIds scope");
    }
    const unique = [...new Set(agentIds)].sort();
    if (unique.length !== agentIds.length)
        throw new Error("Cron migration scope contains duplicate agents");
    return unique;
}
function projected(job) {
    return job.declarationKey === PROJECTED_DECLARATION;
}
function nonportableReason(job) {
    if (!PORTABLE_KINDS.includes(job.schedule.kind))
        return `nonportable ${job.schedule.kind} schedule`;
    if (job.runtimeAuthority)
        return "runtime or host-bound authority that cannot be migrated safely";
    return undefined;
}
function partitionPortable(jobs, retainNonportable = false) {
    const portable = [], retained = [];
    for (const job of jobs) {
        const reason = nonportableReason(job);
        if (reason && !retainNonportable)
            throw new Error(`Cron job ${job.id} has ${reason}`);
        (reason ? retained : portable).push(job);
    }
    return { portable, retained };
}
function parseSnapshot(value) {
    const snapshot = value;
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.scratch) || typeof snapshot.operationId !== "string") {
        throw new Error("Invalid cron migration snapshot");
    }
    return { ...snapshot, agentIds: scope(snapshot.agentIds) };
}
function rpcError(error) {
    if (error instanceof CronAgentMigrationHeldError)
        return `${error.name}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}
function snapshotSchedules(cron, agentIds) {
    const records = [], skipped = [];
    for (const job of [...cron.jobs.values()].filter(job => agentIds.has(job.agentId))) {
        try {
            const reason = nonportableReason(job);
            if (reason)
                throw new Error(reason);
            if (job.enabled)
                cron.cronUpdate(job.id, { enabled: false });
            records.push({
                sourceJobId: job.id, agentId: job.agentId, scratch: null,
                job: { name: job.name, enabled: true, schedule: job.schedule, ...(job.declarationKey ? { declarationKey: job.declarationKey } : {}) },
            });
        }
        catch (error) {
            skipped.push({ jobId: job.id, name: job.name, reason: rpcError(error) });
        }
    }
    return { records, skipped };
}
function removeSchedules(cron, jobIds) {
    const failed = [];
    let removed = 0;
    for (const jobId of jobIds) {
        try {
            cron.cronRemove(jobId);
            removed++;
        }
        catch (error) {
            failed.push({ jobId, error: rpcError(error) });
        }
    }
    return { removed, failed };
}
function restoreSchedules(cron, agentIds, records) {
    const result = { created: 0, existing: 0, failed: [] };
    for (const record of records) {
        const name = typeof record.job.name === "string" ? record.job.name : record.sourceJobId;
        try {
            if (restoreRecord(cron, agentIds, record, name))
                result.created++;
            else
                result.existing++;
        }
        catch (error) {
            result.failed.push({ name, agentId: record.agentId, sourceJobId: record.sourceJobId, error: rpcError(error), retryable: false });
        }
    }
    return result;
}
function checkSchedules(cron, records) {
    const pending = records.flatMap(record => typeof record.job.name !== "string" || presentJob(cron, record) ? [] : [{ record, name: record.job.name }]);
    const sameName = (agentId, name) => new Set(pending.filter(other => other.record.agentId === agentId && other.name === name).map(other => transferKey(other.record)));
    const conflicts = [];
    for (const { record, name } of pending) {
        const live = cron.agentJobs(record.agentId).find(job => job.name === name);
        if (live || sameName(record.agentId, name).size > 1) {
            conflicts.push({ name, agentId: record.agentId, sourceJobId: record.sourceJobId, jobId: live?.id ?? null });
        }
    }
    return { conflicts };
}
function transferKey(record) {
    const carried = typeof record.job.declarationKey === "string" ? record.job.declarationKey : undefined;
    return carried ?? `${TRANSFER_KEY_PREFIX}${record.agentId}:${record.sourceJobId}`;
}
function presentJob(cron, record) {
    const declarationKey = transferKey(record);
    return cron.agentJobs(record.agentId).find(job => job.declarationKey === declarationKey || job.id === record.sourceJobId);
}
function restoreRecord(cron, agentIds, record, name) {
    if (!agentIds.has(record.agentId))
        throw new Error(`agent ${record.agentId} is not this user's agent on this gateway`);
    const declarationKey = transferKey(record);
    const present = presentJob(cron, record);
    if (present) {
        if (present.id === record.sourceJobId && !present.enabled && record.job.enabled !== false)
            cron.cronUpdate(present.id, { enabled: true });
        return false;
    }
    const schedule = record.job.schedule ?? { kind: "cron" };
    cron.cronAdd({ agentId: record.agentId, name, enabled: record.job.enabled !== false, schedule, declarationKey });
    return true;
}
export function createCronCustodyGateways(agentScopes) {
    const stores = new Map();
    const calls = [];
    const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const store = (gatewayId) => {
        if (!stores.has(gatewayId))
            stores.set(gatewayId, new CronCustodyStore());
        return stores.get(gatewayId);
    };
    const agentsOf = (slug) => {
        const agentIds = agentScopes[slug];
        if (!agentIds)
            throw new Error(`no agents for ${slug}`);
        return agentIds;
    };
    const scheduler = (gatewayId, body) => {
        if (body.phase === "stage-requester") {
            return [200, { operationId: body.migrationId, phase: body.phase, agentIds: [], drained: true, stageRequesterProfileId: null }];
        }
        const phase = body.phase;
        const agentIds = body.resolveAgentScope === true ? agentsOf(String(body.slug)) : body.agentIds;
        if (phase === "stage" && (agentIds === undefined || body.snapshot === undefined))
            return [400, { error: "invalid scheduler migration request" }];
        calls.push(`scheduler:${gatewayId}:${phase}:${String(body.migrationId)}`);
        try {
            const result = store(gatewayId).migrate({
                operationId: String(body.migrationId), phase, ...(agentIds ? { agentIds } : {}),
                ...(body.snapshot === undefined ? {} : { snapshot: body.snapshot }),
                ...(body.retainNonportable === undefined ? {} : { retainNonportable: body.retainNonportable }),
            });
            return [result.drained ? 200 : 409, result];
        }
        catch (error) {
            return [500, { error: "scheduler migration failed", message: rpcError(error), retryable: error instanceof UnsettledRunsError }];
        }
    };
    const quiesce = (gatewayId, body) => {
        const envelope = { migrationId: body.migrationId, slug: body.slug };
        if (body.schedulerHandoff !== true)
            return [200, { ...envelope, drained: true, runningCount: 0 }];
        const operationId = String(body.schedulerMigrationId ?? body.migrationId);
        calls.push(`quiesce:${gatewayId}:hold:${operationId}`);
        try {
            const { drained } = store(gatewayId).migrate({
                operationId, phase: "hold", agentIds: agentsOf(String(body.slug)),
                ...(body.retainNonportable === true ? { retainNonportable: true } : {}),
            });
            return [200, { ...envelope, drained, runningCount: drained ? 0 : 1 }];
        }
        catch (error) {
            return [500, { error: "quiesce failed", message: rpcError(error) }];
        }
    };
    const schedules = (gatewayId, body) => {
        const slug = String(body.slug);
        const agentIds = new Set(agentsOf(slug));
        const cron = store(gatewayId);
        const envelope = { migrationId: body.migrationId, slug, op: body.op };
        calls.push(`schedules:${gatewayId}:${String(body.op)}`);
        if (body.op === "snapshot")
            return [200, { ...envelope, ...snapshotSchedules(cron, agentIds) }];
        if (body.op === "remove")
            return [200, { ...envelope, ...removeSchedules(cron, body.jobIds) }];
        if (body.op === "check")
            return [200, { ...envelope, ...checkSchedules(cron, body.records) }];
        return [200, { ...envelope, ...restoreSchedules(cron, agentIds, body.records) }];
    };
    const routes = { scheduler, quiesce, schedules };
    const fetch = async (input, init) => {
        const [, route, gatewayId] = new URL(String(input)).pathname.split("/");
        const handler = routes[route];
        if (!handler || !gatewayId)
            throw new Error(`unexpected migration RPC ${String(input)}`);
        const [status, reply] = handler(gatewayId, JSON.parse(String(init?.body)));
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
