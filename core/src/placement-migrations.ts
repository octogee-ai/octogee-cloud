import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import {
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import type { PlacementOwnerFence } from "./placement-automation-owner.js";
import { GatewayRetirementConflictError, isolatedRuntimeMutationFenced } from "./gateway-retirement-claim.js";
import { builderReturnOperationId, isUserReturnOperationIdFor } from "@octogee/shared/types/isolated-operation-ids";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayAssignment, GatewayRoot } from "./platform-state/gateways.js";
import type { OperationPatch, OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateTransaction, Stored } from "./platform-state/store.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import { nativeReturnTargetDenied, nativeReturnTargetExclusionId } from "./native-return-target-deny.js";
import { excludedDisklessWriter } from "./isolated-gateway-lifecycle/ephemeral-recovery-state.js";
import { readSharedGatewayPoolConfigInStore } from "./shared-gateway-pool-read.js";

export const PLACEMENT_MIGRATION_KIND = "migrate-user";
export const PLACEMENT_MIGRATION_ACTOR = "glm-controller-placement-policy";
export const CONTINUOUS_PLACEMENT_SOURCE = "continuous-placement-policy";
export const ACTIVATION_LEASE_SOURCE = "builder-activation-lease";
export const PLACEMENT_MIGRATION_SOURCES = [CONTINUOUS_PLACEMENT_SOURCE, ACTIVATION_LEASE_SOURCE] as const;
export type PlacementMigrationSource = (typeof PLACEMENT_MIGRATION_SOURCES)[number];

const ISOLATED_ALLOCATION_KIND = "disposable-builder";
const ROLLED_BACK_STATUS = "rolled-back";
const CLEAR = { clear: true } as const;

export interface PlacementMigrationClassifier {
  operationFailureIsTransient(error: string): boolean;
  gatewayStartupUnavailable(error: string | undefined): boolean;
  sourceRecoveryForwardRetryable(operation: Stored<OperationRecord>): boolean;
}

export interface PlacementMigrationEnqueueContext extends PlacementMigrationClassifier {
  requireOwner: PlacementOwnerFence;
  now: number;
  platformArtifact: ReleasePayload | null;
}

export interface EnqueuePlacementMigrationRequest {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: PlacementMigrationSource;
  operationId: string;
  sharedDrain?: { pairedTargetGatewayId: string | null };
  durableRecovery?: true;
}

export interface SupersedePendingSharedDrainMoveRequest {
  operationId: string;
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  activationOperationId: string;
}

export class PlacementMigrationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementMigrationAuthorityError";
  }
}

export class TerminalPlacementMigrationConflictError extends Error {
  constructor(readonly operationId: string, readonly status: string) {
    super(`migration operation ${operationId} ended with status ${status}`);
    this.name = "TerminalPlacementMigrationConflictError";
  }
}

export class HeldUserPlacementError extends GatewayRetirementConflictError {
  constructor(readonly uid: string) {
    super(`user ${uid} is operator-managed`);
    this.name = "HeldUserPlacementError";
  }
}

export class SharedDrainSupersededError extends Error {
  constructor(readonly fromGatewayId: string, reason: string) {
    super(`shared drain of ${fromGatewayId} no longer authorizes this migration: ${reason}`);
    this.name = "SharedDrainSupersededError";
  }
}

