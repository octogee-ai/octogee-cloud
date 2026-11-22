import { isDeepStrictEqual } from "node:util";
import {
  isGatewayDesiredDoc,
  isReleasePayload,
  releasePayloadHash,
  type GatewayDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import {
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import { gatewayArtifactFromReleasePayload, type GatewayArtifact } from "./gateway-live-release.js";
import { assertGatewayRuntimeMutationUnfencedInStore, GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
import type { PlatformStateStore, PlatformStateTransaction, UntypedRecord } from "./platform-state/store.js";

export type DurableGatewayRoot = GatewayDoc & GatewayMutableConfig;

export function asDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): DurableGatewayRoot | null {
  if (!isGatewayDesiredDoc(data) || data.gatewayId !== gatewayId) return null;
  return projectGatewayMutableConfigForGateway(data, gatewayId) as DurableGatewayRoot | null;
}

export class StaleGatewayReleaseError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly expectedRelease: number,
    readonly actualRelease: number,
  ) {
    super(
      `gateway ${gatewayId} changed while this release was being cut ` +
        `(expected ${expectedRelease}, found ${actualRelease})`,
    );
  }
}

export class InvalidGatewayRootError extends Error {
  constructor(readonly gatewayId: string) {
    super(`gateway ${gatewayId} durable root is invalid`);
  }
}

export class GatewayOwnerChangeError extends Error {
  constructor(readonly gatewayId: string, readonly field: "ownerUid" | "builderSlug") {
    super(`gateway ${gatewayId} ${field} is already bound; a release cannot change it`);
  }
}

function assertOwnerUnchanged(current: DurableGatewayRoot, caller: DurableGatewayRoot): void {
  for (const field of ["ownerUid", "builderSlug"] as const) {
    if (current[field] !== null && caller[field] !== current[field]) {
      throw new GatewayOwnerChangeError(current.gatewayId, field);
    }
  }
}

export interface AppendGatewayReleaseArgs {
  gateway: DurableGatewayRoot;
  artifact: GatewayArtifact;
  payload?: ReleasePayload;
  createdBy: string;
  now: number;
  sourceRelease: number | null;
  note: string | null;
  origin?: "automatic" | "operator";
}

export function rolloutOperationInput(
  gatewayId: string,
  targetRelease: number,
  artifact: GatewayArtifact,
): Record<string, unknown> {
  return {
    gatewayId,
    targetRelease,
    imageTag: artifact.imageTag,
    imageRepository: artifact.imageRepository,
  };
}

function currentRootForAppend(stored: unknown, args: AppendGatewayReleaseArgs): GatewayDoc {
  const current = asDurableGatewayRoot(stored, args.gateway.gatewayId);
  if (!current) throw new InvalidGatewayRootError(args.gateway.gatewayId);
  assertOwnerUnchanged(current, args.gateway);
  if (current.desiredStatus === "retired" || current.retirementClaim != null) {
    throw new GatewayRetirementConflictError(
      `gateway ${args.gateway.gatewayId} has a current retirement claim`,
    );
  }
  if (current.latestRelease !== args.gateway.latestRelease) {
    throw new StaleGatewayReleaseError(
      args.gateway.gatewayId,
      args.gateway.latestRelease,
      current.latestRelease,
    );
  }
  return current;
}

function immutableHistoryError(gatewayId: string, release: number): Error {
  return new Error(
    `appendGatewayRelease: gateways/${gatewayId}/releases/${release} already exists — refusing to overwrite immutable history`,
  );
}

async function assertStoredReleaseIsNew(
  transaction: PlatformStateTransaction,
  gatewayId: string,
  release: number,
): Promise<void> {
  if (await transaction.gateways.releases.get(gatewayId, release) !== null) {
    throw immutableHistoryError(gatewayId, release);
  }
}

function releasePayloadFor(args: AppendGatewayReleaseArgs): ReleasePayload {
  const payload = args.payload ?? ({ ...args.artifact } as ReleasePayload);
  if (!isReleasePayload(payload)) {
    throw new Error("appendGatewayRelease requires a valid immutable release payload");
  }
  return payload;
}

