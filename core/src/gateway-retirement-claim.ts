import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAY_UNREACHABLE_AFTER_MS,
} from "@octogee/shared/types/fleet-controller";
import {
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type GatewayDoc,
  type GatewayRetirementClaim as RetirementClaim,
} from "@octogee/shared/types/gateway-releases";
import { findActiveGatewayMigration } from "./fleet-operation-lock.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { NewOperation, OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";

// Retirement under the simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): claim the
// gateway atomically (guarding mounted users + in-flight migrations), flip
// desiredStatus to retired, and let the reconciler tear the realization down.
// Durable config lives in Gitea the whole time — nothing is captured at
// retirement, so there is no wake phase and no config checkpoint ceremony.

export class GatewayRetirementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRetirementConflictError";
  }
}

export class GatewayRetirementTelemetryUnavailableError extends GatewayRetirementConflictError {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRetirementTelemetryUnavailableError";
  }
}

export class GatewayRetirementReleaseUnconvergedError extends GatewayRetirementConflictError {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRetirementReleaseUnconvergedError";
  }
}

type RetirableGateway = GatewayDoc & { desiredStatus: "running" | "draining" | "paused" };

interface ClaimGatewayRetirementInStoreInput {
  store: PlatformStateStore;
  gatewayId: string;
  operationId: string;
  operation: NewOperation;
  now: number;
  updatedBy: string;
  telemetryObservedAfter?: number;
  claimGuard?: (input: {
    transaction: PlatformStateTransaction;
    root: RetirableGateway;
  }) => Promise<void> | void;
  supersededMoves?: { operationIds: readonly string[]; cancelledBecause: string };
}

interface VerifyGatewayRetirementClaimInput {
  store: PlatformStateStore;
  gatewayId: string;
  operationId: string;
  version: number;
  now: number;
  updatedBy: string;
}

export type GatewayRetirementVerification =
  | { ok: true }
  | { ok: false; error: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    try {
      const result = (value as { toMillis: () => unknown }).toMillis();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  }
  return null;
}

function freshObservation(value: unknown, now: number): boolean {
  const observedAt = millis(value);
  return observedAt !== null &&
    observedAt <= now + GATEWAY_HEARTBEAT_INTERVAL_MS &&
    now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

type LiveRuntimeIdentity = RetirementClaim["liveRuntimeIdentity"];

function retirementHeartbeat(
  value: unknown,
): { heartbeat: Record<string, unknown>; mountedCustomers: string[] } | null {
  if (
    !isPlainRecord(value) ||
    !Array.isArray(value.mountedCustomers) ||
    !value.mountedCustomers.every(
      (user) => typeof user === "string" && user.length > 0,
    )
  ) {
    return null;
  }
  return {
    heartbeat: value,
    mountedCustomers: value.mountedCustomers,
  };
}

function liveRuntimeIdentity(heartbeat: Record<string, unknown>): LiveRuntimeIdentity {
  if (
    typeof heartbeat.startedAt !== "number" ||
    !Number.isFinite(heartbeat.startedAt) ||
    !nonEmptyString(heartbeat.version) ||
    !nonEmptyString(heartbeat.openclawVersion)
  ) {
    return null;
  }
  return {
    startedAt: heartbeat.startedAt,
    version: heartbeat.version,
    openclawVersion: heartbeat.openclawVersion,
  };
}

// A RUNNING gateway may retire only on fresh telemetry proving zero mounted
// users. A PAUSED gateway (replicas 0) has no pod, no mounts, and nothing
// unflushed (the watcher + preStop flush committed durable config at pause) —
// it retires directly, with no wake.
function runningRetirementError(
  gatewayId: string,
  runtime: unknown,
  now: number,
  expectedRelease: number,
  telemetryObservedAfter: number | undefined,
): { error: string | null; telemetryUnavailable?: true; liveRuntimeIdentity: LiveRuntimeIdentity } {
  if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== gatewayId) {
    return {
      error: `gateway ${gatewayId} runtime telemetry is unavailable`,
      telemetryUnavailable: true,
      liveRuntimeIdentity: null,
    };
  }
  if (runtime.release !== expectedRelease) {
    return {
      error: `gateway ${gatewayId} runtime release ${runtime.release} does not match live release ${expectedRelease}`,
      liveRuntimeIdentity: null,
    };
  }
  const telemetry = retirementHeartbeat(runtime.heartbeat);
  if (!telemetry) {
    return {
      error: `gateway ${gatewayId} mount telemetry is unavailable`,
      telemetryUnavailable: true,
      liveRuntimeIdentity: null,
    };
  }
  if (telemetry.mountedCustomers.length > 0) {
    return {
      error: `gateway ${gatewayId} still has mounted users: ${telemetry.mountedCustomers.join(", ")}`,
      liveRuntimeIdentity: null,
    };
  }
  const { heartbeat } = telemetry;
  if (!freshObservation(heartbeat.lastHeartbeatAt, now)) {
    return {
      error: `gateway ${gatewayId} telemetry is stale or unavailable`,
      telemetryUnavailable: true,
      liveRuntimeIdentity: null,
    };
  }
  const observedAt = millis(heartbeat.lastHeartbeatAt)!;
  if (
    telemetryObservedAfter !== undefined &&
    observedAt <= telemetryObservedAfter
  ) {
    return {
      error: `gateway ${gatewayId} telemetry predates retirement fence`,
      liveRuntimeIdentity: null,
    };
  }
  return { error: null, liveRuntimeIdentity: liveRuntimeIdentity(heartbeat) };
}