export function isPlacementMigrationRefusal(error: unknown): boolean {
  return error instanceof PlacementMigrationAuthorityError ||
    error instanceof TerminalPlacementMigrationConflictError ||
    error instanceof HeldUserPlacementError ||
    error instanceof SharedDrainSupersededError;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function continuousPlacementMigrationOperationId(input: {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  sourceAssignmentEpoch: number;
}): string {
  if (!Number.isSafeInteger(input.sourceAssignmentEpoch) || input.sourceAssignmentEpoch < 0) {
    throw new Error("continuous placement requires a non-negative source assignment epoch");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([input.uid, input.builderSlug, input.fromGatewayId, input.toGatewayId, input.sourceAssignmentEpoch]))
    .digest("hex")
    .slice(0, 32);
  return `placement-${digest}`;
}

interface ActivationLease {
  raw: Record<string, unknown>;
  leaseId: string;
  generation: number;
  status: string;
  targetGatewayId: string | null;
}

function activationLeaseOf(value: unknown): ActivationLease | null {
  const raw = record(value);
  const leaseId = nonEmptyString(raw?.leaseId);
  const generation = positiveInteger(raw?.generation);
  const status = nonEmptyString(raw?.status);
  if (!raw || !leaseId || !generation || !status) return null;
  return { raw, leaseId, generation, status, targetGatewayId: nonEmptyString(raw.targetGatewayId) };
}

function userGatewayId(userRecord: Stored<PlatformUserRecord> | null): string | null {
  return nonEmptyString(userRecord?.gateway?.gatewayId);
}

function userMutationFenced(userRecord: Stored<PlatformUserRecord> | null): boolean {
  return userRecord !== null && isolatedRuntimeMutationFenced(userRecord);
}

function isAutomaticRolledBackPlacement(data: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean {
  return request.source === CONTINUOUS_PLACEMENT_SOURCE &&
    data.status === "failed" &&
    data.origin === "automatic" &&
    data.createdBy === PLACEMENT_MIGRATION_ACTOR &&
    data.rolledBack === true &&
    data.userMigrationV2 === undefined &&
    millis(data.completedAt) !== null;
}

function rolledBackTransientPlacementCanRearm(
  classifier: PlacementMigrationClassifier,
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationRequest,
): boolean {
  if (!isAutomaticRolledBackPlacement(data, request)) return false;
  const error = typeof data.error === "string" ? data.error : null;
  const attempts = positiveInteger(data.attempts);
  const history = Array.isArray(data.attemptHistory) ? data.attemptHistory : null;
  const lastAttempt = record(history?.at(-1));
  return error !== null &&
    classifier.operationFailureIsTransient(error) &&
    attempts !== null &&
    positiveInteger(lastAttempt?.attempt) === attempts &&
    lastAttempt?.error === error;
}

function existingPlacementMigrationMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean {
  const operationInput = record(data.input);
  return [
    data.kind === PLACEMENT_MIGRATION_KIND,
    operationInput?.uid === request.uid,
    operationInput?.userSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.toGatewayId === request.toGatewayId,
    operationInput?.source === request.source,
  ].every(Boolean);
}

function operatorRetriedUserReturnMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean {
  const operationInput = record(data.input);
  return [
    request.source === ACTIVATION_LEASE_SOURCE,
    data.kind === PLACEMENT_MIGRATION_KIND,
    data.status === "failed" || data.status === ROLLED_BACK_STATUS,
    millis(data.retryRequestedAt) !== null,
    operationInput?.uid === request.uid,
    operationInput?.userSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.source === request.source,
  ].every(Boolean);
}

function placementMigrationIsNonTerminal(data: Record<string, unknown>): boolean {
  return ["pending", "running", "succeeded"].includes(data.status as string);
}

function startupFailedReturnMatchesDemand(
  classifier: PlacementMigrationClassifier,
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationRequest,
): boolean {
  const original = record(data.input);
  return request.source === ACTIVATION_LEASE_SOURCE && data.kind === PLACEMENT_MIGRATION_KIND &&
    data.status === "failed" && data.origin === "automatic" && data.createdBy === PLACEMENT_MIGRATION_ACTOR &&
    data.userMigrationV2 === undefined && data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined &&
    original?.uid === request.uid && original.userSlug === request.builderSlug &&
    original.fromGatewayId === request.fromGatewayId && original.source === request.source &&
    classifier.gatewayStartupUnavailable(typeof data.error === "string" ? data.error : undefined);
}

function sharedRevisionPreflightReturnRetryable(data: Record<string, unknown>, operationId: string): boolean {
  const original = record(data.input);
  return [
    data.kind === PLACEMENT_MIGRATION_KIND,
    data.status === "failed",
    data.origin === "automatic",
    data.createdBy === PLACEMENT_MIGRATION_ACTOR,
    original?.source === ACTIVATION_LEASE_SOURCE,
    isUserReturnOperationIdFor(operationId, original?.fromGatewayId),
    nonEmptyString(original?.toGatewayId) !== null,
    data.gatewayId === original?.toGatewayId,
    data.inputUid === original?.uid,
    data.error === `placement rejected for ${original?.toGatewayId}: revision-not-ready`,
    Array.isArray(data.steps) && data.steps.length === 0,
    data.rolledBack === false,
    data.userMigrationV2 === undefined,
    data.cutoverCommittedAt === undefined,
    data.cancellationRequestedAt === undefined,
    data.sourceTransferExecution === undefined,
    data.schedulerHandoffLost === undefined,
    data.schedulerHandoffReleased !== false,
    data.schedulerHandoff === undefined || data.schedulerHandoffReleased === true,
    original?.recoverSourceOnly === undefined,
  ].every(Boolean);
}

function sharedRevisionReturnMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean {
  const original = record(data.input);
  return sharedRevisionPreflightReturnRetryable(data, request.operationId) &&
    request.source === ACTIVATION_LEASE_SOURCE && original?.uid === request.uid &&
    original.userSlug === request.builderSlug && original.fromGatewayId === request.fromGatewayId;
}

function preRpcAuthorityFailure(data: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const step = record(steps[0]);
  return request.source === CONTINUOUS_PLACEMENT_SOURCE && data.status === "failed" &&
    data.origin === "automatic" && data.createdBy === PLACEMENT_MIGRATION_ACTOR &&
    data.userMigrationV2 === undefined && data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined &&
    data.error === "workspace migration phase authority changed" && steps.length === 1 &&
    step?.name === "keys-sync-state" && step.status === "failed" && step.error === data.error;
}

function sourceOnlyRollbackCompleted(
  classifier: PlacementMigrationClassifier,
  existing: Stored<OperationRecord>,
  request: EnqueuePlacementMigrationRequest,
): boolean {
  const data = existing as unknown as Record<string, unknown>;
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const step = record(steps[0]);
  return isAutomaticRolledBackPlacement(data, request) && record(data.input)?.recoverSourceOnly === true &&
    classifier.sourceRecoveryForwardRetryable(existing) &&
    data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined && steps.length === 1 &&
    step?.name === "recover-source" && step.status === "done";
}

function retrySourceAssignmentMatches(assignment: GatewayAssignment | null, request: EnqueuePlacementMigrationRequest): assignment is GatewayAssignment {
  return assignment?.uid === request.uid && assignment.gatewayId === request.fromGatewayId &&
    assignment.state === "serving" && Number.isSafeInteger(assignment.epoch) && assignment.epoch >= 0;
}

async function assertPreRpcRetryAuthority(
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest,
): Promise<GatewayAssignment> {
  const [source, target] = await Promise.all([
    transaction.gateways.assignments.get(request.fromGatewayId, request.uid),
    transaction.gateways.assignments.get(request.toGatewayId, request.uid),
  ]);
  const exact = !userMutationFenced(userRecord) &&
    userGatewayId(userRecord) === request.fromGatewayId &&
    userRecord?.fences.migration === undefined && target === null &&
    retrySourceAssignmentMatches(source, request) &&
    continuousPlacementMigrationOperationId({ ...request, sourceAssignmentEpoch: source.epoch }) === request.operationId;
  if (!exact || source === null) throw new PlacementMigrationAuthorityError("workspace migration retry authority remains blocked");
  return source;
}

function startupReturnLeaseMatches(
  userRecord: Stored<PlatformUserRecord> | null,
  lease: ActivationLease | null,
  request: EnqueuePlacementMigrationRequest,
): lease is ActivationLease {
  return !userMutationFenced(userRecord) && userGatewayId(userRecord) === request.fromGatewayId &&
    lease?.status === "returning" && lease.targetGatewayId === request.fromGatewayId && lease.raw.returnOperationId === request.operationId;
}

function startupReturnSourceMatches(
  root: ReturnType<typeof projectGatewayDesiredRootForGateway>,
  lease: ActivationLease,
  request: EnqueuePlacementMigrationRequest,
): boolean {
  const allocation = root?.allocation;
  return root?.gatewayClass === "isolated" && root.ownerUid === request.uid && root.desiredStatus !== "retired" &&
    allocation?.kind === ISOLATED_ALLOCATION_KIND && allocation.claimedByUid === request.uid &&
    allocation.leaseId === lease.leaseId && allocation.generation === lease.generation;
}

function sharedReturnTargetReady(
  root: ReturnType<typeof projectGatewayDesiredRootForGateway>,
  runtime: Stored<FleetRegistryRecord> | null,
  request: EnqueuePlacementMigrationRequest,
  now: number,
): boolean {
  if (!root || runtime === null) return false;
  const heartbeatAt = millis(runtime.heartbeat.lastHeartbeatAt);
  return root.gatewayClass === "shared" && root.desiredStatus === "running" && root.liveRelease !== null &&
    root.liveRelease === root.desiredRelease && runtime.gatewayId === request.toGatewayId && runtime.release === root.liveRelease &&
    runtime.lifecycle === "serving" && runtime.heartbeat.status === "ready" &&
    heartbeatAt !== null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

async function assertStartupReturnAuthority(
  context: PlacementMigrationEnqueueContext,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest,
) {
  const [assignment, roots, runtime, pool, targetAssignment] = await Promise.all([
    transaction.gateways.assignments.get(request.fromGatewayId, request.uid),
    transaction.gateways.roots.getMany([request.fromGatewayId, request.toGatewayId]),
    transaction.fleetRegistry.get(request.toGatewayId),
    readSharedGatewayPoolConfigInStore(transaction),
    transaction.gateways.assignments.get(request.toGatewayId, request.uid),
  ]);
  const source = roots.get(request.fromGatewayId) ?? null;
  const target = roots.get(request.toGatewayId) ?? null;
  const lease = activationLeaseOf(userRecord?.activationLease);
  const sourceRoot = projectGatewayDesiredRootForGateway(source, request.fromGatewayId);
  const targetRoot = projectGatewayDesiredRootForGateway(target, request.toGatewayId);
  const exact = targetAssignment === null && startupReturnLeaseMatches(userRecord, lease, request) &&
    startupReturnSourceMatches(sourceRoot, lease, request) && retrySourceAssignmentMatches(assignment, request) &&
    pool?.sharedGatewayIds.includes(request.toGatewayId) && sharedReturnTargetReady(targetRoot, runtime, request, context.now);
  if (!exact) throw new PlacementMigrationAuthorityError("User startup return retry authority changed");
  return { assignment, source, target };
}

async function assertSharedRevisionReturnAuthority(
  context: PlacementMigrationEnqueueContext,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest & { previousTargetGatewayId: string },
): Promise<void> {
  const authority = await assertStartupReturnAuthority(context, transaction, userRecord, request);
  const previousTargetAssignment = await transaction.gateways.assignments.get(request.previousTargetGatewayId, request.uid);
  const rootsUnfenced = [authority.source, authority.target].every((root) =>
    root?.runtimeRestartFence === undefined && root?.retirementClaim === undefined);
  const exact = rootsUnfenced && authority.source?.desiredStatus === "running" &&
    authority.assignment?.slug === request.builderSlug && userRecord?.fences.migration === undefined &&
    previousTargetAssignment === null;
  if (!exact) throw new PlacementMigrationAuthorityError("User revision return retry authority changed");
}

function proofRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((row) => record(row) !== null) ? value : [];
}

function capturedPostgresRosterMatches(source: Record<string, unknown>): boolean {
  const assignments = proofRows(source.assignments);
  const stores = proofRows(source.postgresAgentStores);
  return [
    stores.length > 0,
    assignments.length > 0,
    stores.every((store) => {
      const owner = assignments.find((row) => row.uid === store.uid);
      return owner && store.slug === owner.slug && store.assignmentEpoch === owner.assignmentEpoch &&
        typeof store.agentId === "string" && typeof owner.slug === "string" && agentIdBelongsToSlug(store.agentId, owner.slug) &&
        typeof store.storeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(store.storeId) &&
        typeof store.schema === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(store.schema);
    }),
    assignments.every((owner) => stores.some((store) => store.uid === owner.uid && store.agentId === owner.agentId)),
    new Set(stores.map((store) => store.agentId)).size === stores.length,
    new Set(stores.map((store) => store.storeId)).size === stores.length,
    new Set(stores.map((store) => store.schema)).size === stores.length,
  ].every(Boolean);
}

function completedPostgresDoctorMatches(input: { source: Record<string, unknown>; completed: Record<string, unknown>; repairId: unknown }): boolean {
  const { source, completed, repairId } = input;
  const doctor = record(completed.doctor) ?? {};
  const expectedIds = proofRows(source.postgresAgentStores).map((store) => store.agentId).sort();
  return [
    Array.isArray(doctor.verifiedAgentIds) && isDeepStrictEqual([...doctor.verifiedAgentIds].sort(), expectedIds),
    doctor.requestId === repairId,
    Number.isSafeInteger(doctor.startedAt) && Number(doctor.startedAt) > 0,
    Number.isSafeInteger(doctor.completedAt) && Number(doctor.completedAt) >= Number(doctor.startedAt) &&
      Number(doctor.completedAt) <= Number(completed.completedAt),
    typeof doctor.releaseKey === "string" && doctor.releaseKey.length > 0,
  ].every(Boolean);
}

function completedPostgresImageMatches(source: Record<string, unknown>, completed: Record<string, unknown>): boolean {
  const doctor = record(completed.doctor) ?? {};
  const installed = record(completed.installedImage) ?? {};
  const images = record(source.images) ?? {};
  const digest = typeof images.gateway === "string" ? /@(sha256:[a-f0-9]{64})$/.exec(images.gateway)?.[1] : undefined;
  const bootId = record(completed.managementHealth)?.bootId;
  return [
    typeof completed.podUid === "string" && completed.podUid.length > 0 && installed.podUid === completed.podUid,
    digest !== undefined && typeof installed.gatewayImageId === "string" && installed.gatewayImageId.endsWith("@" + digest),
    Number.isSafeInteger(installed.verifiedAt) && Number(installed.verifiedAt) > 0 && Number(installed.verifiedAt) <= Number(doctor.startedAt),
    typeof bootId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(bootId),
  ].every(Boolean);
}

export function repairedPlacementProofMatches(
  data: Record<string, unknown>,
  repair: Record<string, unknown>,
  request: EnqueuePlacementMigrationRequest,
): boolean {
  const source = record(record(repair.input)?.sourceRecovery) ?? {};
  const completed = record(repair.sourceRuntimeRecovery) ?? {};
  const assignment = proofRows(source.assignments).find((row) => row.uid === request.uid);
  return [
    isAutomaticRolledBackPlacement(data, request),
    data.cutoverCommittedAt === undefined,
    repair.kind === "restart-gateway",
    ["running", "succeeded"].includes(String(repair.status)),
    repair.cancellationRequestedAt === undefined,
    record(repair.input)?.gatewayId === request.fromGatewayId,
    completed.gatewayId === request.fromGatewayId,
    Number.isSafeInteger(repair.startedAt) && Number(repair.startedAt) >= Number(data.completedAt),
    Number.isSafeInteger(completed.completedAt) && Number(completed.completedAt) >= Number(repair.startedAt),
    assignment?.slug === request.builderSlug,
    capturedPostgresRosterMatches(source),
    typeof source.sourceSha === "string" && /^[a-f0-9]{40}$/.test(source.sourceSha),
    source.sourceSha === completed.sourceSha,
    isDeepStrictEqual(source.images, completed.images),
    completedPostgresDoctorMatches({ source, completed, repairId: repair.id }),
    completedPostgresImageMatches(source, completed),
    record(completed.managementHealth)?.attemptId === repair.id,
    record(completed.managementHealth)?.health === true,
  ].every(Boolean);
}

async function assertCurrentRepairTarget(
  context: PlacementMigrationEnqueueContext,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest,
  sourceImage: string,
): Promise<void> {
  const [target, runtime, pool] = await Promise.all([
    transaction.gateways.roots.get(request.toGatewayId),
    transaction.fleetRegistry.get(request.toGatewayId),
    readSharedGatewayPoolConfigInStore(transaction),
  ]);
  const root = projectGatewayDesiredRootForGateway(target, request.toGatewayId);
  const release = root?.liveRelease != null
    ? await transaction.gateways.releases.get(request.toGatewayId, root.liveRelease)
    : null;
  const payload = release?.payload;
  const artifact = context.platformArtifact;
  const exact = [
    sharedReturnTargetReady(root, runtime, request, context.now),
    pool?.sharedGatewayIds.includes(request.toGatewayId),
    target?.runtimeRestartFence === undefined,
    target?.retirementClaim == null,
    artifact !== null && isReleasePayload(payload) && releasePayloadHash(payload) === releasePayloadHash(artifact) &&
      sourceImage.startsWith(payload.imageRepository + ":") && sourceImage.endsWith("@" + payload.imageTag.split("@")[1]),
    userRecord?.slug === request.builderSlug,
    userRecord?.openclaw.status === "complete",
  ].every(Boolean);
  if (!exact) throw new PlacementMigrationAuthorityError("repaired source placement current target authority changed");
}

interface RepairedPostgresSourceObservation {
  source: Record<string, unknown>;
  runtime: Record<string, unknown>;
  release: Record<string, unknown>;
  repair: Record<string, unknown>;
  request: EnqueuePlacementMigrationRequest;
  now: number;
}

function postgresRepairSourceRootMatches(
  source: Record<string, unknown>,
  adopted: Record<string, unknown>,
  request: EnqueuePlacementMigrationRequest,
): boolean {
  return [
    Number.isSafeInteger(adopted.release),
    Number(adopted.release) > 0,
    typeof adopted.operationId === "string" && adopted.operationId.length > 0 && !adopted.operationId.includes("/"),
    source.gatewayId === request.fromGatewayId,
    source.gatewayClass === "shared",
    source.ownerUid === null,
    source.builderSlug === null,
    ["running", "draining"].includes(String(source.desiredStatus)),
    source.runtimeRestartFence === undefined,
    source.retirementClaim == null,
    source.latestRelease === adopted.release,
    source.desiredRelease === adopted.release,
    source.liveRelease === adopted.release,
  ].every(Boolean);
}

function postgresRepairSourceRuntimeMatches(input: {
  runtime: Record<string, unknown>;
  adopted: Record<string, unknown>;
  request: EnqueuePlacementMigrationRequest;
  now: number;
}): boolean {
  const { runtime, adopted, request, now } = input;
  const heartbeat = record(runtime.heartbeat) ?? {};
  const heartbeatAt = millis(heartbeat.lastHeartbeatAt);
  return [
    runtime.gatewayId === request.fromGatewayId,
    runtime.release === adopted.release,
    runtime.lifecycle === "serving",
    heartbeat.status === "ready",
    heartbeatAt !== null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS,
  ].every(Boolean);
}

function postgresRepairSourcePayloadMatches(input: {
  release: Record<string, unknown>;
  captured: Record<string, unknown>;
  runtime: Record<string, unknown>;
  adopted: Record<string, unknown>;
  request: EnqueuePlacementMigrationRequest;
}): boolean {
  const { release, captured, runtime, adopted, request } = input;
  const helm = record(runtime.helm) ?? {};
  const payload = release.payload;
  const expected = captured.payload;
  return [
    release.gatewayId === request.fromGatewayId && release.release === adopted.release,
    isReleasePayload(payload) && isReleasePayload(expected) && release.payloadHash === releasePayloadHash(payload) &&
      releasePayloadHash(payload) === releasePayloadHash(expected) && helm.imageRepository === payload.imageRepository &&
      helm.imageTag === payload.imageTag,
    isReleasePayload(payload) && record(captured.images)?.gateway === `${payload.imageRepository}:${payload.imageTag}`,
  ].every(Boolean);
}

export function repairedPostgresSourceConverged(input: RepairedPostgresSourceObservation): boolean {
  const { source, runtime, release, repair, request, now } = input;
  const completed = record(repair.sourceRuntimeRecovery) ?? {};
  const captured = record(record(repair.input)?.sourceRecovery) ?? {};
  const adopted = record(completed.release) ?? {};
  return [
    postgresRepairSourceRootMatches(source, adopted, request),
    postgresRepairSourceRuntimeMatches({ runtime, adopted, request, now }),
    postgresRepairSourcePayloadMatches({ release, captured, runtime, adopted, request }),
  ].every(Boolean);
}

async function assertCurrentPostgresRepairSource(
  context: PlacementMigrationEnqueueContext,
  transaction: PlatformStateTransaction,
  repair: Record<string, unknown>,
  request: EnqueuePlacementMigrationRequest,
): Promise<void> {
  const completed = record(repair.sourceRuntimeRecovery) ?? {};
  const adopted = record(completed.release) ?? {};
  const adoptedRelease = positiveInteger(adopted.release);
  const [source, runtime, release] = await Promise.all([
    transaction.gateways.roots.get(request.fromGatewayId),
    transaction.fleetRegistry.get(request.fromGatewayId),
    adoptedRelease === null ? null : transaction.gateways.releases.get(request.fromGatewayId, adoptedRelease),
  ]);
  if (!projectGatewayDesiredRootForGateway(source, request.fromGatewayId) || runtime === null ||
      !repairedPostgresSourceConverged({
        source: source as unknown as Record<string, unknown>,
        runtime: runtime as unknown as Record<string, unknown>,
        release: (release ?? {}) as unknown as Record<string, unknown>,
        repair,
        request,
        now: context.now,
      })) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the repaired source release has not converged; retry placement after it is ready");
  }
}

async function findRepairedSourcePlacement(
  context: PlacementMigrationEnqueueContext,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!isAutomaticRolledBackPlacement(data, request)) return false;
  const candidates = await transaction.journal.operations.listByInputGateway(request.fromGatewayId);
  const repair = candidates.map((operation) => operation as unknown as Record<string, unknown>)
    .filter((row) => repairedPlacementProofMatches(data, row, request))
    .sort((left, right) => Number(record(right.sourceRuntimeRecovery)?.completedAt) - Number(record(left.sourceRuntimeRecovery)?.completedAt))[0];
  if (!repair) return false;
  const assignment = await assertPreRpcRetryAuthority(transaction, userRecord, request);
  const captured = record(record(repair.input)?.sourceRecovery) ?? {};
  const owner = proofRows(captured.assignments).find((row) => row.uid === request.uid);
  if (assignment.epoch !== owner?.assignmentEpoch || assignment.slug !== request.builderSlug) {
    throw new PlacementMigrationAuthorityError("source repair assignment changed");
  }
  const sourceImage = record(record(repair.sourceRuntimeRecovery)?.images)?.gateway;
  if (typeof sourceImage !== "string") throw new PlacementMigrationAuthorityError("source repair image receipt is unavailable");
  await assertCurrentPostgresRepairSource(context, transaction, repair, request);
  await assertCurrentRepairTarget(context, transaction, userRecord, request, sourceImage);
  return true;
}

