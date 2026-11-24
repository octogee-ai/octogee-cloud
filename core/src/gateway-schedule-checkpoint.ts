import { parseAgentId } from "@octogee/shared/types/identity";
import { GATEWAY_UNREACHABLE_AFTER_MS, type NativeScheduleCheckpoint } from "@octogee/shared/types/fleet-controller";
import { gatewayVmPodName } from "@octogee/shared/types/glm";
import { sameEphemeralWriter } from "./isolated-gateway-lifecycle/ephemeral-recovery-state.js";
import type { EphemeralGatewayWriter, FleetRegistryRecord, GatewayAssignment, GatewayRoot, PlatformStateStore, PlatformStateTransaction, PlatformUserRecord, Stored } from "./platform-state/index.js";

const MAX_CHECKPOINT_AGE_MS = 60_000;

export type GatewayCheckpointRefusal =
  | "report_stale" | "gateway_missing" | "user_missing" | "assignment_missing" | "gateway_not_serving"
  | "ephemeral_writer_mismatch" | "vm_writer_mismatch" | "kubernetes_writer_unobserved"
  | "kubernetes_observation_stale" | "kubernetes_writer_mismatch" | "assignment_not_owned"
  | "assignment_not_serving" | "user_fenced" | "foreign_schedules";

export type GatewayCheckpointResult = "accepted" | GatewayCheckpointRefusal;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJob(value: unknown): value is NativeScheduleCheckpoint["jobs"][number] {
  return isRecord(value) && typeof value.id === "string" && typeof value.agentId === "string";
}

function isScratch(value: unknown): value is NativeScheduleCheckpoint["scratch"][number] {
  return isRecord(value) && typeof value.jobId === "string" &&
    (value.content === null || typeof value.content === "string") &&
    Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.updatedAtMs) &&
    (value.sourceSha256 === null || typeof value.sourceSha256 === "string");
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0);
}

export function parseScheduleCheckpoint(value: unknown): NativeScheduleCheckpoint | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.operationId !== "string") return null;
  const { operationId, agentIds, jobs, scratch, retainedJobIds } = value;
  if (!isIdList(agentIds) || !agentIds.length) return null;
  if (!Array.isArray(jobs) || !jobs.every(isJob) || !Array.isArray(scratch) || !scratch.every(isScratch)) return null;
  if (retainedJobIds !== undefined && !isIdList(retainedJobIds)) return null;
  const ids = new Set(jobs.map(job => job.id));
  if (ids.size !== jobs.length || scratch.some(entry => !ids.has(entry.jobId))) return null;
  return { version: 1, operationId, agentIds, jobs, scratch, ...(retainedJobIds ? { retainedJobIds } : {}) };
}

function allowsUserCheckpoint(root: GatewayRoot): boolean {
  const canServe = root.desiredStatus === "running" || (root.gatewayClass === "shared" && root.desiredStatus === "draining");
  return canServe && !root.retirementClaim && !root.runtimeRestartFence;
}

function scheduleWriterRefusal(
  root: GatewayRoot, runtime: FleetRegistryRecord | null, pod: EphemeralGatewayWriter, now: number,
): GatewayCheckpointRefusal | null {
  if (!allowsUserCheckpoint(root)) return "gateway_not_serving";
  if (root.allocation?.ephemeralHomeGiB !== undefined) {
    return !root.ephemeralWriter?.exclusion && sameEphemeralWriter(root.ephemeralWriter, pod) ? null : "ephemeral_writer_mismatch";
  }
  if (runtime?.runtime === "gce-vm") {
    return runtime.vm?.status === "RUNNING" && runtime.vm.instanceId === pod.podUid &&
      gatewayVmPodName(root.gatewayId, pod.podUid) === pod.podName ? null : "vm_writer_mismatch";
  }
  return soleObservedClusterWriterRefusal(runtime?.kubernetes, pod, now);
}

function soleObservedClusterWriterRefusal(
  observation: FleetRegistryRecord["kubernetes"],
  pod: EphemeralGatewayWriter,
  now: number,
): GatewayCheckpointRefusal | null {
  if (observation?.status !== "ready" || observation.totalPods !== 1 || observation.readyPods !== 1) return "kubernetes_writer_unobserved";
  if (observation.observedAt > now || now - observation.observedAt > GATEWAY_UNREACHABLE_AFTER_MS) return "kubernetes_observation_stale";
  const [observed, ...otherPods] = observation.pods ?? [];
  return otherPods.length === 0 && observed?.uid === pod.podUid && observed.name === pod.podName ? null : "kubernetes_writer_mismatch";
}

function schedulesBelongTo(slug: string, snapshot: NativeScheduleCheckpoint): boolean {
  const owns = (id: string) => {
    const agent = parseAgentId(id);
    return agent.kind !== "unknown" && agent.username === slug;
  };
  const agentIds = new Set(snapshot.agentIds);
  return snapshot.agentIds.every(owns) && snapshot.jobs.every(job => agentIds.has(job.agentId));
}

