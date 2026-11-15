import { createHash } from "node:crypto";
import { isSurgeSchedulerAlreadyResumed } from "./surge-scheduler-receipt.js";
import type { SchedulerMigrationRequest, SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import type { SurgeAssignment, SurgeUserHandoffDeps, SurgePod } from "./surge-user-handoff.js";

export interface SurgeSchedulerCustody {
  gatewayId: string;
  owner: string;
  assignment: SurgeAssignment;
  source?: SurgePod;
  target: SurgePod;
  agentIds?: string[];
}

export function surgeSchedulerOperationId(custody: Pick<SurgeSchedulerCustody, "assignment" | "gatewayId"> & { target: Pick<SurgePod, "uid"> }): string {
  const { assignment, gatewayId, target } = custody;
  if (!Number.isSafeInteger(assignment.updatedAt) || assignment.updatedAt! <= 0) {
    throw new Error(`scheduler custody requires an assignment clock for ${assignment.slug}`);
  }
  const digest = createHash("sha256").update(JSON.stringify([
    gatewayId, assignment.sharedSurgeForwardRecovery?.targetPodUid ?? target.uid, assignment.uid, assignment.slug, assignment.epoch, assignment.updatedAt,
  ])).digest("hex");
  return `surge-cron:${digest}`;
}

export async function assertSurgeSchedulerCustody(deps: SurgeUserHandoffDeps, custody: SurgeSchedulerCustody): Promise<void> {
  const { gatewayId, owner, assignment, source, target } = custody;
  surgeSchedulerOperationId(custody);
  const current = (await deps.readAssignments(gatewayId)).find(row => row.uid === assignment.uid);
  if (!current || current.slug !== assignment.slug || current.epoch !== assignment.epoch ||
      current.state !== "quiescing" || current.updatedByOperationId !== owner || current.updatedAt !== assignment.updatedAt) {
    throw new Error(`scheduler assignment custody changed for ${assignment.slug}`);
  }
  const snapshot = await deps.listPods(gatewayId);
  const expected = source ? [source, target] : [target];
  if (snapshot.pods.length !== expected.length || snapshot.observedPodUids.length !== expected.length ||
      expected.some(pod => !snapshot.observedPodUids.includes(pod.uid) || !snapshot.pods.some(currentPod =>
        currentPod.uid === pod.uid && currentPod.name === pod.name && currentPod.podIP === pod.podIP &&
        !currentPod.crashLooping && (pod.uid !== target.uid || !currentPod.terminating)))) {
    throw new Error(`scheduler physical custody changed for ${assignment.slug}`);
  }
}

async function schedulerPhase(
  deps: SurgeUserHandoffDeps,
  custody: SurgeSchedulerCustody,
  pod: SurgePod,
  request: Omit<SchedulerMigrationRequest, "operationId">,
): Promise<SchedulerMigrationResult> {
  if (!deps.scheduler) throw new Error("Shared surge scheduler transport unavailable");
  await assertSurgeSchedulerCustody(deps, custody);
  const operationId = surgeSchedulerOperationId(custody);
  const result = await deps.scheduler({ ...request, operationId, gatewayId: custody.gatewayId, slug: custody.assignment.slug, pod });
  if (result.operationId !== operationId || result.phase !== request.phase || !result.drained ||
      !Array.isArray(result.agentIds) || (result.agentIds.length === 0 && request.phase !== "abort" && request.phase !== "resume") || new Set(result.agentIds).size !== result.agentIds.length ||
      result.agentIds.some(id => id !== `octogee-${custody.assignment.slug}-coach` && !id.startsWith(`octogee-${custody.assignment.slug}-proj-`))) {
    throw new Error(`scheduler ${request.phase} acknowledgement invalid for ${custody.assignment.slug}`);
  }
  return result;
}

function assertFullSchedulerSnapshot(snapshot: unknown, operationId: string, agentIds: string[]): void {
  const value = snapshot as { version?: unknown; operationId?: unknown; agentIds?: unknown; jobs?: unknown; scratch?: unknown; retainedJobIds?: unknown } | null;
  if (!value || value.version !== 1 || value.operationId !== operationId || !Array.isArray(value.agentIds) ||
      JSON.stringify([...value.agentIds].sort()) !== JSON.stringify([...agentIds].sort()) ||
      !Array.isArray(value.jobs) || !Array.isArray(value.scratch) ||
      (value.retainedJobIds !== undefined && (!Array.isArray(value.retainedJobIds) || value.retainedJobIds.length !== 0))) {
    throw new Error("full scheduler snapshot required before Shared handoff");
  }
}

export async function stageSurgeScheduler(deps: SurgeUserHandoffDeps, custody: SurgeSchedulerCustody): Promise<void> {
  if (!custody.source) throw new Error("scheduler export requires the physical source");
  const exported = await schedulerPhase(deps, custody, custody.source, {
    phase: "export", ...(custody.assignment.sharedSurgeForwardRecovery ? {} : { resolveAgentScope: true, retainNonportable: true }),
  });
  custody.agentIds = exported.agentIds;
  assertFullSchedulerSnapshot(exported.snapshot, exported.operationId, exported.agentIds);
  const staged = await schedulerPhase(deps, custody, custody.target, {
    phase: "stage", agentIds: exported.agentIds, snapshot: exported.snapshot,
  });
  if (JSON.stringify(staged.agentIds) !== JSON.stringify(exported.agentIds)) {
    throw new Error(`scheduler stage scope changed for ${custody.assignment.slug}`);
  }
}

export async function inspectExistingSurgeScheduler(deps: SurgeUserHandoffDeps, custody: SurgeSchedulerCustody): Promise<void> {
  if (!custody.source) throw new Error("scheduler inspection requires the physical source");
  try {
    const exported = await schedulerPhase(deps, custody, custody.source, { phase: "export" });
    if (exported.snapshot === undefined) throw new Error(`retained scheduler export unavailable for ${custody.assignment.slug}`);
    custody.agentIds = exported.agentIds;
  } catch (error) {
    if (!isSurgeSchedulerAlreadyResumed(error)) throw error;
    const receipt = await schedulerPhase(deps, custody, custody.source, { phase: "resume" });
    if (receipt.agentIds.length === 0) throw new Error(`retained scheduler resume receipt unavailable for ${custody.assignment.slug}`);
    custody.agentIds = receipt.agentIds;
  }
}

export async function abortSurgeSchedulerTarget(deps: SurgeUserHandoffDeps, custody: SurgeSchedulerCustody): Promise<void> {
  if (!custody.source) throw new Error("scheduler rollback requires the physical source");
  await schedulerPhase(deps, custody, custody.target, { phase: "abort" });
}

export async function resumeSurgeSchedulerSource(deps: SurgeUserHandoffDeps, custody: SurgeSchedulerCustody): Promise<void> {
  if (!custody.source) throw new Error("scheduler resume requires the physical source");
  const resumed = await schedulerPhase(deps, custody, custody.source, { phase: "resume" });
  if (resumed.agentIds.length === 0 || (custody.agentIds && JSON.stringify(resumed.agentIds) !== JSON.stringify(custody.agentIds))) {
    throw new Error(`scheduler resume scope changed for ${custody.assignment.slug}`);
  }
  custody.agentIds = resumed.agentIds;
}


export async function activateSurgeScheduler(deps: SurgeUserHandoffDeps, custody: SurgeSchedulerCustody): Promise<void> {
  if (custody.source) throw new Error("scheduler activation requires the physical source to be absent");
  await schedulerPhase(deps, custody, custody.target, { phase: "activate" });
  await assertSurgeSchedulerCustody(deps, custody);
}
