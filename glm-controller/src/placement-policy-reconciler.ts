import { createRepeatSquelch, type RepeatSquelch } from "@octogee/shared/server/repeat-squelch";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { isDeepStrictEqual } from 'node:util';
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const eventLogger = createServiceLogger("cowboy");
import { isReapedOperationError, REARMED_RETIRE_OPERATION } from "./stuck-op-reaper.js";
import { userPlacementDocument, type UserPolicyInputsSource } from "./user-placement-document.js";
import { sourceRecoveryForwardRetryable } from "./legacy-migration-recovery.js";
import { schedulerHandoffAwaitingRelease } from "./scheduler-handoff-release.js";
import { createHash } from "node:crypto";

import {
  GatewayRetirementConflictError,
  isolatedRuntimeMutationFenced,
} from "@octogee/core/gateway-retirement-claim";
import {
  GATEWAY_UNREACHABLE_AFTER_MS,
  parseConfiguredUserReport,
  type ConfiguredUserReport,
} from "@octogee/shared/types/fleet-controller";
import {
  isGatewayRuntime,
  resolveGatewayRuntime,
    type GatewayRuntime,
} from "@octogee/shared/types/glm";
import {
  type GatewayKubernetesObservation,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import {
  GATEWAY_POD_REPLACEMENT_SCHEMA,
  isGatewayPodPlacement,
  isGatewayPodReplacements,
  type GatewayPodPlacement,
  type GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";
import {
  nextPodReplacementTransition,
  observedPodPlacements,
  observedReplicaSets,
  type PodReplacementTransition,
} from "./pod-replacement-tracking.js";
import {
  authoritativeSharedGatewayLoad,
  compareSharedGatewayIds,
  deriveSharedGatewayPoolConfig,
  parseSharedGatewayPoolConfig,
  sharedGatewayAddedBy,
  type SharedGatewayAddedBy,
  type SharedGatewayPoolCandidate,
  type SharedPoolReplacement,
} from "@octogee/shared/types/shared-gateway-pool";
import {
  readSharedGatewayPoolConfigInStore,
} from "@octogee/core/shared-gateway-pool-read";
import {
  builderActivateOperationId,
  isolatedRecoverOperationId,
  builderReturnOperationId,
  isUserReturnOperationIdFor,
  placementRetireOperationId,
  type SizingKeyReader,
} from "@octogee/core/user-activation-lease";
import {
  clearRetiredUserActivationPreparation,
  commitRecoveredDisposableRuntimeResetAtomic,
  commitUnavailableGatewayRecoveryAtomic,
  type RecoveredDisposableRuntimeResetParams,
  type UnavailableGatewayRecoveryParams,
  type UnavailableGatewayRecoveryTargetValidationContext,
} from "@octogee/core/fleet-state";
import { supersedeRollingSharedGatewayRoll } from "@octogee/core/shared-gateway-roll-recovery";
import {
  FenceMismatchError,
  type PlatformUserRecord,
  type FleetRegistryRecord,
  type GatewayAssignment,
  type GatewayRoot,
  type OperationPatch,
  type OperationRecord,
  type PlacementAdmissionDecision,
  type PlacementAdmissionPolicy,
  type PlatformStateStore,
  type PlatformStateTransaction,
  type Stored,
  type GatewaySizingProfile,
} from "@octogee/core/platform-state";
import {
  resolveDefaultPlacementEligibility,
  type ContinuousPlacementOwnedGateway,
} from "@octogee/shared/types/orchestrator-placement";
import type { SizingTier } from "@octogee/shared/types/sizing";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";
import type { UserHomeMigrationDeps } from "./user-home-migration.js";
import { commitInitialPlacement, type AssignInitialPlacementInput } from "./initial-placement.js";
import { pairedReplacementTarget, readSharedPoolReplacements } from "./shared-pool-replacements.js";
import type { FleetInformer } from "./fleet-informer.js";
import {
  classifyOperationFailure,
  isAgentStoreRetirementSessionDrain,
  isGatewayStartupUnavailable,
} from "./operation-retry.js";

export const PLACEMENT_POLICY_RECONCILE_MS_DEFAULT = 15_000;
export const SHARED_GATEWAY_REBALANCE_STABILITY_MS = 10 * 60_000;
export const PLACEMENT_POLICY_ACTOR = "glm-controller-placement-policy";
export const USER_ACTIVATION_LEASE_SOURCE = "builder-activation-lease";
export const ISOLATED_GATEWAY_ALLOCATION_KIND = "disposable-builder";
export const ROLLED_BACK_STATUS = "rolled-back";
export const NO_ACCEPTING_SHARED_GATEWAY = "no-accepting-shared-gateway";
export const CONTINUOUS_PLACEMENT_POLICY_SOURCE = "continuous-placement-policy";
export const LIVE_LEASE_STATUSES = new Set([
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
]);

export class TerminalPlacementMigrationConflictError extends Error {
  constructor(
    readonly operationId: string,
    readonly status: string,
  ) {
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

export function isSkippablePlacementConflict(
  error: unknown,
): error is TerminalPlacementMigrationConflictError | HeldUserPlacementError {
  return error instanceof TerminalPlacementMigrationConflictError || error instanceof HeldUserPlacementError;
}

export interface PlacementPolicyUser {
  uid: string;
  data: Record<string, unknown>;
}

export interface PlacementPolicyMigration {
  id: string;
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "builder-activation-lease";
  status: "pending" | "running" | "succeeded" | "failed" | "rolled-back";
  error?: string;
  retryRequested?: boolean;
  sourceRecoveryPending?: boolean;
  sharedRevisionRetryable?: boolean;
}

export type PlacementPolicyKubernetesStatus = "ready" | "not-ready" | "missing" | "unknown";

export interface PlacementPolicyPodDiagnostics {
  status: string;
  totalPods: number;
  readyPods: number;
  pods?: ReadonlyArray<{
    gatewayId?: string | null;
    phase?: string;
    deleting?: boolean;
    gatewayContainerStartedAt?: number | null;
    uid?: string | null;
    name?: string | null;
    replicaSetUid?: string | null;
    nodeName?: string | null;
    instanceId?: string | null;
    nodePool?: string | null;
  }>;
  replicaSets?: ReadonlyArray<{
    uid: string;
    name: string;
    desiredReplicas: number;
    observedReplicas: number;
  }>;
  error?: string;
}

export function placementKubernetesStatus(
  diagnostics: PlacementPolicyPodDiagnostics | undefined,
): PlacementPolicyKubernetesStatus {
  if (!diagnostics || diagnostics.error) return "unknown";
  if (diagnostics.status === "unknown") return "unknown";
  if (diagnostics.totalPods === 0) return "missing";
  if (diagnostics.totalPods > 0 && diagnostics.readyPods > 0) return "ready";
  if (diagnostics.totalPods > 0) return "not-ready";
  return "unknown";
}

export interface PlacementPolicyGateway extends ContinuousPlacementOwnedGateway {
  runtime?: GatewayRuntime;
  builderSlug?: string | null;
  sizingTier?: SizingTier | null;
  kubernetesStatus?: PlacementPolicyKubernetesStatus;
  serving?: boolean;
  runtimeStatus?: string;
  heartbeatFresh?: boolean;
  vmStartedAt?: number | null;
  runtimeStartedAt?: number | null;
  liveReleaseReady?: boolean;
  rosterComplete?: boolean;
  assignmentCount?: number;
  addedBy?: SharedGatewayAddedBy | null;
  latestRelease?: number;
  desiredRelease?: number;
  liveRelease?: number | null;
  rollActive?: boolean;
  recoveryGraceUntil?: number;
  mountedCustomers?: readonly string[];
  configuredBuilder?: ConfiguredUserReport | null;
}

export const SHARED_GATEWAY_RECOVERY_GRACE_MS = GATEWAY_UNREACHABLE_AFTER_MS;

export interface PlacementPolicyAssignment {
  uid: string;
  slug: string;
  gatewayId: string;
  state: string;
  epoch: number | null;
  createdAt?: number | null;
  source?: string;
  updatedByOperationId?: string;
}

export interface PlacementPolicySnapshot {
  sizingProfiles: Readonly<Record<string, GatewaySizingProfile>>;
  defaultGatewayId: string;
  sharedGatewayIds: readonly string[];
  platformCurrentGatewayIds: readonly string[];
  sharedPoolReplacements: readonly SharedPoolReplacement[];
  users: PlacementPolicyUser[];
  gateways: PlacementPolicyGateway[];
  assignments: PlacementPolicyAssignment[];
  activeMigrations: PlacementPolicyMigration[];
}

export interface EnqueuePlacementMigrationInput {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "builder-activation-lease";
  operationId: string;
  sharedDrain?: { pairedTargetGatewayId: string | null };
}

export class SharedDrainSupersededError extends Error {
  constructor(readonly fromGatewayId: string, reason: string) {
    super(`shared drain of ${fromGatewayId} no longer authorizes this migration: ${reason}`);
    this.name = "SharedDrainSupersededError";
  }
}

export interface RecoverUnavailableGatewayInput extends UnavailableGatewayRecoveryParams {}

export interface SupersedeRollingSharedGatewayInput {
  sourceGatewayId: string;
  targetGatewayId: string;
  expectedLiveRelease: number;
  expectedDesiredRelease: number;
  targetHeartbeatMaxAgeMs: number;
}

export interface PlacementPolicyReconcilerDeps {
  now(): number;
  log(message: string): void;
  debug?(message: string): void;
  readSnapshot(): Promise<PlacementPolicySnapshot>;
  decidePlacementAdmission(uid: string): Promise<PlacementAdmissionDecision>;
  assignInitialPlacement(input: AssignInitialPlacementInput): Promise<void>;
  recoverUnavailableGateway(input: RecoverUnavailableGatewayInput): Promise<{ operationId: string }>;
  recoverDisposableRuntimeReset(
    input: RecoveredDisposableRuntimeResetParams,
  ): Promise<{ operationId: string }>;
  supersedeRollingSharedGateway(input: SupersedeRollingSharedGatewayInput): Promise<{
    kind: "scheduled" | "already-scheduled" | "not-eligible";
    release?: number;
    operationId?: string;
  }>;
  enqueueMigration(input: EnqueuePlacementMigrationInput): Promise<string>;
  deleteRetiredDisposableGateway(
    input: DeleteRetiredDisposableGatewayInput,
  ): Promise<boolean>;
  isolatedGateways?: IsolatedGatewayAutomation;
  sharedGatewayMoves?: SharedGatewayMoves;
}

export interface IsolatedUserReconcileInput {
  context: PlacementPolicyReconcileContext;
  user: PlacementPolicyUser;
  builderSlug: string;
  current: string | null;
}

export interface IsolatedGatewayPass {
  operations: readonly PlacementPolicyMigration[];
  reconcileUser(input: IsolatedUserReconcileInput): Promise<boolean>;
}

export interface IsolatedGatewayAutomation {
  readPass(state: PlacementPolicySnapshot): Promise<IsolatedGatewayPass>;
}

export interface SharedGatewayMoves {
  startPass(context: PlacementPolicyReconcileContext): Promise<void>;
  recoverUser(input: IsolatedUserReconcileInput): Promise<boolean>;
  placeUser(input: IsolatedUserReconcileInput): Promise<void>;
  reconcilePool(context: PlacementPolicyReconcileContext): Promise<void>;
  assignmentLimitIn(transaction: PlatformStateTransaction): Promise<number>;
}

export interface IsolatedGatewayProductDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  namespace: string;
  now(): number;
  log(message: string): void;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
  readGatewayPodDiagnostics(input: {
    namespace: string;
    gatewayId: string;
  }): Promise<{
    status: string;
    totalPods: number;
    error?: string;
  }>;
  userHome?: Omit<UserHomeMigrationDeps, "store" | "readSizingKey" | "now" | "log">;
}

export type IsolatedGatewayProductFactory = (deps: IsolatedGatewayProductDeps) => IsolatedGatewayAutomation;

export interface DeleteRetiredDisposableGatewayInput {
  gatewayId: string;
  ownerUid: string;
  generation: number;
}

export interface PlacementPolicyReconcileResult {
  assigned: number;
  enqueued: number;
  adopted: number;
  retired: number;
  swept: number;
  blocked: number;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function currentGatewayId(data: Record<string, unknown>): string | null {
  const provisioning = data.provisioning;
  if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) return null;
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  return openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
    ? nonEmptyString((openclaw as Record<string, unknown>).gatewayId)
    : null;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

export function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    const result = (value as { toMillis: () => unknown }).toMillis();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  }
  return null;
}

export interface UserActivationLease {
  raw: Record<string, unknown>;
  leaseId: string;
  generation: number;
  status: string;
  targetGatewayId: string | null;
}

// The 15s tick must not re-read the terminal journal. Only unfinished operations
// need a scan; the terminal rows any consumer looks up are addressed by
// deterministic id derived from a live activation lease, so they are fetched by
// document read instead.
export const PLACEMENT_ACTIVE_OPERATION_STATUSES = ["pending", "running"] as const;

export function userActivationLease(data: Record<string, unknown>): UserActivationLease | null {
  return activationLeaseOf(record(record(data.provisioning)?.openclaw)?.activationLease);
}

export function activationLeaseOf(value: unknown): UserActivationLease | null {
  const raw = record(value);
  const leaseId = nonEmptyString(raw?.leaseId);
  const generation = positiveInteger(raw?.generation);
  const status = nonEmptyString(raw?.status);
  if (!raw || !leaseId || !generation || !status) return null;
  return {
    raw,
    leaseId,
    generation,
    status,
    targetGatewayId: nonEmptyString(raw.targetGatewayId),
  };
}

export interface PlacementPolicyReconcileContext {
  deps: PlacementPolicyReconcilerDeps;
  state: PlacementPolicySnapshot;
  gateways: Map<string, PlacementPolicyGateway>;
  migrations: Map<string, PlacementPolicyMigration>;
  operations: Map<string, PlacementPolicyMigration>;
  assignments: Map<string, PlacementPolicyAssignment>;
  projectedSharedGatewayPlacements: Map<string, number>;
  supersededSharedGatewayIds: Set<string>;
  result: PlacementPolicyReconcileResult;
  isolatedGatewayPass: IsolatedGatewayPass | null;
  unavailableSharedHolds: Map<string, string[]>;
  unplacedHolds: string[];
}

const blockedLogs = new WeakMap<PlacementPolicyReconcilerDeps, RepeatSquelch>();

function blockedLogFor(deps: PlacementPolicyReconcilerDeps): RepeatSquelch {
  let squelch = blockedLogs.get(deps);
  if (!squelch) {
    squelch = createRepeatSquelch({ windowMs: 5 * 60_000 });
    blockedLogs.set(deps, squelch);
  }
  return squelch;
}

const isolatedHoldLogs = new WeakMap<PlacementPolicyReconcilerDeps, RepeatSquelch>();

export function transientSharedRecoveryFence(
  context: PlacementPolicyReconcileContext,
  gateway: PlacementPolicyGateway,
): string | null {
  const sharedGateway = isSharedPoolGateway(context, gateway.gatewayId) && gateway.gatewayClass === "shared";
  if (
    sharedGateway &&
    gatewayHeartbeatFresh(gateway) &&
    (gateway.kubernetesStatus === "not-ready" || gateway.kubernetesStatus === "missing")
  ) {
    return `source ${gateway.gatewayId} still has a fresh runtime heartbeat while Kubernetes reports ${gateway.kubernetesStatus}`;
  }
  if (!sharedGateway) return null;
  if (gateway.kubernetesStatus === "not-ready") {
    return `shared source ${gateway.gatewayId} still has Kubernetes pods; retaining assignments until it is missing`;
  }
  if (gateway.rollActive) {
    return `shared source ${gateway.gatewayId} is in an active roll`;
  }
  if (
    typeof gateway.recoveryGraceUntil === "number"
    && context.deps.now() < gateway.recoveryGraceUntil
  ) {
    return `shared source ${gateway.gatewayId} is inside its post-change recovery grace`;
  }
  return null;
}

async function reconcileUnavailableSharedGateway(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
): Promise<boolean> {
  if (context.deps.sharedGatewayMoves) {
    return context.deps.sharedGatewayMoves.recoverUser({ context, user, builderSlug, current });
  }
  const source = current ? context.gateways.get(current) : null;
  if (!source || source.gatewayClass !== "shared" ||
    !isSharedPoolGateway(context, source.gatewayId) || !knownKubernetesUnavailable(source)) return false;
  if (transientSharedRecoveryFence(context, source)) return true;
  const assignment = context.assignments.get(placementAssignmentKey(source.gatewayId, user.uid));
  if (!assignment || assignment.state !== "serving" || assignment.epoch === null) {
    blockPlacement(context, {
      uid: user.uid,
      code: "unavailable-source-assignment-fence",
      reason: `source ${source.gatewayId} has no exact serving assignment epoch`,
    });
    return true;
  }
  context.result.blocked += 1;
  const waiting = context.unavailableSharedHolds.get(source.gatewayId) ?? [];
  waiting.push(user.uid);
  context.unavailableSharedHolds.set(source.gatewayId, waiting);
  return true;
}

async function reconcileSharedPool(context: PlacementPolicyReconcileContext): Promise<void> {
  try {
    if (context.deps.sharedGatewayMoves) await context.deps.sharedGatewayMoves.reconcilePool(context);
    else holdDrainingSharedGateways(context);
  } catch (error) {
    context.result.blocked += 1;
    context.deps.log(
      `[placement-policy] shared placement: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function logUnplacedHolds(context: PlacementPolicyReconcileContext): void {
  logUnplacedUids(context.deps, context.unplacedHolds);
}

function logUnplacedUids(deps: PlacementPolicyReconcilerDeps, uids: readonly string[]): void {
  if (uids.length === 0) return;
  deps.log(
    `[placement-policy] ⚠ platform only: ${uids.length} user(s) have no gateway: ` +
      `${uids.join(", ")}; place them with user assign`,
  );
}

function holdUnplacedUsersWithoutPool(
  deps: PlacementPolicyReconcilerDeps,
  state: PlacementPolicySnapshot,
  result: PlacementPolicyReconcileResult,
): void {
  const unplaced = state.users
    .filter((user) => resolveDefaultPlacementEligibility(user.data).eligible && currentGatewayId(user.data) === null)
    .map((user) => user.uid)
    .sort();
  result.blocked += unplaced.length;
  logUnplacedUids(deps, unplaced);
}

function logUnavailableSharedHolds(context: PlacementPolicyReconcileContext): void {
  for (const [gatewayId, uids] of context.unavailableSharedHolds) {
    const status = context.gateways.get(gatewayId)?.kubernetesStatus ?? "unknown";
    context.deps.log(
      `[placement-policy] ⚠ platform only: ${uids.length} user(s) wait on unavailable shared gateway ${gatewayId} ` +
        `(known Kubernetes status ${status}): ${uids.join(", ")}; move them with user migrate`,
    );
  }
}

function holdDrainingSharedGateways(context: PlacementPolicyReconcileContext): void {
  for (const gatewayId of context.state.sharedGatewayIds) {
    if (context.gateways.get(gatewayId)?.desiredStatus !== "draining") continue;
    const kept = context.state.assignments.filter((assignment) => assignment.gatewayId === gatewayId).length;
    if (kept === 0) continue;
    context.result.blocked += kept;
    context.deps.log(
      `[placement-policy] ⚠ platform only: draining shared gateway ${gatewayId} keeps ${kept} user(s); ` +
        "move them one at a time with user migrate, then retire it",
    );
  }
}

function logPlatformOnlyIsolatedHold(
  context: PlacementPolicyReconcileContext,
  uid: string,
  gatewayId: string,
): void {
  let squelch = isolatedHoldLogs.get(context.deps);
  if (!squelch) {
    squelch = createRepeatSquelch({ windowMs: 60 * 60_000 });
    isolatedHoldLogs.set(context.deps, squelch);
  }
  const gateway = context.gateways.get(gatewayId);
  const observed = `desiredStatus=${gateway?.desiredStatus ?? "unknown"} kubernetes=${gateway?.kubernetesStatus ?? "unknown"} ready=${gateway?.ready ?? "unknown"}`;
  const admitted = squelch.admit(uid, `${gatewayId}:${observed}`);
  if (!admitted) return;
  context.deps.log(
    `[placement-policy] left uid=${uid} on isolated gateway ${gatewayId} (${observed}): no isolated gateway product is installed${admitted.note}`,
  );
}

export function blockPlacement(
  context: PlacementPolicyReconcileContext,
  input: {
    uid: string;
    code: string;
    reason: string;
    lease?: UserActivationLease;
  },
): void {
  context.result.blocked += 1;
  const leaseIdentity = input.lease
    ? ` lease=${input.lease.leaseId} generation=${input.lease.generation}`
    : "";
  const admitted = blockedLogFor(context.deps).admit(input.uid, `${input.code}:${input.reason}`);
  if (!admitted) return;
  const warning = input.code === NO_ACCEPTING_SHARED_GATEWAY ? "⚠ " : "";
  context.deps.log(
    `[placement-policy] ${warning}blocked code=${input.code} uid=${input.uid}${leaseIdentity}: ${input.reason}${admitted.note}`,
  );
}

export function placementAssignmentKey(gatewayId: string, uid: string): string {
  return `${gatewayId}\u0000${uid}`;
}

export function continuousPlacementMigrationOperationId(input: {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  sourceAssignmentEpoch: number;
}): string {
  if (nonNegativeInteger(input.sourceAssignmentEpoch) === null) {
    throw new Error("continuous placement requires a non-negative source assignment epoch");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([
      input.uid,
      input.builderSlug,
      input.fromGatewayId,
      input.toGatewayId,
      input.sourceAssignmentEpoch,
    ]))
    .digest("hex")
    .slice(0, 32);
  return `placement-${digest}`;
}

export function sourceAssignmentEpoch(
  context: PlacementPolicyReconcileContext,
  gatewayId: string,
  uid: string,
): number {
  const epoch = context.assignments.get(placementAssignmentKey(gatewayId, uid))?.epoch;
  const parsed = nonNegativeInteger(epoch);
  if (parsed === null) {
    throw new Error(`User ${uid} has no authoritative assignment epoch on ${gatewayId}`);
  }
  return parsed;
}

export function kubernetesReady(gateway: PlacementPolicyGateway): boolean {
  return gateway.kubernetesStatus === undefined
    ? gateway.ready
    : gateway.kubernetesStatus === "ready";
}

export function knownKubernetesUnavailable(gateway: PlacementPolicyGateway | undefined): boolean {
  return gateway?.kubernetesStatus === "missing" || gateway?.kubernetesStatus === "not-ready";
}

function gatewayRuntimeServing(gateway: PlacementPolicyGateway): boolean {
  return gateway.serving ?? gateway.ready;
}

export function gatewayHeartbeatFresh(gateway: PlacementPolicyGateway): boolean {
  return gateway.heartbeatFresh ?? gateway.ready;
}

function gatewayLiveReleaseReady(gateway: PlacementPolicyGateway): boolean {
  return gateway.liveReleaseReady ?? gateway.ready;
}

export function isPositiveRelease(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isSharedPoolGateway(
  context: PlacementPolicyReconcileContext,
  gatewayId: string | null,
): boolean {
  return gatewayId !== null && context.state.sharedGatewayIds.includes(gatewayId);
}

export function sharedGatewayCandidates(
  context: PlacementPolicyReconcileContext,
): SharedGatewayPoolCandidate[] {
  return context.state.gateways.map((gateway) => {
    const incomingMigrationCount = context.state.activeMigrations.filter(
      (operation) =>
        (operation.status === "pending" || operation.status === "running") &&
        operation.toGatewayId === gateway.gatewayId &&
        !context.assignments.has(placementAssignmentKey(gateway.gatewayId, operation.uid)),
    ).length;
    const outgoingMigrationCount = context.state.activeMigrations.filter(
      (operation) =>
        (operation.status === "pending" || operation.status === "running") &&
        operation.fromGatewayId === gateway.gatewayId &&
        context.assignments.has(placementAssignmentKey(gateway.gatewayId, operation.uid)),
    ).length;
    const assignmentCount = (
      gateway.assignmentCount ?? context.state.assignments.filter(
        (assignment) => assignment.gatewayId === gateway.gatewayId,
      ).length
    ) - outgoingMigrationCount +
      (context.projectedSharedGatewayPlacements.get(gateway.gatewayId) ?? 0);
    return {
      gatewayId: gateway.gatewayId,
      gatewayClass: gateway.gatewayClass,
      desiredStatus: gateway.desiredStatus,
      ready: kubernetesReady(gateway),
      serving: gatewayRuntimeServing(gateway),
      heartbeatFresh: gatewayHeartbeatFresh(gateway),
      liveReleaseReady: gatewayLiveReleaseReady(gateway),
      rosterComplete: gateway.rosterComplete ?? true,
      incomingMigrationCount,
      assignmentCount,
    };
  });
}

export function sharedGatewayPlacementConfig(context: PlacementPolicyReconcileContext) {
  return {
    defaultGatewayId: context.state.defaultGatewayId,
    sharedGatewayIds: context.state.sharedGatewayIds,
  };
}

export function projectSharedGatewayPlacement(
  context: PlacementPolicyReconcileContext,
  gatewayId: string,
): void {
  if (isSharedPoolGateway(context, gatewayId)) {
    context.projectedSharedGatewayPlacements.set(
      gatewayId,
      (context.projectedSharedGatewayPlacements.get(gatewayId) ?? 0) + 1,
    );
  }
}

function recoveredRuntimeResetState(user: PlacementPolicyUser): Record<string, unknown> | null {
  return record(record(record(user.data.provisioning)?.openclaw)?.runtimeReset);
}

function recoveredRuntimeResetTarget(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  currentGatewayId: string | null,
): {
  target: PlacementPolicyGateway;
  assignment: PlacementPolicyAssignment;
  epoch: number;
} | null {
  if (!currentGatewayId || !isSharedPoolGateway(context, currentGatewayId)) return null;
  const target = context.gateways.get(currentGatewayId);
  const assignment = context.assignments.get(
    placementAssignmentKey(currentGatewayId, user.uid),
  );
  if (
    !target ||
    target.gatewayClass !== "shared" ||
    !assignment ||
    assignment.state !== "serving" ||
    assignment.epoch === null
  ) return null;
  return { target, assignment, epoch: assignment.epoch };
}

function reconcileRecoveredRuntimeResetMarker(input: {
  context: PlacementPolicyReconcileContext;
  user: PlacementPolicyUser;
  builderSlug: string;
  gatewayId: string;
  assignment: PlacementPolicyAssignment;
}): boolean | null {
  const marker = recoveredRuntimeResetState(input.user);
  if (!marker) return null;
  if (marker.status === "acknowledged") return false;
  const exact = [
    marker.uid === input.user.uid,
    marker.slug === input.builderSlug,
    marker.targetGatewayId === input.gatewayId,
    marker.generation === input.assignment.epoch,
    marker.operationId === input.assignment.updatedByOperationId,
    input.assignment.source === "repair",
  ].every(Boolean);
  if (!exact || marker.status !== "pending") {
    blockPlacement(input.context, {
      uid: input.user.uid,
      code: "recovered-runtime-reset-fence",
      reason: `runtime reset marker does not match ${input.gatewayId}/${input.assignment.epoch}`,
    });
    return true;
  }
  return marker.status === "pending";
}

function recoveredRuntimeResetPreviousOperationId(
  assignment: PlacementPolicyAssignment,
  target: PlacementPolicyGateway,
  builderSlug: string,
): string | null {
  const operationId = assignment.updatedByOperationId;
  if (
    assignment.source !== "repair" ||
    typeof operationId !== "string" ||
    !operationId.startsWith("recover-disposable-") ||
    operationId.startsWith("recover-disposable-reset-") ||
    target.mountedCustomers?.includes(builderSlug)
  ) return null;
  return operationId;
}

function recoveredRuntimeResetTargetIsReady(target: PlacementPolicyGateway): boolean {
  return [
    gatewayRuntimeServing(target),
    gatewayHeartbeatFresh(target),
    gatewayLiveReleaseReady(target),
  ].every(Boolean);
}

async function reconcileRecoveredDisposableRuntimeReset(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  currentGatewayId: string | null,
): Promise<boolean> {
  const recovery = recoveredRuntimeResetTarget(context, user, currentGatewayId);
  if (!recovery || !currentGatewayId) return false;
  const markerResult = reconcileRecoveredRuntimeResetMarker({
    context,
    user,
    builderSlug,
    gatewayId: currentGatewayId,
    assignment: recovery.assignment,
  });
  if (markerResult !== null) return markerResult;
  const previousRecoveryOperationId = recoveredRuntimeResetPreviousOperationId(
    recovery.assignment,
    recovery.target,
    builderSlug,
  );
  if (!previousRecoveryOperationId) return false;
  if (!recoveredRuntimeResetTargetIsReady(recovery.target)) {
    blockPlacement(context, {
      uid: user.uid,
      code: "recovered-runtime-reset-target-unavailable",
      reason: `shared repair target ${currentGatewayId} is not a fresh serving runtime`,
    });
    return true;
  }
  const operationId = `recover-disposable-reset-${user.uid}-${currentGatewayId}-${recovery.epoch}`;
  await context.deps.recoverDisposableRuntimeReset({
    operationId,
    previousRecoveryOperationId,
    uid: user.uid,
    slug: builderSlug,
    targetGatewayId: currentGatewayId,
    expectedAssignmentEpoch: recovery.epoch,
    sharedGatewayIds: context.state.sharedGatewayIds,
    targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
  });
  return true;
}

export function currentOnIsolatedGateway(
  context: PlacementPolicyReconcileContext,
  current: string | null,
): boolean {
  return current !== null &&
    !isSharedPoolGateway(context, current) &&
    context.gateways.get(current)?.gatewayClass !== "shared";
}

async function reconcileEligibleUser(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  if (
    await reconcileRecoveredDisposableRuntimeReset(
      context,
      user,
      builderSlug,
      current,
    )
  ) return;
  if (await reconcileUnavailableSharedGateway(context, user, builderSlug, current)) return;
  if (await context.isolatedGatewayPass?.reconcileUser({ context, user, builderSlug, current })) return;
  if (currentOnIsolatedGateway(context, current)) {
    if (!context.isolatedGatewayPass) logPlatformOnlyIsolatedHold(context, user.uid, current!);
    return;
  }
  if (context.deps.sharedGatewayMoves) {
    await context.deps.sharedGatewayMoves.placeUser({ context, user, builderSlug, current });
    return;
  }
  if (current === null) {
    context.result.blocked += 1;
    context.unplacedHolds.push(user.uid);
  }
}

async function reconcilePlacementUser(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
): Promise<void> {
  const eligibility = resolveDefaultPlacementEligibility(user.data);
  if (!eligibility.eligible) return;
  await reconcileEligibleUser(context, user, eligibility.slug);
}

export function compareSharedGatewayLoad(
  left: SharedGatewayPoolCandidate,
  right: SharedGatewayPoolCandidate,
): number {
  const loadDifference = authoritativeSharedGatewayLoad(left) - authoritativeSharedGatewayLoad(right);
  return loadDifference !== 0 ? loadDifference : compareSharedGatewayIds(left.gatewayId, right.gatewayId);
}

export async function reconcilePlacementPolicyOnce(
  deps: PlacementPolicyReconcilerDeps,
): Promise<PlacementPolicyReconcileResult> {
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    retired: 0,
    swept: 0,
    blocked: 0,
  };
  const state = await deps.readSnapshot();
  const pool = parseSharedGatewayPoolConfig({
    defaultGatewayId: state.defaultGatewayId,
    sharedGatewayIds: state.sharedGatewayIds,
  });
  if (!pool) {
    deps.log("[placement-policy] idle: the shared pool has no controller-managed members yet");
    if (!deps.sharedGatewayMoves) holdUnplacedUsersWithoutPool(deps, state, result);
    return result;
  }
  const gateways = new Map(state.gateways.map((item) => [item.gatewayId, item]));
  const unknownMirrorGatewayIds = state.users
    .flatMap((user) => {
      const gatewayId = currentGatewayId(user.data);
      return gatewayId && !gateways.has(gatewayId) ? [gatewayId] : [];
    })
    .sort();
  if (unknownMirrorGatewayIds.length > 0) {
    deps.log(
      `[placement-policy] disabled: user mirrors reference missing gateways ${[...new Set(unknownMirrorGatewayIds)].join(",")}`,
    );
    return result;
  }
  const migrations = new Map(
    state.activeMigrations
      .filter((item) => item.status === "pending" || item.status === "running")
      .map((item) => [item.uid, item]),
  );
  const isolatedGatewayPass = await deps.isolatedGateways?.readPass(state) ?? null;
  const operations = new Map(
    [...state.activeMigrations, ...isolatedGatewayPass?.operations ?? []].map((item) => [item.id, item]),
  );
  const assignments = new Map(
    state.assignments.map((assignment) => [
      placementAssignmentKey(assignment.gatewayId, assignment.uid),
      assignment,
    ]),
  );

  const context = {
    deps,
    state,
    gateways,
    migrations,
    operations,
    assignments,
    projectedSharedGatewayPlacements: new Map<string, number>(),
    supersededSharedGatewayIds: new Set<string>(),
    result,
    isolatedGatewayPass,
    unavailableSharedHolds: new Map<string, string[]>(),
    unplacedHolds: [],
  };
  await deps.sharedGatewayMoves?.startPass(context);
  for (const user of [...state.users].sort((a, b) => a.uid.localeCompare(b.uid))) {
    try {
      await reconcilePlacementUser(context, user);
    } catch (error) {
      result.blocked += 1;
      deps.log(
        `[placement-policy] ${user.uid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  logUnavailableSharedHolds(context);
  logUnplacedHolds(context);
  await reconcileSharedPool(context);
  try {
    await reconcileDisposableTombstones(context);
  } catch (error) {
    result.blocked += 1;
    deps.log(
      `[placement-policy] tombstone sweep: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

function liveLeaseTargetGatewayIds(
  users: ReadonlyArray<PlacementPolicyUser>,
): Set<string> {
  const targets = new Set<string>();
  for (const user of users) {
    const lease = record(record(record(user.data.provisioning)?.openclaw)?.activationLease);
    const target = lease ? nonEmptyString(lease.targetGatewayId) : null;
    if (lease && target && LIVE_LEASE_STATUSES.has(String(lease.status))) {
      targets.add(target);
    }
  }
  return targets;
}

// Disposable runtimes leave no fleet tombstone: once retirement cleanup has
// succeeded, the durable record is deleted and the user's placement
// receipts become the audit trail.
async function reconcileDisposableTombstones(
  context: PlacementPolicyReconcileContext,
): Promise<void> {
  const liveTargets = liveLeaseTargetGatewayIds(context.state.users);
  const candidates = context.state.gateways
    .filter((gateway) =>
      gateway.disposable &&
      gateway.desiredStatus === "retired" &&
      gateway.ownerUid !== null &&
      gateway.allocation?.generation !== undefined &&
      !liveTargets.has(gateway.gatewayId))
    .sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
  for (const gateway of candidates) {
    const deleted = await context.deps.deleteRetiredDisposableGateway({
      gatewayId: gateway.gatewayId,
      ownerUid: gateway.ownerUid!,
      generation: gateway.allocation!.generation,
    });
    if (deleted) {
      context.result.swept += 1;
    }
  }
}

function placementMigrationStatus(
  value: unknown,
): PlacementPolicyMigration["status"] | null {
  if (
    value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === ROLLED_BACK_STATUS
  ) {
    return value;
  }
  return null;
}

function placementMigrationSource(
  value: unknown,
): PlacementPolicyMigration["source"] | null {
  if (value === CONTINUOUS_PLACEMENT_POLICY_SOURCE) return value;
  if (value === USER_ACTIVATION_LEASE_SOURCE) return value;
  return null;
}

export function activeMigration(operation: Stored<OperationRecord>): PlacementPolicyMigration | null {
  const data = operation as unknown as Record<string, unknown>;
  if (data.kind !== MIGRATE_USER_KIND) return null;
  const input = record(data.input);
  if (!input) return null;
  const uid = nonEmptyString(input.uid) ?? nonEmptyString(data.inputUid);
  const builderSlug = nonEmptyString(input.userSlug);
  const fromGatewayId = nonEmptyString(input.fromGatewayId);
  const toGatewayId = nonEmptyString(input.toGatewayId);
  const source = placementMigrationSource(input.source);
  const status = placementMigrationStatus(data.status);
  if (!uid || !builderSlug || !fromGatewayId || !toGatewayId || !source || !status) return null;
  return {
    id: operation.id,
    uid,
    builderSlug,
    fromGatewayId,
    toGatewayId,
    source,
    status,
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    ...(schedulerHandoffAwaitingRelease(data) ? { sourceRecoveryPending: true } : {}),
    ...(millis(data.retryRequestedAt) !== null ? { retryRequested: true } : {}),
    ...(sharedRevisionPreflightReturnRetryable(data, operation.id) ? { sharedRevisionRetryable: true } : {}),
  };
}

export interface FirestorePlacementPolicyInput {
  store: PlatformStateStore;
  placementAdmission: PlacementAdmissionPolicy;
  policyInputs: UserPolicyInputsSource;
  informer: FleetInformer;
  namespace: string;
  platformArtifact: ReleasePayload;
  now(): number;
  log(message: string): void;
  debug?(message: string): void;
  isolatedGateways?: IsolatedGatewayAutomation;
  sharedGatewayMoves?: SharedGatewayMoves;
  readGatewayPodDiagnosticsBatch(input: {
    namespace: string;
    gatewayIds: readonly string[];
    includeReplicaSets?: boolean;
  }): Promise<Record<string, PlacementPolicyPodDiagnostics>>;
}

export function placementPodDiagnosticsScope(
  gatewayIds: readonly string[],
  runtimes: ReadonlyMap<string, Pick<FleetRegistryRecord, "runtime">>,
): {
  clusterGatewayIds: string[];
  vmDiagnostics: Record<string, PlacementPolicyPodDiagnostics>;
} {
  const clusterGatewayIds: string[] = [];
  const vmDiagnostics: Record<string, PlacementPolicyPodDiagnostics> = {};
  for (const gatewayId of gatewayIds) {
    if (resolveGatewayRuntime(runtimes.get(gatewayId)?.runtime) === "gce-vm") {
      vmDiagnostics[gatewayId] = { status: "unknown", totalPods: 0, readyPods: 0 };
    } else {
      clusterGatewayIds.push(gatewayId);
    }
  }
  return { clusterGatewayIds, vmDiagnostics };
}

// Must stay a reconcile tick inside GATEWAY_UNREACHABLE_AFTER_MS.
export const KUBERNETES_OBSERVATION_REFRESH_MS = 120_000;

interface KubernetesObservation {
  status: string;
  totalPods: number;
  readyPods: number;
}

// Structured record mirroring octogee.disruption.v1: emitted to stdout so Cloud
// Logging can extract gateway_id / instance_id / node_pool as log-metric labels.
// instance_id is the join key against octogee_spot_preemptions, which knows the
// preempted instance but not which gateway was running on it. Node identity is
// "unknown" rather than null when the pod was never observed on a node, so the
// metric carries an explicit unattributed series instead of a blank label.
export interface GatewayPodReplacementRecord {
  schema: typeof GATEWAY_POD_REPLACEMENT_SCHEMA;
  recordType: "gateway_pod_replacement";
  observedAt: string;
  namespace: string;
  gatewayId: string;
  podName: string;
  vacatedPodUid: string;
  replicaSetUid: string;
  nodeName: string;
  instanceId: string;
  nodePool: string;
  total: number;
}

export const UNATTRIBUTED_NODE_IDENTITY = "unknown";

function emitGatewayPodReplacementRecord(value: GatewayPodReplacementRecord): void {
  eventLogger.info("Gateway pod replaced", { ...value });
}

function storedPodPlacements(
  stored: Record<string, unknown> | null,
): GatewayPodPlacement[] | null {
  const pods = stored?.pods;
  if (!Array.isArray(pods)) return null;
  const placements: GatewayPodPlacement[] = [];
  for (const pod of pods) {
    if (!isGatewayPodPlacement(pod)) return null;
    placements.push({
      uid: pod.uid,
      name: pod.name,
      replicaSetUid: pod.replicaSetUid,
      nodeName: pod.nodeName,
      instanceId: pod.instanceId,
      nodePool: pod.nodePool,
    });
  }
  return placements;
}

function samePodPlacement(left: GatewayPodPlacement, right: GatewayPodPlacement): boolean {
  return left.uid === right.uid &&
    left.name === right.name &&
    left.replicaSetUid === right.replicaSetUid &&
    left.nodeName === right.nodeName &&
    left.instanceId === right.instanceId &&
    left.nodePool === right.nodePool;
}

// A Spot preemption replaces the pod without changing readyPods or the restart
// count, so pod identity has to be part of the freshness comparison — otherwise
// a loss inside the refresh interval is skipped and never recorded. Node facts
// are compared too: a pod first seen Pending binds to its node later, and the
// instance id it lands on must be persisted before that node can be preempted.
function samePodPlacements(
  stored: Record<string, unknown> | null,
  observed: readonly GatewayPodPlacement[] | null,
): boolean {
  if (observed === null) return true;
  const previous = storedPodPlacements(stored);
  if (previous === null) return false;
  return previous.length === observed.length &&
    previous.every((pod, index) => samePodPlacement(pod, observed[index]!));
}

function kubernetesObservationIsCurrent(input: {
  stored: unknown;
  observed: KubernetesObservation;
  observedPlacements: readonly GatewayPodPlacement[] | null;
  now: number;
}): boolean {
  const { observed, observedPlacements, now } = input;
  const current = record(input.stored);
  if (!current) return false;
  const observedAt = current.observedAt;
  if (typeof observedAt !== "number") return false;
  if (observedAt > now || now - observedAt >= KUBERNETES_OBSERVATION_REFRESH_MS) return false;
  return current.status === observed.status &&
    current.totalPods === observed.totalPods &&
    current.readyPods === observed.readyPods &&
    samePodPlacements(current, observedPlacements);
}

interface KubernetesObservationOutcome {
  transition: PodReplacementTransition | null;
  malformedReplacements: boolean;
}

function persistedKubernetesObservation(input: {
  observed: KubernetesObservation;
  now: number;
  transition: PodReplacementTransition | null;
}): { kubernetes: Record<string, unknown>; podReplacements?: GatewayPodReplacements } {
  const { observed, now, transition } = input;
  if (transition === null) return { kubernetes: { ...observed, observedAt: now } };
  return {
    kubernetes: { ...observed, observedAt: now, pods: transition.placements },
    ...(transition.replacements ? { podReplacements: transition.replacements } : {}),
  };
}

function gatewayPodReplacementRecord(input: {
  gatewayId: string;
  namespace: string;
  vacated: GatewayPodPlacement;
  total: number;
  now: number;
}): GatewayPodReplacementRecord {
  const { vacated } = input;
  return {
    schema: GATEWAY_POD_REPLACEMENT_SCHEMA,
    recordType: "gateway_pod_replacement",
    observedAt: new Date(input.now).toISOString(),
    namespace: input.namespace,
    gatewayId: input.gatewayId,
    podName: vacated.name,
    vacatedPodUid: vacated.uid,
    replicaSetUid: vacated.replicaSetUid ?? UNATTRIBUTED_NODE_IDENTITY,
    nodeName: vacated.nodeName ?? UNATTRIBUTED_NODE_IDENTITY,
    instanceId: vacated.instanceId ?? UNATTRIBUTED_NODE_IDENTITY,
    nodePool: vacated.nodePool ?? UNATTRIBUTED_NODE_IDENTITY,
    total: input.total,
  };
}

function describePlacement(pod: GatewayPodPlacement): string {
  return `${pod.name} (uid=${pod.uid} rs=${pod.replicaSetUid ?? "none"} node=${pod.nodeName ?? "unscheduled"} ` +
    `instance=${pod.instanceId ?? "unknown"} nodePool=${pod.nodePool ?? "unknown"})`;
}

// Log lines and the structured record are emitted only after the transaction
// has committed: firebase-admin re-runs the transaction callback on contention,
// and a DELTA log metric would count every retry as another loss.
function reportKubernetesObservationOutcome(input: {
  gatewayId: string;
  outcome: KubernetesObservationOutcome;
  now: number;
  options: PersistKubernetesObservationsOptions;
}): void {
  const { gatewayId, outcome, now, options } = input;
  const log = options.log ?? (() => undefined);
  if (outcome.malformedReplacements) {
    log(`[placement-policy] ${gatewayId} stored podReplacements were malformed; restarting the loss history`);
  }
  const transition = outcome.transition;
  if (!transition) return;
  for (const pod of transition.deferred) {
    log(
      `[placement-policy] ${gatewayId} pod ${describePlacement(pod)} is missing from the pod list but ` +
        `its ReplicaSet still counts it; deferring the verdict to the next observation`,
    );
  }
  for (const pod of transition.unowned) {
    log(`[placement-policy] ${gatewayId} pod ${describePlacement(pod)} vanished with no ReplicaSet owner; not counted`);
  }
  for (const pod of transition.vacated) {
    log(
      `[placement-policy] ${gatewayId} lost pod ${describePlacement(pod)} while its ReplicaSet ` +
        `still wanted it running; total=${transition.replacements?.total ?? 0}`,
    );
    (options.emitReplacement ?? emitGatewayPodReplacementRecord)(gatewayPodReplacementRecord({
      gatewayId,
      namespace: options.namespace ?? UNATTRIBUTED_NODE_IDENTITY,
      vacated: pod,
      total: transition.replacements?.total ?? 0,
      now,
    }));
  }
}

export interface PersistKubernetesObservationsOptions {
  log?: (message: string) => void;
  emitReplacement?: (record: GatewayPodReplacementRecord) => void;
  namespace?: string;
}

export interface ScannedGatewayRuntime {
  gatewayId: string;
  kubernetes: unknown;
}

export async function persistKubernetesObservations(
  store: PlatformStateStore,
  runtimes: ReadonlyArray<ScannedGatewayRuntime>,
  kubernetesByGatewayId: Readonly<Record<string, PlacementPolicyPodDiagnostics>>,
  now: number,
  options: PersistKubernetesObservationsOptions = {},
): Promise<void> {
  if (runtimes.length === 0) return;
  await Promise.all(runtimes.map(async (scanned) => {
    const diagnostics = kubernetesByGatewayId[scanned.gatewayId];
    const observed: KubernetesObservation = {
      status: placementKubernetesStatus(diagnostics),
      totalPods: diagnostics?.totalPods ?? 0,
      readyPods: diagnostics?.readyPods ?? 0,
    };
    const observedPlacements = observedPodPlacements(diagnostics);
    const replicaSets = observedReplicaSets(diagnostics);
    if (kubernetesObservationIsCurrent({
      stored: scanned.kubernetes,
      observed,
      observedPlacements,
      now,
    })) return;
    const outcome = await store.transaction(
      { label: "placement-policy.kubernetes-observation" },
      async (transaction): Promise<KubernetesObservationOutcome | null> => {
        const current = await transaction.fleetRegistry.get(scanned.gatewayId);
        if (current === null) return null;
        const storedKubernetes = record(current.kubernetes);
        const storedObservedAt = storedKubernetes?.observedAt;
        if (typeof storedObservedAt === "number" && storedObservedAt > now) return null;
        const malformedReplacements = current.podReplacements !== undefined &&
          !isGatewayPodReplacements(current.podReplacements);
        const transition = nextPodReplacementTransition({
          previousPlacements: storedPodPlacements(storedKubernetes),
          previous: isGatewayPodReplacements(current.podReplacements) ? current.podReplacements : null,
          observedPlacements,
          replicaSets,
          now,
        });
        const persisted = persistedKubernetesObservation({ observed, now, transition });
        await transaction.fleetRegistry.patch(scanned.gatewayId, {
          ...persisted,
          kubernetes: { ...storedKubernetes, ...persisted.kubernetes } as unknown as GatewayKubernetesObservation,
        }, { revision: current.revision });
        return { transition, malformedReplacements };
      },
    );
    if (outcome) {
      reportKubernetesObservationOutcome({ gatewayId: scanned.gatewayId, outcome, now, options });
    }
  }));
}

function placementAssignmentFromRecord(assignment: GatewayAssignment): PlacementPolicyAssignment {
  return {
    uid: assignment.uid,
    slug: assignment.slug,
    gatewayId: assignment.gatewayId,
    state: assignment.state,
    epoch: assignment.epoch,
    createdAt: assignment.createdAt,
    source: assignment.source,
    ...(assignment.updatedByOperationId ? { updatedByOperationId: assignment.updatedByOperationId } : {}),
  };
}

function gatewayRuntimeStartedAt(input: {
  gatewayId: string;
  gatewayClass: string;
  runtime: FleetRegistryRecord | null;
  diagnostics: PlacementPolicyPodDiagnostics | undefined;
}): number | null {
  const heartbeatStartedAt = input.runtime ? millis(input.runtime.heartbeat.startedAt) : null;
  if (input.gatewayClass !== "isolated" || resolveGatewayRuntime(input.runtime?.runtime) !== "cluster") {
    return heartbeatStartedAt;
  }
  return heartbeatStartedAt ?? gatewayPodStartedAt(input.gatewayId, input.diagnostics);
}

function gatewayPodStartedAt(
  gatewayId: string,
  diagnostics: PlacementPolicyPodDiagnostics | undefined,
): number | null {
  if (!diagnostics || diagnostics.error || diagnostics.status === "unknown" ||
      !diagnostics.pods || diagnostics.totalPods !== diagnostics.pods.length) return null;
  const currentPods = diagnostics.pods.filter((pod) => Boolean(
    pod.uid && pod.gatewayId === gatewayId && pod.deleting === false &&
    pod.phase === "Running" && pod.name?.startsWith(`octogee-gateway-${gatewayId}-`) &&
    diagnostics.replicaSets?.some(owner => owner.uid === pod.replicaSetUid && owner.desiredReplicas > 0) &&
    millis(pod.gatewayContainerStartedAt) !== null,
  ));
  return currentPods.length === 1 ? millis(currentPods[0].gatewayContainerStartedAt) : null;
}

function gatewayVmStartedAt(runtime: FleetRegistryRecord | null): number | null {
  if (runtime?.runtime !== "gce-vm") return null;
  return runtime.vm?.status === "RUNNING" ? millis(runtime.vm.startedAt) : null;
}

function gatewayRuntimeObservation(runtime: FleetRegistryRecord | null) {
  return {
    runtime: isGatewayRuntime(runtime?.runtime) ? runtime.runtime : undefined,
    vmStartedAt: gatewayVmStartedAt(runtime),
    runtimeStatus: runtime?.heartbeat.status,
  };
}

function runtimeConfiguredUser(runtime: FleetRegistryRecord | null): ConfiguredUserReport | null {
  return runtime ? parseConfiguredUserReport(runtime.heartbeat.configuredBuilder) : null;
}

function placementGatewayFromRoot(input: {
  stored: Stored<GatewayRoot>;
  runtimes: ReadonlyMap<string, Stored<FleetRegistryRecord>>;
  assignments: readonly PlacementPolicyAssignment[];
  kubernetesByGatewayId: Readonly<Record<string, PlacementPolicyPodDiagnostics>>;
  now: number;
}): PlacementPolicyGateway | null {
  const { stored, runtimes, assignments, kubernetesByGatewayId, now } = input;
  const gatewayId = stored.gatewayId;
  const root = projectGatewayDesiredRootForGateway(stored, gatewayId);
  if (!root) return null;
  const runtime = runtimes.get(gatewayId) ?? null;
  const heartbeatAt = millis(runtime?.heartbeat.lastHeartbeatAt);
  const heartbeatFresh = heartbeatAt === null
    ? false
    : now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
  const runtimeReady = [
    runtime !== null,
    root.liveRelease !== null,
    root.desiredRelease === root.liveRelease,
    runtime?.release === root.liveRelease,
    runtime?.lifecycle === "serving",
    runtime?.heartbeat.status === "ready",
    heartbeatFresh,
  ].every(Boolean);
  const assigned = assignments.filter((assignment) => assignment.gatewayId === gatewayId);
  const mounted = new Set(runtime?.heartbeat.mountedCustomers ?? []);
  return {
    gatewayId,
    gatewayClass: root.gatewayClass,
    ownerUid: root.ownerUid,
    builderSlug: root.builderSlug,
    sizingTier: root.sizingTier,
    desiredStatus: root.desiredStatus,
    disposable: root.allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND,
    configuredBuilder: runtimeConfiguredUser(runtime),
    allocation: root.allocation ?? null,
    ready: runtimeReady,
    ...gatewayRuntimeObservation(runtime),
    kubernetesStatus: placementKubernetesStatus(kubernetesByGatewayId[gatewayId]),
    serving: runtime?.lifecycle === "serving",
    heartbeatFresh,
    runtimeStartedAt: gatewayRuntimeStartedAt({
      gatewayId,
      gatewayClass: root.gatewayClass,
      runtime,
      diagnostics: kubernetesByGatewayId[gatewayId],
    }),
    liveReleaseReady: [
      runtime !== null,
      root.liveRelease !== null,
      root.desiredRelease === root.liveRelease,
      runtime?.release === root.liveRelease,
    ].every(Boolean),
    rosterComplete: assigned.every((assignment) => mounted.has(assignment.slug)),
    assignmentCount: assigned.length,
    addedBy: root.gatewayClass === "shared" ? sharedGatewayAddedBy(root) : null,
    latestRelease: root.latestRelease,
    desiredRelease: root.desiredRelease,
    liveRelease: root.liveRelease,
    rollActive: root.desiredRelease !== root.liveRelease,
    recoveryGraceUntil: root.updatedAt + SHARED_GATEWAY_RECOVERY_GRACE_MS,
    mountedCustomers: [...mounted],
  };
}


async function readPlatformCurrentSharedGatewayIds(
  input: FirestorePlacementPolicyInput,
  sharedGateways: readonly PlacementPolicyGateway[],
): Promise<string[]> {
  const platformHash = releasePayloadHash(input.platformArtifact);
  const current = await Promise.all(sharedGateways.map(async (gateway) => {
    const release = gateway.latestRelease === undefined
      ? null
      : await input.store.gateways.releases.get(gateway.gatewayId, gateway.latestRelease);
    const payload = release?.payload;
    if (!isReleasePayload(payload)) {
      throw new Error(
        `shared pool member ${gateway.gatewayId} latest release ${gateway.latestRelease} has no readable payload`,
      );
    }
    return releasePayloadHash(payload) === platformHash;
  }));
  return sharedGateways
    .filter((_gateway, index) => current[index])
    .map((gateway) => gateway.gatewayId);
}

async function readPlacementUsers(
  informer: FleetInformer,
  store: PlatformStateStore,
  log: (message: string) => void,
): Promise<readonly Stored<PlatformUserRecord>[]> {
  const mirrored = informer.usersWithoutMalformed();
  if (mirrored === null) return store.users.records.listAll();
  if (mirrored.malformedKeys.length > 0) {
    log(`[placement-policy] ⚠ skipping malformed user records: ${mirrored.malformedKeys.join(", ")}`);
  }
  return mirrored.records;
}

async function readPlacementPolicySnapshot(
  input: FirestorePlacementPolicyInput,
): Promise<PlacementPolicySnapshot> {
  const { store, now: nowFn, informer, policyInputs } = input;
  const now = nowFn();
  const [orchestrator, userRecords, currentPolicyInputs, roots, runtimeRecords, activeOperations, assignmentRecords, sharedPoolReplacements] =
    await Promise.all([
      store.config.orchestrator.get(),
      readPlacementUsers(informer, store, input.log),
      policyInputs.current() ?? policyInputs.list(),
      informer.gateways() ?? store.gateways.roots.list(),
      informer.fleetRegistry() ?? store.fleetRegistry.list(),
      store.journal.operations.listByStatus([...PLACEMENT_ACTIVE_OPERATION_STATUSES]),
      informer.assignments() ?? store.gateways.assignments.listAll(),
      readSharedPoolReplacements(store),
    ]);
  const users: PlacementPolicyUser[] = userRecords.map((userRecord) => ({
    uid: userRecord.uid,
    data: userPlacementDocument(userRecord, currentPolicyInputs.get(userRecord.uid) ?? {}),
  }));
  const pool = deriveSharedGatewayPoolConfig(roots.map((root) => ({
    gatewayId: root.gatewayId,
    gatewayClass: root.gatewayClass,
    desiredStatus: root.desiredStatus,
  })));
  const defaultGatewayId = pool?.defaultGatewayId ?? "";
  const sharedGatewayIds = pool?.sharedGatewayIds ?? [];
  const runtimes = new Map(runtimeRecords.map((runtime) => [runtime.gatewayId, runtime]));
  const diagnosticsScope = placementPodDiagnosticsScope(roots.map((root) => root.gatewayId), runtimes);
  const kubernetesByGatewayId = {
    ...diagnosticsScope.vmDiagnostics,
    ...await input.readGatewayPodDiagnosticsBatch({
      namespace: input.namespace,
      gatewayIds: diagnosticsScope.clusterGatewayIds,
      includeReplicaSets: true,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[placement-policy] Kubernetes diagnostics unreadable; treating fleet as unknown: ${message}`);
      return Object.fromEntries(diagnosticsScope.clusterGatewayIds.map((gatewayId) => [gatewayId, {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
      }]));
    }),
  };
  await persistKubernetesObservations(input.store, runtimeRecords.map((runtime) => ({
    gatewayId: runtime.gatewayId,
    kubernetes: runtime.kubernetes,
  })), kubernetesByGatewayId, now, {
    log: input.log,
    namespace: input.namespace,
  });
  const assignments = assignmentRecords.map(placementAssignmentFromRecord);
  const gateways = roots
    .map((stored) => placementGatewayFromRoot({
      stored,
      runtimes,
      assignments,
      kubernetesByGatewayId,
      now,
    }))
    .filter((gateway): gateway is PlacementPolicyGateway => gateway !== null);
  const platformCurrentGatewayIds = await readPlatformCurrentSharedGatewayIds(
    input,
    gateways.filter((gateway) => sharedGatewayIds.includes(gateway.gatewayId)),
  );
  return {
    sizingProfiles: orchestrator?.sizingProfiles ?? {},
    defaultGatewayId,
    sharedGatewayIds,
    platformCurrentGatewayIds,
    sharedPoolReplacements,
    users,
    gateways,
    assignments,
    activeMigrations: activeOperations.flatMap((operation) => activeMigration(operation) ?? []),
  };
}

function unavailableRecoveryTargetFence(
  request: UnavailableGatewayRecoveryParams,
): (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void> {
  return async (context) => {
    const pool = await readSharedGatewayPoolConfigInStore(context.transaction);
    if (
      pool === null ||
      pool.sharedGatewayIds.length !== request.sharedGatewayIds.length ||
      pool.sharedGatewayIds.some((gatewayId, index) => gatewayId !== request.sharedGatewayIds[index]) ||
      !pool.sharedGatewayIds.includes(context.targetGatewayId)
    ) {
      throw new Error("shared gateway pool changed before unavailable-source recovery");
    }
  };
}

async function assignInitialPlacementInStore(
  input: FirestorePlacementPolicyInput,
  request: AssignInitialPlacementInput,
): Promise<void> {
  const placement = await commitInitialPlacement(input.store, request, {
    nowMs: input.now(),
    log: input.log,
    assignmentLimitIn: input.sharedGatewayMoves?.assignmentLimitIn,
  });
  if (placement.kind === "rejected") {
    throw new Error(`initial placement onto ${request.gatewayId} failed: ${placement.reason}`);
  }
}

function isAutomaticRolledBackPlacement(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  return request.source === CONTINUOUS_PLACEMENT_POLICY_SOURCE
    && data.status === "failed"
    && data.origin === "automatic"
    && data.createdBy === PLACEMENT_POLICY_ACTOR
    && data.rolledBack === true
    && data.userMigrationV2 === undefined
    && millis(data.completedAt) !== null;
}

function rolledBackTransientPlacementCanRearm(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  if (!isAutomaticRolledBackPlacement(data, request)) return false;
  const error = typeof data.error === "string" ? data.error : null;
  const attempts = positiveInteger(data.attempts);
  const history = Array.isArray(data.attemptHistory) ? data.attemptHistory : null;
  const lastAttempt = record(history?.at(-1));
  return error !== null &&
    classifyOperationFailure(error) === "transient" &&
    attempts !== null &&
    positiveInteger(lastAttempt?.attempt) === attempts &&
    lastAttempt?.error === error;
}

function existingPlacementMigrationMatchesDemand(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  const operationInput = record(data.input);
  return [
    data.kind === MIGRATE_USER_KIND,
    operationInput?.uid === request.uid,
    operationInput?.userSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.toGatewayId === request.toGatewayId,
    operationInput?.source === request.source,
  ].every(Boolean);
}

function operatorRetriedUserReturnMatchesDemand(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  const operationInput = record(data.input);
  return [
    request.source === USER_ACTIVATION_LEASE_SOURCE,
    data.kind === MIGRATE_USER_KIND,
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

function startupFailedReturnMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const original = record(data.input);
  return request.source === USER_ACTIVATION_LEASE_SOURCE && data.kind === MIGRATE_USER_KIND &&
    data.status === "failed" && data.origin === "automatic" && data.createdBy === PLACEMENT_POLICY_ACTOR &&
    data.userMigrationV2 === undefined && data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined &&
    original?.uid === request.uid && original.userSlug === request.builderSlug &&
    original.fromGatewayId === request.fromGatewayId && original.source === request.source &&
    isGatewayStartupUnavailable(typeof data.error === "string" ? data.error : undefined);
}

function sharedRevisionPreflightReturnRetryable(data: Record<string, unknown>, operationId: string): boolean {
  const original = record(data.input);
  return [
    data.kind === MIGRATE_USER_KIND,
    data.status === "failed",
    data.origin === "automatic",
    data.createdBy === PLACEMENT_POLICY_ACTOR,
    original?.source === USER_ACTIVATION_LEASE_SOURCE,
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

function sharedRevisionReturnMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const original = record(data.input);
  return sharedRevisionPreflightReturnRetryable(data, request.operationId) &&
    request.source === USER_ACTIVATION_LEASE_SOURCE && original?.uid === request.uid &&
    original.userSlug === request.builderSlug && original.fromGatewayId === request.fromGatewayId;
}

function preRpcAuthorityFailure(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const step = record(steps[0]);
  return request.source === CONTINUOUS_PLACEMENT_POLICY_SOURCE && data.status === "failed" &&
    data.origin === "automatic" && data.createdBy === PLACEMENT_POLICY_ACTOR &&
    data.userMigrationV2 === undefined && data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined &&
    data.error === "workspace migration phase authority changed" && steps.length === 1 &&
    step?.name === "keys-sync-state" && step.status === "failed" && step.error === data.error;
}

function sourceOnlyRollbackCompleted(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const step = record(steps[0]);
  return isAutomaticRolledBackPlacement(data, request) && record(data.input)?.recoverSourceOnly === true &&
    sourceRecoveryForwardRetryable({ ...data, id: request.operationId } as unknown as Parameters<typeof sourceRecoveryForwardRetryable>[0]) &&
    data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined && steps.length === 1 &&
    step?.name === "recover-source" && step.status === "done";
}

export function userGatewayId(userRecord: Stored<PlatformUserRecord> | null): string | null {
  return nonEmptyString(userRecord?.gateway?.gatewayId);
}

function userMutationFenced(userRecord: Stored<PlatformUserRecord> | null): boolean {
  return userRecord !== null && isolatedRuntimeMutationFenced(userRecord);
}

async function assertPreRpcRetryAuthority(
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationInput,
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
  if (!exact) throw new Error("workspace migration retry authority remains blocked");
  return source!;
}

function retrySourceAssignmentMatches(assignment: GatewayAssignment | null, request: EnqueuePlacementMigrationInput): assignment is GatewayAssignment {
  return assignment?.uid === request.uid && assignment.gatewayId === request.fromGatewayId &&
    assignment.state === "serving" && Number.isSafeInteger(assignment.epoch) && assignment.epoch >= 0;
}

function startupReturnLeaseMatches(userRecord: Stored<PlatformUserRecord> | null, lease: UserActivationLease | null, request: EnqueuePlacementMigrationInput): lease is UserActivationLease {
  return !userMutationFenced(userRecord) && userGatewayId(userRecord) === request.fromGatewayId &&
    lease?.status === "returning" && lease.targetGatewayId === request.fromGatewayId && lease.raw.returnOperationId === request.operationId;
}

function startupReturnSourceMatches(root: ReturnType<typeof projectGatewayDesiredRootForGateway>, lease: UserActivationLease, request: EnqueuePlacementMigrationInput): boolean {
  const allocation = root?.allocation;
  return root?.gatewayClass === "isolated" && root.ownerUid === request.uid && root.desiredStatus !== "retired" &&
    allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND && allocation.claimedByUid === request.uid &&
    allocation.leaseId === lease.leaseId && allocation.generation === lease.generation;
}

function sharedReturnTargetReady(root: ReturnType<typeof projectGatewayDesiredRootForGateway>, runtime: Stored<FleetRegistryRecord> | null, request: EnqueuePlacementMigrationInput, now: number): boolean {
  if (!root || runtime === null) return false;
  const heartbeatAt = millis(runtime.heartbeat.lastHeartbeatAt);
  return root.gatewayClass === "shared" && root.desiredStatus === "running" && root.liveRelease !== null &&
    root.liveRelease === root.desiredRelease && runtime.gatewayId === request.toGatewayId && runtime.release === root.liveRelease &&
    runtime.lifecycle === "serving" && runtime.heartbeat.status === "ready" &&
    heartbeatAt !== null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

async function assertStartupReturnAuthority(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationInput,
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
    pool?.sharedGatewayIds.includes(request.toGatewayId) && sharedReturnTargetReady(targetRoot, runtime, request, input.now());
  if (!exact) throw new Error("User startup return retry authority changed");
  return { assignment, source, target };
}

async function assertSharedRevisionReturnAuthority(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationInput & { previousTargetGatewayId: string },
): Promise<void> {
  const authority = await assertStartupReturnAuthority(input, transaction, userRecord, request);
  const previousTargetAssignment = await transaction.gateways.assignments.get(request.previousTargetGatewayId, request.uid);
  const rootsUnfenced = [authority.source, authority.target].every(root =>
    root?.runtimeRestartFence === undefined && root?.retirementClaim === undefined);
  const exact = rootsUnfenced && authority.source?.desiredStatus === "running" &&
    authority.assignment?.slug === request.builderSlug && userRecord?.fences.migration === undefined &&
    previousTargetAssignment === null;
  if (!exact) throw new Error("User revision return retry authority changed");
}

function proofRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(row => record(row) !== null) ? value : [];
}
function capturedPostgresRosterMatches(source: Record<string, unknown>): boolean {
  const assignments = proofRows(source.assignments), stores = proofRows(source.postgresAgentStores);
  return [stores.length > 0, assignments.length > 0,
    stores.every(store => {
      const owner = assignments.find(row => row.uid === store.uid);
      return owner && store.slug === owner.slug && store.assignmentEpoch === owner.assignmentEpoch &&
        typeof store.agentId === "string" && typeof owner.slug === "string" && agentIdBelongsToSlug(store.agentId, owner.slug) &&
        typeof store.storeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(store.storeId) &&
        typeof store.schema === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(store.schema);
    }),
    assignments.every(owner => stores.some(store => store.uid === owner.uid && store.agentId === owner.agentId)),
    new Set(stores.map(store => store.agentId)).size === stores.length, new Set(stores.map(store => store.storeId)).size === stores.length,
    new Set(stores.map(store => store.schema)).size === stores.length].every(Boolean);
}

function completedPostgresDoctorMatches(input: { source: Record<string, unknown>; completed: Record<string, unknown>; repairId: unknown }): boolean {
  const { source, completed, repairId } = input, doctor = record(completed.doctor) ?? {};
  const expectedIds = proofRows(source.postgresAgentStores).map(store => store.agentId).sort();
  return [Array.isArray(doctor.verifiedAgentIds) && isDeepStrictEqual([...doctor.verifiedAgentIds].sort(), expectedIds),
    doctor.requestId === repairId, Number.isSafeInteger(doctor.startedAt) && Number(doctor.startedAt) > 0,
    Number.isSafeInteger(doctor.completedAt) && Number(doctor.completedAt) >= Number(doctor.startedAt) && Number(doctor.completedAt) <= Number(completed.completedAt),
    typeof doctor.releaseKey === "string" && doctor.releaseKey.length > 0].every(Boolean);
}

function completedPostgresImageMatches(source: Record<string, unknown>, completed: Record<string, unknown>): boolean {
  const doctor = record(completed.doctor) ?? {}, installed = record(completed.installedImage) ?? {}, images = record(source.images) ?? {};
  const digest = typeof images.gateway === "string" ? /@(sha256:[a-f0-9]{64})$/.exec(images.gateway)?.[1] : undefined;
  return [typeof completed.podUid === "string" && completed.podUid.length > 0 && installed.podUid === completed.podUid,
    digest !== undefined && typeof installed.gatewayImageId === "string" && installed.gatewayImageId.endsWith("@" + digest),
    Number.isSafeInteger(installed.verifiedAt) && Number(installed.verifiedAt) > 0 && Number(installed.verifiedAt) <= Number(doctor.startedAt),
    typeof record(completed.managementHealth)?.bootId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(String(record(completed.managementHealth)?.bootId))].every(Boolean);
}

export function repairedPlacementProofMatches(data: Record<string, unknown>, repair: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const source = record(record(repair.input)?.sourceRecovery) ?? {}, completed = record(repair.sourceRuntimeRecovery) ?? {};
  const assignment = proofRows(source.assignments).find(row => row.uid === request.uid);
  return [isAutomaticRolledBackPlacement(data, request), data.cutoverCommittedAt === undefined,
    repair.kind === 'restart-gateway', ['running', 'succeeded'].includes(String(repair.status)), repair.cancellationRequestedAt === undefined,
    record(repair.input)?.gatewayId === request.fromGatewayId, completed.gatewayId === request.fromGatewayId,
    Number.isSafeInteger(repair.startedAt) && Number(repair.startedAt) >= Number(data.completedAt),
    Number.isSafeInteger(completed.completedAt) && Number(completed.completedAt) >= Number(repair.startedAt),
    assignment?.slug === request.builderSlug, capturedPostgresRosterMatches(source),
    typeof source.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(source.sourceSha), source.sourceSha === completed.sourceSha,
    isDeepStrictEqual(source.images, completed.images), completedPostgresDoctorMatches({ source, completed, repairId: repair.id }),
    completedPostgresImageMatches(source, completed), record(completed.managementHealth)?.attemptId === repair.id,
    record(completed.managementHealth)?.health === true].every(Boolean);
}
async function assertCurrentRepairTarget(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationInput,
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
  const exact = [sharedReturnTargetReady(root, runtime, request, input.now()), pool?.sharedGatewayIds.includes(request.toGatewayId),
    target?.runtimeRestartFence === undefined, target?.retirementClaim == null,
    isReleasePayload(payload) && releasePayloadHash(payload) === releasePayloadHash(input.platformArtifact) &&
      sourceImage.startsWith(payload.imageRepository + ':') && sourceImage.endsWith('@' + payload.imageTag.split('@')[1]),
    userRecord?.slug === request.builderSlug, userRecord?.openclaw.status === 'complete'].every(Boolean);
  if (!exact) throw new Error('repaired source placement current target authority changed');
}
interface RepairedPostgresSourceObservation {
  source: Record<string, unknown>; runtime: Record<string, unknown>; release: Record<string, unknown>;
  repair: Record<string, unknown>; request: EnqueuePlacementMigrationInput; now: number;
}

function postgresRepairSourceRootMatches(source: Record<string, unknown>, adopted: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  return [Number.isSafeInteger(adopted.release), Number(adopted.release) > 0,
    typeof adopted.operationId === "string" && adopted.operationId.length > 0 && !adopted.operationId.includes("/"),
    source.gatewayId === request.fromGatewayId, source.gatewayClass === "shared", source.ownerUid === null, source.builderSlug === null,
    ["running", "draining"].includes(String(source.desiredStatus)), source.runtimeRestartFence === undefined, source.retirementClaim == null,
    source.latestRelease === adopted.release, source.desiredRelease === adopted.release, source.liveRelease === adopted.release].every(Boolean);
}

function postgresRepairSourceRuntimeMatches(input: {
  runtime: Record<string, unknown>; adopted: Record<string, unknown>; request: EnqueuePlacementMigrationInput; now: number;
}): boolean {
  const { runtime, adopted, request, now } = input, heartbeat = record(runtime.heartbeat) ?? {};
  const heartbeatAt = millis(heartbeat.lastHeartbeatAt);
  return [runtime.gatewayId === request.fromGatewayId, runtime.release === adopted.release, runtime.lifecycle === "serving", heartbeat.status === "ready",
    heartbeatAt !== null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS].every(Boolean);
}

function postgresRepairSourcePayloadMatches(input: {
  release: Record<string, unknown>; captured: Record<string, unknown>; runtime: Record<string, unknown>;
  adopted: Record<string, unknown>; request: EnqueuePlacementMigrationInput;
}): boolean {
  const { release, captured, runtime, adopted, request } = input, helm = record(runtime.helm) ?? {};
  const payload = release.payload, expected = captured.payload;
  return [release.gatewayId === request.fromGatewayId && release.release === adopted.release,
    isReleasePayload(payload) && isReleasePayload(expected) && release.payloadHash === releasePayloadHash(payload) &&
      releasePayloadHash(payload) === releasePayloadHash(expected) && helm.imageRepository === payload.imageRepository && helm.imageTag === payload.imageTag,
    isReleasePayload(payload) && record(captured.images)?.gateway === `${payload.imageRepository}:${payload.imageTag}`].every(Boolean);
}

export function repairedPostgresSourceConverged(input: RepairedPostgresSourceObservation): boolean {
  const { source, runtime, release, repair, request, now } = input;
  const completed = record(repair.sourceRuntimeRecovery) ?? {}, captured = record(record(repair.input)?.sourceRecovery) ?? {};
  const adopted = record(completed.release) ?? {};
  return [postgresRepairSourceRootMatches(source, adopted, request), postgresRepairSourceRuntimeMatches({ runtime, adopted, request, now }),
    postgresRepairSourcePayloadMatches({ release, captured, runtime, adopted, request })].every(Boolean);
}

async function assertCurrentPostgresRepairSource(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  repair: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): Promise<void> {
  const completed = record(repair.sourceRuntimeRecovery) ?? {}, adopted = record(completed.release) ?? {};
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
        repair, request, now: input.now(),
      })) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the repaired source release has not converged; retry placement after it is ready");
  }
}

async function findRepairedSourcePlacement(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationInput,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!isAutomaticRolledBackPlacement(data, request)) return false;
  const candidates = await transaction.journal.operations.listByInputGateway(request.fromGatewayId);
  const repair = candidates.map((operation) => operation as unknown as Record<string, unknown>)
    .filter(row => repairedPlacementProofMatches(data, row, request))
    .sort((left, right) => Number(record(right.sourceRuntimeRecovery)?.completedAt) - Number(record(left.sourceRuntimeRecovery)?.completedAt))[0];
  if (!repair) return false;
  const assignment = await assertPreRpcRetryAuthority(transaction, userRecord, request);
  const captured = record(record(repair.input)?.sourceRecovery) ?? {};
  const owner = proofRows(captured.assignments).find(row => row.uid === request.uid);
  if (assignment.epoch !== owner?.assignmentEpoch || assignment.slug !== request.builderSlug) throw new Error('source repair assignment changed');
  const sourceImage = record(record(repair.sourceRuntimeRecovery)?.images)?.gateway;
  if (typeof sourceImage !== 'string') throw new Error('source repair image receipt is unavailable');
  await assertCurrentPostgresRepairSource(input, transaction, repair, request);
  await assertCurrentRepairTarget(input, transaction, userRecord, request, sourceImage);
  return true;
}

export const CLEAR = { clear: true } as const;

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
  request: EnqueuePlacementMigrationInput & { sharedDrain: { pairedTargetGatewayId: string | null } },
): Promise<void> {
  const [roots, replacements] = await Promise.all([
    transaction.gateways.roots.getMany([request.fromGatewayId, request.toGatewayId]),
    readSharedPoolReplacements(transaction),
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
  const pairedTargetGatewayId = pairedReplacementTarget(replacements, request.fromGatewayId);
  if (pairedTargetGatewayId !== request.sharedDrain.pairedTargetGatewayId) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "its replacement pairing changed");
  }
  if (pairedTargetGatewayId !== null && pairedTargetGatewayId !== request.toGatewayId) {
    throw new SharedDrainSupersededError(request.fromGatewayId, `it is paired with ${pairedTargetGatewayId}`);
  }
}