function unconvergedRetirementError(gatewayId: string, runtime: unknown): GatewayRetirementConflictError {
  const mountedCustomers = isGatewayRuntimeDoc(runtime) && runtime.gatewayId === gatewayId
    ? retirementHeartbeat(runtime.heartbeat)?.mountedCustomers ?? []
    : [];
  return mountedCustomers.length > 0
    ? new GatewayRetirementConflictError(
      `gateway ${gatewayId} still has mounted users: ${mountedCustomers.join(", ")}`,
    )
    : new GatewayRetirementReleaseUnconvergedError(
      `gateway ${gatewayId} desired release is not converged to live`,
    );
}

function readClaim(value: unknown): RetirementClaim | null {
  if (!isPlainRecord(value)) return null;
  const valid = [
    typeof value.operationId === "string",
    Number.isInteger(value.version),
    (value.version as number) > 0,
    typeof value.claimedAt === "number",
    Number.isFinite(value.claimedAt),
    value.previousDesiredStatus === "running" || value.previousDesiredStatus === "draining" || value.previousDesiredStatus === "paused",
    value.phase === "claimed",
  ].every(Boolean);
  if (!valid) return null;
  return value as unknown as RetirementClaim;
}

function nextRetirementVersion(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new GatewayRetirementConflictError("gateway retirement version is invalid");
  }
  return (value as number) + 1;
}

function claimableGatewayRetirementRoot(
  gatewayId: string,
  value: unknown,
): {
  rootData: RetirableGateway;
  root: Record<string, unknown>;
} {
  const projected = projectGatewayDesiredRootForGateway(value, gatewayId);
  if (projected === null) {
    throw new GatewayRetirementConflictError(`gateway ${gatewayId} durable root is unavailable`);
  }
  const root = projected as unknown as Record<string, unknown>;
  if (projected.desiredStatus === "retired") {
    throw new GatewayRetirementConflictError(`gateway ${gatewayId} is already retired`);
  }
  if (root.retirementClaim != null) {
    throw new GatewayRetirementConflictError(
      `gateway ${gatewayId} already has a retirement claim`,
    );
  }
  return {
    rootData: projected as RetirableGateway,
    root,
  };
}

export function isolatedRuntimeMutationFenced(user: Stored<PlatformUserRecord>): boolean {
  return user.fences.restoreFence !== undefined || user.fences.sourceTransferFence !== undefined;
}

export async function assertGatewayRuntimeMutationUnfencedInStore(
  transaction: PlatformStateTransaction,
  gatewayId: string,
  allowedVmRecoveryOperationId?: string,
): Promise<void> {
  const root = await transaction.gateways.roots.get(gatewayId);
  if (root?.runtimeRestartFence !== undefined) {
    throw new GatewayRetirementConflictError(`gateway ${gatewayId} runtime restart outcome is unresolved`);
  }
  const holders = await transaction.users.records.listGatewayFenceHolders(gatewayId);
  if (holders.computerRecovery.some(user => !allowedVmRecoveryOperationId || user.fences.computerRecovery?.operationId !== allowedVmRecoveryOperationId)) {
    throw new GatewayRetirementConflictError(`gateway ${gatewayId} VM recovery is in progress`);
  }
  if (holders.sourceTransferSource.length > 0 || holders.sourceTransferTarget.length > 0 || holders.assigned.some(isolatedRuntimeMutationFenced)) {
    throw new GatewayRetirementConflictError(`gateway ${gatewayId} source transfer outcome is unresolved`);
  }
}

export function moveHasNotBegun(operation: OperationRecord, gatewayId: string): boolean {
  return operation.kind === "migrate-user" && operation.status === "pending" && operation.startedAt === null &&
    operation.input?.toGatewayId === gatewayId && !operation.attempts && operation.steps.length === 0 &&
    operation.userMigrationV2 === undefined && operation.schedulerHandoff === undefined &&
    operation.cutoverCommittedAt === undefined && operation.sourceTransferExecution === undefined;
}

function activeMigrationConflict(gatewayId: string, operations: readonly Stored<OperationRecord>[]): boolean {
  return findActiveGatewayMigration(
    gatewayId,
    operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      input: operation.input,
      userMigrationV2: operation.userMigrationV2,
    })),
  ) !== null;
}