export async function appendGatewayRelease(
  store: PlatformStateStore,
  args: AppendGatewayReleaseArgs,
): Promise<{ release: number; operationId: string | null }> {
  return store.transaction({ label: "gateway-release.append" }, async (transaction) => {
    const current = currentRootForAppend(await transaction.gateways.roots.get(args.gateway.gatewayId), args);
    await assertGatewayRuntimeMutationUnfencedInStore(transaction, args.gateway.gatewayId);
    const release = current.latestRelease + 1;
    await assertStoredReleaseIsNew(transaction, args.gateway.gatewayId, release);
    const payload = releasePayloadFor(args);
    const operationId = await appendStoredGatewayRelease(transaction, args, { release, payload });
    return { release, operationId };
  });
}

function rolloutOperation(args: AppendGatewayReleaseArgs, release: number, payload: ReleasePayload) {
  return {
    kind: "rollout" as const,
    status: "pending" as const,
    createdBy: args.createdBy,
    ...(args.origin ? { origin: args.origin } : {}),
    createdAt: args.now,
    startedAt: null,
    completedAt: null,
    input: rolloutOperationInput(args.gateway.gatewayId, release, gatewayArtifactFromReleasePayload(payload)),
    steps: [],
    gatewayId: args.gateway.gatewayId,
  };
}

async function appendStoredGatewayRelease(
  transaction: PlatformStateTransaction,
  args: AppendGatewayReleaseArgs,
  record: { release: number; payload: ReleasePayload; activate?: boolean },
): Promise<string> {
  await appendImmutableGatewayRelease(transaction, args, record);
  return transaction.journal.operations.enqueue(rolloutOperation(args, record.release, record.payload));
}

async function appendImmutableGatewayRelease(
  transaction: PlatformStateTransaction,
  args: AppendGatewayReleaseArgs,
  record: { release: number; payload: ReleasePayload; activate?: boolean },
): Promise<void> {
  const { release, payload, activate = false } = record;
  await transaction.gateways.releases.append({
    gatewayId: args.gateway.gatewayId,
    expectedLatestRelease: release - 1,
    createdAt: args.now,
    createdBy: args.createdBy,
    sourceRelease: args.sourceRelease,
    note: args.note,
    payload,
    payloadHash: releasePayloadHash(payload),
    activate,
    updatedBy: args.createdBy,
  });
}

export async function appendRetainedSharedMaintenanceReleaseInStore(
  transaction: PlatformStateTransaction,
  input: { gatewayId: string; attemptId: string; phase: "dispatched" | "rollback"; originalRelease: number; payload: ReleasePayload; now: number },
): Promise<number> {
  const root = await transaction.gateways.roots.get(input.gatewayId);
  const current = asDurableGatewayRoot(root, input.gatewayId);
  const guard = root?.runtimeRestartFence;
  const maintenance = guard?.maintenance as UntypedRecord | undefined;
  const images = input.phase === "rollback" ? maintenance?.originalImages : maintenance?.maintenanceImages;
  if (!recoveredSharedRoot(current) || guard?.kind !== "shared-held-return-maintenance" ||
      guard.attemptId !== input.attemptId || guard.phase !== input.phase || maintenance?.targetRelease !== input.originalRelease ||
      !isDeepStrictEqual(images, recoveredReleaseImages(input.payload))) {
    throw new Error("Shared maintenance release authorization changed");
  }
  const release = current.latestRelease + 1;
  await assertStoredReleaseIsNew(transaction, input.gatewayId, release);
  const args: AppendGatewayReleaseArgs = { gateway: current, artifact: gatewayArtifactFromReleasePayload(input.payload),
    payload: input.payload, createdBy: input.attemptId, now: input.now, sourceRelease: input.originalRelease,
    note: input.phase === "rollback" ? "Retained Shared maintenance reversal" : "Retained Shared maintenance", origin: "operator" };
  await appendImmutableGatewayRelease(transaction, args, { release, payload: releasePayloadFor(args), activate: true });
  return release;
}