function supersededSharedDrainMoveCanRearm(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  return request.sharedDrain !== undefined &&
    data.status === "failed" &&
    record(data.supersededBy)?.kind === "builder-activation" &&
    data.startedAt === null &&
    data.attempts === undefined &&
    data.cutoverCommittedAt === undefined &&
    data.userMigrationV2 === undefined;
}

function assertUserPlacementNotHeld(userRecord: Stored<PlatformUserRecord> | null, uid: string): void {
  if (userRecord?.openclaw.managedBy === "operator") throw new HeldUserPlacementError(uid);
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

type PlacementMigrationEnqueueInput = Pick<FirestorePlacementPolicyInput, "store" | "now" | "platformArtifact">;

async function placementMigrationRearm(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord> | null,
  request: EnqueuePlacementMigrationInput,
  existing: Stored<OperationRecord>,
): Promise<OperationPatch | null> {
  const data = existing as unknown as Record<string, unknown>;
  const retarget = { input: operationInputWithout(existing, [], { toGatewayId: request.toGatewayId }), gatewayId: request.toGatewayId };
  if (sharedRevisionReturnMatchesDemand(data, request)) {
    await assertSharedRevisionReturnAuthority(input, transaction, userRecord, {
      ...request, previousTargetGatewayId: existing.input.toGatewayId as string,
    });
    return { ...rearmedPlacementMigrationPatch(), ...retarget };
  }
  if (startupFailedReturnMatchesDemand(data, request)) {
    await assertStartupReturnAuthority(input, transaction, userRecord, request);
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
    throw new Error(`migration operation ${request.operationId} does not match activation demand`);
  }
  if (placementMigrationIsNonTerminal(data)) return null;
  if (supersededSharedDrainMoveCanRearm(data, request)) {
    return { ...rearmedPlacementMigrationPatch(), supersededBy: CLEAR };
  }
  if (await findRepairedSourcePlacement(input, transaction, userRecord, request, data)) {
    return rearmedPlacementMigrationPatch();
  }
  if (preRpcAuthorityFailure(data, request) || sourceOnlyRollbackCompleted(data, request)) {
    await assertPreRpcRetryAuthority(transaction, userRecord, request);
    return {
      ...rearmedPlacementMigrationPatch(),
      schedulerHandoff: CLEAR,
      schedulerHandoffReleased: CLEAR,
      schedulerHandoffReleasedAt: CLEAR,
      input: operationInputWithout(existing, ["recoverSourceOnly"]),
    };
  }
  if (!rolledBackTransientPlacementCanRearm(data, request)) {
    throw new TerminalPlacementMigrationConflictError(request.operationId, String(data.status));
  }
  return rearmedPlacementMigrationPatch();
}

export async function enqueuePlacementMigration(
  input: PlacementMigrationEnqueueInput,
  request: EnqueuePlacementMigrationInput,
): Promise<string> {
  const now = input.now();
  const operation: OperationRecord = {
    id: request.operationId,
    kind: MIGRATE_USER_KIND,
    status: "pending",
    origin: "automatic",
    createdBy: PLACEMENT_POLICY_ACTOR,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    input: {
      uid: request.uid,
      userSlug: request.builderSlug,
      fromGatewayId: request.fromGatewayId,
      toGatewayId: request.toGatewayId,
      source: request.source,
    },
    steps: [],
    gatewayId: request.toGatewayId,
    inputUid: request.uid,
  };
  await input.store.transaction({ label: "placement-policy.enqueue-migration" }, async (transaction) => {
    const userRecord = await transaction.users.records.get(request.uid);
    assertUserPlacementNotHeld(userRecord, request.uid);
    const sharedDrain = request.sharedDrain;
    if (sharedDrain) await assertSharedDrainAuthority(transaction, { ...request, sharedDrain });
    const existing = await transaction.journal.operations.get(request.operationId);
    if (existing === null) {
      await transaction.journal.operations.create(operation);
      return;
    }
    const rearm = await placementMigrationRearm(input, transaction, userRecord, request, existing);
    if (rearm === null) return;
    await transaction.journal.operations.patch(request.operationId, rearm, {
      status: [existing.status],
      startedAt: existing.startedAt,
    });
  });
  return request.operationId;
}

type RetiredDisposableGatewayVerdict = "delete" | "rearmed" | "handoff-pending" | "skip";

function retiredDisposableGatewayVerdict(input: {
  request: DeleteRetiredDisposableGatewayInput;
  operationId: string;
  root: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  claimOperationId: unknown;
  operation: Stored<OperationRecord> | null;
  ownerMirrorGatewayId: string | null;
  unreleasedHandoffOperationId: string | null;
}): RetiredDisposableGatewayVerdict {
  const { request, root, operation } = input;
  const fenced = [
    root !== null,
    root?.desiredStatus === "retired",
    root?.ownerUid === request.ownerUid,
    root?.allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND,
    root?.allocation?.generation === request.generation,
    input.claimOperationId === input.operationId,
    operation !== null,
    operation?.kind === "retire-gateway",
    input.ownerMirrorGatewayId !== request.gatewayId,
  ].every(Boolean);
  if (!fenced) return "skip";
  if (operation?.status === "succeeded") {
    return input.unreleasedHandoffOperationId === null ? "delete" : "handoff-pending";
  }
  if (operation?.status === "failed" && isRetryableUserRetirementFailure(operation.error, request.gatewayId)) return "rearmed";
  return "skip";
}

function isRetryableUserRetirementFailure(error: unknown, gatewayId: string): boolean {
  return isReapedOperationError(error) || isAgentStoreRetirementSessionDrain(error, gatewayId);
}

interface RetiredDisposableGatewayReading {
  verdict: RetiredDisposableGatewayVerdict;
  retirementVersion: number | null;
  unreleasedHandoffOperationId: string | null;
}

async function readRetiredDisposableGatewayVerdict(
  store: PlatformStateStore,
  request: DeleteRetiredDisposableGatewayInput,
  operationId: string,
): Promise<RetiredDisposableGatewayReading> {
  const handoffOperationIds = [
    builderActivateOperationId(request.gatewayId, request.generation),
    builderReturnOperationId(request.gatewayId, request.generation),
  ];
  return store.transaction({ label: "placement-policy.retired-disposable-verdict" }, async (transaction) => {
    const [stored, operation, owner, handoffs] = await Promise.all([
      transaction.gateways.roots.get(request.gatewayId),
      transaction.journal.operations.get(operationId),
      transaction.users.records.get(request.ownerUid),
      transaction.journal.operations.getMany(handoffOperationIds),
    ]);
    const unreleasedHandoffOperationId = handoffOperationIds.find((id) => {
      const handoff = handoffs.get(id);
      return handoff !== undefined && schedulerHandoffAwaitingRelease(handoff as unknown as Record<string, unknown>);
    }) ?? null;
    const verdict = retiredDisposableGatewayVerdict({
      request,
      operationId,
      root: projectGatewayDesiredRootForGateway(stored, request.gatewayId),
      claimOperationId: record(stored?.retirementClaim)?.operationId,
      operation,
      ownerMirrorGatewayId: userGatewayId(owner),
      unreleasedHandoffOperationId,
    });
    if (verdict === "rearmed") {
      await transaction.journal.operations.patch(operationId, REARMED_RETIRE_OPERATION, { status: ["failed"] });
    }
    return { verdict, retirementVersion: stored?.retirementVersion ?? null, unreleasedHandoffOperationId };
  });
}

async function deleteRetiredDisposableGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: DeleteRetiredDisposableGatewayInput,
): Promise<boolean> {
  const { store } = input;
  const operationId = placementRetireOperationId(request.ownerUid, request.gatewayId, request.generation);
  const recoverOperationId = isolatedRecoverOperationId(request.gatewayId, request.generation);
  const reading = await readRetiredDisposableGatewayVerdict(store, request, operationId);
  if (reading.verdict === "rearmed") {
    input.log(
      `[placement-policy] re-armed retirement ${operationId} for ${request.gatewayId}: it failed retryably (reaped after a controller restart or draining PostgreSQL sessions); the op runner re-drives it`,
    );
    return false;
  }
  if (reading.verdict === "handoff-pending") {
    input.log(
      `[placement-policy] kept retired disposable runtime ${request.gatewayId}: ${reading.unreleasedHandoffOperationId} has an unreleased scheduler handoff; the handoff release sweep must settle it first`,
    );
    return false;
  }
  if (reading.verdict !== "delete") return false;
  const preparationCleared = await clearRetiredUserActivationPreparation({ store }, { uid: request.ownerUid, targetGatewayId: request.gatewayId, generation: request.generation, retirementOperationId: operationId });
  if (preparationCleared) input.log(`[placement-policy] cleared failed preparation for retired target ${request.gatewayId}`);
  await Promise.all([
    store.journal.operations.delete(recoverOperationId),
    store.journal.recoveryReceipts.delete(recoverOperationId),
  ]);
  try {
    await store.gateways.roots.delete(request.gatewayId, {
      retirementVersion: reading.retirementVersion,
      desiredStatus: ["retired"],
    });
  } catch (error) {
    if (!(error instanceof FenceMismatchError)) throw error;
    input.log(
      `[placement-policy] kept retired disposable runtime ${request.gatewayId}: its root changed after the deletion verdict (${error.message})`,
    );
    return false;
  }
  input.log(
    `[placement-policy] deleted retired disposable runtime ${request.gatewayId} for ${request.ownerUid}`,
  );
  return true;
}

