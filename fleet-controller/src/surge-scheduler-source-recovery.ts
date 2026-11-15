import { createHash } from "node:crypto";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { isValidUsername } from "@octogee/shared/types/identity";
import type { SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import { surgeSchedulerOperationId } from "./surge-scheduler-handoff.js";
import { isSurgeSchedulerAlreadyResumed } from "./surge-scheduler-receipt.js";
import type { SurgeAssignment, SurgeUserHandoffDeps, SurgePod, SurgePodHealth, SurgePodSnapshot } from "./surge-user-handoff.js";

export interface SurgeSchedulerSourceRecoveryInput {
  gatewayId: string;
  assignment: SurgeAssignment;
  sourcePod: SurgePod;
  standbyTarget?: SurgePod;
}

export interface SurgeSchedulerSourceRecoveryProof extends SurgeSchedulerSourceRecoveryInput {
  operationId: string;
  phase: "resume" | "activate";
  agentIds: string[];
  observationFingerprint: string;
}

type RecoveryDeps = Pick<SurgeUserHandoffDeps, "readAssignments" | "listPods" | "readPodHealth" | "scheduler">;
const POD_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function formerTargetUid({ gatewayId, assignment }: SurgeSchedulerSourceRecoveryInput): string {
  const prefix = `surge-${gatewayId}-`;
  const owner = assignment.updatedByOperationId;
  if (!gatewayId || typeof owner !== "string" || !owner.startsWith(prefix) || !POD_UID.test(owner.slice(prefix.length))) {
    throw new Error("scheduler recovery owner is not an exact same-gateway surge");
  }
  return owner.slice(prefix.length);
}

function projectAssignments(rows: SurgeAssignment[]): SurgeAssignment[] {
  if (rows.length === 0 || new Set(rows.map(row => row.uid)).size !== rows.length || new Set(rows.map(row => row.slug)).size !== rows.length) {
    throw new Error("scheduler recovery assignment roster is ambiguous");
  }
  return rows.map(({ uid, slug, epoch, state, updatedByOperationId, updatedAt }) => ({ uid, slug, epoch, state, updatedByOperationId, updatedAt }))
    .sort((left, right) => left.uid.localeCompare(right.uid));
}

function assertAssignment(input: SurgeSchedulerSourceRecoveryInput, rows: SurgeAssignment[]): void {
  const expected = input.assignment;
  const current = rows.find(row => row.uid === expected.uid);
  if (!expected.uid || !isValidUsername(expected.slug) || expected.state !== "quiescing" || !Number.isSafeInteger(expected.epoch) || expected.epoch < 0 ||
      !current || current.slug !== expected.slug || current.epoch !== expected.epoch || current.state !== expected.state ||
      current.updatedByOperationId !== expected.updatedByOperationId || current.updatedAt !== expected.updatedAt) {
    throw new Error("scheduler recovery assignment custody changed");
  }
}

function matchingPod(current: SurgePod | undefined, expected: SurgePod, ready: boolean): SurgePod {
  if (!current || current.uid !== expected.uid || current.name !== expected.name || current.podIP !== expected.podIP || current.image !== expected.image ||
      current.ready !== ready || current.terminating || current.crashLooping) {
    throw new Error("scheduler recovery physical custody changed");
  }
  return { ...current };
}

function recoveryPods(input: SurgeSchedulerSourceRecoveryInput, snapshot: SurgePodSnapshot): { source: SurgePod; standby?: SurgePod } {
  const expected = input.standbyTarget ? [input.sourcePod, input.standbyTarget] : [input.sourcePod];
  const count = expected.length;
  if (snapshot.pods.length !== count || snapshot.observedPodUids.length !== count || new Set(snapshot.observedPodUids).size !== count ||
      new Set(expected.map(pod => pod.uid)).size !== count || expected.some(pod => !snapshot.observedPodUids.includes(pod.uid))) {
    throw new Error("scheduler recovery physical custody projection changed");
  }
  const source = matchingPod(snapshot.pods.find(pod => pod.uid === input.sourcePod.uid), input.sourcePod, true);
  if (!input.standbyTarget) return { source };
  if (input.standbyTarget.uid === formerTargetUid(input)) throw new Error("scheduler recovery former target is still present");
  const standby = matchingPod(snapshot.pods.find(pod => pod.uid === input.standbyTarget!.uid), input.standbyTarget, false);
  return { source, standby };
}

function readyHealth(rows: SurgeAssignment[], health: SurgePodHealth | null): SurgePodHealth {
  if (!health || health.status !== "ready" || !health.version || health.fleetSignatureCapability !== "gateway-scoped" || !health.handoffReleased ||
      health.terminalTarget !== undefined || (health.migratingIn?.length ?? 0) !== 0 || !["none", "serving"].includes(health.prelaunchState)) {
    throw new Error("scheduler recovery source is not ready");
  }
  const expected = rows.map(row => row.slug).sort();
  const mounted = [...health.mountedCustomers].sort();
  if (JSON.stringify(mounted) !== JSON.stringify(expected)) throw new Error("scheduler recovery mounted roster changed");
  return { ...health, mountedCustomers: mounted, ...(health.migratingIn ? { migratingIn: [...health.migratingIn].sort() } : {}) };
}

function readyStandby(health: SurgePodHealth | null): SurgePodHealth {
  if (!health || health.status !== "ready" || !health.version || health.fleetSignatureCapability !== "gateway-scoped" || health.handoffReleased !== false ||
      health.prelaunchState !== "none" || health.mountedCustomers.length !== 0 || (health.migratingIn?.length ?? 0) !== 0 || health.terminalTarget !== undefined) {
    throw new Error("scheduler recovery standby is not an empty unreleased Native candidate");
  }
  return { ...health };
}

async function observeRecovery(deps: RecoveryDeps, input: SurgeSchedulerSourceRecoveryInput): Promise<string> {
  const rows = projectAssignments(await deps.readAssignments(input.gatewayId));
  assertAssignment(input, rows);
  const physical = recoveryPods(input, await deps.listPods(input.gatewayId));
  const health = {
    source: readyHealth(rows, await deps.readPodHealth(physical.source, input.gatewayId)),
    ...(physical.standby ? { standby: readyStandby(await deps.readPodHealth(physical.standby, input.gatewayId)) } : {}),
  };
  const currentRows = projectAssignments(await deps.readAssignments(input.gatewayId));
  assertAssignment(input, currentRows);
  const currentPhysical = recoveryPods(input, await deps.listPods(input.gatewayId));
  if (JSON.stringify(rows) !== JSON.stringify(currentRows) || JSON.stringify(physical) !== JSON.stringify(currentPhysical)) {
    throw new Error("scheduler recovery observation custody changed");
  }
  return createHash("sha256").update(JSON.stringify({ assignments: currentRows, physical: currentPhysical, health })).digest("hex");
}

function acknowledgementScope(result: SchedulerMigrationResult, operationId: string, phase: string, slug: string): string[] {
  if (!result || result.operationId !== operationId || result.phase !== phase || result.drained !== true || !Array.isArray(result.agentIds)) {
    throw new Error(`scheduler recovery ${phase} acknowledgement invalid`);
  }
  const ids = result.agentIds;
  if (!ids.length || new Set(ids).size !== ids.length || !ids.includes(`octogee-${slug}-coach`) || ids.some(id => typeof id !== "string" || !agentIdBelongsToSlug(id, slug))) {
    throw new Error(`scheduler recovery ${phase} scope invalid`);
  }
  return [...ids].sort();
}

function assertExportSnapshot(result: SchedulerMigrationResult, operationId: string, agentIds: string[]): void {
  const snapshot = result.snapshot as { version?: unknown; operationId?: unknown; agentIds?: unknown; jobs?: unknown; scratch?: unknown } | null | undefined;
  if (!snapshot || snapshot.version !== 1 || snapshot.operationId !== operationId || !Array.isArray(snapshot.agentIds) ||
      JSON.stringify([...snapshot.agentIds].sort()) !== JSON.stringify(agentIds) || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.scratch)) {
    throw new Error("scheduler recovery export snapshot invalid");
  }
}