function rearmedPlacementMigrationPatch(): OperationPatch {
  return {
    status: "pending",
    startedAt: null,
    completedAt: null,
    steps: [],
    error: CLEAR,
    expireAt: CLEAR,
    rolledBack: CLEAR,
    output: CLEAR,
    lastProgressAt: CLEAR,
    waitingOn: CLEAR,
    nextAttemptAt: CLEAR,
  };
}

async function assertSharedDrainAuthority(
  transaction: PlatformStateTransaction,
  request: EnqueuePlacementMigrationRequest & { sharedDrain: { pairedTargetGatewayId: string | null } },
): Promise<void> {
  const [roots, scaler] = await Promise.all([
    transaction.gateways.roots.getMany([request.fromGatewayId, request.toGatewayId]),
    transaction.controllerState.sharedPoolScaler.get(),
  ]);
  const source = roots.get(request.fromGatewayId);
  const target = roots.get(request.toGatewayId);
  if (source?.runtimeRestartFence !== undefined) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the source runtime restart is unresolved");
  }
  if (source?.desiredStatus !== "draining") {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the source is no longer draining");
  }
  if (target?.desiredStatus !== "running") {
    throw new SharedDrainSupersededError(request.fromGatewayId, `target ${request.toGatewayId} is no longer running`);
  }
  const pairedTargetGatewayId = (scaler?.replacements ?? [])
    .find((replacement) => replacement.sourceGatewayId === request.fromGatewayId)?.targetGatewayId ?? null;
  if (pairedTargetGatewayId !== request.sharedDrain.pairedTargetGatewayId) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "its replacement pairing changed");
  }
  if (pairedTargetGatewayId !== null && pairedTargetGatewayId !== request.toGatewayId) {
    throw new SharedDrainSupersededError(request.fromGatewayId, `it is paired with ${pairedTargetGatewayId}`);
  }
}

