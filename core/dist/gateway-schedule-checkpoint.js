import { isDeepStrictEqual } from "node:util";
import { parseAgentId } from "@octogee/shared/types/identity";
import { gatewayVmPodName } from "@octogee/shared/types/glm";
import { sameEphemeralWriter } from "./isolated-gateway-lifecycle/ephemeral-recovery-state.js";
const MAX_OBSERVATION_AGE_MS = 120_000;
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
function servingScheduleWriter(root, runtime, pod, now) {
    if (root.retirementClaim || root.runtimeRestartFence || root.desiredStatus !== "running")
        return false;
    if (root.allocation?.ephemeralHomeGiB !== undefined)
        return sameEphemeralWriter(root.ephemeralWriter, pod);
    if (runtime?.runtime === "gce-vm") {
        return runtime.vm?.status === "RUNNING" && runtime.vm.instanceId === pod.podUid &&
            gatewayVmPodName(root.gatewayId, pod.podUid) === pod.podName;
    }
    return isSoleObservedClusterWriter(runtime?.kubernetes, pod, now);
}
function isSoleObservedClusterWriter(observation, pod, now) {
    if (observation?.status !== "ready" || observation.totalPods !== 1 || observation.readyPods !== 1)
        return false;
    if (observation.observedAt > now || now - observation.observedAt > MAX_OBSERVATION_AGE_MS)
        return false;
    const [observed, ...otherPods] = observation.pods ?? [];
    return otherPods.length === 0 && observed?.uid === pod.podUid && observed.name === pod.podName;
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
function canPublishWorkspace(user, assignment) {
    const fences = Object.keys(user.fences);
    return assignment.state === "serving" && fences.length === 0 ||
        assignment.state === "quiescing" && fences.every(fence => fence === "migration");
}
function alreadyCaptured(last, input) {
    if (last?.gatewayId !== input.gatewayId || last.assignmentEpoch !== input.assignmentEpoch)
        return false;
    if (last.observedAt >= input.observedAt)
        return true;
    return input.observedAt - last.observedAt < MAX_CHECKPOINT_AGE_MS &&
        isDeepStrictEqual(last.snapshot, input.snapshot);
}
export async function recordGatewayScheduleCheckpoint(input) {
    const { store, gatewayId, uid, assignmentEpoch, pod, now, observedAt, snapshot } = input;
    if (!Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > MAX_CHECKPOINT_AGE_MS)
        return false;
    return store.transaction({ label: "gateway-schedule-checkpoint.record" }, async (tx) => {
        const [root, runtime, user, assignment] = await Promise.all([
            tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
            tx.users.records.get(uid), tx.gateways.assignments.get(gatewayId, uid),
        ]);
        if (!root || !user || !assignment || !servingScheduleWriter(root, runtime, pod, now))
            return false;
        if (!ownsAssignment(user, assignment, input) || assignment.state !== "serving" ||
            Object.keys(user.fences).length || !schedulesBelongTo(assignment.slug, snapshot))
            return false;
        if (alreadyCaptured(user.scheduleCheckpoint, input))
            return true;
        await tx.users.records.patch(uid, {
            scheduleCheckpoint: {
                gatewayId, assignmentEpoch, observedAt,
                snapshot,
            },
        }, { revision: user.revision, gatewayId });
        return true;
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
    const { store, gatewayId, uid, assignmentEpoch, pod, now, observedAt, commits } = input;
    if (!Number.isSafeInteger(observedAt) || observedAt > now + 5_000 || now - observedAt > MAX_CHECKPOINT_AGE_MS)
        return false;
    return store.transaction({ label: "gateway-workspace-checkpoint.record" }, async (tx) => {
        const [root, runtime, user, assignment] = await Promise.all([
            tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
            tx.users.records.get(uid), tx.gateways.assignments.get(gatewayId, uid),
        ]);
        if (!root || !user || !assignment || !servingScheduleWriter(root, runtime, pod, now) || !ownsAssignment(user, assignment, input))
            return false;
        if (!canPublishWorkspace(user, assignment))
            return false;
        const last = user.workspaceCheckpoint;
        if (last?.gatewayId === gatewayId && last.assignmentEpoch === assignmentEpoch &&
            (last.observedAt >= observedAt || isDeepStrictEqual(last.commits, commits)))
            return true;
        await tx.users.records.patch(uid, {
            workspaceCheckpoint: { gatewayId, assignmentEpoch, observedAt, commits },
        }, { revision: user.revision, gatewayId });
        return true;
    });
}
