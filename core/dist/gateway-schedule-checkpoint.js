import { parseAgentId } from "@octogee/shared/types/identity";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { gatewayVmPodName } from "@octogee/shared/types/glm";
import { sameEphemeralWriter } from "./isolated-gateway-lifecycle/ephemeral-recovery-state.js";
const MAX_CHECKPOINT_AGE_MS = 60_000;
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isJob(value) {
    return isRecord(value) && typeof value.id === "string" && typeof value.agentId === "string";
}
function isScratch(value) {
    return isRecord(value) && typeof value.jobId === "string" &&
        (value.content === null || typeof value.content === "string") &&
        Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.updatedAtMs) &&
        (value.sourceSha256 === null || typeof value.sourceSha256 === "string");
}
function isIdList(value) {
    return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0);
}
export function parseScheduleCheckpoint(value) {
    if (!isRecord(value) || value.version !== 1 || typeof value.operationId !== "string")
        return null;
    const { operationId, agentIds, jobs, scratch, retainedJobIds } = value;
    if (!isIdList(agentIds) || !agentIds.length)
        return null;
    if (!Array.isArray(jobs) || !jobs.every(isJob) || !Array.isArray(scratch) || !scratch.every(isScratch))
        return null;
    if (retainedJobIds !== undefined && !isIdList(retainedJobIds))
        return null;
    const ids = new Set(jobs.map(job => job.id));
    if (ids.size !== jobs.length || scratch.some(entry => !ids.has(entry.jobId)))
        return null;
    return { version: 1, operationId, agentIds, jobs, scratch, ...(retainedJobIds ? { retainedJobIds } : {}) };
}
function allowsUserCheckpoint(root) {
    const canServe = root.desiredStatus === "running" || (root.gatewayClass === "shared" && root.desiredStatus === "draining");
    return canServe && !root.retirementClaim && !root.runtimeRestartFence;
}
function scheduleWriterRefusal(root, runtime, pod, now) {
    if (!allowsUserCheckpoint(root))
        return "gateway_not_serving";
    if (root.allocation?.ephemeralHomeGiB !== undefined) {
        return !root.ephemeralWriter?.exclusion && sameEphemeralWriter(root.ephemeralWriter, pod) ? null : "ephemeral_writer_mismatch";
    }
    if (runtime?.runtime === "gce-vm") {
        return runtime.vm?.status === "RUNNING" && runtime.vm.instanceId === pod.podUid &&
            gatewayVmPodName(root.gatewayId, pod.podUid) === pod.podName ? null : "vm_writer_mismatch";
    }
    return soleObservedClusterWriterRefusal(runtime?.kubernetes, pod, now);
}
function soleObservedClusterWriterRefusal(observation, pod, now) {
    if (observation?.status !== "ready" || observation.totalPods !== 1 || observation.readyPods !== 1)
        return "kubernetes_writer_unobserved";
    if (observation.observedAt > now || now - observation.observedAt > GATEWAY_UNREACHABLE_AFTER_MS)
        return "kubernetes_observation_stale";
    const [observed, ...otherPods] = observation.pods ?? [];
    return otherPods.length === 0 && observed?.uid === pod.podUid && observed.name === pod.podName ? null : "kubernetes_writer_mismatch";
}
function schedulesBelongTo(slug, snapshot) {
    const owns = (id) => {
        const agent = parseAgentId(id);
        return agent.kind !== "unknown" && agent.username === slug;
    };
    const agentIds = new Set(snapshot.agentIds);
    return snapshot.agentIds.every(owns) && snapshot.jobs.every(job => agentIds.has(job.agentId));
}
function ownsAssignment(user, assignment, input) {
    return !!user.slug && user.gateway?.gatewayId === input.gatewayId &&
        assignment.slug === user.slug && assignment.epoch === input.assignmentEpoch;
}
function activeFences(user) {
    const { pendingNativeSchedulerRetirement: retirement, ...fences } = user.fences;
    const dormant = retirement === undefined || typeof retirement.completedAt === "number";
    return [...Object.keys(fences), ...(dormant ? [] : ["pendingNativeSchedulerRetirement"])];
}
async function checkpointOwner(tx, input) {
    const { gatewayId, uid } = input;
    const [root, runtime, user, assignment] = await Promise.all([
        tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
        tx.users.records.get(uid), tx.gateways.assignments.get(gatewayId, uid),
    ]);
    if (!root)
        return "gateway_missing";
    if (!user)
        return "user_missing";
    if (!assignment)
        return "assignment_missing";
    const refusal = scheduleWriterRefusal(root, runtime, input.pod, input.now) ??
        (ownsAssignment(user, assignment, input) ? null : "assignment_not_owned");
    return refusal ?? { user, assignment };
}
function staleReport({ observedAt, now }) {
    return !Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > MAX_CHECKPOINT_AGE_MS;
}
function alreadyCaptured(last, input) {
    return last?.gatewayId === input.gatewayId && last.assignmentEpoch === input.assignmentEpoch &&
        last.observedAt >= input.observedAt;
}
export async function recordGatewayScheduleCheckpoint(input) {
    const { store, gatewayId, uid, assignmentEpoch, observedAt, snapshot } = input;
    if (staleReport(input))
        return "report_stale";
    return store.transaction({ label: "gateway-schedule-checkpoint.record" }, async (tx) => {
        const owner = await checkpointOwner(tx, input);
        if (typeof owner === "string")
            return owner;
        const { user, assignment } = owner;
        if (assignment.state !== "serving")
            return "assignment_not_serving";
        if (activeFences(user).length)
            return "user_fenced";
        if (!schedulesBelongTo(assignment.slug, snapshot))
            return "foreign_schedules";
        if (alreadyCaptured(user.scheduleCheckpoint, input))
            return "accepted";
        await tx.users.records.patch(uid, {
            scheduleCheckpoint: { gatewayId, assignmentEpoch, observedAt, snapshot },
        }, { revision: user.revision, gatewayId });
        return "accepted";
    });
}
export function parseWorkspaceCheckpoint(value) {
    if (!isRecord(value) || typeof value.workspace !== "string")
        return null;
    const entries = Object.entries(value);
    if (!entries.length || !entries.every(([repo, commit]) => /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(repo) && typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit)))
        return null;
    return Object.fromEntries(entries);
}
export async function recordGatewayWorkspaceCheckpoint(input) {
    const { store, gatewayId, uid, assignmentEpoch, observedAt, commits } = input;
    if (staleReport(input))
        return "report_stale";
    return store.transaction({ label: "gateway-workspace-checkpoint.record" }, async (tx) => {
        const owner = await checkpointOwner(tx, input);
        if (typeof owner === "string")
            return owner;
        const { user, assignment } = owner;
        if (assignment.state !== "serving" && assignment.state !== "quiescing")
            return "assignment_not_serving";
        if (activeFences(user).some(fence => fence !== "migration"))
            return "user_fenced";
        if (alreadyCaptured(user.workspaceCheckpoint, input))
            return "accepted";
        await tx.users.records.patch(uid, {
            workspaceCheckpoint: { gatewayId, assignmentEpoch, observedAt, commits },
        }, { revision: user.revision, gatewayId });
        return "accepted";
    });
}