function supersededSharedDrainMoveCanRearm(data: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean {
  return request.sharedDrain !== undefined &&
    data.status === "failed" &&
    record(data.supersededBy)?.kind === "builder-activation" &&
    data.startedAt === null &&
    data.attempts === undefined &&
    data.cutoverCommittedAt === undefined &&
    data.userMigrationV2 === undefined;
}

function operationInputWithout(
  operation: Stored<OperationRecord>,
  removed: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...operation.input, ...overrides };
  for (const field of removed) delete next[field];
  return next;
}

function nativeReturnRecoveryCompleted(operation: Stored<OperationRecord>): boolean {
  const recovery = record(operation.input.nativeReturnSourceRecovery);
  return typeof recovery?.completedAt === "number" && recovery.completedAt > 0;
}

function compensatedReturnMatchesDemand(
  user: Stored<PlatformUserRecord>, lease: ActivationLease, request: EnqueuePlacementMigrationRequest,
  operation: Stored<OperationRecord>, compensation: Record<string, unknown>,
): boolean {
  return [
    lease.status === "active", lease.targetGatewayId === request.fromGatewayId, lease.raw.returnOperationId === undefined,
    request.operationId === builderReturnOperationId(request.fromGatewayId, lease.generation),
    user.slug === request.builderSlug, userGatewayId(user) === request.fromGatewayId, Object.keys(user.fences).length === 0,
    operation.kind === PLACEMENT_MIGRATION_KIND, operation.status === "failed", operation.rolledBack === true,
    operation.schedulerHandoffReleased === true, operation.cutoverCommittedAt === undefined, operation.userMigrationV2 === undefined,
    operation.sourceTransferExecution === undefined, operation.restoreAttempt === undefined, operation.schedulerHandoffLost === undefined,
    operation.cancellationRequestedAt === undefined,
    operation.inputUid === request.uid, operation.input.uid === request.uid, operation.input.userSlug === request.builderSlug,
    operation.input.fromGatewayId === request.fromGatewayId, operation.input.source === ACTIVATION_LEASE_SOURCE,
    request.source === ACTIVATION_LEASE_SOURCE, nonEmptyString(operation.input.toGatewayId),
    compensation.targetGatewayId !== request.toGatewayId,
    compensation.uid === request.uid, compensation.slug === request.builderSlug,
    compensation.operationId === request.operationId, compensation.exclusionId === nativeReturnTargetExclusionId(request.uid),
    compensation.sourceGatewayId === request.fromGatewayId, compensation.targetGatewayId === operation.input.toGatewayId,
  ].every(Boolean);
}