export function createFirestorePlacementPolicyReconcilerDeps(
  input: FirestorePlacementPolicyInput,
): PlacementPolicyReconcilerDeps {
  const { store } = input;
  return {
    now: input.now,
    log: input.log,
    debug: input.debug,
    readSnapshot: () => readPlacementPolicySnapshot(input),
    decidePlacementAdmission: (uid) => input.placementAdmission.decide(uid),
    assignInitialPlacement: (request) => assignInitialPlacementInStore(input, request),
    recoverUnavailableGateway: (request) => commitUnavailableGatewayRecoveryAtomic({
      store,
      now: () => new Date(input.now()),
    }, {
      ...request,
      validateTarget: unavailableRecoveryTargetFence(request),
    }),
    recoverDisposableRuntimeReset: (request) =>
      commitRecoveredDisposableRuntimeResetAtomic({
        store,
        now: () => new Date(input.now()),
      }, request),
    supersedeRollingSharedGateway: (request) => supersedeRollingSharedGatewayRoll({ store, now: input.now }, request),
    enqueueMigration: (request) => enqueuePlacementMigration(input, request),
    deleteRetiredDisposableGateway: (request) =>
      deleteRetiredDisposableGatewayFirestore(input, request),
    ...(input.isolatedGateways ? { isolatedGateways: input.isolatedGateways } : {}),
    ...(input.sharedGatewayMoves ? { sharedGatewayMoves: input.sharedGatewayMoves } : {}),
  };
}