function inspectRetirementRuntime(
  input: Pick<ClaimGatewayRetirementInStoreInput, "gatewayId" | "now" | "telemetryObservedAfter">,
  root: RetirableGateway,
  runtime: unknown,
): LiveRuntimeIdentity {
  if (root.desiredRelease !== root.liveRelease) {
    throw unconvergedRetirementError(input.gatewayId, runtime);
  }
  const inspection = runningRetirementError(
    input.gatewayId,
    runtime,
    input.now,
    root.liveRelease as number,
    input.telemetryObservedAfter,
  );
  if (inspection.error) {
    throw inspection.telemetryUnavailable
      ? new GatewayRetirementTelemetryUnavailableError(inspection.error)
      : new GatewayRetirementConflictError(inspection.error);
  }
  return inspection.liveRuntimeIdentity;
}

export async function claimGatewayRetirementInStore(
  input: ClaimGatewayRetirementInStoreInput,
): Promise<{ version: number }> {
  return input.store.transaction({ label: "gateway-retirement.claim" }, async (transaction) => {
    const [stored, activeOperations] = await Promise.all([
      transaction.gateways.roots.get(input.gatewayId),
      transaction.journal.operations.listByStatus(["pending", "running"]),
    ]);
    const { rootData } = claimableGatewayRetirementRoot(input.gatewayId, stored ?? undefined);
    const superseded = new Set(input.supersededMoves?.operationIds ?? []);
    const stillWaiting = activeOperations.filter((operation) =>
      superseded.has(operation.id) && moveHasNotBegun(operation, input.gatewayId));
    if (stillWaiting.length !== superseded.size ||
        activeMigrationConflict(input.gatewayId, activeOperations.filter((operation) => !superseded.has(operation.id)))) {
      throw new GatewayRetirementConflictError(
        `user migration is in flight for gateway ${input.gatewayId}`,
      );
    }

    await assertGatewayRuntimeMutationUnfencedInStore(transaction, input.gatewayId);

    let liveRuntimeIdentity: LiveRuntimeIdentity = null;
    if (rootData.desiredStatus !== "paused" && rootData.liveRelease != null) {
      const registry = await transaction.fleetRegistry.get(input.gatewayId);
      liveRuntimeIdentity = inspectRetirementRuntime(
        input,
        rootData,
        registry === null ? undefined : { ...registry, docKind: "runtime" },
      );
    }

    await input.claimGuard?.({ transaction, root: rootData });

    const version = nextRetirementVersion(rootData.retirementVersion);
    const claim: RetirementClaim = {
      operationId: input.operationId,
      version,
      claimedAt: input.now,
      phase: "claimed",
      liveRelease: rootData.liveRelease,
      liveRuntimeIdentity,
      previousDesiredStatus: rootData.desiredStatus,
    };
    await transaction.gateways.roots.patch(
      input.gatewayId,
      {
        desiredStatus: "retired",
        retirementVersion: version,
        retirementClaim: claim,
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { retirementVersion: rootData.retirementVersion ?? null, updatedAt: rootData.updatedAt },
    );
    for (const operation of stillWaiting) {
      await transaction.journal.operations.patch(operation.id, {
        status: "failed",
        completedAt: input.now,
        error: input.supersededMoves!.cancelledBecause,
        nextAttemptAt: { clear: true },
      }, { status: ["pending"], startedAt: null });
    }
    await transaction.journal.operations.put({
      ...input.operation,
      id: input.operationId,
      input: { ...input.operation.input, retirementClaimVersion: version },
    });
    return { version };
  });
}

function matchingRetirementClaim(
  root: { readonly retirementClaim?: unknown },
  operationId: string,
  version: number,
): RetirementClaim | null {
  const claim = readClaim(root.retirementClaim);
  return claim?.operationId === operationId && claim.version === version ? claim : null;
}

export async function verifyGatewayRetirementClaimAtomic(
  input: VerifyGatewayRetirementClaimInput,
): Promise<GatewayRetirementVerification> {
  return input.store.transaction({ label: "gateway-retirement.verify", readOnly: true }, async (transaction) => {
    const root = await transaction.gateways.roots.get(input.gatewayId);
    if (root === null) {
      return { ok: false, error: `gateway ${input.gatewayId} durable root is unavailable` };
    }
    const claim = matchingRetirementClaim(root, input.operationId, input.version);
    if (!claim) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match this operation`,
      };
    }
    if (root.desiredStatus !== "retired") {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} desiredStatus left retired during retirement`,
      };
    }
    try {
      await assertGatewayRuntimeMutationUnfencedInStore(transaction, input.gatewayId);
    } catch (error) {
      if (!(error instanceof GatewayRetirementConflictError)) throw error;
      return { ok: false, error: error.message };
    }
    return { ok: true };
  });
}