type PlacementJournalAudit = Awaited<ReturnType<PlatformStateTransaction["journal"]["audits"]["get"]>>;

function compensatedReturnAuditMatches(
  audit: PlacementJournalAudit, completed: PlacementJournalAudit, lease: ActivationLease,
  operation: Stored<OperationRecord>, compensation: Record<string, unknown>,
): boolean {
  const restored = record(audit?.target.retiredLeaseRestoration);
  if (!audit || !restored || !completed) return false;
  return [
    audit.target.targetGatewayId === operation.input.toGatewayId, restored.operationId === operation.id,
    restored.compensationAuditId === completed.id, restored.leaseId === lease.leaseId,
    restored.generation === lease.generation, restored.sourceEpoch === compensation.sourceEpoch,
    millis(restored.restoredAt) !== null, completed.status === "completed", completed.outcome === "completed",
    completed.actionClaimId === compensation.attemptId, completed.target.operationId === operation.id,
    isDeepStrictEqual(completed.target.original, compensation.source), operation.schedulerHandoff,
    isDeepStrictEqual(record(completed.target.archivedReturn)?.handoff, operation.schedulerHandoff),
  ].every(Boolean);
}

function compensatedReturnTargetReady(
  root: GatewayRoot, runtime: Stored<FleetRegistryRecord> | null, request: EnqueuePlacementMigrationRequest, now: number,
): boolean {
  return runtime !== null && !root.runtimeRestartFence && !root.retirementClaim &&
    sharedReturnTargetReady(projectGatewayDesiredRootForGateway(root, request.toGatewayId), runtime, request, now) &&
    !runtime.heartbeat.mountedCustomers.includes(request.builderSlug) && !runtime.heartbeat.migratingIn?.includes(request.builderSlug);
}

