import { parseAgentId } from "@octogee/shared/types/identity";
import type { NativeScheduleCheckpoint } from "@octogee/shared/types/fleet-controller";
import { gatewayVmPodName } from "@octogee/shared/types/glm";
import { sameEphemeralWriter } from "./isolated-gateway-lifecycle/ephemeral-recovery-state.js";
import type { EphemeralGatewayWriter, FleetRegistryRecord, GatewayAssignment, GatewayRoot, PlatformStateStore, PlatformUserRecord } from "./platform-state/index.js";

const MAX_OBSERVATION_AGE_MS = 120_000;
const MAX_CHECKPOINT_AGE_MS = 60_000;

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

function servingScheduleWriter(root: GatewayRoot, runtime: FleetRegistryRecord | null, pod: EphemeralGatewayWriter, now: number): boolean {
  if (!allowsUserCheckpoint(root)) return false;
  if (root.allocation?.ephemeralHomeGiB !== undefined) {
    return !root.ephemeralWriter?.exclusion && sameEphemeralWriter(root.ephemeralWriter, pod);
  }
  if (runtime?.runtime === "gce-vm") {
    return runtime.vm?.status === "RUNNING" && runtime.vm.instanceId === pod.podUid &&
      gatewayVmPodName(root.gatewayId, pod.podUid) === pod.podName;
  }
  return isSoleObservedClusterWriter(runtime?.kubernetes, pod, now);
}

function isSoleObservedClusterWriter(
  observation: FleetRegistryRecord["kubernetes"],
  pod: EphemeralGatewayWriter,
  now: number,
): boolean {
  if (observation?.status !== "ready" || observation.totalPods !== 1 || observation.readyPods !== 1) return false;
  if (observation.observedAt > now || now - observation.observedAt > MAX_OBSERVATION_AGE_MS) return false;
  const [observed, ...otherPods] = observation.pods ?? [];
  return otherPods.length === 0 && observed?.uid === pod.podUid && observed.name === pod.podName;
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

function canPublishWorkspace(user: PlatformUserRecord, assignment: GatewayAssignment): boolean {
  return (assignment.state === "serving" || assignment.state === "quiescing") &&
    Object.keys(user.fences).every(fence => fence === "migration");
}

function alreadyCaptured(
  last: { gatewayId: string; assignmentEpoch: number; observedAt: number } | undefined,
  input: GatewayCheckpointScope,
): boolean {
  return last?.gatewayId === input.gatewayId && last.assignmentEpoch === input.assignmentEpoch &&
    last.observedAt >= input.observedAt;
}

export async function recordGatewayScheduleCheckpoint(input: CheckpointRequest): Promise<boolean> {
  const { store, gatewayId, uid, assignmentEpoch, pod, now, observedAt, snapshot } = input;
  if (!Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > MAX_CHECKPOINT_AGE_MS) return false;
  return store.transaction({ label: "gateway-schedule-checkpoint.record" }, async tx => {
    const [root, runtime, user, assignment] = await Promise.all([
      tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
      tx.users.records.get(uid), tx.gateways.assignments.get(gatewayId, uid),
    ]);
    if (!root || !user || !assignment || !servingScheduleWriter(root, runtime, pod, now)) return false;
    if (!ownsAssignment(user, assignment, input) || assignment.state !== "serving" ||
        Object.keys(user.fences).length || !schedulesBelongTo(assignment.slug, snapshot)) return false;
    if (alreadyCaptured(user.scheduleCheckpoint, input)) return true;
    await tx.users.records.patch(uid, {
      scheduleCheckpoint: {
        gatewayId, assignmentEpoch, observedAt,
        snapshot,
      },
    }, { revision: user.revision, gatewayId });
    return true;
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
): Promise<boolean> {
  const { store, gatewayId, uid, assignmentEpoch, pod, now, observedAt, commits } = input;
  if (!Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > MAX_CHECKPOINT_AGE_MS) return false;
  return store.transaction({ label: "gateway-workspace-checkpoint.record" }, async tx => {
    const [root, runtime, user, assignment] = await Promise.all([
      tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
      tx.users.records.get(uid), tx.gateways.assignments.get(gatewayId, uid),
    ]);
    if (!root || !user || !assignment || !servingScheduleWriter(root, runtime, pod, now) || !ownsAssignment(user, assignment, input)) return false;
    if (!canPublishWorkspace(user, assignment)) return false;
    if (alreadyCaptured(user.workspaceCheckpoint, input)) return true;
    await tx.users.records.patch(uid, {
      workspaceCheckpoint: { gatewayId, assignmentEpoch, observedAt, commits },
    }, { revision: user.revision, gatewayId });
    return true;
  });
}
