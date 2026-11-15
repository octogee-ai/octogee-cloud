import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import {
  hasFreshReadyKubernetesObservation,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
  releasePayloadHash,
  type GatewayKubernetesObservation,
  type GatewayRuntimeDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import type { SharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
import { gatewayArtifactFromReleasePayload } from "./gateway-live-release.js";
import { readSharedGatewayPoolConfigInStore } from "./shared-gateway-pool-read.js";
import {
  FleetMutationIdempotencyError,
  runNormalFleetMutation,
} from "./normal-fleet-mutation.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayAssignment, GatewayRelease, GatewayRoot } from "./platform-state/gateways.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";

const ACTOR = "glm-controller-placement-policy";

export interface SupersedeRollingSharedGatewayRollInput {
  sourceGatewayId: string;
  targetGatewayId: string;
  expectedLiveRelease: number;
  expectedDesiredRelease: number;
  targetHeartbeatMaxAgeMs?: number;
}

export type SupersedeRollingSharedGatewayRollResult =
  | { kind: "scheduled"; release: number; operationId: string }
  | { kind: "already-scheduled"; release: number; operationId: string }
  | { kind: "not-eligible"; reason: string };

export interface SharedGatewayRollRecoveryDeps {
  store: PlatformStateStore;
  now: () => number;
}

export function sharedRollRecoveryOperationId(input: SupersedeRollingSharedGatewayRollInput): string {
  return `recover-shared-roll-${input.sourceGatewayId}-to-${input.targetGatewayId}-r${input.expectedDesiredRelease}-to-r${input.expectedLiveRelease}`;
}

function recoveryIdempotencyKey(input: SupersedeRollingSharedGatewayRollInput): string {
  return [
    "shared-peer-roll-recovery",
    input.sourceGatewayId,
    input.targetGatewayId,
    input.expectedDesiredRelease,
    input.expectedLiveRelease,
  ].join(":");
}

function isPositiveRelease(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function gatewayRootOf(root: Stored<GatewayRoot> | undefined, gatewayId: string) {
  return projectGatewayDesiredRootForGateway(root, gatewayId);
}

function gatewayRuntimeOf(record: Stored<FleetRegistryRecord> | undefined): GatewayRuntimeDoc | null {
  return record === undefined ? null : { ...record, docKind: "runtime" };
}

function runtimeIsServingLiveRelease(
  runtime: GatewayRuntimeDoc | null,
  input: SupersedeRollingSharedGatewayRollInput,
  now: number,
): boolean {
  if (!runtime) return false;
  return [
    runtime.gatewayId === input.targetGatewayId,
    runtime.release === input.expectedLiveRelease,
    runtime.lifecycle === "serving",
    runtime.heartbeat.status === "ready",
    hasFreshReadyKubernetesObservation(
      runtime,
      now,
      input.targetHeartbeatMaxAgeMs ?? GATEWAY_UNREACHABLE_AFTER_MS,
    ),
  ].every(Boolean);
}

function sourceHasFreshMissingKubernetesObservation(
  runtime: GatewayRuntimeDoc | null,
  input: SupersedeRollingSharedGatewayRollInput,
  now: number,
): boolean {
  const observedAt = runtime?.kubernetes?.observedAt;
  const maxAge = input.targetHeartbeatMaxAgeMs ?? GATEWAY_UNREACHABLE_AFTER_MS;
  return runtime?.gatewayId === input.sourceGatewayId &&
    runtime.kubernetes?.status === "missing" &&
    typeof observedAt === "number" &&
    now >= observedAt &&
    now - observedAt <= maxAge;
}

function targetRosterIsServing(
  assignments: readonly GatewayAssignment[],
  runtime: GatewayRuntimeDoc | null,
): boolean {
  const mounted = new Set(runtime?.heartbeat.mountedCustomers ?? []);
  return assignments.every((assignment) =>
    assignment.state === "serving" &&
    typeof assignment.slug === "string" &&
    mounted.has(assignment.slug));
}

function activeMigrationTargetsGateway(
  operations: readonly OperationRecord[],
  gatewayId: string,
): boolean {
  return operations.some((operation) => {
    if (operation.kind !== "migrate-user") return false;
    const input: unknown = operation.input;
    const migration: unknown = operation.userMigrationV2;
    const fields = [
      input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null,
      migration && typeof migration === "object" && !Array.isArray(migration)
        ? migration as Record<string, unknown>
        : null,
    ];
    return fields.some((field) =>
      field?.fromGatewayId === gatewayId ||
      field?.toGatewayId === gatewayId ||
      field?.sourceGatewayId === gatewayId ||
      field?.targetGatewayId === gatewayId,
    );
  });
}

function matchingRecoveryOperation(
  value: OperationRecord,
  input: SupersedeRollingSharedGatewayRollInput,
  release: number,
): boolean {
  const operationInput: unknown = value.input;
  if (!operationInput || typeof operationInput !== "object" || Array.isArray(operationInput)) {
    return false;
  }
  const record = operationInput as Record<string, unknown>;
  const recovery = record.sharedPeerRollRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const detail = recovery as Record<string, unknown>;
  return [
    value.kind === "rollout",
    record.gatewayId === input.targetGatewayId,
    record.targetRelease === release,
    detail.sourceGatewayId === input.sourceGatewayId,
    detail.targetGatewayId === input.targetGatewayId,
    detail.supersededRelease === input.expectedDesiredRelease,
    detail.sourceRelease === input.expectedLiveRelease,
  ].every(Boolean);
}

interface RecoveryRollState {
  target: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  source: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  pool: SharedGatewayPoolConfig | null;
  runtime: GatewayRuntimeDoc | null;
  sourceRuntime: GatewayRuntimeDoc | null;
  assignments: readonly GatewayAssignment[];
  operations: readonly OperationRecord[];
  now: number;
}

function recoveryRollBlocker(
  state: RecoveryRollState,
  input: SupersedeRollingSharedGatewayRollInput,
): string | null {
  const { target, source, pool } = state;
  if (!pool) return "the shared gateway pool is not configured";
  if (!source) return `source ${input.sourceGatewayId} has no readable root`;
  if (!target) return `target ${input.targetGatewayId} has no readable root`;
  const checks: Array<[string, boolean]> = [
    [`source ${input.sourceGatewayId} is not in the shared gateway pool`, pool.sharedGatewayIds.includes(input.sourceGatewayId)],
    [`target ${input.targetGatewayId} is not in the shared gateway pool`, pool.sharedGatewayIds.includes(input.targetGatewayId)],
    [`source ${input.sourceGatewayId} is not a shared gateway`, source.gatewayClass === "shared"],
    [`target ${input.targetGatewayId} is not a shared gateway`, target.gatewayClass === "shared"],
    [`source ${input.sourceGatewayId} is not running`, source.desiredStatus === "running"],
    [`target ${input.targetGatewayId} is not running`, target.desiredStatus === "running"],
    [`target live release is ${target.liveRelease}, expected ${input.expectedLiveRelease}`, target.liveRelease === input.expectedLiveRelease],
    [`target desired release is ${target.desiredRelease}, expected ${input.expectedDesiredRelease}`, target.desiredRelease === input.expectedDesiredRelease],
    [`target latest release is ${target.latestRelease}, expected ${input.expectedDesiredRelease}`, target.latestRelease === input.expectedDesiredRelease],
    [`target ${input.targetGatewayId} is not serving its live release`, runtimeIsServingLiveRelease(state.runtime, input, state.now)],
    [`source ${input.sourceGatewayId} has no fresh missing Kubernetes observation`, sourceHasFreshMissingKubernetesObservation(state.sourceRuntime, input, state.now)],
    [`target ${input.targetGatewayId} has an assignment it does not serve`, targetRosterIsServing(state.assignments, state.runtime)],
    [`an active migration involves ${input.targetGatewayId}`, !activeMigrationTargetsGateway(state.operations, input.targetGatewayId)],
  ];
  return checks.find(([, holds]) => !holds)?.[0] ?? null;
}

function validReleasePayload(release: GatewayRelease | null): ReleasePayload | null {
  const payload = release?.payload;
  if (!payload || !isReleasePayload(payload)) return null;
  return release.payloadHash === releasePayloadHash(payload) ? payload : null;
}

function recoveryRolloutOperation(
  input: SupersedeRollingSharedGatewayRollInput,
  operationId: string,
  release: number,
  payload: ReleasePayload,
  now: number,
): OperationRecord {
  const artifact = gatewayArtifactFromReleasePayload(payload);
  return {
    id: operationId,
    kind: "rollout",
    status: "pending",
    origin: "automatic",
    createdBy: ACTOR,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    input: {
      gatewayId: input.targetGatewayId,
      targetRelease: release,
      imageTag: artifact.imageTag,
      imageRepository: artifact.imageRepository,
      sharedPeerRollRecovery: {
        sourceGatewayId: input.sourceGatewayId,
        targetGatewayId: input.targetGatewayId,
        supersededRelease: input.expectedDesiredRelease,
        sourceRelease: input.expectedLiveRelease,
      },
    },
    steps: [],
    gatewayId: input.targetGatewayId,
  };
}

async function appendRecoveryRollback(
  deps: SharedGatewayRollRecoveryDeps,
  input: SupersedeRollingSharedGatewayRollInput,
): Promise<SupersedeRollingSharedGatewayRollResult> {
  return deps.store.transaction({ label: "shared-gateway-roll-recovery.append" }, (transaction) =>
    appendSharedRollRecoveryInTransaction(transaction, input, { now: deps.now() }));
}

function withObservedKubernetes(
  runtime: GatewayRuntimeDoc | null,
  observation: GatewayKubernetesObservation | undefined,
): GatewayRuntimeDoc | null {
  if (runtime === null || observation === undefined) return runtime;
  return { ...runtime, kubernetes: observation };
}

export async function appendSharedRollRecoveryInTransaction(
  transaction: PlatformStateTransaction,
  input: SupersedeRollingSharedGatewayRollInput,
  options: { now: number; sourceKubernetes?: GatewayKubernetesObservation },
): Promise<SupersedeRollingSharedGatewayRollResult> {
  const operationId = sharedRollRecoveryOperationId(input);
  const gatewayIds = [input.targetGatewayId, input.sourceGatewayId];
  const [roots, runtimes, pool, operation, assignments, operations] = await Promise.all([
    transaction.gateways.roots.getMany(gatewayIds),
    transaction.fleetRegistry.getMany(gatewayIds),
    readSharedGatewayPoolConfigInStore(transaction),
    transaction.journal.operations.get(operationId),
    transaction.gateways.assignments.list(input.targetGatewayId),
    transaction.journal.operations.listByStatus(["pending", "running"]),
  ]);
  const state: RecoveryRollState = {
    target: gatewayRootOf(roots.get(input.targetGatewayId), input.targetGatewayId),
    source: gatewayRootOf(roots.get(input.sourceGatewayId), input.sourceGatewayId),
    pool,
    runtime: gatewayRuntimeOf(runtimes.get(input.targetGatewayId)),
    sourceRuntime: withObservedKubernetes(gatewayRuntimeOf(runtimes.get(input.sourceGatewayId)), options.sourceKubernetes),
    assignments,
    operations,
    now: options.now,
  };
  const scheduledRelease = input.expectedDesiredRelease + 1;
  if (operation !== null && matchingRecoveryOperation(operation, input, scheduledRelease)) {
    return { kind: "already-scheduled", release: scheduledRelease, operationId };
  }
  const blocker = recoveryRollBlocker(state, input);
  if (!state.target || blocker !== null) {
    return { kind: "not-eligible", reason: blocker ?? `target ${input.targetGatewayId} has no readable root` };
  }
  const release = state.target.latestRelease + 1;
  if (!isPositiveRelease(release)) {
    throw new Error(`shared peer recovery release is invalid for ${input.targetGatewayId}`);
  }
  if (operation !== null) {
    return matchingRecoveryOperation(operation, input, release)
      ? { kind: "already-scheduled", release, operationId }
      : { kind: "not-eligible", reason: `operation ${operationId} exists for another recovery` };
  }
  const [sourceRelease, replacementRelease] = await Promise.all([
    transaction.gateways.releases.get(input.targetGatewayId, input.expectedLiveRelease),
    transaction.gateways.releases.get(input.targetGatewayId, release),
  ]);
  if (replacementRelease !== null) {
    throw new Error(
      `shared peer recovery release ${input.targetGatewayId}/r${release} already exists`,
    );
  }
  const payload = validReleasePayload(sourceRelease);
  if (!payload) {
    throw new Error(
      `shared peer recovery source release ${input.targetGatewayId}/r${input.expectedLiveRelease} is invalid`,
    );
  }
  await transaction.gateways.releases.append({
    gatewayId: input.targetGatewayId,
    expectedLatestRelease: state.target.latestRelease,
    createdAt: state.now,
    createdBy: ACTOR,
    sourceRelease: input.expectedLiveRelease,
    note: `shared peer recovery from ${input.sourceGatewayId}`,
    payload,
    payloadHash: releasePayloadHash(payload),
    activate: false,
    updatedBy: ACTOR,
  });
  await transaction.journal.operations.create(
    recoveryRolloutOperation(input, operationId, release, payload, state.now),
  );
  return { kind: "scheduled", release, operationId };
}

export async function supersedeRollingSharedGatewayRoll(
  deps: SharedGatewayRollRecoveryDeps,
  input: SupersedeRollingSharedGatewayRollInput,
): Promise<SupersedeRollingSharedGatewayRollResult> {
  try {
    return await runNormalFleetMutation(deps.store, {
      actor: ACTOR,
      forced: false,
      what: "supersede rolling shared gateway",
      why: "shared gateway recovery",
      target: { gatewayId: input.targetGatewayId },
      preActionStatus: {
        sourceGatewayId: input.sourceGatewayId,
        expectedLiveRelease: input.expectedLiveRelease,
        expectedDesiredRelease: input.expectedDesiredRelease,
      },
      mutation: {
        kind: "supersede-rolling-shared-gateway",
        sourceGatewayId: input.sourceGatewayId,
        targetGatewayId: input.targetGatewayId,
        expectedLiveRelease: input.expectedLiveRelease,
        expectedDesiredRelease: input.expectedDesiredRelease,
      },
      idempotencyKey: recoveryIdempotencyKey(input),
      now: deps.now,
      action: () => appendRecoveryRollback(deps, input),
      classifyResult: (result) => result.kind === "scheduled"
        ? {
            outcome: "completed",
            releaseRollout: {
              releaseId: `${input.targetGatewayId}/${result.release}`,
              rolloutOperationId: result.operationId,
            },
          }
        : {
            outcome: "partial",
            partialOutcome: {
              summary: "shared peer recovery no longer eligible",
              details: { targetGatewayId: input.targetGatewayId },
            },
          },
    });
  } catch (error) {
    if (!(error instanceof FleetMutationIdempotencyError)) throw error;
    const audit = await deps.store.journal.audits.get(error.auditId);
    const linkage = audit?.releaseRollout;
    if (
      audit?.status === "completed" &&
      linkage &&
      typeof linkage === "object" &&
      typeof (linkage as Record<string, unknown>).rolloutOperationId === "string" &&
      typeof (linkage as Record<string, unknown>).releaseId === "string"
    ) {
      const releaseId = (linkage as Record<string, unknown>).releaseId as string;
      const release = Number(releaseId.split("/").at(-1));
      if (Number.isSafeInteger(release) && release >= 1) {
        return {
          kind: "already-scheduled",
          release,
          operationId: (linkage as Record<string, unknown>).rolloutOperationId as string,
        };
      }
    }
    throw error;
  }
}