export async function rearmCompensatedNativeReturn(
  now: number,
  transaction: PlatformStateTransaction,
  user: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest,
  operation: Stored<OperationRecord>,
): Promise<OperationPatch> {
  const refusal = new TerminalPlacementMigrationConflictError(request.operationId, operation.status);
  const lease = activationLeaseOf(user?.activationLease);
  const compensation = record(operation.input.compensatingNativeReturn);
  const auditId = nonEmptyString(compensation?.auditId);
  if (!lease || !user || !auditId || !compensation || !record(compensation.retiredTarget) ||
      !compensatedReturnMatchesDemand(user, lease, request, operation, compensation)) throw refusal;
  const exclusionId = nativeReturnTargetExclusionId(request.uid);
  const [audit, completed, assignments, roots, runtime, pool, denied, active] = await Promise.all([
    transaction.journal.audits.get(exclusionId),
    transaction.journal.audits.get(auditId),
    transaction.gateways.assignments.listForUid(request.uid),
    transaction.gateways.roots.getMany([request.fromGatewayId, request.toGatewayId]),
    transaction.fleetRegistry.get(request.toGatewayId),
    readSharedGatewayPoolConfigInStore(transaction),
    nativeReturnTargetDenied(transaction, request.uid, request.toGatewayId),
    transaction.journal.operations.listForUid(request.uid, { statuses: ["pending", "running"] }),
  ]);
  const assignment = assignments[0] ?? null;
  const sourceRoot = roots.get(request.fromGatewayId);
  const targetRoot = roots.get(request.toGatewayId);
  if (!sourceRoot || !targetRoot || !retrySourceAssignmentMatches(assignment, request)) throw refusal;
  if (![
    !denied, compensatedReturnAuditMatches(audit, completed, lease, operation, compensation),
    assignments.length === 1, assignment.slug === request.builderSlug, assignment.epoch === compensation.sourceEpoch,
    startupReturnSourceMatches(projectGatewayDesiredRootForGateway(sourceRoot, request.fromGatewayId), lease, request),
    sourceRoot.desiredStatus === "running", sourceRoot.liveRelease === sourceRoot.desiredRelease,
    !sourceRoot.runtimeRestartFence, !sourceRoot.retirementClaim, active.length === 0,
    pool?.sharedGatewayIds.includes(request.toGatewayId), compensatedReturnTargetReady(targetRoot, runtime, request, now),
  ].every(Boolean)) throw refusal;
  return { ...rearmedPlacementMigrationPatch(), gatewayId: request.toGatewayId,
    input: operationInputWithout(operation, ["compensatingNativeReturn"], { toGatewayId: request.toGatewayId }),
    schedulerHandoff: CLEAR, schedulerHandoffReleased: CLEAR, schedulerHandoffReleasedAt: CLEAR,
    retryRequestedAt: CLEAR, retryRequestedBy: CLEAR };
}