export async function recoverAbandonedSurgeSchedulerSource(
  deps: RecoveryDeps,
  input: SurgeSchedulerSourceRecoveryInput,
): Promise<SurgeSchedulerSourceRecoveryProof> {
  const captured = structuredClone(input);
  const targetUid = formerTargetUid(captured);
  const operationId = surgeSchedulerOperationId({ gatewayId: captured.gatewayId, assignment: captured.assignment, target: { uid: targetUid } });
  const scheduler = deps.scheduler;
  if (!scheduler) throw new Error("Shared surge scheduler transport unavailable");
  const observationFingerprint = await observeRecovery(deps, captured);
  const assertCurrent = async (): Promise<void> => {
    if (await observeRecovery(deps, captured) !== observationFingerprint) throw new Error("scheduler recovery observation custody changed");
  };
  const call = async (phase: "export" | "resume" | "activate"): Promise<SchedulerMigrationResult> => {
    await assertCurrent();
    let result: SchedulerMigrationResult;
    try {
      result = await scheduler({ gatewayId: captured.gatewayId, slug: captured.assignment.slug, pod: captured.sourcePod, operationId, phase });
    } catch (error) {
      try { await assertCurrent(); } catch (custodyError) {
        throw new AggregateError([error, custodyError], "scheduler recovery failed and observation custody changed");
      }
      throw error;
    }
    await assertCurrent();
    return result;
  };
  let exportedScope: string[] | undefined;
  if (targetUid !== captured.sourcePod.uid) {
    let exported: SchedulerMigrationResult | undefined;
    try { exported = await call("export"); } catch (error) {
      if (!isSurgeSchedulerAlreadyResumed(error)) throw error;
    }
    if (exported) {
      exportedScope = acknowledgementScope(exported, operationId, "export", captured.assignment.slug);
      assertExportSnapshot(exported, operationId, exportedScope);
    }
  }
  const phase = targetUid === captured.sourcePod.uid ? "activate" : "resume";
  const result = await call(phase);
  const agentIds = acknowledgementScope(result, operationId, phase, captured.assignment.slug);
  if (exportedScope && JSON.stringify(exportedScope) !== JSON.stringify(agentIds)) throw new Error("scheduler recovery resume scope changed");
  return { ...captured, operationId, phase, agentIds, observationFingerprint };
}