interface GatewayCheckpointScope {
  store: PlatformStateStore;
  gatewayId: string;
  uid: string;
  assignmentEpoch: number;
  pod: EphemeralGatewayWriter;
  now: number;
  observedAt: number;
}

interface CheckpointRequest extends GatewayCheckpointScope {
  snapshot: NativeScheduleCheckpoint;
}

function ownsAssignment(user: PlatformUserRecord, assignment: GatewayAssignment, input: GatewayCheckpointScope): boolean {
  return !!user.slug && user.gateway?.gatewayId === input.gatewayId &&
    assignment.slug === user.slug && assignment.epoch === input.assignmentEpoch;
}

function activeFences(user: PlatformUserRecord): string[] {
  const { pendingNativeSchedulerRetirement: retirement, ...fences } = user.fences;
  const dormant = retirement === undefined || typeof retirement.completedAt === "number";
  return [...Object.keys(fences), ...(dormant ? [] : ["pendingNativeSchedulerRetirement"])];
}

type CheckpointOwner = { user: Stored<PlatformUserRecord>; assignment: GatewayAssignment };

async function checkpointOwner(
  tx: PlatformStateTransaction, input: GatewayCheckpointScope,
): Promise<CheckpointOwner | GatewayCheckpointRefusal> {
  const { gatewayId, uid } = input;
  const [root, runtime, user, assignment] = await Promise.all([
    tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
    tx.users.records.get(uid), tx.gateways.assignments.get(gatewayId, uid),
  ]);
  if (!root) return "gateway_missing";
  if (!user) return "user_missing";
  if (!assignment) return "assignment_missing";
  const refusal = scheduleWriterRefusal(root, runtime, input.pod, input.now) ??
    (ownsAssignment(user, assignment, input) ? null : "assignment_not_owned");
  return refusal ?? { user, assignment };
}

function staleReport({ observedAt, now }: GatewayCheckpointScope): boolean {
  return !Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > MAX_CHECKPOINT_AGE_MS;
}

function alreadyCaptured(
  last: { gatewayId: string; assignmentEpoch: number; observedAt: number } | undefined,
  input: GatewayCheckpointScope,
): boolean {
  return last?.gatewayId === input.gatewayId && last.assignmentEpoch === input.assignmentEpoch &&
    last.observedAt >= input.observedAt;
}

export async function recordGatewayScheduleCheckpoint(input: CheckpointRequest): Promise<GatewayCheckpointResult> {
  const { store, gatewayId, uid, assignmentEpoch, observedAt, snapshot } = input;
  if (staleReport(input)) return "report_stale";
  return store.transaction({ label: "gateway-schedule-checkpoint.record" }, async (tx): Promise<GatewayCheckpointResult> => {
    const owner = await checkpointOwner(tx, input);
    if (typeof owner === "string") return owner;
    const { user, assignment } = owner;
    if (assignment.state !== "serving") return "assignment_not_serving";
    if (activeFences(user).length) return "user_fenced";
    if (!schedulesBelongTo(assignment.slug, snapshot)) return "foreign_schedules";
    if (alreadyCaptured(user.scheduleCheckpoint, input)) return "accepted";
    await tx.users.records.patch(uid, {
      scheduleCheckpoint: { gatewayId, assignmentEpoch, observedAt, snapshot },
    }, { revision: user.revision, gatewayId });
    return "accepted";
  });
}


export function parseWorkspaceCheckpoint(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value) || typeof value.workspace !== "string") return null;
  const entries = Object.entries(value);
  if (!entries.length || !entries.every(([repo, commit]) =>
    /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(repo) && typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit)
  )) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

export async function recordGatewayWorkspaceCheckpoint(
  input: GatewayCheckpointScope & { commits: Readonly<Record<string, string>> },
): Promise<GatewayCheckpointResult> {
  const { store, gatewayId, uid, assignmentEpoch, observedAt, commits } = input;
  if (staleReport(input)) return "report_stale";
  return store.transaction({ label: "gateway-workspace-checkpoint.record" }, async (tx): Promise<GatewayCheckpointResult> => {
    const owner = await checkpointOwner(tx, input);
    if (typeof owner === "string") return owner;
    const { user, assignment } = owner;
    if (assignment.state !== "serving" && assignment.state !== "quiescing") return "assignment_not_serving";
    if (activeFences(user).some(fence => fence !== "migration")) return "user_fenced";
    if (alreadyCaptured(user.workspaceCheckpoint, input)) return "accepted";
    await tx.users.records.patch(uid, {
      workspaceCheckpoint: { gatewayId, assignmentEpoch, observedAt, commits },
    }, { revision: user.revision, gatewayId });
    return "accepted";
  });
}