async function placementMigrationRearm(
  context: PlacementMigrationEnqueueContext,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationRequest,
  existing: Stored<OperationRecord>,
): Promise<OperationPatch | null> {
  const data = existing as unknown as Record<string, unknown>;
  if (existing.input.compensatingNativeReturn !== undefined) {
    return rearmCompensatedNativeReturn(context.now, transaction, userRecord, request, existing);
  }
  const retarget = { input: operationInputWithout(existing, [], { toGatewayId: request.toGatewayId }), gatewayId: request.toGatewayId };
  if (sharedRevisionReturnMatchesDemand(data, request)) {
    await assertSharedRevisionReturnAuthority(context, transaction, userRecord, {
      ...request,
      previousTargetGatewayId: existing.input.toGatewayId as string,
    });
    return { ...rearmedPlacementMigrationPatch(), ...retarget };
  }
  if (startupFailedReturnMatchesDemand(context, data, request)) {
    await assertStartupReturnAuthority(context, transaction, userRecord, request);
    return { ...rearmedPlacementMigrationPatch(), ...retarget };
  }
  if (operatorRetriedUserReturnMatchesDemand(data, request)) {
    const removed = nativeReturnRecoveryCompleted(existing) ? ["recoverSourceOnly", "nativeReturnSourceRecovery"] : [];
    return {
      ...rearmedPlacementMigrationPatch(),
      input: operationInputWithout(existing, removed, { toGatewayId: request.toGatewayId }),
      gatewayId: request.toGatewayId,
      retryRequestedAt: CLEAR,
      retryRequestedBy: CLEAR,
    };
  }
  if (!existingPlacementMigrationMatchesDemand(data, request)) {
    throw new PlacementMigrationAuthorityError(`migration operation ${request.operationId} does not match activation demand`);
  }
  if (placementMigrationIsNonTerminal(data)) return null;
  if (supersededSharedDrainMoveCanRearm(data, request)) {
    return { ...rearmedPlacementMigrationPatch(), supersededBy: CLEAR };
  }
  if (await findRepairedSourcePlacement(context, transaction, userRecord, request, data)) {
    return rearmedPlacementMigrationPatch();
  }
  if (preRpcAuthorityFailure(data, request) || sourceOnlyRollbackCompleted(context, existing, request)) {
    await assertPreRpcRetryAuthority(transaction, userRecord, request);
    return {
      ...rearmedPlacementMigrationPatch(),
      schedulerHandoff: CLEAR,
      schedulerHandoffReleased: CLEAR,
      schedulerHandoffReleasedAt: CLEAR,
      input: operationInputWithout(existing, ["recoverSourceOnly"]),
    };
  }
  if (!rolledBackTransientPlacementCanRearm(context, data, request)) {
    throw new TerminalPlacementMigrationConflictError(request.operationId, String(data.status));
  }
  return rearmedPlacementMigrationPatch();
}

export type EnqueuePlacementMigrationOutcome = "created" | "rearmed" | "already-enqueued";

async function assertNoOtherActivePlacementMigration(
  transaction: PlatformStateTransaction,
  request: EnqueuePlacementMigrationRequest,
): Promise<void> {
  const active = await transaction.journal.operations.listForUid(request.uid, {
    kind: PLACEMENT_MIGRATION_KIND, statuses: ["pending", "running"],
  });
  const other = active.find((operation) => operation.id !== request.operationId);
  if (other !== undefined) {
    throw new PlacementMigrationAuthorityError(`user ${request.uid} already has ${other.status} migration ${other.id}`);
  }
}

function sameDisklessCheckpointEpoch(user: Stored<PlatformUserRecord>, gatewayId: string, epoch: number): boolean {
  const { workspaceCheckpoint: workspace, scheduleCheckpoint: schedule } = user;
  return !!workspace && !!schedule && [workspace, schedule].every(checkpoint =>
    checkpoint.gatewayId === gatewayId && checkpoint.assignmentEpoch === epoch);
}

async function assertDisklessPlacementDemand(
  transaction: PlatformStateTransaction,
  user: Stored<PlatformUserRecord>,
  request: EnqueuePlacementMigrationRequest,
): Promise<void> {
  const lease = activationLeaseOf(user.activationLease);
  const denial = () => new PlacementMigrationAuthorityError("diskless return requires the current excluded writer and its durable checkpoints");
  if (!lease || request.source !== ACTIVATION_LEASE_SOURCE || lease.targetGatewayId !== request.fromGatewayId ||
      !["active", "returning"].includes(lease.status) || userGatewayId(user) !== request.fromGatewayId ||
      request.operationId !== builderReturnOperationId(request.fromGatewayId, lease.generation)) throw denial();
  const [source, assignment] = await Promise.all([
    transaction.gateways.roots.get(request.fromGatewayId),
    transaction.gateways.assignments.get(request.fromGatewayId, request.uid),
  ]);
  const owner = { uid: request.uid, slug: request.builderSlug, leaseId: lease.leaseId, generation: lease.generation };
  if (!excludedDisklessWriter(source, owner) || assignment?.state !== "serving" ||
      !sameDisklessCheckpointEpoch(user, request.fromGatewayId, assignment.epoch)) throw denial();
}

function exactExistingDisklessDemand(existing: Stored<OperationRecord>, request: EnqueuePlacementMigrationRequest): boolean {
  return existing.kind === PLACEMENT_MIGRATION_KIND && existing.origin === "automatic" &&
    existing.createdBy === PLACEMENT_MIGRATION_ACTOR && existing.input.uid === request.uid &&
    existing.input.userSlug === request.builderSlug && existing.input.fromGatewayId === request.fromGatewayId &&
    existing.input.toGatewayId === request.toGatewayId && existing.input.source === request.source;
}

async function disklessPlacementReplay(
  transaction: PlatformStateTransaction,
  user: Stored<PlatformUserRecord>,
  request: EnqueuePlacementMigrationRequest,
  existing: Stored<OperationRecord> | null,
  admit: () => Promise<void>,
): Promise<EnqueuePlacementMigrationOutcome | undefined> {
  if (existing?.input.durableRecovery === true) {
    if (!request.durableRecovery || !exactExistingDisklessDemand(existing, request)) {
      throw new PlacementMigrationAuthorityError("an existing diskless return cannot switch authority or destination");
    }
    return "already-enqueued";
  }
  if (request.durableRecovery) {
    await assertDisklessPlacementDemand(transaction, user, request);
    if (existing) {
      if (!exactExistingDisklessDemand(existing, request) || !sharedDrainMoveNeverClaimed({ ...existing })) {
        throw new PlacementMigrationAuthorityError("the existing live return has already claimed work");
      }
      await admit();
      await transaction.journal.operations.patch(request.operationId, {
        input: operationInputWithout(existing, [], { durableRecovery: true }),
      }, { status: ["pending"], startedAt: null });
      return "rearmed";
    }
  }
  return undefined;
}