export interface RecoveredGatewayReleaseInput {
  gatewayId: string; operationId: string; claimedStartedAt: number | null; payload: ReleasePayload; now: number;
}
function recoveredSharedRoot(current: DurableGatewayRoot | null): current is DurableGatewayRoot {
  return current !== null && current.gatewayClass === "shared" && current.ownerUid === null && current.builderSlug === null &&
    ["running", "draining"].includes(current.desiredStatus) && current.retirementClaim == null;
}
function recoveredReleaseOperation(op: UntypedRecord | undefined, input: RecoveredGatewayReleaseInput): boolean {
  return op?.kind === "restart-gateway" && op.status === "running" && op.startedAt === input.claimedStartedAt &&
    typeof input.claimedStartedAt === "number" && op.cancellationRequestedAt === undefined && op.input?.gatewayId === input.gatewayId &&
    Array.isArray(op.input?.sourceRecovery?.postgresAgentStores) && op.input.sourceRecovery.postgresAgentStores.length > 0;
}
function recoveredReleasePayload(recovery: UntypedRecord | undefined, payload: ReleasePayload, images: Record<string, string>): boolean {
  return isReleasePayload(payload) && payload.gatewayEdgeImage !== undefined && isDeepStrictEqual(recovery?.payload, payload) &&
    isDeepStrictEqual(recovery?.images, images);
}
function recoveredReleaseDoctor(fence: UntypedRecord | undefined, operationId: string, images: Record<string, string>): boolean {
  const doctor = fence?.doctor;
  return fence?.kind === "source-recovery" && fence.attemptId === operationId && fence.phase === "dispatched" &&
    doctor?.requestId === operationId && doctor?.error === undefined && recoveredDoctorTiming(doctor) && isDeepStrictEqual(fence.target?.images, images);
}
function recoveredDoctorTiming(doctor: UntypedRecord | undefined): boolean {
  return doctor !== undefined && Number.isSafeInteger(doctor.startedAt) && Number.isSafeInteger(doctor.completedAt) && doctor.completedAt >= doctor.startedAt;
}
function recoveredReleaseImages(payload: ReleasePayload): Record<string, string> {
  return { gateway: `${payload.imageRepository}:${payload.imageTag}`,
    "gateway-edge": `${payload.gatewayEdgeImage?.imageRepository}:${payload.gatewayEdgeImage?.imageTag}` };
}
function recoveredReleaseRoot(
  root: UntypedRecord | undefined, op: UntypedRecord | undefined, input: RecoveredGatewayReleaseInput,
): DurableGatewayRoot {
  const current = asDurableGatewayRoot(root, input.gatewayId), images = recoveredReleaseImages(input.payload);
  if (!recoveredSharedRoot(current) || !recoveredReleaseOperation(op, input) ||
      !recoveredReleasePayload(op?.input?.sourceRecovery, input.payload, images) ||
      !recoveredReleaseDoctor(root?.runtimeRestartFence, input.operationId, images)) {
    throw new Error("recovered Shared release authority changed");
  }
  return current;
}
function recoveredReleaseArgs(current: DurableGatewayRoot, input: RecoveredGatewayReleaseInput): AppendGatewayReleaseArgs {
  return {
    gateway: current, artifact: gatewayArtifactFromReleasePayload(input.payload), payload: input.payload,
    createdBy: input.operationId, now: input.now, sourceRelease: current.liveRelease,
    note: "Stopped-source PostgreSQL repair", origin: "operator",
  };
}
export async function recordRecoveredGatewayReleaseInStore(
  transaction: PlatformStateTransaction, input: RecoveredGatewayReleaseInput,
): Promise<{ release: number; operationId: string }> {
  const [root, operation] = await Promise.all([transaction.gateways.roots.get(input.gatewayId),
    transaction.journal.operations.get(input.operationId)]);
  const current = recoveredReleaseRoot(root ?? undefined, operation ?? undefined, input);
  const release = current.latestRelease + 1;
  await assertStoredReleaseIsNew(transaction, input.gatewayId, release);
  const operationId = await appendStoredGatewayRelease(transaction, recoveredReleaseArgs(current, input),
    { release, payload: input.payload, activate: true });
  return { release, operationId };
}
