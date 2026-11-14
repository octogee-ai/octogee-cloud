import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import type { FleetRegistryRecord, PlatformStateStore } from "@octogee/core/platform-state";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { assertSurgeAssignmentCoverage, type SurgeAssignment, type SurgeLiveRoster } from "./surge-user-handoff.js";

type AssignedUser = { uid: string; slug: string };

function runtimeProvesAbsent(
  runtime: FleetRegistryRecord | null,
  liveRoster: SurgeLiveRoster | undefined,
  gatewayId: string,
  slug: string,
  now: number,
): boolean {
  if (liveRoster) return !liveRoster.mountedCustomers.includes(slug);
  const heartbeat = runtime?.heartbeat;
  const mounted = heartbeat?.mountedCustomers;
  const observedAt = heartbeat?.lastHeartbeatAt;
  return runtime?.gatewayId === gatewayId &&
    heartbeat?.status === "ready" &&
    Array.isArray(mounted) &&
    mounted.every((item) => typeof item === "string") &&
    !mounted.includes(slug) &&
    typeof observedAt === "number" &&
    observedAt <= now &&
    now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

function operationId(gatewayId: string, assignment: SurgeAssignment): string {
  return `surge-prune-orphan-${gatewayId}-${assignment.uid}-${assignment.epoch}`;
}

async function pruneOne(input: {
  store: PlatformStateStore;
  gatewayId: string;
  assignment: SurgeAssignment;
  liveRoster: SurgeLiveRoster | undefined;
  now: number;
}): Promise<boolean | "restore-fenced"> {
  const { store, gatewayId, assignment, liveRoster, now } = input;
  const id = operationId(gatewayId, assignment);
  return store.transaction({ label: "surge-orphan-assignment.prune" }, async (tx) => {
    const [stored, owner, runtime, journal] = await Promise.all([
      tx.gateways.assignments.get(gatewayId, assignment.uid),
      tx.users.records.get(assignment.uid),
      tx.fleetRegistry.get(gatewayId),
      tx.journal.operations.get(id),
    ]);
    if (!stored) return true;
    if (owner && isolatedRuntimeMutationFenced(owner)) return "restore-fenced";
    if (stored.slug !== assignment.slug || stored.epoch !== assignment.epoch) return false;
    if (owner?.gateway?.gatewayId === gatewayId && owner.slug === assignment.slug) return false;
    if (!runtimeProvesAbsent(runtime, liveRoster, gatewayId, assignment.slug, now)) return false;
    if (journal) {
      throw new Error(`orphan assignment repair journal ${id} already exists while assignment remains`);
    }
    await tx.gateways.assignments.delete(gatewayId, assignment.uid, { epoch: stored.epoch, updatedAt: stored.updatedAt });
    await tx.journal.operations.create({
      id,
      kind: "deprovision-user",
      status: "succeeded",
      origin: "automatic",
      createdBy: "surge-handoff-orphan-repair",
      createdAt: now,
      startedAt: now,
      completedAt: now,
      lastProgressAt: now,
      input: {
        uid: assignment.uid,
        slug: assignment.slug,
        gatewayId,
        epoch: assignment.epoch,
        reason: "user-not-authoritative-runtime-unmounted",
      },
      output: { assignmentDeleted: true },
      steps: [],
    });
    return true;
  });
}

export async function pruneSurgeOrphanAssignments(input: {
  store: PlatformStateStore;
  gatewayId: string;
  assignments: readonly SurgeAssignment[];
  users: readonly AssignedUser[];
  liveRoster?: SurgeLiveRoster;
  now: number;
  log: (message: string) => void;
}): Promise<SurgeAssignment[]> {
  const usersByUid = new Map(input.users.map((user) => [user.uid, user.slug]));
  const retained: SurgeAssignment[] = [];
  for (const assignment of input.assignments) {
    if (usersByUid.get(assignment.uid) === assignment.slug) {
      retained.push(assignment);
      continue;
    }
    const removed = await pruneOne({
      store: input.store,
      gatewayId: input.gatewayId,
      assignment,
      liveRoster: input.liveRoster,
      now: input.now,
    });
    if (removed === "restore-fenced") {
      input.log(`[surge-handoff] orphan assignment retained during unresolved restore gateway=${input.gatewayId} uid=${assignment.uid}`);
    }
    if (removed !== true) {
      retained.push(assignment);
      continue;
    }
    input.log(
      `[surge-handoff] pruned orphan assignment gateway=${input.gatewayId} ` +
      `uid=${assignment.uid} slug=${assignment.slug}`,
    );
  }
  return retained;
}

export async function readSurgeAssignments(input: {
  store: PlatformStateStore;
  gatewayId: string;
  liveRoster?: SurgeLiveRoster;
  now: number;
  log: (message: string) => void;
}): Promise<SurgeAssignment[]> {
  const { store, gatewayId } = input;
  const [assignments, userRecords] = await Promise.all([
    store.gateways.assignments.list(gatewayId),
    store.users.records.listByGateway(gatewayId),
  ]);
  const projected = assignments.map((assignment) => ({
    uid: assignment.uid,
    slug: assignment.slug,
    state: assignment.state,
    epoch: assignment.epoch,
    updatedAt: assignment.updatedAt,
    updatedByOperationId: assignment.updatedByOperationId,
    ...(assignment.sharedSurgeForwardRecovery ? { sharedSurgeForwardRecovery: assignment.sharedSurgeForwardRecovery } : {}),
  }));
  const assignedUsers = userRecords.map((userRecord) => {
    if (!userRecord.slug) throw new Error(`assigned user ${userRecord.uid} has no gateway slug`);
    return { uid: userRecord.uid, slug: userRecord.slug };
  });
  const retained = await pruneSurgeOrphanAssignments({
    store,
    gatewayId,
    assignments: projected,
    users: assignedUsers,
    ...(input.liveRoster ? { liveRoster: input.liveRoster } : {}),
    now: input.now,
    log: input.log,
  });
  assertSurgeAssignmentCoverage(retained, assignedUsers);
  return retained;
}