export const PLACEMENT_POLICY_PASS_DEADLINE_MS = 5 * 60_000;
export const PLACEMENT_POLICY_MAX_ABANDONED_PASSES = 3;

interface PlacementPolicyAttempt {
  startedAt: number;
  abandoned: boolean;
}

export function startPlacementPolicyReconciler(
  deps: PlacementPolicyReconcilerDeps,
  intervalMs = PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
  options?: {
    passDeadlineMs?: number;
    maxAbandonedPasses?: number;
    subscribe?: (wake: () => void) => () => void;
    runPass?: (deps: PlacementPolicyReconcilerDeps) => Promise<unknown>;
  },
): () => void {
  if (intervalMs <= 0) return () => undefined;
  const passDeadlineMs = options?.passDeadlineMs ?? PLACEMENT_POLICY_PASS_DEADLINE_MS;
  const maxAbandonedPasses = options?.maxAbandonedPasses ?? PLACEMENT_POLICY_MAX_ABANDONED_PASSES;
  const runPass = options?.runPass ?? reconcilePlacementPolicyOnce;
  let stopped = false;
  let pending = false;
  let current: PlacementPolicyAttempt | null = null;
  let abandonedOutstanding = 0;
  let haltLogged = false;
  const tick = async () => {
    if (stopped) return;
    if (current) {
      const heldMs = deps.now() - current.startedAt;
      if (heldMs < passDeadlineMs) return;
      current.abandoned = true;
      current = null;
      abandonedOutstanding += 1;
      deps.log(
        `[placement-policy] ⚠ pass exceeded its ${passDeadlineMs}ms deadline (held ${heldMs}ms) — ` +
          `releasing the tick gate (${abandonedOutstanding} abandoned outstanding)`,
      );
    }
    if (abandonedOutstanding >= maxAbandonedPasses) {
      if (!haltLogged) {
        haltLogged = true;
        deps.log(
          `[placement-policy] ⚠ halted: ${abandonedOutstanding} abandoned passes outstanding — ` +
            `no new passes until one settles`,
        );
      }
      return;
    }
    pending = false;
    const attempt: PlacementPolicyAttempt = { startedAt: deps.now(), abandoned: false };
    current = attempt;
    try {
      await runPass(deps);
    } catch (error) {
      deps.log(`[placement-policy] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (attempt.abandoned) {
        abandonedOutstanding -= 1;
        haltLogged = false;
        deps.log(
          `[placement-policy] abandoned pass settled after ${deps.now() - attempt.startedAt}ms ` +
            `(${abandonedOutstanding} still outstanding)`,
        );
      }
      if (current === attempt) current = null;
      if (pending && !current && !stopped) void tick();
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  const unsubscribe = options?.subscribe?.(() => { pending = true; void tick(); });
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}