export async function enqueuePlacementMigrationInTransaction(
  transaction: PlatformStateTransaction,
  context: PlacementMigrationEnqueueContext,
  request: EnqueuePlacementMigrationRequest,
  admit: () => Promise<void> = async () => undefined,
): Promise<EnqueuePlacementMigrationOutcome> {
  await context.requireOwner(transaction);
  const userRecord = await transaction.users.records.get(request.uid);
  if (userRecord?.openclaw.managedBy === "operator") throw new HeldUserPlacementError(request.uid);
  if (userRecord?.slug !== request.builderSlug) {
    throw new PlacementMigrationAuthorityError(`slug ${request.builderSlug} does not match user ${request.uid}'s slug ${userRecord?.slug ?? "(none)"}`);
  }
  const sharedDrain = request.sharedDrain;
  if (sharedDrain) await assertSharedDrainAuthority(transaction, { ...request, sharedDrain });
  const existing = await transaction.journal.operations.get(request.operationId);
  const disklessReplay = await disklessPlacementReplay(transaction, userRecord, request, existing, admit);
  if (disklessReplay !== undefined) return disklessReplay;
  if (existing === null) {
    await assertNoOtherActivePlacementMigration(transaction, request);
    await admit();
    await transaction.journal.operations.create({
      id: request.operationId,
      kind: PLACEMENT_MIGRATION_KIND,
      status: "pending",
      origin: "automatic",
      createdBy: PLACEMENT_MIGRATION_ACTOR,
      createdAt: context.now,
      startedAt: null,
      completedAt: null,
      input: {
        uid: request.uid,
        userSlug: request.builderSlug,
        fromGatewayId: request.fromGatewayId,
        toGatewayId: request.toGatewayId,
        source: request.source,
        ...(request.durableRecovery ? { durableRecovery: true } : {}),
      },
      steps: [],
      gatewayId: request.toGatewayId,
      inputUid: request.uid,
    });
    return "created";
  }
  const rearm = await placementMigrationRearm(context, transaction, userRecord, request, existing);
  if (rearm === null) return "already-enqueued";
  await assertNoOtherActivePlacementMigration(transaction, request);
  await admit();
  await transaction.journal.operations.patch(request.operationId, rearm, {
    status: [existing.status],
    startedAt: existing.startedAt,
  });
  return "rearmed";
}

export function sharedDrainMoveNeverClaimed(data: Record<string, unknown>): boolean {
  const history = data.attemptHistory;
  return [
    data.status === "pending",
    data.startedAt === null,
    data.firstStartedAt === undefined,
    data.attempts === undefined,
    data.resumeCount === undefined,
    history === undefined || (Array.isArray(history) && history.length === 0),
    Array.isArray(data.steps) && data.steps.length === 0,
    data.cutoverCommittedAt === undefined,
    data.userMigrationV2 === undefined,
    data.cancellationRequestedAt === undefined,
    data.sourceTransferExecution === undefined,
    data.schedulerHandoff === undefined,
  ].every(Boolean);
}

function neverClaimedSharedDrainMove(data: Record<string, unknown> | undefined, request: SupersedePendingSharedDrainMoveRequest): boolean {
  if (data === undefined) return false;
  const operationInput = record(data.input);
  return [
    data.kind === PLACEMENT_MIGRATION_KIND,
    data.origin === "automatic",
    data.createdBy === PLACEMENT_MIGRATION_ACTOR,
    sharedDrainMoveNeverClaimed(data),
    operationInput?.uid === request.uid,
    operationInput?.userSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.toGatewayId === request.toGatewayId,
    operationInput?.source === CONTINUOUS_PLACEMENT_SOURCE,
  ].every(Boolean);
}

function supersedingActivationLeaseHolds(userRecord: Stored<PlatformUserRecord> | null, request: SupersedePendingSharedDrainMoveRequest): boolean {
  const lease = activationLeaseOf(userRecord?.activationLease);
  return userGatewayId(userRecord) === request.fromGatewayId &&
    lease?.leaseId === request.leaseId &&
    lease.generation === request.generation &&
    lease.status === "provisioning" &&
    lease.targetGatewayId === request.targetGatewayId;
}

function sharedDrainMoveSupersededBy(operation: Stored<OperationRecord> | null, request: SupersedePendingSharedDrainMoveRequest): boolean {
  const supersededBy = record((operation as unknown as Record<string, unknown> | null)?.supersededBy);
  return operation?.status === "failed" &&
    supersededBy?.kind === "builder-activation" &&
    supersededBy.leaseId === request.leaseId &&
    supersededBy.generation === request.generation &&
    supersededBy.targetGatewayId === request.targetGatewayId &&
    supersededBy.operationId === request.activationOperationId;
}

export type SupersedePendingSharedDrainMoveOutcome =
  | { kind: "superseded" }
  | { kind: "already-superseded" }
  | { kind: "refused"; reason: string };

export async function supersedePendingSharedDrainMoveInTransaction(
  transaction: PlatformStateTransaction,
  context: { requireOwner: PlacementOwnerFence; now: number; operationJournalRetentionMs: number },
  request: SupersedePendingSharedDrainMoveRequest,
): Promise<SupersedePendingSharedDrainMoveOutcome> {
  await context.requireOwner(transaction);
  const [operation, userRecord, source] = await Promise.all([
    transaction.journal.operations.get(request.operationId),
    transaction.users.records.get(request.uid),
    transaction.gateways.roots.get(request.fromGatewayId),
  ]);
  if (sharedDrainMoveSupersededBy(operation, request)) return { kind: "already-superseded" };
  if (!neverClaimedSharedDrainMove(operation === null ? undefined : operation as unknown as Record<string, unknown>, request)) {
    return { kind: "refused", reason: `operation ${request.operationId} is not a pending, never-claimed drain move of this user` };
  }
  if (!supersedingActivationLeaseHolds(userRecord, request)) {
    return { kind: "refused", reason: `user ${request.uid} does not hold provisioning lease ${request.leaseId} generation ${request.generation} for ${request.targetGatewayId}` };
  }
  if (source?.desiredStatus !== "draining") {
    return { kind: "refused", reason: `source ${request.fromGatewayId} is not draining` };
  }
  const now = context.now;
  await transaction.journal.operations.patch(request.operationId, {
    status: "failed",
    completedAt: now,
    expireAt: now + context.operationJournalRetentionMs,
    rolledBack: false,
    error: `superseded before claim by user activation lease ${request.leaseId} ` +
      `generation ${request.generation} (operation ${request.activationOperationId})`,
    supersededBy: {
      kind: "builder-activation",
      leaseId: request.leaseId,
      generation: request.generation,
      targetGatewayId: request.targetGatewayId,
      operationId: request.activationOperationId,
      at: now,
    },
    waitingOn: CLEAR,
    nextAttemptAt: CLEAR,
    queuedAt: CLEAR,
  }, { status: ["pending"], startedAt: null });
  return { kind: "superseded" };
}
