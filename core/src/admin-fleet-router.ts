import { migrationCancellationDeferred } from "./fleet-state.js";
import { readSharedSourceRecoveryAuthority, readSharedSourceRecoverySupersession, SharedSourceRecoveryConflict } from "./shared-source-recovery.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";


import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  isOperationAuditRecord,
  isOperationAuditRow,
  GATEWAY_IMAGE_PROFILES,
  GATEWAY_PROFILES,
  NEW_GATEWAY_ID_REQUIREMENT,
  isValidNewGatewayId,
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveGatewayRuntime,
  isGatewayRuntime,
  deriveGatewayIdentity,
  type GatewayClass,
  type GlmOperationRecord,
  type OperationAuditStatus,
  type OperationStatus,
  type GatewayImageProfile,
  type GatewayProfile,
  type GatewayRuntime,
  type GatewayVmState,
  type OperationAuditAliasPlan,
  type OperationAuditDocument,
} from "@octogee/shared/types/glm";
import {
  DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS,
  type PlatformRuntimeConfig,
} from "@octogee/shared/types/platform-config";
import {
  accountAllowsInteractiveAccess,
  type AccountLifecycle,
} from "@octogee/shared/types/account-lifecycle";
import {
  isReleasePayload,
  isGatewayRuntimeDoc,
  type AssignmentDoc,
  type AssignmentState,
  type GatewayRuntimeDoc,
  type PlatformReleaseRecord,
  type ReleaseDoc,
} from "@octogee/shared/types/gateway-releases";
import {
  isGatewayPodReplacements,
  summarizeGatewayPodReplacements,
  type GatewayPodReplacementSummary,
} from "@octogee/shared/types/gateway-pod-replacements";
import type { MigrationProgressRecord } from "@octogee/shared/types/glm";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  InitialGatewayReleaseConflictError,
  gatewayArtifactFromReleasePayload,
  isGatewayMutableConfigForGateway,
  writeInitialGatewayReleaseInStore,
  type GatewayArtifact,
  type GatewayMutableConfig,
} from "./gateway-live-release.js";
import { projectReleaseHistory } from "./gateway-release-history.js";
import {
  resolveContinuousUserPlacement,
  resolveLiveActivationTargetGatewayId,
} from "@octogee/shared/types/orchestrator-placement";
import {
  SHARED_POOL_SLOT_ID_REQUIREMENT,
  isSharedPoolSlotId,
  sharedGatewayAddedBy,
  type SharedGatewayAddedBy,
  type SharedGatewayPoolConfig,
} from "@octogee/shared/types/shared-gateway-pool";
import {
  readSharedGatewayPoolConfigInStore,
} from "./shared-gateway-pool-read.js";
import {
  SIZING_TIERS,
  resolveSizingTier,
  type SizingTier,
} from "@octogee/shared/types/sizing";
import {
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  type GatewayPricingMode,
} from "@octogee/shared/types/cost-estimator";
import { GATEWAY_UNREACHABLE_AFTER_MS, parseOpenClawProcessReport } from "@octogee/shared/types/fleet-controller";
import {
  builderReturnOperationId,
  placementRetireOperationId,
} from "./user-activation-lease.js";
import { withActorEmails } from "./admin-journal-actor.js";
import {
  AdminDryRunPlanned,
  admitAdminDryRunMarker,
  isAdminDryRun,
  refuseUnansweredAdminDryRun,
  respondToAdminDryRun,
} from "./admin-dry-run.js";
import { addAdminComputerRoutes } from "./admin-vm-router.js";
import { addAdminUserRoutes, type UserAccounts, type UserSignInHosts } from "./admin-user-router.js";
import {
  GatewayRetirementConflictError,
  assertGatewayRuntimeMutationUnfencedInStore,
  isolatedRuntimeMutationFenced,
  claimGatewayRetirementInStore,
} from "./gateway-retirement-claim.js";
import {
  commitOperatorPlacement,
  planOperatorPlacement,
  SHARED_GATEWAY_MIRROR,
  type OperatorPlacementRefusal,
} from "./operator-placement.js";
import {
  appendGatewayRelease,
  asDurableGatewayRoot,
  InvalidGatewayRootError,
  StaleGatewayReleaseError,
  type DurableGatewayRoot,
} from "./gateway-release-append.js";
import {
  findActiveGatewayMigration,
  GatewayMigrationInFlightError,
} from "./fleet-operation-lock.js";
import { buildUserDeletionSchedule } from "@octogee/shared/types/account-lifecycle";
import { buildUserDeletionPlan } from "./user-deletion-plan.js";
import {
  FleetMutationIdempotencyError,
  runNormalFleetMutation,
  type NormalFleetMutationResult,
} from "./normal-fleet-mutation.js";
import { OperationAuditIdempotencyConflictError, type OperationAuditActionClaim } from "./operation-audit.js";
import {
  type UserAccount,
  type UserAccountReader,
} from "./user-account.js";
import type {
  PlatformUserRecord,
} from "./platform-state/users.js";
import {
  failedRetirementOf,
  giveOperatorIsolatedGateway,
  movesTouchingGateway,
  rearmFailedRetirement,
  isolatedGatewayRetireRefusal,
  operatorAllocationId,
  ownIsolatedGatewayTargetRefusal,
  planOperatorIsolatedGateway,
} from "./operator-isolated-gateway.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import { readReleaseStatus, summarizeReleaseStatus } from "./release-status.js";
import type { GatewayAssignment, GatewayRoot } from "./platform-state/gateways.js";
import type { NewOperation, OperationRecord } from "./platform-state/operations.js";
import type { OpaqueMap, PlatformStateStore, PlatformStateTransaction, Stored, UntypedRecord } from "./platform-state/store.js";
import {
  type CentralReleaseAuthority,
  type ReleaseDigestManifest,
  centralGatewayReleasePayload,
  ReleaseDigestManifestNotFoundError,
} from "./artifact-registry.js";

export interface FleetLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";
export type GatewayPodCapacityType = "spot" | "on-demand";

function rejectPersistenceInBody(body: Record<string, unknown>): {
  status: number;
  body: Record<string, string>;
} | null {
  if (body.persistence === undefined) return null;
  return {
    status: 400,
    body: {
      error:
        "persistence specs are rejected — gateways use emptyDir; scheduling is managed independently",
    },
  };
}

export interface GatewayPodDiagnostic {
  name: string;
  uid: string | null;
  replicaSetUid: string | null;
  phase: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
  nodeName: string | null;
  instanceId: string | null;
  nodePool: string | null;
  capacityType: GatewayPodCapacityType | null;
  ageMs: number | null;
}

export interface GatewayPodDiagnostics {
  status: GatewayPodDiagnosticsStatus;
  totalPods: number;
  readyPods: number;
  totalRestarts: number;
  spotPods: number;
  onDemandPods: number;
  unknownCapacityPods: number;
  pods: GatewayPodDiagnostic[];
  error?: string;
}

export interface FleetRouterDeps {
  computerReplacementEnabled?: boolean;
  accounts: UserAccountReader;
  store: PlatformStateStore;
  logger: FleetLogger;
  provisionGatewayAuthSecret: (opts: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
  listGatewayBuilds: (opts: {
    service: string;
    limit: number;
  }) => Promise<unknown[]>;
  releaseEnvironment?: "test" | "prod" | null;
  releaseAuthority?: CentralReleaseAuthority;
  platformArtifact?: GatewayArtifact;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  readGatewayPodDiagnosticsBatch?: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;

  requestNativeReturnSourceRecovery?: (input: { uid: string; operationId: string; requestedAt: number; requestedBy: string }) => Promise<boolean>;
  suspendAuthUser: (uid: string) => Promise<void>;
  revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
  userAccounts?: UserAccounts;
  userSignIn?: UserSignInHosts;
  discoverDeletionProductContext?: DeletionProductContextDiscovery;
}

export type DeletionProductContextDiscovery = (uid: string) => Promise<OpaqueMap>;

const noDeletionProductContext: DeletionProductContextDiscovery = async () => ({});

export type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

class GatewayAuthSecretProvisionError extends Error {}

function resolveSizingForResponse(
  glmDoc: Record<string, unknown> | undefined,
  reservation: ReturnType<typeof projectGatewayReservation>,
): {
  tier: SizingTier;
  resolvedFrom: "explicit" | "class-default" | "profile-default";
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  capacity: { targetActiveUsers: number; typicalUsers: number };
  monthlyCostUsd: {
    compute: number;
    onDemandCompute: number;
    savings: number;
    pricingMode: GatewayPricingMode;
    perUserAtTarget: number;
    perUserAtTypical: number;
  };
} {
  const sizingTier =
    typeof glmDoc?.sizingTier === "string" && (SIZING_TIERS as readonly string[]).includes(glmDoc.sizingTier)
      ? (glmDoc.sizingTier as SizingTier)
      : undefined;
  const profile = isGatewayProfile(glmDoc?.profile) ? glmDoc.profile : undefined;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(glmDoc?.gatewayClass) ? glmDoc.gatewayClass : undefined,
    profile,
    imageProfile: isGatewayProfile(glmDoc?.imageProfile) ? glmDoc.imageProfile : undefined,
  });
  const resolved = resolveSizingTier({ sizingTier, gatewayClass, profile });
  // Paused pods are scaled to 0 replicas → no node consumption → no compute
  // bill. Reflect that in both the per-gateway surface and the fleet roll-up
  // so the operator sees real cost, not nameplate.
  const isPaused = glmDoc?.desiredStatus === "paused";
  const cost = isPaused
    ? {
        computeUsd: 0,
        onDemandComputeUsd: 0,
        savingsUsd: 0,
        pricingMode: reservation.type,
        perUserAtTarget: 0,
        perUserAtTypical: 0,
      }
    : estimateGatewayMonthlyCost(resolved.tier, { pricingMode: reservation.type });
  return {
    tier: resolved.tier,
    resolvedFrom: resolved.resolvedFrom,
    resources: {
      requests: {
        cpu: resolved.preset.resources.requests.cpu,
        memory: resolved.preset.resources.requests.memory,
      },
      limits: {
        cpu: resolved.preset.resources.limits.cpu,
        memory: resolved.preset.resources.limits.memory,
      },
    },
    capacity: resolved.preset.capacity,
    monthlyCostUsd: {
      compute: cost.computeUsd,
      onDemandCompute: cost.onDemandComputeUsd,
      savings: cost.savingsUsd,
      pricingMode: cost.pricingMode,
      perUserAtTarget: cost.perUserAtTarget,
      perUserAtTypical: cost.perUserAtTypical,
    },
  };
}

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "builder" ? "builder" : "standard";
}

function normalizeGatewayClass(doc: GlmDoc | undefined): GatewayClass {
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function normalizeGatewayImageProfile(doc: GlmDoc | undefined): GatewayImageProfile {
  return resolveGatewayImageProfile({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function isTruthyQueryFlag(value: unknown): boolean {
  return value === "true" || value === "1";
}

// The K8s namespace this fleet runs in — scopes the Grafana deep-link to the env.
export function resolveFleetNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const ns = env.K8S_NAMESPACE;
  return typeof ns === "string" && ns.length > 0 ? ns : "octogee";
}

type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike { id: string; data(): GlmDoc }
export const ERR_SHARED_GATEWAY_NOT_ROLLED_IN_PLACE =
  "a shared gateway is not rolled in place; add a shared gateway on the new build, move its users to it, then retire this one";

interface DurableGatewayRuntime {
  root: DurableGatewayRoot;
  runtime: GatewayRuntimeDoc | null;
  heartbeat: GlmDoc | null;
}

type AdminPlacementDriftState =
  | "healthy"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "missing-gateway"
  | "in-flight";

type AdminPlacementWarningCode =
  | "default-gateway-missing"
  | "default-gateway-retired"
  | "default-gateway-not-shared"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "migration-in-flight"
  | "account-deletion-pending"
  | "shared-gateway-behind-platform-build";

export interface AdminPlacementWarning {
  code: AdminPlacementWarningCode;
  message: string;
  severity: "info" | "warning" | "error";
  gatewayId?: string;
  uid?: string;
  slug?: string;
  operationId?: string;
  expiresAt?: number;
}

interface AdminPlacementLatestOperation {
  id: string;
  kind: string;
  status: string;
  gatewayId: string | null;
  inputUid: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
  input: Record<string, unknown>;
}

type AdminGatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

interface AdminPlacementGatewaySummary {
  gatewayId: string;
  gatewayClass: AdminGatewayClass;
  desiredStatus: AdminGatewayDesiredStatus | null;
  status: string | null;
  imageTag: string | null;
  openclawVersion: string | null;
  assignableAsDefault: boolean;
  defaultTarget: boolean;
  assignedCount: number;
  mountedCount: number;
  driftCount: number;
  warnings: AdminPlacementWarning[];
  lastOperation: AdminPlacementLatestOperation | null;
}

type AdminGatewayClass = "shared" | "isolated";

function adminGatewayClass(gatewayClass: GatewayClass): AdminGatewayClass {
  return gatewayClass === "builder" ? "isolated" : "shared";
}

function isAdminGatewayClass(value: unknown): value is AdminGatewayClass {
  return value === "shared" || value === "isolated";
}

function withAdminGatewayClass<T extends { gatewayClass: GatewayClass }>(
  gateway: T,
): Omit<T, "gatewayClass"> & { gatewayClass: AdminGatewayClass } {
  return { ...gateway, gatewayClass: adminGatewayClass(gateway.gatewayClass) };
}

interface AdminPlacementUserProjection {
  uid: string;
  username: string;
  email: string;
  slug: string | null;
  policyTargetGatewayId: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  provisioningStatus: string | null;
  driftState: AdminPlacementDriftState;
  // Durable roster truth from gateways/{gw}/assignments/{uid}. null when
  // the user has no assignment doc (legacy/un-backfilled gateway) — the
  // client falls back to derivation only in that case.
  rosterState: AssignmentState | null;
  rosterRevisionId: string | null;
  rosterEpoch: number | null;
  warnings: AdminPlacementWarning[];
  latestOperation: AdminPlacementLatestOperation | null;
}

type AdminPlacementUser = Omit<AdminPlacementUserProjection, "uid" | "slug"> & {
  id: string;
  name: string | null;
};

interface AdminPlacementResponse {
  config: {
    defaultGatewayId: string | null;
    sharedGatewayIds: string[];
  };
  gateways: AdminPlacementGatewaySummary[];
  users: AdminPlacementUser[];
  driftSummary: Record<AdminPlacementDriftState, number>;
  warnings: AdminPlacementWarning[];
  generatedAt: string;
}

type DefaultPlacementConfig = SharedGatewayPoolConfig;


async function readDefaultPlacementConfigInStore(
  transaction: PlatformStateTransaction,
): Promise<DefaultPlacementConfig> {
  const pool = await readSharedGatewayPoolConfigInStore(transaction);
  return {
    defaultGatewayId: pool?.defaultGatewayId ?? "",
    sharedGatewayIds: pool?.sharedGatewayIds ?? [],
  };
}

function presentFields(fields: GlmDoc): GlmDoc {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

function userDocData(userRecord: PlatformUserRecord, account: UserAccount | null | undefined): GlmDoc {
  return presentFields({
    ...account?.planInputs,
    username: account?.username,
    email: account?.email,
    lastActive: account?.lastActive,
    accountLifecycle: userRecord.accountLifecycle,
    provisioning: presentFields({
      ...userRecord.provisioning,
      ...userRecord.home,
      computerRecovery: userRecord.fences.computerRecovery,
      pendingNativeSchedulerRetirement: userRecord.fences.pendingNativeSchedulerRetirement,
      openclaw: presentFields({
        ...userRecord.openclaw,
        ...userRecord.gateway,
        slug: userRecord.slug,
        activationLease: userRecord.activationLease,
        restoreFence: userRecord.fences.restoreFence,
        sourceTransferFence: userRecord.fences.sourceTransferFence,
        migration: userRecord.fences.migration,
        runtimeReset: userRecord.fences.runtimeReset,
      }),
    }),
  });
}

function userDocument(userRecord: PlatformUserRecord, account: UserAccount | null | undefined): FirestoreDocLike {
  const data = userDocData(userRecord, account);
  return { id: userRecord.uid, data: () => data };
}

function recordDoc(id: string, record: object): FirestoreDocLike {
  const { revision: _revision, id: _id, ...data } = record as GlmDoc;
  return { id, data: () => data };
}

function operationDocs(operations: readonly { readonly id: string }[]): FirestoreDocLike[] {
  return operations.map((operation) => recordDoc(operation.id, operation));
}

function runtimeRecordDoc(record: FleetRegistryRecord): FirestoreDocLike {
  return recordDoc(record.gatewayId, { docKind: "runtime", ...record });
}

interface FleetSnapshot {
  roots: readonly Stored<GatewayRoot>[];
  runtimes: readonly Stored<FleetRegistryRecord>[];
  users: readonly Stored<PlatformUserRecord>[];
  assignments: readonly Stored<GatewayAssignment>[];
}

async function readFleetSnapshot(store: PlatformStateStore): Promise<FleetSnapshot> {
  const [roots, runtimes, userRecords, assignments] = await Promise.all([
    store.gateways.roots.list(),
    store.fleetRegistry.list(),
    store.users.records.listAll(),
    store.gateways.assignments.listAll(),
  ]);
  return { roots, runtimes, users: userRecords, assignments };
}

function userDocuments(
  users: readonly PlatformUserRecord[],
  accounts: ReadonlyMap<string, UserAccount>,
): FirestoreDocLike[] {
  return users.map((userRecord) => userDocument(userRecord, accounts.get(userRecord.uid)));
}

function fleetGatewayDocs(snapshot: Pick<FleetSnapshot, "roots" | "runtimes">): {
  gatewayDocs: FirestoreDocLike[];
  glmDocs: FirestoreDocLike[];
} {
  return {
    gatewayDocs: snapshot.roots.map((root) => recordDoc(root.gatewayId, root)),
    glmDocs: snapshot.runtimes.map(runtimeRecordDoc),
  };
}

function readUserOpenclaw(data: Record<string, unknown>): Record<string, unknown> {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
}

function readProvisioningStatus(data: Record<string, unknown>): string | null {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(provisioning.status) ?? asStringOrNull(readUserOpenclaw(data).status);
}

function shapePlacementOperation(
  id: string,
  data: Record<string, unknown>,
): AdminPlacementLatestOperation {
  return {
    id,
    kind: asStringOrNull(data.kind) ?? "unknown",
    status: asStringOrNull(data.status) ?? "unknown",
    gatewayId: asStringOrNull(data.gatewayId),
    inputUid: asStringOrNull(data.inputUid),
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    input: isPlainRecord(data.input) ? data.input : {},
  };
}

function latestOperation(
  operations: ReadonlyArray<AdminPlacementLatestOperation>,
  predicate: (operation: AdminPlacementLatestOperation) => boolean,
): AdminPlacementLatestOperation | null {
  return operations
    .filter(predicate)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

function operationUid(operation: AdminPlacementLatestOperation): string | null {
  return asStringOrNull(operation.input.uid) ?? asStringOrNull(operation.inputUid);
}

function operationTouchesGateway(
  operation: AdminPlacementLatestOperation,
  gatewayId: string,
): boolean {
  return (
    operation.gatewayId === gatewayId ||
    operation.input.gatewayId === gatewayId ||
    operation.input.fromGatewayId === gatewayId ||
    operation.input.toGatewayId === gatewayId
  );
}

function isInFlightOperation(operation: AdminPlacementLatestOperation | null): boolean {
  return operation?.status === "pending" || operation?.status === "running";
}

function mountedGatewayBySlug(
  gatewayById: ReadonlyMap<string, GlmDoc>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [gatewayId, runtime] of gatewayById) {
    const hb = effectiveHeartbeatDoc(gatewayId, runtime)?.data();
    if (!hb) continue;
    for (const slug of readMountedSlugs(hb)) {
      out.set(slug, gatewayId);
    }
  }
  return out;
}

function shouldIncludePlacementUser(input: {
  data: Record<string, unknown>;
}): boolean {
  return (
    accountAllowsInteractiveAccess(input.data) &&
    (
      asStringOrNull(input.data.username) !== null ||
      readUserGatewayId(input.data) !== null
    )
  );
}

// eslint-disable-next-line complexity -- Warning projection intentionally enumerates each drift state with its distinct operator message.
function userPlacementWarnings(input: {
  uid: string;
  slug: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  driftState: AdminPlacementDriftState;
  latestOperation: AdminPlacementLatestOperation | null;
}): AdminPlacementWarning[] {
  const warnings: AdminPlacementWarning[] = [];
  if (input.driftState === "pointer-drift") {
    warnings.push({
      code: "pointer-drift",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but policy targets ${input.policyTargetGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "assigned-not-mounted") {
    warnings.push({
      code: "assigned-not-mounted",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but is not mounted there`,
    });
  }
  if (input.driftState === "mounted-orphan") {
    warnings.push({
      code: "mounted-orphan",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.mountedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is mounted on ${input.mountedGatewayId ?? "none"} but assigned to ${input.assignedGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "in-flight" && input.latestOperation) {
    warnings.push({
      code: "migration-in-flight",
      severity: "info",
      uid: input.uid,
      slug: input.slug ?? undefined,
      operationId: input.latestOperation.id,
      message: `${input.latestOperation.kind} ${input.slug ?? "unresolved-user"} (${input.uid}) is ${input.latestOperation.status}`,
    });
  }
  return warnings;
}

function accountLifecycleWarning(input: {
  uid: string;
  data: Record<string, unknown>;
  operations: ReadonlyArray<AdminPlacementLatestOperation>;
}): AdminPlacementWarning | null {
  const lifecycle = isPlainRecord(input.data.accountLifecycle)
    ? input.data.accountLifecycle
    : null;
  if (lifecycle?.status !== "deletion_scheduled" && lifecycle?.status !== "erasing") {
    return null;
  }
  const operation = latestOperation(
    input.operations,
    (candidate) =>
      candidate.kind === "erase-user" && operationUid(candidate) === input.uid,
  );
  const slug = resolveUserSlug(input.data) ?? asStringOrNull(operation?.input.builderSlug);
  const expiresAt = toMillis(lifecycle.eraseAfter);
  return {
    code: "account-deletion-pending",
    severity: "info",
    uid: input.uid,
    slug: slug ?? undefined,
    ...(operation ? { operationId: operation.id } : {}),
    ...(expiresAt !== null ? { expiresAt } : {}),
    message: `${slug ?? "unresolved-user"} (${input.uid}) is ${lifecycle.status === "erasing" ? "being deleted" : "scheduled for deletion"}`,
  };
}

function accountLifecycleWarnings(
  userDocs: ReadonlyArray<FirestoreDocLike>,
  operations: ReadonlyArray<AdminPlacementLatestOperation>,
): AdminPlacementWarning[] {
  return userDocs
    .map((userDoc) => accountLifecycleWarning({
      uid: userDoc.id,
      data: userDoc.data(),
      operations,
    }))
    .filter((warning): warning is AdminPlacementWarning => warning !== null);
}

function driftStateForUser(input: {
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  latestOperation: AdminPlacementLatestOperation | null;
  glmByGatewayId: Map<string, GlmDoc>;
}): AdminPlacementDriftState {
  if (isInFlightOperation(input.latestOperation)) return "in-flight";
  const missing = (gatewayId: string | null): boolean =>
    Boolean(gatewayId) &&
    (!input.glmByGatewayId.has(gatewayId!) ||
      projectDesiredStatus(input.glmByGatewayId.get(gatewayId!)) === "retired");
  if (missing(input.policyTargetGatewayId) || missing(input.assignedGatewayId)) {
    return "missing-gateway";
  }
  if (
    input.assignedGatewayId &&
    input.policyTargetGatewayId &&
    input.assignedGatewayId !== input.policyTargetGatewayId
  ) {
    return "pointer-drift";
  }
  if (
    input.mountedGatewayId &&
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "mounted-orphan";
  }
  if (input.mountedGatewayId && !input.assignedGatewayId) return "mounted-orphan";
  if (
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "assigned-not-mounted";
  }
  return "healthy";
}

function activationPolicyGatewayId(input: {
  uid: string;
  data: Record<string, unknown>;
  assignedGatewayId: string | null;
  glmByGatewayId: ReadonlyMap<string, GlmDoc>;
}): string | null {
  const candidate = resolveLiveActivationTargetGatewayId({
    userData: input.data,
  });
  const gateway = candidate ? input.glmByGatewayId.get(candidate) : undefined;
  const placement = resolveContinuousUserPlacement({
    uid: input.uid,
    userData: input.data,
    currentGatewayId: input.assignedGatewayId,
    defaultGatewayId: "",
    ownedGateway: candidate && gateway
      ? {
          gatewayId: candidate,
          gatewayClass: normalizeGatewayClass(gateway),
          ownerUid: asStringOrNull(gateway.ownerUid),
          desiredStatus: projectDesiredStatus(gateway) ?? "invalid",
          ready: asStringOrNull(effectiveHeartbeatDoc(candidate, gateway)?.data()?.status) === "ready",
          disposable: isPlainRecord(gateway.allocation) &&
            gateway.allocation.kind === "disposable-builder",
        }
      : null,
  });
  return placement.targetGatewayId || null;
}

function projectionAssignment(
  assignmentsByUid: ReadonlyMap<string, AssignmentDoc[]>,
  uid: string,
  mirroredGatewayId: string | null,
): AssignmentDoc | null {
  const assignments = assignmentsByUid.get(uid) ?? [];
  return assignments.find((candidate) => candidate.gatewayId === mirroredGatewayId) ??
    (assignments.length === 1 ? assignments[0]! : null);
}

function buildUserPlacementProjection(input: {
  uid: string;
  data: Record<string, unknown>;
  config: SharedGatewayPoolConfig;
  mountedBySlug: Map<string, string>;
  operations: ReadonlyArray<AdminPlacementLatestOperation>;
  glmByGatewayId: Map<string, GlmDoc>;
  assignmentsByUid: Map<string, AssignmentDoc[]>;
}): AdminPlacementUserProjection {
  const slug = resolveUserSlug(input.data);
  const mirroredGatewayId = readUserGatewayId(input.data);
  const assignment = projectionAssignment(
    input.assignmentsByUid,
    input.uid,
    mirroredGatewayId,
  );
  const assignedGatewayId = assignment?.gatewayId ?? mirroredGatewayId;
  const policyTargetGatewayId = activationPolicyGatewayId({
    uid: input.uid,
    data: input.data,
    assignedGatewayId,
    glmByGatewayId: input.glmByGatewayId,
  }) ?? (
    assignedGatewayId !== null && input.config.sharedGatewayIds.includes(assignedGatewayId)
      ? assignedGatewayId
      : input.config.defaultGatewayId
  );
  const mountedGatewayId = slug ? input.mountedBySlug.get(slug) ?? null : null;
  const latestOp = latestOperation(
    input.operations,
    (operation: AdminPlacementLatestOperation) => operationUid(operation) === input.uid,
  );
  const driftState = driftStateForUser({
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId,
    latestOperation: latestOp,
    glmByGatewayId: input.glmByGatewayId,
  });
  const warnings = userPlacementWarnings({
    uid: input.uid,
    slug,
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId,
    driftState,
    latestOperation: latestOp,
  });
  return {
    uid: input.uid,
    username: asStringOrNull(input.data.username) ?? "",
    email: asStringOrNull(input.data.email) ?? "",
    slug,
    policyTargetGatewayId,
    assignedGatewayId,
    mountedGatewayId,
    provisioningStatus: readProvisioningStatus(input.data),
    driftState,
    rosterState: assignment ? assignment.state : null,
    rosterRevisionId: assignment ? assignment.gatewayId : null,
    rosterEpoch: assignment ? assignment.epoch : null,
    warnings,
    latestOperation: latestOp,
  };
}

function countBy<T extends string | null>(
  items: ReadonlyArray<AdminPlacementUserProjection>,
  key: (item: AdminPlacementUserProjection) => T,
): Record<Exclude<T, null>, number> {
  const out = {} as Record<Exclude<T, null>, number>;
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    out[value as Exclude<T, null>] = (out[value as Exclude<T, null>] ?? 0) + 1;
  }
  return out;
}

function indexAssignmentsByUid(
  assignments: readonly AssignmentDoc[],
): Map<string, AssignmentDoc[]> {
  const byUid = new Map<string, AssignmentDoc[]>();
  for (const assignment of assignments) {
    const forUid = byUid.get(assignment.uid) ?? [];
    forUid.push(assignment);
    byUid.set(assignment.uid, forUid);
  }
  return byUid;
}

function buildPlacementResponse(opts: {
  now: number;
  config: DefaultPlacementConfig;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  userDocs: ReadonlyArray<FirestoreDocLike>;
  operationDocs: ReadonlyArray<FirestoreDocLike>;
  assignments: readonly AssignmentDoc[];
  buildWarnings: readonly AdminPlacementWarning[];
}): AdminPlacementResponse {
  const glmByGatewayId = indexAdminGatewayRuntimeDocs({
    gatewayDocs: opts.gatewayDocs,
    glmDocs: opts.glmDocs,
  });
  const heartbeatByGatewayId = indexFirestoreDocs(opts.gatewayDocs);
  const assignmentsByUid = indexAssignmentsByUid(opts.assignments);
  const operations = opts.operationDocs.map((doc) =>
    shapePlacementOperation(doc.id, doc.data()),
  );
  const mountedBySlug = mountedGatewayBySlug(glmByGatewayId);
  const users = opts.userDocs
    .filter((doc) =>
      shouldIncludePlacementUser({
        data: doc.data(),
      }),
    )
    .map((doc) =>
      buildUserPlacementProjection({
        uid: doc.id,
        data: doc.data(),
        config: opts.config,
        mountedBySlug,
        operations,
        glmByGatewayId,
        assignmentsByUid,
      }),
    )
    .sort((a, b) =>
      (a.slug ?? a.username ?? a.email ?? a.uid).localeCompare(
        b.slug ?? b.username ?? b.email ?? b.uid,
        undefined,
        { sensitivity: "base" },
      ),
    );

  const mountedCountsByGateway = countBy(users, (user) => user.mountedGatewayId);
  const assignedCountsByGateway = countBy(users, (user) => user.assignedGatewayId);
  const driftCountsByGateway: Record<string, number> = {};
  for (const user of users) {
    if (user.driftState === "healthy") continue;
    const touchedGatewayIds = new Set(
      [
        user.policyTargetGatewayId,
        user.assignedGatewayId,
        user.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    );
    for (const gatewayId of touchedGatewayIds) {
      driftCountsByGateway[gatewayId] = (driftCountsByGateway[gatewayId] ?? 0) + 1;
    }
  }
  const driftSummary: Record<AdminPlacementDriftState, number> = {
    healthy: 0,
    "pointer-drift": 0,
    "assigned-not-mounted": 0,
    "mounted-orphan": 0,
    "missing-gateway": 0,
    "in-flight": 0,
  };
  for (const user of users) driftSummary[user.driftState] += 1;

  const gatewayIds = new Set([
    ...glmByGatewayId.keys(),
    ...heartbeatByGatewayId.keys(),
    ...users.flatMap((user) =>
      [
        user.policyTargetGatewayId,
        user.assignedGatewayId,
        user.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    ),
  ]);
  const gateways = [...gatewayIds].sort().map((gatewayId) => {
    const glmDoc = glmByGatewayId.get(gatewayId);
    const heartbeat = effectiveHeartbeatDoc(gatewayId, glmDoc)?.data();
    const desiredStatus = projectDesiredStatus(glmDoc);
    const gatewayClass = normalizeGatewayClass(glmDoc);
    const status = glmDoc || heartbeat
      ? observedGatewayStatus({
          desiredStatus,
          appliedReplicas: glmDoc?.appliedReplicas,
          heartbeatStatus: heartbeat?.status,
          heartbeatAgeMs: ageMsOrNull(toMillis(heartbeat?.lastHeartbeatAt), opts.now),
        })
      : null;
    const warnings = users
      .filter((user) =>
        [
          user.policyTargetGatewayId,
          user.assignedGatewayId,
          user.mountedGatewayId,
        ].includes(gatewayId),
      )
      .flatMap((user) => user.warnings);
    return {
      gatewayId,
      gatewayClass: adminGatewayClass(gatewayClass),
      desiredStatus,
      status,
      imageTag: projectImageTag(heartbeat ?? {}, glmDoc),
      openclawVersion: projectOpenclawVersion(heartbeat ?? {}, glmDoc),
      assignableAsDefault:
        Boolean(glmDoc) &&
        gatewayClass === "shared" &&
        desiredStatus === "running" &&
        status === "ready",
      defaultTarget: opts.config.defaultGatewayId === gatewayId,
      assignedCount: assignedCountsByGateway[gatewayId] ?? 0,
      mountedCount: mountedCountsByGateway[gatewayId] ?? 0,
      driftCount: driftCountsByGateway[gatewayId] ?? 0,
      warnings,
      lastOperation: latestOperation(operations, (operation) =>
        operationTouchesGateway(operation, gatewayId),
      ),
    };
  });

  const warnings: AdminPlacementWarning[] = [];
  const defaultGatewayId = opts.config.defaultGatewayId || null;
  if (defaultGatewayId) {
    const glmDoc = glmByGatewayId.get(defaultGatewayId);
    if (!glmDoc) {
      warnings.push({
        code: "default-gateway-missing",
        severity: "error",
        gatewayId: defaultGatewayId,
        message: `Shared gateway anchor ${defaultGatewayId} has no desired state`,
      });
    } else if (projectDesiredStatus(glmDoc) === "retired") {
      warnings.push({
        code: "default-gateway-retired",
        severity: "error",
        gatewayId: defaultGatewayId,
        message: `Shared gateway anchor ${defaultGatewayId} is retired`,
      });
    } else if (normalizeGatewayClass(glmDoc) !== "shared") {
      warnings.push({
        code: "default-gateway-not-shared",
        severity: "warning",
        gatewayId: defaultGatewayId,
        message: `Shared gateway anchor ${defaultGatewayId} is not a shared gateway`,
      });
    }
  } else {
    warnings.push({
      code: "default-gateway-missing",
      severity: "error",
      message: "No default gateway is configured",
    });
  }
  warnings.push(...accountLifecycleWarnings(opts.userDocs, operations));
  warnings.push(...opts.buildWarnings);
  for (const user of users) warnings.push(...user.warnings);

  return {
    config: {
      defaultGatewayId,
      sharedGatewayIds: [...opts.config.sharedGatewayIds],
    },
    gateways,
    users: users.map(({ uid, slug, ...user }) => ({ ...user, id: uid, name: slug })),
    driftSummary,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

export async function readAdminPlacementResponse(
  store: PlatformStateStore,
  accounts: UserAccountReader,
): Promise<AdminPlacementResponse> {
  const [config, snapshot, recent, accountsByUid, platformRelease] = await Promise.all([
    store.transaction(
      { label: "admin.fleet.onboardingPlacementConfig", readOnly: true },
      readDefaultPlacementConfigInStore,
    ),
    readFleetSnapshot(store),
    store.journal.listRecent({ limit: 200 }),
    accounts.list(),
    store.controllerState.platformRelease.get(),
  ]);
  return buildPlacementResponse({
    now: Date.now(),
    config,
    ...fleetGatewayDocs(snapshot),
    userDocs: userDocuments(snapshot.users, accountsByUid),
    operationDocs: operationDocs(recent.items),
    assignments: snapshot.assignments,
    buildWarnings: await sharedGatewayBuildWarnings(store, config.sharedGatewayIds, snapshot.roots, platformRelease),
  });
}

function buildName(imageTag: string): string {
  return imageTag.split("@")[0]!;
}

async function sharedGatewayBuildWarnings(
  store: PlatformStateStore,
  sharedGatewayIds: readonly string[],
  roots: FleetSnapshot["roots"],
  platformRelease: PlatformReleaseRecord | null,
): Promise<AdminPlacementWarning[]> {
  if (platformRelease === null) return [];
  const shared = roots.filter((root) => sharedGatewayIds.includes(root.gatewayId) && root.desiredStatus !== "retired");
  const live = await Promise.all(shared.map((root) =>
    root.liveRelease === null ? null : store.gateways.releases.get(root.gatewayId, root.liveRelease)));
  const platformBuild = buildName(platformRelease.imageTag);
  return shared.flatMap((root, index) => {
    const release = live[index];
    if (release?.payloadHash === platformRelease.payloadHash) return [];
    const running = release ? `runs build ${buildName(release.payload.imageTag)}` : "runs no build yet";
    return [{
      code: "shared-gateway-behind-platform-build" as const,
      severity: "warning" as const,
      gatewayId: root.gatewayId,
      message: `${root.gatewayId} ${running}; the platform runs ${platformBuild}`,
    }];
  });
}

function indexGlmDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, GlmDoc> {
  const out = new Map<string, GlmDoc>();
  for (const doc of docs) out.set(doc.id, doc.data());
  return out;
}

function addOperationId(ids: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) ids.add(value);
}

function leasePlacementRetireOperationId(
  uid: string,
  targetGatewayId: string,
  generation: unknown,
): string | null {
  return Number.isSafeInteger(generation) && (generation as number) > 0
    ? placementRetireOperationId(uid, targetGatewayId, generation as number)
    : null;
}

function disposableRuntimeRetireOperationId(
  gateway: GlmDoc,
  gatewayId: string,
): string | null {
  const runtime = projectDisposableRuntime(gateway);
  return runtime && runtime.generation > 0
    ? placementRetireOperationId(runtime.ownerUid, gatewayId, runtime.generation)
    : null;
}

function fleetProjectionOperationIds(
  userDocs: ReadonlyArray<FirestoreDocLike>,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
): string[] {
  const ids = new Set<string>();
  for (const userDoc of userDocs) {
    const resolved = activationLeaseFromUser(userDoc.data());
    if (!resolved) continue;
    addOperationId(ids, resolved.lease.activationOperationId);
    addOperationId(ids, resolved.lease.returnOperationId);
    const targetGatewayId = asStringOrNull(resolved.lease.targetGatewayId);
    if (!targetGatewayId) continue;
    const target = gatewaysById.get(targetGatewayId);
    const retirementClaim = isPlainRecord(target?.retirementClaim)
      ? target.retirementClaim
      : null;
    addOperationId(
      ids,
      asStringOrNull(retirementClaim?.operationId) ??
      leasePlacementRetireOperationId(userDoc.id, targetGatewayId, resolved.lease.generation),
    );
  }
  for (const [gatewayId, gateway] of gatewaysById) {
    if (
      projectDesiredStatus(gateway) !== "retired" ||
      projectDisposableRuntime(gateway) === null
    ) {
      continue;
    }
    const retirementClaim = isPlainRecord(gateway.retirementClaim)
      ? gateway.retirementClaim
      : null;
    addOperationId(
      ids,
      asStringOrNull(retirementClaim?.operationId) ??
      disposableRuntimeRetireOperationId(gateway, gatewayId),
    );
  }
  return [...ids].sort();
}

async function readFleetProjectionOperations(
  store: PlatformStateStore,
  operationIds: readonly string[],
): Promise<FirestoreDocLike[]> {
  const found = await store.journal.operations.getMany(operationIds);
  return operationDocs([...found.values()]);
}

function indexFirestoreDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, FirestoreDocLike> {
  const out = new Map<string, FirestoreDocLike>();
  for (const doc of docs) out.set(doc.id, doc);
  return out;
}

function indexDurableGatewayRoots(
  docs: ReadonlyArray<FirestoreDocLike>,
): Map<string, DurableGatewayRoot> {
  const out = new Map<string, DurableGatewayRoot>();
  for (const doc of docs) {
    const root = asDurableGatewayRoot(doc.data(), doc.id);
    if (root) out.set(doc.id, root);
  }
  return out;
}

function projectDurableGatewayRuntime(
  root: DurableGatewayRoot,
  runtime: GatewayRuntimeDoc | null,
): GlmDoc {
  if (!runtime) return { ...root, gateway: root.gatewayId };
  return {
    ...root,
    gateway: root.gatewayId,
    imageRepository: runtime.helm.imageRepository,
    imageTag: runtime.helm.imageTag,
    appliedReplicas: runtime.helm.replicas,
    heartbeat: runtime.heartbeat,
    lastError: runtime.lastError,
    podReplacements: runtime.podReplacements,
  };
}

function indexAdminGatewayRuntimeDocs(input: {
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
}): Map<string, GlmDoc> {
  const rawGlmById = indexGlmDocs(input.glmDocs);
  const rootsById = indexDurableGatewayRoots(input.gatewayDocs);
  const out = new Map<string, GlmDoc>();
  for (const [gatewayId, root] of rootsById) {
    out.set(
      gatewayId,
      projectDurableGatewayRuntime(root, exactRuntimeDoc(root, rawGlmById.get(gatewayId))),
    );
  }
  return out;
}

function projectLastError(raw: unknown):
  | { slug?: string; message?: string; at: string | null }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { slug?: string; message?: string; at?: unknown };
  return { slug: e.slug, message: e.message, at: toIso(e.at) };
}

function projectDesiredStatus(glmDoc: GlmDoc | undefined):
  | "running" | "paused" | "draining" | "retired" | null {
  const v = glmDoc?.desiredStatus;
  if (typeof v !== "string") return null;
  if (v === "running" || v === "paused" || v === "draining" || v === "retired") return v;
  return null;
}

function requestedGatewayStatus(
  desiredStatus: ReturnType<typeof projectDesiredStatus>,
): string {
  if (desiredStatus === "running") return "booting";
  if (desiredStatus === "paused") return "paused";
  if (desiredStatus === "draining") return "draining";
  return "unknown";
}

function observedGatewayStatus(input: {
  desiredStatus: ReturnType<typeof projectDesiredStatus>;
  appliedReplicas: unknown;
  heartbeatStatus: unknown;
  heartbeatAgeMs: number | null;
}): string {
  if (input.desiredStatus === "retired" || input.desiredStatus === "paused") return input.desiredStatus;
  if (input.appliedReplicas === 0) return requestedGatewayStatus(input.desiredStatus);
  if (input.heartbeatAgeMs !== null && input.heartbeatAgeMs > GATEWAY_UNREACHABLE_AFTER_MS) return "unreachable";
  return typeof input.heartbeatStatus === "string"
    ? input.heartbeatStatus
    : requestedGatewayStatus(input.desiredStatus);
}

function notServingReason(status: string, openclawProcess: unknown): string | null {
  if (status !== "booting") return null;
  const report = parseOpenClawProcessReport(openclawProcess);
  if (!report) return null;
  switch (report.state) {
    case "held":
    case "hydrated":
      return report.migrationId ? `OpenClaw is held for move ${report.migrationId}` : "OpenClaw is held with no move in progress";
    case "unavailable":
      return "The OpenClaw supervisor is not answering; it is still preparing or has failed";
    case "starting":
      return "OpenClaw is starting";
    case "serving":
      return "OpenClaw is running; startup checks are not finished";
  }
}

function openclawVersionFromImageTag(imageTag: unknown): string | null {
  if (typeof imageTag !== "string") return null;
  const match = imageTag.match(/^[0-9a-f]{7,40}-oc(.+)$/u);
  return match?.[1] ?? null;
}

const OPENCLAW_VERSION_PRODUCT_PREFIX = /^openclaw\s+/iu;

function withoutBuildSuffix(value: string): string {
  if (!value.endsWith(")")) return value;
  const opensAt = value.lastIndexOf("(");
  return opensAt === -1 ? value : value.slice(0, opensAt);
}

function reportedOpenclawVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = withoutBuildSuffix(
    value.trim().replace(OPENCLAW_VERSION_PRODUCT_PREFIX, ""),
  ).trim();
  return version.length === 0 || version === "unknown" ? null : version;
}

function projectOpenclawVersion(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  return reportedOpenclawVersion(data.openclawVersion) ??
    openclawVersionFromImageTag(glmDoc?.imageTag);
}

function projectImageTag(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  if (typeof data.version === "string") return data.version;
  return typeof glmDoc?.imageTag === "string" ? glmDoc.imageTag : null;
}

function syntheticGatewayDoc(id: string, glmDoc: GlmDoc | undefined): FirestoreDocLike {
  const lastError = isPlainRecord(glmDoc?.lastError) ? glmDoc.lastError : undefined;
  return { id, data: () => ({ gatewayId: id, ...(lastError ? { lastError } : {}) }) };
}

function effectiveHeartbeatDoc(
  gatewayId: string,
  glmDoc: GlmDoc | undefined,
): FirestoreDocLike | undefined {
  const hb = glmDoc?.heartbeat;
  if (isPlainRecord(hb) && Object.keys(hb).length > 0) {
    const lastError = isPlainRecord(glmDoc?.lastError) ? glmDoc.lastError : undefined;
    return {
      id: gatewayId,
      data: () => ({ gatewayId, ...hb, ...(lastError ? { lastError } : {}) }),
    };
  }
  return undefined;
}

function shouldProjectDesiredOnlyGateway(glmDoc: GlmDoc | undefined): boolean {
  const desiredStatus = projectDesiredStatus(glmDoc);
  return desiredStatus !== null && desiredStatus !== "retired";
}

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function exactRuntimeDoc(
  root: DurableGatewayRoot,
  data: unknown,
): GatewayRuntimeDoc | null {
  if (!isGatewayRuntimeDoc(data) || data.gatewayId !== root.gatewayId) {
    return null;
  }
  return data;
}

function runtimeHeartbeat(runtime: GatewayRuntimeDoc | null): GlmDoc | null {
  return runtime && isPlainRecord(runtime.heartbeat) ? runtime.heartbeat : null;
}

function durableRootOf(stored: GatewayRoot | null, gatewayId: string): DurableGatewayRoot | null {
  return stored === null ? null : asDurableGatewayRoot(recordDoc(gatewayId, stored).data(), gatewayId);
}

async function readDurableGatewayRuntime(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<DurableGatewayRuntime | null> {
  const [stored, registry] = await Promise.all([
    store.gateways.roots.get(gatewayId),
    store.fleetRegistry.get(gatewayId),
  ]);
  const root = durableRootOf(stored, gatewayId);
  if (!root) return null;
  const runtime = registry === null ? null : exactRuntimeDoc(root, runtimeRecordDoc(registry).data());
  return { root, runtime, heartbeat: runtimeHeartbeat(runtime) };
}

async function retirementRefusal(
  store: PlatformStateStore,
  gatewayId: string,
  runtime: DurableGatewayRuntime,
  asked: { blockingMove: string | null; force: boolean; deleteHome: boolean; retainData: boolean },
): Promise<Record<string, unknown> | null> {
  if (asked.blockingMove) return { error: `user migration is in flight for gateway ${gatewayId}`, gatewayId };
  if (projectDisposableRuntime(runtime.root as unknown as GlmDoc)) {
    const isolated = await isolatedGatewayRetireRefusal(store, gatewayId, asked);
    if (isolated) return isolated;
  }
  const blocker = gatewayRetirementBlocker(gatewayId, runtime);
  if (blocker) return blocker;
  const assignments = await store.gateways.assignments.list(gatewayId);
  if (assignments.length > 0) {
    return {
      error: "gateway still has assigned users; migrate them off before retiring",
      gatewayId,
      assignedUsers: assignments.map((a) => a.slug),
    };
  }
  const mounted = await mountedUsersBlockingRetirement(store, gatewayId, runtime);
  return mounted.length > 0
    ? { error: "gateway still has mounted users; migrate them off before retiring", gatewayId, mountedUsers: mounted }
    : null;
}

async function mountedUsersBlockingRetirement(
  store: PlatformStateStore,
  gatewayId: string,
  runtime: DurableGatewayRuntime,
): Promise<string[]> {
  const parkedIsolated = runtime.root.desiredStatus === "paused" && runtime.root.gatewayClass === "builder" &&
    isGatewayRuntime((await store.fleetRegistry.get(gatewayId))?.runtime);
  return parkedIsolated ? [] : [...readMountedSlugs(runtime.heartbeat ?? undefined)];
}

function gatewayRetirementBlocker(
  gatewayId: string,
  runtime: DurableGatewayRuntime,
): Record<string, unknown> | null {
  if (
    runtime.root.desiredStatus === "running" &&
    runtime.root.liveRelease != null &&
    !runtime.runtime
  ) {
    return {
      error: "gateway runtime telemetry is unavailable",
      gatewayId,
    };
  }
  return null;
}

export async function readGatewayRegistrationReadiness(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<{
  registered: boolean;
  status: string | null;
  gatewayClass: DurableGatewayRoot["gatewayClass"] | null;
}> {
  const runtime = await readDurableGatewayRuntime(store, gatewayId);
  return {
    registered: runtime !== null,
    gatewayClass: runtime?.root.gatewayClass ?? null,
    status:
      runtime?.root.desiredStatus === "running"
        ? asStringOrNull(runtime.heartbeat?.status)
        : null,
  };
}

type ProjectedGatewayStorage = {
  mode: "emptyDir" | "pvc";
  pvcName: string | null;
  size: string | null;
  storageClassName: string | null;
  accessModes: string[];
};

function emptyDirGatewayStorage(): ProjectedGatewayStorage {
  return {
    mode: "emptyDir",
    pvcName: null,
    size: null,
    storageClassName: null,
    accessModes: [],
  };
}

function projectGatewayStorage(
  _gatewayId: string,
  _glmDoc: GlmDoc | undefined,
): ProjectedGatewayStorage {
  return emptyDirGatewayStorage();
}

export function projectGatewayReservation(
  glmDoc: GlmDoc | undefined,
  observedCapacityType?: GatewayPodCapacityType,
): {
  type: GatewayPricingMode;
  priceMultiplier: number;
  source: "kubernetes" | "class-default";
} {
  const type = observedCapacityType ??
    (normalizeGatewayClass(glmDoc) === "shared" ? "on-demand" : "spot");
  return {
    type,
    priceMultiplier: type === "spot" ? SPOT_PRICE_MULTIPLIER : 1,
    source: observedCapacityType ? "kubernetes" : "class-default",
  };
}

function projectDisposableRuntime(
  glmDoc: GlmDoc | undefined,
): {
  ownerUid: string;
  leaseId: string;
  generation: number;
} | null {
  const allocation = isPlainRecord(glmDoc?.allocation)
    ? glmDoc.allocation
    : null;
  if (
    allocation?.kind !== "disposable-builder" ||
    typeof allocation.leaseId !== "string" ||
    !Number.isSafeInteger(allocation.generation) ||
    typeof allocation.claimedByUid !== "string" ||
    glmDoc?.ownerUid !== allocation.claimedByUid
  ) {
    return null;
  }
  return {
    ownerUid: allocation.claimedByUid,
    leaseId: allocation.leaseId,
    generation: allocation.generation as number,
  };
}

// The stored window is a list of replacement timestamps, so the rolling counts
// are derived against the request clock rather than read back from a number that
// was accurate only when the fleet controller last wrote the document.
function projectGatewayPodReplacements(
  glmDoc: GlmDoc | undefined,
  now: number,
): GatewayPodReplacementSummary | null {
  const stored = glmDoc?.podReplacements;
  if (!isGatewayPodReplacements(stored)) return null;
  return summarizeGatewayPodReplacements(stored, now);
}

export function projectGatewaySummary(
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): {
  gatewayId: string; gateway: string; status: string;
  statusReason: string | null;
  desiredStatus: AdminGatewayDesiredStatus | null;
  imageTag: string | null; openclawVersion: string | null;
  mountedUsers: unknown[];
  ownerId: string | null;
  handoffProgress?: Record<string, MigrationProgressRecord[]>;
  lastHeartbeatAt: string | null; heartbeatAgeMs: number | null;
  startedAt: string | null; uptimeMs: number | null;
  lastError: ReturnType<typeof projectLastError>;
  sizing: ReturnType<typeof resolveSizingForResponse>;
  storage: ReturnType<typeof projectGatewayStorage>;
  reservation: ReturnType<typeof projectGatewayReservation>;
  profile: GatewayProfile;
  gatewayClass: GatewayClass;
  addedBy: SharedGatewayAddedBy | null;
  imageProfile: GatewayImageProfile;
  disposableRuntime: ReturnType<typeof projectDisposableRuntime>;
  podReplacements: GatewayPodReplacementSummary | null;
} {
  const data = doc.data();
  const gatewayId = typeof data.gatewayId === "string" ? data.gatewayId : doc.id;
  const desiredStatus = projectDesiredStatus(glmDoc);
  const reservation = projectGatewayReservation(glmDoc);
  const heartbeatAgeMs = ageMsOrNull(toMillis(data.lastHeartbeatAt), now);
  const status = observedGatewayStatus({
    desiredStatus,
    appliedReplicas: glmDoc?.appliedReplicas,
    heartbeatStatus: data.status,
    heartbeatAgeMs,
  });
  return {
    gatewayId,
    gateway: deriveGatewayIdentity(gatewayId, glmDoc?.gateway),
    status,
    statusReason: notServingReason(status, data.openclawProcess),
    desiredStatus,
    imageTag: projectImageTag(data, glmDoc),
    openclawVersion: projectOpenclawVersion(data, glmDoc),
    mountedUsers: Array.isArray(data.mountedCustomers) ? data.mountedCustomers : [],
    ownerId: asStringOrNull(glmDoc?.ownerUid),
    lastHeartbeatAt: toIso(data.lastHeartbeatAt),
    heartbeatAgeMs,
    startedAt: toIso(data.startedAt),
    uptimeMs: ageMsOrNull(toMillis(data.startedAt), now),
    lastError: projectLastError(data.lastError),
    sizing: resolveSizingForResponse(glmDoc, reservation),
    storage: projectGatewayStorage(gatewayId, glmDoc),
    reservation,
    profile: normalizeGatewayProfile(glmDoc?.profile),
    gatewayClass: normalizeGatewayClass(glmDoc),
    addedBy: normalizeGatewayClass(glmDoc) === "shared" && typeof glmDoc?.createdBy === "string"
      ? sharedGatewayAddedBy({ createdBy: glmDoc.createdBy })
      : null,
    imageProfile: normalizeGatewayImageProfile(glmDoc),
    disposableRuntime: projectDisposableRuntime(glmDoc),
    podReplacements: projectGatewayPodReplacements(glmDoc, now),
  };
}

export type AdminIsolatedRuntimeLifecycle =
  | "requested"
  | "provisioning"
  | "activating"
  | "active"
  | "returning"
  | "retiring"
  | "failed";

const LIVE_ISOLATED_RUNTIME_STATUSES = new Set([
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
]);
const ISOLATED_RUNTIME_STALE_AFTER_MS = 10 * 60_000;
const ISOLATED_RUNTIME_STATUS_FIELDS: Record<AdminIsolatedRuntimeLifecycle, string> = {
  requested: "requestedAt",
  provisioning: "provisionedAt",
  activating: "activatingAt",
  active: "activeAt",
  returning: "returningAt",
  retiring: "returningAt",
  failed: "failedAt",
};

function activationLeaseFromUser(
  data: GlmDoc,
): {
  openclaw: GlmDoc;
  lease: GlmDoc;
} | null {
  const provisioning = isPlainRecord(data.provisioning)
    ? data.provisioning
    : null;
  const openclaw = isPlainRecord(provisioning?.openclaw)
    ? provisioning.openclaw
    : null;
  const lease = isPlainRecord(openclaw?.activationLease)
    ? openclaw.activationLease
    : null;
  return openclaw && lease ? { openclaw, lease } : null;
}

function runtimeStatusAt(lease: GlmDoc, lifecycle: AdminIsolatedRuntimeLifecycle): number | null {
  const field = ISOLATED_RUNTIME_STATUS_FIELDS[lifecycle];
  return toMillis(lease[field]) ?? toMillis(lease.requestedAt);
}

function runtimeWakeDurationMs(
  lease: GlmDoc,
  leaseStatus: string,
  requestedAt: number | null,
  now: number,
): number | null {
  if (requestedAt === null) return null;
  let completedAt: number | null = null;
  if (
    leaseStatus === "active" ||
    leaseStatus === "returning" ||
    leaseStatus === "parked"
  ) {
    completedAt = toMillis(lease.activeAt);
  } else if (leaseStatus === "failed") {
    completedAt = toMillis(lease.failedAt);
  }
  return Math.max(0, (completedAt ?? now) - requestedAt);
}

function projectOperationSteps(
  operation: GlmDoc | undefined,
): Array<{ name: string; status: string }> {
  return Array.isArray(operation?.steps)
    ? operation.steps.flatMap((step) => {
        if (
          !isPlainRecord(step) ||
          typeof step.name !== "string" ||
          typeof step.status !== "string"
        ) {
          return [];
        }
        return [{ name: step.name, status: step.status }];
      })
    : [];
}

interface IsolatedRuntimeLeaseContext {
  data: GlmDoc;
  openclaw: GlmDoc;
  lease: GlmDoc;
  leaseId: string;
  generation: number;
  leaseStatus: string;
}

interface IsolatedRuntimeRetirementContext {
  targetGatewayId: string | null;
  target: GlmDoc | undefined;
  operationId: string | null;
  operation: GlmDoc | undefined;
  started: boolean;
  complete: boolean;
  failed: boolean;
}

type AdminIsolatedRuntimePhase = "activation" | "runtime" | "return" | "retirement";

function isolatedRuntimeLeaseContext(
  userDoc: FirestoreDocLike,
): IsolatedRuntimeLeaseContext | null {
  const data = userDoc.data();
  const resolved = activationLeaseFromUser(data);
  if (!resolved) return null;
  const { openclaw, lease } = resolved;
  if (
    typeof lease.leaseId !== "string" ||
    !Number.isSafeInteger(lease.generation)
  ) {
    return null;
  }
  return {
    data,
    openclaw,
    lease,
    leaseId: lease.leaseId,
    generation: lease.generation as number,
    leaseStatus: typeof lease.status === "string" ? lease.status : "",
  };
}

function isolatedRuntimeRetirementContext(
  uid: string,
  lease: GlmDoc,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
  operationsById: ReadonlyMap<string, GlmDoc>,
): IsolatedRuntimeRetirementContext {
  const targetGatewayId = asStringOrNull(lease.targetGatewayId);
  const target = targetGatewayId ? gatewaysById.get(targetGatewayId) : undefined;
  const retirementClaim = isPlainRecord(target?.retirementClaim)
    ? target.retirementClaim
    : null;
  let operationId: string | null = null;
  if (targetGatewayId) {
    operationId =
      asStringOrNull(retirementClaim?.operationId) ??
      leasePlacementRetireOperationId(uid, targetGatewayId, lease.generation);
  }
  const operation = operationId ? operationsById.get(operationId) : undefined;
  return {
    targetGatewayId,
    target,
    operationId,
    operation,
    started: target?.desiredStatus === "retired",
    complete: operation?.status === "succeeded",
    failed: operation?.status === "failed",
  };
}

function builderRuntimeLifecycle(
  leaseStatus: string,
  retirement: IsolatedRuntimeRetirementContext,
): AdminIsolatedRuntimeLifecycle | null {
  const targetRetained = leaseStatus === "parked" && !retirement.started && !retirement.failed &&
    projectDesiredStatus(retirement.target) === "paused";
  const teardownLingers = retirement.target !== undefined && !retirement.complete && !targetRetained;
  const visible =
    LIVE_ISOLATED_RUNTIME_STATUSES.has(leaseStatus) ||
    ((leaseStatus === "parked" || leaseStatus === "failed") && teardownLingers);
  if (!visible) return null;
  if (retirement.failed || leaseStatus === "failed") return "failed";
  if (retirement.started || leaseStatus === "parked") return "retiring";
  return leaseStatus as AdminIsolatedRuntimeLifecycle;
}

function builderRuntimePhase(
  leaseStatus: string,
  lifecycle: AdminIsolatedRuntimeLifecycle,
  retirementStarted: boolean,
): AdminIsolatedRuntimePhase {
  if (leaseStatus === "failed") return "activation";
  if (retirementStarted) return "retirement";
  if (lifecycle === "returning") return "return";
  if (lifecycle === "active") return "runtime";
  return "activation";
}

function builderRuntimeOperationId(
  phase: AdminIsolatedRuntimePhase,
  lease: GlmDoc,
  retirementOperationId: string | null,
): string | null {
  if (phase === "retirement") return retirementOperationId;
  if (phase === "return") return asStringOrNull(lease.returnOperationId);
  return asStringOrNull(lease.activationOperationId);
}

function builderRuntimeSlug(
  uid: string,
  data: GlmDoc,
  openclaw: GlmDoc,
  lease: GlmDoc,
): string {
  const leaseSlug = asStringOrNull(lease.builderSlug);
  if (leaseSlug) return leaseSlug;
  const openclawSlug = asStringOrNull(openclaw.slug);
  if (openclawSlug) return openclawSlug;
  return asStringOrNull(data.username) ?? uid;
}

function builderRuntimeIsStale(
  leaseStatus: string,
  wakeDurationMs: number | null,
): boolean {
  const preCutover =
    leaseStatus === "requested" ||
    leaseStatus === "provisioning" ||
    leaseStatus === "activating";
  return preCutover &&
    wakeDurationMs !== null &&
    wakeDurationMs > ISOLATED_RUNTIME_STALE_AFTER_MS;
}

function builderRuntimeTerminationAvailable(input: {
  targetGatewayId: string | null;
  currentGatewayId: string | null;
  target: GlmDoc | undefined;
  leaseFailed: boolean;
  stale: boolean;
}): boolean {
  return input.targetGatewayId !== null &&
    input.currentGatewayId !== input.targetGatewayId &&
    input.target?.desiredStatus !== "retired" &&
    (input.leaseFailed || input.stale);
}

function isoFromMillis(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function projectIsolatedRuntime(
  userDoc: FirestoreDocLike,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
  operationsById: ReadonlyMap<string, GlmDoc>,
  now: number,
): {
  uid: string;
  userSlug: string;
  lifecycle: AdminIsolatedRuntimeLifecycle;
  phase: "activation" | "runtime" | "return" | "retirement";
  leaseId: string;
  generation: number;
  cause: string | null;
  currentGatewayId: string | null;
  sourceGatewayId: string | null;
  targetGatewayId: string | null;
  sizingTier: string | null;
  requestedAt: string | null;
  wakeDurationMs: number | null;
  statusAt: string | null;
  statusAgeMs: number | null;
  stale: boolean;
  operationId: string | null;
  operationStatus: string | null;
  operationSteps: Array<{ name: string; status: string }>;
  cleanupOperationId: string | null;
  cleanupOperationStatus: string | null;
  cleanupOperationSteps: Array<{ name: string; status: string }>;
  cleanupError: string | null;
  error: string | null;
  terminationAvailable: boolean;
  targetPodStatus: GatewayPodDiagnosticsStatus | null;
  targetPodCount: number | null;
} | null {
  const leaseContext = isolatedRuntimeLeaseContext(userDoc);
  if (!leaseContext) return null;
  const { data, openclaw, lease, leaseId, generation, leaseStatus } = leaseContext;
  if (openclaw.managedBy === "operator") return null;
  const retirement = isolatedRuntimeRetirementContext(
    userDoc.id,
    lease,
    gatewaysById,
    operationsById,
  );
  const { targetGatewayId } = retirement;
  const lifecycle = builderRuntimeLifecycle(leaseStatus, retirement);
  if (!lifecycle) return null;
  const leaseFailed = leaseStatus === "failed";
  const phase = builderRuntimePhase(
    leaseStatus,
    lifecycle,
    retirement.started,
  );
  const operationId = builderRuntimeOperationId(
    phase,
    lease,
    retirement.operationId,
  );
  const operation = operationId ? operationsById.get(operationId) : undefined;
  const operationSteps = projectOperationSteps(operation);
  const cleanupOperationId = retirement.started
    ? retirement.operationId
    : null;
  const cleanupOperation = cleanupOperationId
    ? retirement.operation
    : undefined;
  const lastError = isPlainRecord(lease.lastError) ? lease.lastError : null;
  const requestedAt = toMillis(lease.requestedAt);
  const statusAt = runtimeStatusAt(lease, lifecycle);
  const statusAgeMs = ageMsOrNull(statusAt, now);
  const wakeDurationMs = runtimeWakeDurationMs(
    lease,
    leaseStatus,
    requestedAt,
    now,
  );
  const currentGatewayId = asStringOrNull(openclaw.gatewayId);
  const stale = builderRuntimeIsStale(leaseStatus, wakeDurationMs);
  return {
    uid: userDoc.id,
    userSlug: builderRuntimeSlug(userDoc.id, data, openclaw, lease),
    lifecycle,
    phase,
    leaseId,
    generation,
    cause: asStringOrNull(lease.cause),
    currentGatewayId,
    sourceGatewayId: asStringOrNull(lease.sourceGatewayId),
    targetGatewayId,
    sizingTier: asStringOrNull(lease.sizingTier),
    requestedAt: isoFromMillis(requestedAt),
    wakeDurationMs,
    statusAt: isoFromMillis(statusAt),
    statusAgeMs,
    stale,
    operationId,
    operationStatus: asStringOrNull(operation?.status),
    operationSteps,
    cleanupOperationId,
    cleanupOperationStatus: asStringOrNull(cleanupOperation?.status),
    cleanupOperationSteps: projectOperationSteps(cleanupOperation),
    cleanupError: asStringOrNull(cleanupOperation?.error),
    error:
      asStringOrNull(operation?.error) ??
      asStringOrNull(lastError?.message),
    terminationAvailable: builderRuntimeTerminationAvailable({
      targetGatewayId,
      currentGatewayId,
      target: retirement.target,
      leaseFailed,
      stale,
    }),
    targetPodStatus: null,
    targetPodCount: null,
  };
}

export function projectDisposableFleetCapacity(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
  isolatedRuntimes: ReadonlyArray<NonNullable<ReturnType<typeof projectIsolatedRuntime>>> = [],
  parkedUsers = 0,
): {
  disposableInstances: number;
  stagedInstances: 0;
  byTier: Record<string, number>;
  parkedUsers: number;
  byLifecycle: Record<AdminIsolatedRuntimeLifecycle | "parked", number>;
  failedUsers: number;
  staleActivations: number;
  oldestActivationAgeMs: number | null;
} {
  const disposables = gateways.filter((gateway) => gateway.disposableRuntime !== null);
  const byTier: Record<string, number> = {};
  const byLifecycle: Record<AdminIsolatedRuntimeLifecycle | "parked", number> = {
    requested: 0,
    provisioning: 0,
    activating: 0,
    active: 0,
    returning: 0,
    retiring: 0,
    failed: 0,
    parked: parkedUsers,
  };
  for (const gateway of disposables) {
    byTier[gateway.sizing.tier] = (byTier[gateway.sizing.tier] ?? 0) + 1;
  }
  for (const runtime of isolatedRuntimes) {
    byLifecycle[runtime.lifecycle] += 1;
  }
  const activationAges = isolatedRuntimes.flatMap((runtime) =>
    (
      runtime.lifecycle === "requested" ||
      runtime.lifecycle === "provisioning" ||
      runtime.lifecycle === "activating"
    ) && runtime.wakeDurationMs !== null
      ? [runtime.wakeDurationMs]
      : []
  );
  return {
    disposableInstances: disposables.length,
    stagedInstances: 0,
    byTier,
    parkedUsers,
    byLifecycle,
    failedUsers: byLifecycle.failed,
    staleActivations: isolatedRuntimes.filter((runtime) => runtime.stale).length,
    oldestActivationAgeMs:
      activationAges.length === 0 ? null : Math.max(...activationAges),
  };
}

function rollupFleetStats(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
): {
  gateways: { total: number; ready: number; paused: number; unreachable: number };
  usersMounted: number;
  fleetCost: {
    monthlyUsd: number;
    onDemandMonthlyUsd: number;
    savingsUsd: number;
    byTier: Record<string, {
      count: number;
      subtotalUsd: number;
      onDemandSubtotalUsd: number;
      spotCount: number;
      onDemandCount: number;
    }>;
  };
} {
  let ready = 0, paused = 0, unreachable = 0, usersMounted = 0, fleetMonthlyUsd = 0, fleetOnDemandUsd = 0;
  const byTier: Record<string, {
    count: number;
    subtotalUsd: number;
    onDemandSubtotalUsd: number;
    spotCount: number;
    onDemandCount: number;
  }> = {};
  for (const g of gateways) {
    if (g.status === "paused") paused++;
    else if (g.status === "unreachable") unreachable++;
    else if (g.status === "ready") ready++;
    usersMounted += g.mountedUsers.length;
    fleetMonthlyUsd += g.sizing.monthlyCostUsd.compute;
    fleetOnDemandUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    const entry = byTier[g.sizing.tier] ?? {
      count: 0,
      subtotalUsd: 0,
      onDemandSubtotalUsd: 0,
      spotCount: 0,
      onDemandCount: 0,
    };
    entry.count += 1;
    entry.subtotalUsd += g.sizing.monthlyCostUsd.compute;
    entry.onDemandSubtotalUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    if (g.reservation.type === "spot") entry.spotCount += 1;
    else entry.onDemandCount += 1;
    byTier[g.sizing.tier] = entry;
  }
  return {
    gateways: { total: gateways.length, ready, paused, unreachable },
    usersMounted,
    fleetCost: {
      monthlyUsd: fleetMonthlyUsd,
      onDemandMonthlyUsd: fleetOnDemandUsd,
      savingsUsd: Math.max(0, fleetOnDemandUsd - fleetMonthlyUsd),
      byTier,
    },
  };
}

const ERR_GATEWAY_NOT_FOUND = "gateway not found";
const ERR_GATEWAY_OPERATION_IN_FLIGHT =
  "another operation is already pending or running for this gateway";
export const ERR_USER_NOT_FOUND = "user not found";
const ERR_OPERATION_NOT_FOUND = "operation not found";
export const ERR_TARGET_GATEWAY_NOT_READY = "target gateway not ready";
export const ADMIN_FLEET_REQUEST_REASON = "Admin fleet request";
const OP_KIND_RESTART_GATEWAY = "restart-gateway";

interface RestoreRecoveryBody {
  sourceSha?: unknown;
  operationId?: unknown;
  reauthorizeAttemptId?: unknown;
  supersedeRecoveryId?: unknown;
}
function validRecoveryOperationId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && value.length <= 256 && !value.includes("/");
}
function validRecoveryAttemptId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 256;
}
function validRecoverySupersession(body: RestoreRecoveryBody): boolean {
  return body.supersedeRecoveryId === undefined || (validRecoveryAttemptId(body.supersedeRecoveryId) &&
    !body.supersedeRecoveryId.includes("/"));
}
function validSourceRecoveryBody(body: Record<string, unknown>): boolean {
  const predecessorId = body.supersedeRecoveryId;
  return typeof body.sourceSha === "string" && /^[a-f0-9]{40}$/.test(body.sourceSha) &&
    Object.keys(body).every(key => ["sourceSha", "supersedeRecoveryId"].includes(key)) &&
    (predecessorId === undefined || (typeof predecessorId === "string" && Boolean(predecessorId) && !predecessorId.includes("/")));
}
function validRestoreRecoveryBody(body: RestoreRecoveryBody): boolean {
  return typeof body.sourceSha === "string" && /^[a-f0-9]{40}$/.test(body.sourceSha) &&
    validRecoveryOperationId(body.operationId) &&
    (body.reauthorizeAttemptId === undefined || validRecoveryAttemptId(body.reauthorizeAttemptId)) &&
    validRecoverySupersession(body) &&
    Object.keys(body).every(key => ["sourceSha", "operationId", "reauthorizeAttemptId", "supersedeRecoveryId"].includes(key));
}
async function capturedRestoreAttempt(store: PlatformStateStore, operationId: string, attemptId: unknown): Promise<UntypedRecord | undefined> {
  if (attemptId === undefined) return undefined;
  return (await store.journal.operations.get(operationId))?.restoreAttempt;
}
function failedRecoveryOperationMatches(previous: UntypedRecord | undefined, gatewayId: string): previous is UntypedRecord {
  return previous?.kind === OP_KIND_RESTART_GATEWAY && previous.status === "failed" &&
    previous.cancellationRequestedAt === undefined && previous.completedAt > 0 &&
    previous.restoreRuntimeRecovery === undefined && previous.input?.gatewayId === gatewayId;
}
function recoveryPredecessorFenceMatches(input: {
  fence: UntypedRecord | undefined;
  predecessorId: string;
  gatewayId: string;
  operationId: string;
  images: unknown;
}): boolean {
  const { fence, predecessorId, gatewayId, operationId, images } = input;
  return fence?.kind === "restore-recovery" && fence.attemptId === predecessorId &&
    fence.gatewayId === gatewayId && fence.phase === "dispatched" &&
    fence.target?.restoreOperationId === operationId && isDeepStrictEqual(fence.target?.images, images);
}
async function capturedRecoveryPredecessor(store: PlatformStateStore, gatewayId: string, operationId: string, predecessorId: string, reauthorize: unknown) {
  const [root, predecessor] = await Promise.all([
    store.gateways.roots.get(gatewayId), store.journal.operations.get(predecessorId),
  ]);
  const previous: UntypedRecord | undefined = predecessor === null ? undefined : recordDoc(predecessorId, predecessor).data();
  const fence: UntypedRecord | undefined = root?.runtimeRestartFence;
  const recovery = previous?.input?.restoreRecovery;
  if (recovery?.operationId !== operationId ||
      !recoveryPredecessorFenceMatches({ fence, predecessorId, gatewayId, operationId, images: recovery.images })) return null;
  if (!failedRecoveryOperationMatches(previous, gatewayId) || reauthorize === undefined || !isDeepStrictEqual(recovery.reauthorize, reauthorize)) return null;
  return { operationId: predecessorId, input: previous.input, completedAt: previous.completedAt, fence };
}
function restoreRecoveryOperationInput(input: {
  gatewayId: string;
  sourceSha: string;
  operationId: string;
  payload: ReturnType<typeof centralGatewayReleasePayload>;
  reauthorize: UntypedRecord | undefined;
  supersede: Awaited<ReturnType<typeof capturedRecoveryPredecessor>> | undefined;
}) {
  const { gatewayId, sourceSha, operationId, payload, reauthorize, supersede } = input;
  return { gatewayId, restoreRecovery: { operationId, sourceSha,
    ...(reauthorize ? { reauthorize } : {}), ...(supersede ? { supersede } : {}),
    images: { gateway: `${payload.imageRepository}:${payload.imageTag}`,
      "gateway-edge": `${payload.gatewayEdgeImage!.imageRepository}:${payload.gatewayEdgeImage!.imageTag}` } } };
}
export const OP_KIND_MIGRATE_USER = "migrate-user";
const BUILDS_SERVICE_ALLOWLIST = new Set([
  "octogee-gateway",
  "gateway-edge",
  "release-digest-manifest",
]);

const OP_KINDS = new Set([
  "add-gateway",
  OP_KIND_MIGRATE_USER,
  "retire-gateway",
  OP_KIND_RESTART_GATEWAY,
  "rollout",
  "deprovision-user",
  "suspend-user",
  "erase-user",
]);
const OP_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
]);

export interface AdminGatewayControlProjection {
  desiredStatus: string;
  desiredRelease: number | null;
  liveRelease: number | null;
  runtime: GatewayRuntime;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  profile: GatewayProfile | null;
  sizingTier: string | null;
  ownerUid: string | null;
  userSlug: string | null;
  gcpProject: string | null;
  serviceAccountName: string | null;
  userAccess: Record<string, unknown> | null;
  modelBrokerLimits: Record<string, unknown> | null;
  vm: GatewayVmState | null;
}

export function projectGatewayControl(
  root: DurableGatewayRoot,
  glmData: Record<string, unknown> | undefined,
): AdminGatewayControlProjection {
  const profileInput = {
    gatewayClass: root.gatewayClass,
    imageProfile: root.imageProfile,
    profile: root.profile ?? undefined,
  };
  return {
    desiredStatus: root.desiredStatus,
    desiredRelease: releaseNumberOrNull(root.desiredRelease),
    liveRelease: releaseNumberOrNull(root.liveRelease),
    runtime: resolveGatewayRuntime(glmData?.runtime),
    gatewayClass: resolveGatewayClass(profileInput),
    imageProfile: resolveGatewayImageProfile(profileInput),
    profile: orNull(root.profile),
    sizingTier: orNull(root.sizingTier),
    ownerUid: orNull(root.ownerUid),
    userSlug: orNull(root.builderSlug),
    gcpProject: orNull(root.gcpProject),
    serviceAccountName: orNull(root.serviceAccountName),
    userAccess: orNull(root.builderAccess as Record<string, unknown> | null | undefined),
    modelBrokerLimits: orNull(root.modelBrokerLimits as Record<string, unknown> | null | undefined),
    vm: recordOrNull(glmData?.vm) as GatewayVmState | null,
  };
}

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function releaseNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

interface DrawerMountedUser {
  uid: string;
  slug: string;
  username: string;
  email: string;
  lastActive: string | null;
}

interface DrawerOperation {
  id: string;
  kind: string;
  status: string;
  createdBy: string;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: unknown[];
  error?: string;
  rolledBack?: boolean;
}

interface NewOperationInput {
  kind:
    | "add-gateway"
    | typeof OP_KIND_MIGRATE_USER
    | "retire-gateway"
    | "restart-gateway"
    | "rollout"
    | "deprovision-user"
    | "suspend-user"
    | "erase-user";
  createdBy: string;
  origin?: "automatic" | "operator";
  input: Record<string, unknown>;
}

interface AddGatewayBody {
  gatewayId: string;
  sourceSha: string;
  profile: string;
  gatewayClass: string;
  imageProfile: string;
  sizingTier: string;
  ownerUid: string;
  userSlug: string;
}

interface AddGatewayCreate {
  gatewayId: string;
  sourceSha: string | null;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  sizingTier?: SizingTier;
}

export function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function coerceNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function toMillis(v: unknown): number | null {
  if (v == null) return null;
  const t = v as { toDate?: () => Date };
  if (typeof t?.toDate === "function") return t.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return null;
}

function toIso(v: unknown): string | null {
  const ms = toMillis(v);
  return ms == null ? null : new Date(ms).toISOString();
}

function ageMsOrNull(ms: number | null, now: number): number | null {
  return ms == null ? null : now - ms;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

interface RolloutBodyError {
  status: number;
  body: Record<string, unknown>;
}

// A PATCH may move a gateway between running/paused/draining, but NOT to
// "retired": that must run full teardown via DELETE (which creates the
// retire-gateway op). A bare PATCH to "retired" only flips desired state, and
// the reconciler would then remove the pod while stranding the PVC, both
// auth-token secrets, the GSA, and the Firestore records.
export function validateDesiredStatusPatch(
  desiredStatus: string,
):
  | { error: { status: number; body: { error: string; got?: string } } }
  | { ok: "running" | "paused" | "draining" } {
  if (desiredStatus === "retired") {
    return {
      error: {
        status: 400,
        body: {
          error:
            "retire a gateway via DELETE /gateways/:id (full teardown), not PATCH desiredStatus=retired",
        },
      },
    };
  }
  if (
    desiredStatus !== "running" &&
    desiredStatus !== "paused" &&
    desiredStatus !== "draining"
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "desiredStatus must be one of: running, paused, draining",
          got: desiredStatus,
        },
      },
    };
  }
  return { ok: desiredStatus };
}

export function validateDeployBody(
  body: unknown,
): { error: RolloutBodyError } | { ok: { sourceSha: string } } {
  if (
    !isPlainRecord(body) ||
    Object.keys(body).length !== 1 ||
    !releaseSourceShaFromBody(body.sourceSha)
  ) {
    return {
      error: {
        status: 400,
        body: { error: "deploy requires one exact full lowercase sourceSha" },
      },
    };
  }
  return { ok: { sourceSha: body.sourceSha as string } };
}

const ADD_GATEWAY_IMAGE_FIELDS = ["imageRepository", "imageTag"] as const;

function validateAddGatewayRequiredFields(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | {
  ok: Pick<AddGatewayCreate, "gatewayId" | "sourceSha">;
} {
  const imageFields = ADD_GATEWAY_IMAGE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field));
  if (imageFields.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: "gateway add takes a build: name its sourceSha; the images come from that build's manifest",
          fields: imageFields,
        },
      },
    };
  }
  if (!isNonEmptyString(body.gatewayId)) {
    return {
      error: {
        status: 400,
        body: { error: "missing required fields", required: ["gatewayId"] },
      },
    };
  }
  if (body.sourceSha !== undefined && !releaseSourceShaFromBody(body.sourceSha)) {
    return {
      error: {
        status: 400,
        body: { error: "sourceSha must be one exact full lowercase commit SHA", got: body.sourceSha },
      },
    };
  }
  if (!isValidNewGatewayId(body.gatewayId)) {
    return {
      error: {
        status: 400,
        body: {
          error: NEW_GATEWAY_ID_REQUIREMENT,
          got: body.gatewayId,
        },
      },
    };
  }
  return {
    ok: {
      gatewayId: body.gatewayId,
      sourceSha: body.sourceSha ?? null,
    },
  };
}

function validateAddGatewayProfile(
  body: Partial<AddGatewayBody>,
): {
  error: RolloutBodyError;
} | {
  ok: {
    profile?: GatewayProfile;
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
  };
} {
  if (body.profile !== undefined && !isGatewayProfile(body.profile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `profile must be one of: ${GATEWAY_PROFILES.join(", ")}`,
          got: body.profile,
        },
      },
    };
  }
  if (body.gatewayClass !== undefined && !isAdminGatewayClass(body.gatewayClass)) {
    return {
      error: {
        status: 400,
        body: {
          error: "gatewayClass must be one of: shared, isolated",
          got: body.gatewayClass,
        },
      },
    };
  }
  if (body.imageProfile !== undefined && !isGatewayProfile(body.imageProfile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `imageProfile must be one of: ${GATEWAY_IMAGE_PROFILES.join(", ")}`,
          got: body.imageProfile,
        },
      },
    };
  }
  return {
    ok: {
      ...(body.profile ? { profile: body.profile as GatewayProfile } : {}),
      ...(body.gatewayClass ? { gatewayClass: body.gatewayClass === "isolated" ? "builder" as const : "shared" as const } : {}),
      ...(body.imageProfile ? { imageProfile: body.imageProfile as GatewayImageProfile } : {}),
    },
  };
}

function validateAddGatewaySizing(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: { sizingTier?: SizingTier } } {
  if (
    body.sizingTier !== undefined &&
    !(SIZING_TIERS as readonly string[]).includes(body.sizingTier)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
          got: body.sizingTier,
        },
      },
    };
  }
  return {
    ok: body.sizingTier ? { sizingTier: body.sizingTier as SizingTier } : {},
  };
}

function validateSharedGatewayCreate(
  body: Partial<AddGatewayBody>,
  gatewayClass: GatewayClass,
): RolloutBodyError | null {
  if (gatewayClass !== "shared") {
    return {
      status: 400,
      body: {
        error: "isolated gateways are created by the disposable lifecycle",
      },
    };
  }
  if (body.ownerUid !== undefined || body.userSlug !== undefined) {
    return {
      status: 400,
      body: { error: "shared gateway creation does not accept owner fields" },
    };
  }
  if (!isSharedPoolSlotId(body.gatewayId)) {
    return {
      status: 400,
      body: { error: SHARED_POOL_SLOT_ID_REQUIREMENT, got: body.gatewayId },
    };
  }
  return null;
}

function validateAddGatewayBody(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: AddGatewayCreate } {
  const required = validateAddGatewayRequiredFields(body);
  if ("error" in required) return required;
  const profile = validateAddGatewayProfile(body);
  if ("error" in profile) return profile;
  const gatewayClass = resolveGatewayClass(profile.ok);
  const sizing = validateAddGatewaySizing(body);
  if ("error" in sizing) return sizing;
  const ownershipError = validateSharedGatewayCreate(
    body,
    gatewayClass,
  );
  if (ownershipError) return { error: ownershipError };
  return {
    ok: {
      ...required.ok,
      ...profile.ok,
      gatewayClass,
      imageProfile: resolveGatewayImageProfile(profile.ok),
      ...sizing.ok,
    },
  };
}

function readUserGatewayId(
  data: Record<string, unknown> | undefined,
): string | null {
  const provisioning =
    (data?.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.gatewayId);
}

function resolveUserSlug(userData: Record<string, unknown>): string | null {
  return asStringOrNull(readUserOpenclaw(userData).slug) ?? asStringOrNull(userData.username);
}

interface PendingPlacement {
  uid: string;
  username: string;
  email: string;
  currentGatewayId: string | null;
  reason: "never-assigned" | "gateway-gone";
}

interface UserPlacement {
  kind: "unassigned" | "orphan" | "assigned-not-mounted" | "mounted";
  gid: string | null;
  pending: PendingPlacement | null;
}

function classifyUserPlacement(
  uid: string,
  data: Record<string, unknown>,
  gateways: Map<string, { mountedCustomers: Set<string> }>,
): UserPlacement {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const slug = userSlug(data) || null;
  const gid =
    typeof openclaw.gatewayId === "string" ? openclaw.gatewayId : null;
  const username = typeof data.username === "string" ? data.username : "";
  const email = typeof data.email === "string" ? data.email : "";

  if (!gid) {
    return {
      kind: "unassigned",
      gid: null,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: null,
        reason: "never-assigned",
      },
    };
  }
  const gw = gateways.get(gid);
  if (!gw) {
    return {
      kind: "orphan",
      gid,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: gid,
        reason: "gateway-gone",
      },
    };
  }
  return {
    kind: slug && gw.mountedCustomers.has(slug) ? "mounted" : "assigned-not-mounted",
    gid,
    pending: null,
  };
}

function readMountedSlugs(
  hbData: Record<string, unknown> | undefined,
): Set<string> {
  if (!Array.isArray(hbData?.mountedCustomers)) return new Set();
  return new Set(
    (hbData.mountedCustomers as unknown[]).filter(
      (s): s is string => typeof s === "string",
    ),
  );
}

function buildMountedUser(
  uid: string,
  data: Record<string, unknown>,
  slug: string,
): DrawerMountedUser {
  return {
    uid,
    slug,
    username: typeof data.username === "string" ? data.username : "",
    email: typeof data.email === "string" ? data.email : "",
    lastActive: toIso(data.lastActive),
  };
}

function userSlug(data: Record<string, unknown>): string {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  if (typeof openclaw.slug === "string") return openclaw.slug;
  return typeof data.username === "string" ? data.username : "";
}

function shapeDrawerOperation(
  id: string,
  data: Record<string, unknown>,
): DrawerOperation {
  const kind =
    typeof data.kind === "string" && OP_KINDS.has(data.kind)
      ? data.kind
      : "unknown";
  const status =
    typeof data.status === "string" && OP_STATUSES.has(data.status)
      ? data.status
      : "unknown";
  const out: DrawerOperation = {
    id,
    kind,
    status,
    createdBy:
      typeof data.createdBy === "string" ? data.createdBy : "unknown",
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    input:
      typeof data.input === "object" && data.input !== null
        ? (data.input as Record<string, unknown>)
        : {},
    steps: Array.isArray(data.steps) ? data.steps : [],
  };
  if (typeof data.error === "string") out.error = data.error;
  if (typeof data.rolledBack === "boolean") out.rolledBack = data.rolledBack;
  return out;
}

function shapeInvalidOperationAuditHistoryRecord(
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    recordType: "audit",
    invalid: true,
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : null,
    status: "invalid",
    lifecycleStage: "invalid",
    createdAt: typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
      ? data.createdAt
      : 0,
    completedAt: null,
    error: "Unsupported or malformed operation audit record",
  };
}

function shapeAuditHistoryPreCreatedAtFields(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(data.aliasOutcomes ? { aliasOutcomes: data.aliasOutcomes } : {}),
    ...(data.releaseRollout ? { releaseRollout: data.releaseRollout } : {}),
    ...(data.testProvenance ? { testProvenance: data.testProvenance } : {}),
    ...(data.outcome ? { outcome: data.outcome } : {}),
    ...(data.partialOutcome ? { partialOutcome: data.partialOutcome } : {}),
  };
}

function shapeAuditHistoryActionFields(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(data.actionClaimId ? { actionClaimId: data.actionClaimId } : {}),
    ...(data.actionStartedAt !== undefined ? { actionStartedAt: data.actionStartedAt } : {}),
    ...(data.actionRecoveryCount !== undefined
      ? { actionRecoveryCount: data.actionRecoveryCount }
      : {}),
  };
}

function shapeAuditHistoryErrorField(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

function shapeValidOperationAuditHistoryRecord(
  id: string,
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    id,
    recordType: data.recordType,
    schemaVersion: data.schemaVersion,
    status: data.status,
    lifecycleStage: data.lifecycleStage,
    idempotencyKey: data.idempotencyKey,
    mutationFingerprint: data.mutationFingerprint,
    mutation: data.mutation,
    kind: data.mutation.kind,
    actor: data.actor,
    createdBy: data.actor,
    forced: data.forced,
    what: data.what,
    why: data.why,
    target: data.target,
    preActionStatus: data.preActionStatus,
    aliasPlan: data.aliasPlan,
    ...shapeAuditHistoryPreCreatedAtFields(data),
    createdAt: data.createdAt,
    ...shapeAuditHistoryActionFields(data),
    completedAt: data.completedAt,
    ...shapeAuditHistoryErrorField(data),
  };
}

function attachHandoffProgress(
  gateways: Array<{ gateway: string; handoffProgress?: Record<string, MigrationProgressRecord[]> }>,
  byGateway: ReadonlyMap<string, Record<string, MigrationProgressRecord[]>>,
): void {
  for (const gateway of gateways) {
    gateway.handoffProgress = byGateway.get(gateway.gateway) ?? {};
  }
}

export function projectHandoffProgress(
  assignments: readonly AssignmentDoc[],
): Map<string, Record<string, MigrationProgressRecord[]>> {
  const byGateway = new Map<string, Record<string, MigrationProgressRecord[]>>();
  for (const assignment of assignments) {
    const progress = assignment.handoffProgress;
    if (!progress || progress.length === 0) continue;
    const newest = [...progress].sort((a, b) => b.at - a.at)[0];
    if (assignment.state === "serving" && newest.status !== "failed") continue;
    const slugs = byGateway.get(assignment.gatewayId) ?? {};
    slugs[assignment.slug] = progress;
    byGateway.set(assignment.gatewayId, slugs);
  }
  return byGateway;
}

function isUnresolvedMigrationFailure(data: Record<string, unknown>): boolean {
  return data.kind === OP_KIND_MIGRATE_USER && (data.status === "failed" || data.status === "rolled-back");
}

async function listUnresolvedOperationDocs(
  store: PlatformStateStore,
  limit: number,
): Promise<FirestoreDocLike[]> {
  const [inFlight, assignments] = await Promise.all([
    store.journal.operations.listByStatus(["pending", "running"]),
    store.gateways.assignments.listAll(),
  ]);
  const inFlightIds = new Set(inFlight.map((operation) => operation.id));
  const pointed = new Set<string>();
  for (const assignment of assignments) {
    const operationId = asStringOrNull(assignment.updatedByOperationId);
    if (operationId && !inFlightIds.has(operationId)) pointed.add(operationId);
  }
  const pointedOperations = await store.journal.operations.getMany([...pointed]);
  const pointedFailures = [...pointedOperations.values()].filter((operation) =>
    isUnresolvedMigrationFailure({ ...operation }));
  const createdAt = (operation: OperationRecord): number => coerceNumberOrNull(operation.createdAt) ?? 0;
  const newestFirst = (operations: OperationRecord[]): OperationRecord[] =>
    operations.sort((a, b) => createdAt(b) - createdAt(a));
  const inFlightCapped = newestFirst([...inFlight]).slice(0, limit);
  return operationDocs(newestFirst([...pointedFailures, ...inFlightCapped]));
}

const JOURNAL_STATUS_FILTERS = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
  "recorded",
  "in-progress",
  "completed",
] as const satisfies readonly (OperationStatus | OperationAuditStatus)[];

type JournalStatusFilter = (typeof JOURNAL_STATUS_FILTERS)[number];

const JOURNAL_SCAN_PAGE_SIZE = 100;

function isJournalStatusFilter(value: unknown): value is JournalStatusFilter {
  return (JOURNAL_STATUS_FILTERS as readonly unknown[]).includes(value);
}

async function listJournalDocsWithStatus(
  store: PlatformStateStore,
  status: JournalStatusFilter,
  limit: number,
): Promise<FirestoreDocLike[]> {
  const matching: GlmOperationRecord[] = [];
  let after: string | null = null;
  do {
    const page = await store.journal.listRecent(
      after === null ? { limit: JOURNAL_SCAN_PAGE_SIZE } : { limit: JOURNAL_SCAN_PAGE_SIZE, after },
    );
    for (const record of page.items) {
      if (record.status !== status) continue;
      matching.push(record);
      if (matching.length === limit) return operationDocs(matching);
    }
    after = page.next;
  } while (after !== null);
  return operationDocs(matching);
}

async function listOperationDocsForStatus(
  store: PlatformStateStore,
  status: "unresolved" | JournalStatusFilter | undefined,
  limit: number,
): Promise<FirestoreDocLike[]> {
  if (status === undefined) return operationDocs((await store.journal.listRecent({ limit })).items);
  if (status === "unresolved") return listUnresolvedOperationDocs(store, limit);
  return listJournalDocsWithStatus(store, status, limit);
}

export function shapeOperationsHistoryRecord(
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (isOperationAuditRow(data) && !isOperationAuditRecord(data)) {
    return shapeInvalidOperationAuditHistoryRecord(id, data);
  }
  if (isOperationAuditRecord(data)) {
    return shapeValidOperationAuditHistoryRecord(id, data);
  }
  return { id, ...data };
}

async function projectGatewaySummaryWithDiagnostics(
  deps: FleetRouterDeps,
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): Promise<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}> {
  const summary = projectGatewaySummary(doc, glmDoc, now);
  if (!deps.readGatewayPodDiagnostics) {
    return { ...summary, podDiagnostics: null };
  }
  try {
    const podDiagnostics = await deps.readGatewayPodDiagnostics(summary.gatewayId);
    return {
      ...repriceGatewaySummaryFromKubernetes(summary, podDiagnostics),
      podDiagnostics,
    };
  } catch (e) {
    deps.logger.warn("gateway pod diagnostics failed", {
      gatewayId: summary.gatewayId,
      error: (e as Error)?.message ?? String(e),
    });
    return {
      ...summary,
      podDiagnostics: {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
        totalRestarts: 0,
        spotPods: 0,
        onDemandPods: 0,
        unknownCapacityPods: 0,
        pods: [],
        error: (e as Error)?.message ?? "pod diagnostics failed",
      },
    };
  }
}

function unknownGatewayPodDiagnostics(error: string): GatewayPodDiagnostics {
  return {
    status: "unknown",
    totalPods: 0,
    readyPods: 0,
    totalRestarts: 0,
    spotPods: 0,
    onDemandPods: 0,
    unknownCapacityPods: 0,
    pods: [],
    error,
  };
}

function observedGatewayCapacityType(
  diagnostics: GatewayPodDiagnostics,
): GatewayPodCapacityType | undefined {
  if (diagnostics.onDemandPods > 0) return "on-demand";
  if (diagnostics.spotPods > 0) return "spot";
  return undefined;
}

function repriceGatewaySummaryFromKubernetes<T extends ReturnType<typeof projectGatewaySummary>>(
  summary: T,
  diagnostics: GatewayPodDiagnostics,
): T {
  const reservation = projectGatewayReservation(
    { gatewayClass: summary.gatewayClass },
    observedGatewayCapacityType(diagnostics),
  );
  const cost = summary.desiredStatus === "paused"
    ? {
        computeUsd: 0,
        onDemandComputeUsd: 0,
        savingsUsd: 0,
        pricingMode: reservation.type,
        perUserAtTarget: 0,
        perUserAtTypical: 0,
      }
    : estimateGatewayMonthlyCost(summary.sizing.tier, {
        pricingMode: reservation.type,
      });
  return {
    ...summary,
    reservation,
    sizing: {
      ...summary.sizing,
      monthlyCostUsd: {
        compute: cost.computeUsd,
        onDemandCompute: cost.onDemandComputeUsd,
        savings: cost.savingsUsd,
        pricingMode: cost.pricingMode,
        perUserAtTarget: cost.perUserAtTarget,
        perUserAtTypical: cost.perUserAtTypical,
      },
    },
  };
}

async function projectGatewaySummariesWithDiagnostics(
  deps: FleetRouterDeps,
  summaries: Array<ReturnType<typeof projectGatewaySummary>>,
  readBatch: NonNullable<FleetRouterDeps["readGatewayPodDiagnosticsBatch"]>,
): Promise<Array<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}>> {
  try {
    const diagnostics = await readBatch(
      summaries.map((summary) => summary.gatewayId),
    );
    return summaries.map((summary) => {
      const podDiagnostics = diagnostics[summary.gatewayId] ??
        unknownGatewayPodDiagnostics("gateway missing from batched pod diagnostics");
      return {
        ...repriceGatewaySummaryFromKubernetes(summary, podDiagnostics),
        podDiagnostics,
      };
    });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    deps.logger.warn("gateway pod diagnostics batch failed", { error: message });
    return summaries.map((summary) => ({
      ...summary,
      podDiagnostics: unknownGatewayPodDiagnostics(message),
    }));
  }
}

function operationGatewayId(input: Record<string, unknown>): string | null {
  for (const field of ["gatewayId", "toGatewayId", "fromGatewayId"]) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  return null;
}

export async function createOperation(
  store: PlatformStateStore,
  opts: NewOperationInput,
): Promise<string> {
  return store.transaction({ label: "admin.fleet.createOperation" }, (transaction) =>
    transaction.journal.operations.enqueue(operationDoc(opts, Date.now())));
}

function operationDoc(
  opts: NewOperationInput,
  createdAt: number,
): NewOperation {
  const gatewayId = operationGatewayId(opts.input);
  const inputUid =
    typeof opts.input.uid === "string" ? opts.input.uid : null;
  return {
    kind: opts.kind,
    status: "pending",
    createdBy: opts.createdBy,
    ...(opts.origin ? { origin: opts.origin } : {}),
    createdAt,
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  };
}

async function readGatewayDoc(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<DurableGatewayRoot | null> {
  return durableRootOf(await store.gateways.roots.get(gatewayId), gatewayId);
}

function releaseSourceShaFromBody(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

function artifactFromRelease(release: ReleaseDoc): GatewayArtifact | null {
  if (!isReleasePayload(release.payload)) return null;
  return gatewayArtifactFromReleasePayload(release.payload);
}

function sameArtifact(left: GatewayArtifact, right: GatewayArtifact): boolean {
  return (
    left.imageRepository === right.imageRepository &&
    left.imageTag === right.imageTag
  );
}

function respondReleaseWriteConflict(res: Response, error: unknown): boolean {
  if (error instanceof GatewayRetirementConflictError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  if (error instanceof GatewayMigrationInFlightError) {
    res.status(409).json({
      error: error.message,
      gatewayId: error.gatewayId,
      operationId: error.operationId,
      kind: OP_KIND_MIGRATE_USER,
    });
    return true;
  }
  if (error instanceof InvalidGatewayRootError) {
    res.status(409).json({ error: error.message, gatewayId: error.gatewayId });
    return true;
  }
  if (error instanceof StaleGatewayReleaseError) {
    res.status(409).json({
      error: error.message,
      gatewayId: error.gatewayId,
      expectedRelease: error.expectedRelease,
      actualRelease: error.actualRelease,
    });
    return true;
  }
  return false;
}

class CentralReleaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : "CENTRAL release request failed");
  }
}

function rejectCentralReleaseRequest(status: number, body: Record<string, unknown>): never {
  throw new CentralReleaseRequestError(status, body);
}

async function centralManifestForSourceSha(
  authority: CentralReleaseAuthority,
  sourceSha: string,
): Promise<ReleaseDigestManifest> {
  const manifest = await authority.resolveManifest(sourceSha);
  if (manifest.sourceSha !== sourceSha) {
    rejectCentralReleaseRequest(409, {
      error: "release manifest sourceSha does not match the requested SHA",
    });
  }
  return manifest;
}

function respondCentralReleaseError(res: Response, error: unknown): boolean {
  if (error instanceof CentralReleaseRequestError) {
    res.status(error.status).json(error.body);
    return true;
  }
  return respondReleaseWriteConflict(res, error);
}

const GATEWAY_MUTABLE_CONFIG_FIELDS = [
  "profile",
  "gatewayClass",
  "imageProfile",
  "sizingTier",
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "builderAccess",
  "ownerUid",
  "builderSlug",
  "modelBrokerLimits",
] as const satisfies ReadonlyArray<keyof Omit<GatewayMutableConfig, "configSchemaVersion">>;

const ADMIN_GATEWAY_CONFIG_FIELD_NAMES: Partial<Record<(typeof GATEWAY_MUTABLE_CONFIG_FIELDS)[number], string>> = {
  builderAccess: "userAccess",
  builderSlug: "userSlug",
};

function mutableConfigPatchFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of GATEWAY_MUTABLE_CONFIG_FIELDS) {
    const name = ADMIN_GATEWAY_CONFIG_FIELD_NAMES[field] ?? field;
    if (Object.prototype.hasOwnProperty.call(body, name)) patch[field] = body[name];
  }
  return patch;
}

function buildCreateGatewayConfig(args: {
  body: AddGatewayCreate;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
}): GatewayMutableConfig {
  return {
    configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
    profile: args.body.profile ?? null,
    gatewayClass: args.gatewayClass,
    imageProfile: args.imageProfile,
    sizingTier: args.body.sizingTier ?? null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
  };
}

type AddGatewayBuild =
  | { kind: "named"; sourceSha: string; manifestDigest: string; artifact: GatewayArtifact }
  | { kind: "platform"; artifact: GatewayArtifact };

async function readAddGatewayRequest(
  store: PlatformStateStore,
  deps: Pick<FleetRouterDeps, "releaseEnvironment" | "releaseAuthority" | "platformArtifact">,
  rawBody: unknown,
): Promise<{ error: RolloutBodyError } | { ok: { body: AddGatewayCreate; build: AddGatewayBuild } }> {
  const bodyError = gatewayCreationBodyError((rawBody ?? {}) as Record<string, unknown>);
  if (bodyError) return { error: bodyError };
  const parsed = validateAddGatewayBody(rawBody as Partial<AddGatewayBody>);
  if ("error" in parsed) return parsed;
  const uniqueness = await ensureGatewayCreateIsUnique(store, parsed.ok);
  if ("error" in uniqueness) return uniqueness;
  const build = await resolveAddGatewayBuild(deps, parsed.ok.sourceSha);
  if ("error" in build) return build;
  return { ok: { body: parsed.ok, build: build.ok } };
}

async function resolveAddGatewayBuild(
  deps: Pick<FleetRouterDeps, "releaseEnvironment" | "releaseAuthority" | "platformArtifact">,
  sourceSha: string | null,
): Promise<{ error: RolloutBodyError } | { ok: AddGatewayBuild }> {
  if (sourceSha === null) {
    if (deps.platformArtifact === undefined) {
      return {
        error: {
          status: 400,
          body: { error: "a build is required: name its sourceSha; the build the platform is running is not known here" },
        },
      };
    }
    return { ok: { kind: "platform", artifact: deps.platformArtifact } };
  }
  if (!deps.releaseEnvironment || !deps.releaseAuthority) {
    return { error: { status: 503, body: { error: "immutable build manifests are unavailable" } } };
  }
  let manifest: ReleaseDigestManifest;
  try {
    manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
  } catch (error) {
    if (error instanceof ReleaseDigestManifestNotFoundError) {
      return { error: { status: 404, body: { error: "no build manifest for sourceSha", sourceSha } } };
    }
    if (error instanceof CentralReleaseRequestError) {
      return { error: { status: error.status, body: error.body } };
    }
    throw error;
  }
  return {
    ok: {
      kind: "named",
      sourceSha,
      manifestDigest: manifest.manifestDigest,
      artifact: gatewayArtifactFromReleasePayload(centralGatewayReleasePayload(manifest)),
    },
  };
}

function buildDurableGatewayPatch(args: {
  gatewayId: string;
  current: GatewayMutableConfig;
  body: Record<string, unknown>;
}):
  | { error: RolloutBodyError }
  | { ok: { patch: Record<string, unknown>; config: GatewayMutableConfig } } {
  const artifactFields = ["imageRepository", "imageTag"].filter((field) =>
    Object.prototype.hasOwnProperty.call(args.body, field),
  );
  if (artifactFields.length > 0) {
    return {
      error: {
        status: 409,
        body: {
          error: "image artifacts deploy from immutable releases; use POST /api/admin/gateways/:id/deploy",
          fields: artifactFields,
        },
      },
    };
  }
  if (Object.prototype.hasOwnProperty.call(args.body, "byosub")) {
    return {
      error: {
        status: 400,
        body: { error: "gateway credential references are user-scoped and cannot be patched here" },
      },
    };
  }
  const lifecycleOwnedFields = ["gatewayClass", "ownerUid", "userSlug"].filter((field) =>
    Object.prototype.hasOwnProperty.call(args.body, field),
  );
  if (lifecycleOwnedFields.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: "gateway ownership is managed by the disposable lifecycle",
          fields: lifecycleOwnedFields,
        },
      },
    };
  }
  const configPatch = mutableConfigPatchFromBody(args.body);
  const patch: Record<string, unknown> = { ...configPatch };
  if (args.body.desiredStatus !== undefined) {
    if (typeof args.body.desiredStatus !== "string") {
      return { error: { status: 400, body: { error: "desiredStatus must be a string" } } };
    }
    const desired = validateDesiredStatusPatch(args.body.desiredStatus);
    if ("error" in desired) return { error: desired.error };
    if (desired.ok === "draining") {
      return {
        error: {
          status: 400,
          body: { error: "durable gateway desiredStatus must be running or paused" },
        },
      };
    }
    patch.desiredStatus = desired.ok;
  }
  if (Object.keys(patch).length === 0) {
    return { error: { status: 400, body: { error: "no updatable fields provided" } } };
  }
  const config = { ...args.current, ...configPatch } as GatewayMutableConfig;
  if (!isGatewayMutableConfigForGateway(config, args.gatewayId)) {
    return {
      error: {
        status: 400,
        body: { error: "invalid durable gateway configuration", gatewayId: args.gatewayId },
      },
    };
  }
  return { ok: { patch, config } };
}

async function findConflictingGatewayOp(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<{ id: string; kind: string | null } | null> {
  const pendingOps = await store.journal.operations.listByStatus(["pending", "running"]);
  const conflicting = pendingOps.find((operation) => operation.input.gatewayId === gatewayId);
  return conflicting ? { id: conflicting.id, kind: conflicting.kind } : null;
}

type RollbackReleaseResolution =
  | { error: RolloutBodyError }
  | {
      ok: {
        gateway: DurableGatewayRoot;
        target: ReleaseDoc;
        artifact: GatewayArtifact;
        release: number;
        note: string;
      };
    };

async function resolveRollbackRelease(args: {
  store: PlatformStateStore;
  gatewayId: string;
  requestedRelease: string | string[] | undefined;
  body: Record<string, unknown>;
}): Promise<RollbackReleaseResolution> {
  const release = Number(args.requestedRelease);
  if (
    typeof args.requestedRelease !== "string" ||
    !Number.isInteger(release) ||
    release < 1
  ) {
    return {
      error: {
        status: 400,
        body: { error: "release must be a positive integer", got: args.requestedRelease },
      },
    };
  }
  const gateway = await readGatewayDoc(args.store, args.gatewayId);
  if (!gateway) {
    return {
      error: {
        status: 404,
        body: { error: ERR_GATEWAY_NOT_FOUND, gatewayId: args.gatewayId },
      },
    };
  }
  if (gateway.desiredStatus === "retired") {
    return {
      error: {
        status: 409,
        body: {
          error: "cannot cut a release for a retired gateway",
          gatewayId: args.gatewayId,
        },
      },
    };
  }
  if (gateway.gatewayClass === "shared") {
    return {
      error: {
        status: 409,
        body: { error: ERR_SHARED_GATEWAY_NOT_ROLLED_IN_PLACE, gatewayId: args.gatewayId },
      },
    };
  }
  const target = await args.store.gateways.releases.get(args.gatewayId, release);
  if (!target) {
    return {
      error: {
        status: 404,
        body: { error: "release not found", gatewayId: args.gatewayId, release },
      },
    };
  }
  const previous = await args.store.gateways.releases.get(args.gatewayId, gateway.latestRelease);
  if (!previous) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway has no current release artifact",
          gatewayId: args.gatewayId,
          latestRelease: gateway.latestRelease,
        },
      },
    };
  }
  const artifact = artifactFromRelease(target);
  const previousArtifact = artifactFromRelease(previous);
  if (!artifact || !previousArtifact) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway release artifact is malformed",
          gatewayId: args.gatewayId,
        },
      },
    };
  }
  if (sameArtifact(artifact, previousArtifact)) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway is already on release artifact — no-op rollback",
          gatewayId: args.gatewayId,
          release: gateway.latestRelease,
        },
      },
    };
  }
  const conflicting = await findConflictingGatewayOp(args.store, args.gatewayId);
  if (conflicting) {
    return {
      error: {
        status: 409,
        body: {
          error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
          gatewayId: args.gatewayId,
          operationId: conflicting.id,
          kind: conflicting.kind,
        },
      },
    };
  }
  return {
    ok: {
      gateway,
      target,
      artifact,
      release,
      note:
        typeof args.body.note === "string"
          ? args.body.note
          : `rollback to release ${release}`,
    },
  };
}

async function ensureGatewayCreateIsUnique(
  store: PlatformStateStore,
  body: Pick<AddGatewayCreate, "gatewayId">,
): Promise<{ error: RolloutBodyError } | { ok: true }> {
  const [runtime, durable] = await Promise.all([
    store.fleetRegistry.get(body.gatewayId),
    store.gateways.roots.get(body.gatewayId),
  ]);
  if (runtime !== null || durable !== null) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway already exists",
          gatewayId: body.gatewayId,
        },
      },
    };
  }

  return { ok: true };
}

async function accelerateScheduledUserErasure(opts: {
  store: PlatformStateStore;
  uid: string;
}): Promise<
  | { status: 202; body: Record<string, unknown> }
  | { status: 409; body: Record<string, unknown> }
> {
  return opts.store.transaction({ label: "admin.fleet.accelerateCustomerErasure" }, async (transaction) => {
    const lifecycle = (await transaction.users.records.get(opts.uid))?.accountLifecycle ?? null;
    const deletionId = asStringOrNull(lifecycle?.deletionId);
    if (!lifecycle || !deletionId) {
      return {
        status: 409 as const,
        body: { error: "Scheduled deletion is missing its deletion id" },
      };
    }
    const deletion = await transaction.jobs.deletions.get(deletionId);
    const erasureOperationId = asStringOrNull(deletion?.erasureOperationId);
    if (!erasureOperationId) {
      return {
        status: 409 as const,
        body: {
          error: "Scheduled deletion is missing its durable erasure operation",
          deletionId,
        },
      };
    }
    const erasure = await transaction.journal.operations.get(erasureOperationId);
    const runnable = erasure?.kind === "erase-user" &&
      (erasure.status === "pending" || erasure.status === "running");
    if (!runnable) {
      return {
        status: 409 as const,
        body: {
          error: "Scheduled erasure operation is not runnable",
          deletionId,
          erasureOperationId,
        },
      };
    }
    const now = Date.now();
    await transaction.users.records.patch(opts.uid, { accountLifecycle: { ...lifecycle, eraseAfter: now } });
    await transaction.jobs.deletions.patch(deletionId, { eraseAfter: now, updatedAt: now });
    await transaction.journal.operations.patch(erasureOperationId, { nextAttemptAt: now });
    return {
      status: 202 as const,
      body: {
        status: "erasure_requested",
        deletionId,
        erasureOperationId,
        eraseAfter: now,
      },
    };
  });
}

type UserDeletionAdmission =
  | { kind: "not-found" }
  | { kind: "conflict"; runtimeFenced: boolean; deletionId: string | null; operationId: string | null }
  | {
      kind: "created";
      deletionId: string;
      suspensionOperationId: string;
      erasureOperationId: string;
      eraseAfter: number;
      slug: string | null;
    };

type UserDeletionActionOutcome =
  | UserDeletionAdmission
  | {
      kind: "partial";
      failedStep: "suspend-auth" | "revoke-connector-grants";
      claimed: Extract<UserDeletionAdmission, { kind: "created" }>;
      error: Error;
    };

function isUserDeletionConflict(operation: OperationRecord): boolean {
  return (operation.kind === "suspend-user" || operation.kind === "erase-user") &&
    (operation.status === "pending" || operation.status === "running");
}

async function userDeletionConflict(
  transaction: PlatformStateTransaction,
  userRecord: Stored<PlatformUserRecord>,
): Promise<UserDeletionAdmission | null> {
  if (isolatedRuntimeMutationFenced(userRecord)) {
    return { kind: "conflict", runtimeFenced: true, deletionId: null, operationId: null };
  }
  const lifecycle = userRecord.accountLifecycle;
  if (lifecycle?.status === "deletion_scheduled" || lifecycle?.status === "erasing") {
    return {
      kind: "conflict",
      runtimeFenced: false,
      deletionId: asStringOrNull(lifecycle.deletionId),
      operationId: null,
    };
  }
  const inFlight = await inFlightOperationsForUid(transaction, userRecord.uid);
  const forwardMigration = inFlight.find((operation) =>
    operation.kind === OP_KIND_MIGRATE_USER && migrationCancellationDeferred({ ...operation }, operation.id));
  if (forwardMigration) {
    return { kind: "conflict", runtimeFenced: true, deletionId: null, operationId: forwardMigration.id };
  }
  const conflict = inFlight.find(isUserDeletionConflict);
  return conflict
    ? { kind: "conflict", runtimeFenced: false, deletionId: null, operationId: conflict.id }
    : null;
}

async function claimUserDeletion(opts: {
  store: PlatformStateStore;
  discoverProductContext: DeletionProductContextDiscovery;
  uid: string;
  requestedBy: string;
  eraseNow: boolean;
}): Promise<UserDeletionAdmission> {
  const productContext = await opts.discoverProductContext(opts.uid);
  const deletionId = randomUUID();
  const suspensionOperationId = randomUUID();
  const erasureOperationId = randomUUID();
  return opts.store.transaction({ label: "admin.fleet.claimCustomerDeletion" }, async (transaction): Promise<UserDeletionAdmission> => {
    const userRecord = await transaction.users.records.get(opts.uid);
    if (!userRecord) return { kind: "not-found" };
    const conflict = await userDeletionConflict(transaction, userRecord);
    if (conflict) return conflict;
    const now = Date.now();
    const schedule = buildUserDeletionSchedule({ now, eraseNow: opts.eraseNow });
    const currentGatewayId = userRecord.gateway?.gatewayId ?? null;
    const plan = buildUserDeletionPlan({
      uid: opts.uid,
      slug: userRecord.slug,
      currentGatewayId,
      requestedBy: opts.requestedBy,
      requestedAt: schedule.requestedAt,
      eraseAfter: schedule.eraseAfter,
      deletionId,
      suspensionOperationId,
      erasureOperationId,
      productContext,
    });
    if (currentGatewayId) {
      await transaction.gateways.assignments.delete(currentGatewayId, opts.uid);
      await transaction.users.records.setGatewayMirror(opts.uid, { clear: true });
    }
    await transaction.users.records.patch(opts.uid, { accountLifecycle: plan.lifecycle });
    await transaction.jobs.deletions.create(plan.job);
    await transaction.journal.operations.create(plan.suspensionOperation);
    await transaction.journal.operations.create(plan.erasureOperation);
    return {
      kind: "created",
      deletionId,
      suspensionOperationId,
      erasureOperationId,
      eraseAfter: schedule.eraseAfter,
      slug: userRecord.slug,
    };
  });
}

function classifyErasureAcceleration(
  result: Awaited<ReturnType<typeof accelerateScheduledUserErasure>>,
): NormalFleetMutationResult {
  if (result.status < 400) return { outcome: "completed" };
  return {
    outcome: "failed",
    error: typeof result.body.error === "string"
      ? result.body.error
      : `user erasure acceleration returned ${result.status}`,
  };
}

function eraseNowValueIsInvalid(value: unknown): boolean {
  return value !== undefined && typeof value !== "boolean";
}

function userDeletionIsActive(
  lifecycle: AccountLifecycle | undefined,
): lifecycle is AccountLifecycle {
  return lifecycle?.status === "deletion_scheduled" ||
    lifecycle?.status === "erasing";
}

function userDeletionCanAccelerate(
  lifecycleStatus: unknown,
  eraseNow: unknown,
): boolean {
  return lifecycleStatus === "deletion_scheduled" && eraseNow === true;
}

function classifyUserDeletion(
  result: UserDeletionActionOutcome,
  uid: string,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: "User not found" };
  }
  if (result.kind === "conflict") {
    return { outcome: "failed", error: "Cleanup already in progress" };
  }
  if (result.kind !== "partial") return { outcome: "completed" };
  const summary = result.failedStep === "suspend-auth"
    ? "user deletion was scheduled but identity suspension failed"
    : "user deletion was scheduled but connector grant revocation failed";
  return {
    outcome: "partial",
    partialOutcome: {
      summary,
      details: {
        uid,
        failedStep: result.failedStep,
        deletionId: result.claimed.deletionId,
        suspensionOperationId: result.claimed.suspensionOperationId,
        erasureOperationId: result.claimed.erasureOperationId,
      },
    },
  };
}

function respondToUserDeletionAdmission(
  admission: UserDeletionActionOutcome,
  res: Response,
  logger: FleetLogger,
  uid: string,
): void {
  if (admission.kind === "partial") throw admission.error;
  if (admission.kind === "not-found") {
    res.status(404).json({ error: "User not found", uid });
    return;
  }
  if (admission.kind === "conflict") {
    res.status(409).json({
      error: "Cleanup already in progress",
      ...(admission.deletionId ? { deletionId: admission.deletionId } : {}),
      ...(admission.operationId ? { operationId: admission.operationId } : {}),
    });
    return;
  }
  logger.info(
    `[admin-delete] scheduled deletion=${admission.deletionId} uid=${uid} eraseAfter=${admission.eraseAfter}`,
  );
  res.status(202).json({
    status: "deletion_scheduled",
    deletionId: admission.deletionId,
    suspensionOperationId: admission.suspensionOperationId,
    erasureOperationId: admission.erasureOperationId,
    eraseAfter: admission.eraseAfter,
    slug: admission.slug,
  });
}

async function claimAndCleanupUserDeletion(opts: {
  store: PlatformStateStore;
  discoverProductContext: DeletionProductContextDiscovery;
  deps: Pick<FleetRouterDeps, "suspendAuthUser" | "revokeConnectorGrantsForUser">;
  uid: string;
  requestedBy: string;
  eraseNow: boolean;
}): Promise<UserDeletionActionOutcome> {
  const claimed = await claimUserDeletion({
    store: opts.store,
    discoverProductContext: opts.discoverProductContext,
    uid: opts.uid,
    requestedBy: opts.requestedBy,
    eraseNow: opts.eraseNow,
  });
  if (claimed.kind !== "created") return claimed;
  try {
    await opts.deps.suspendAuthUser(opts.uid);
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "suspend-auth",
      claimed,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  try {
    await opts.deps.revokeConnectorGrantsForUser(opts.uid);
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "revoke-connector-grants",
      claimed,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return claimed;
}

const USER_SELF_DELETION_REASON = "User account deletion request";

export type UserSelfDeletionOutcome =
  | { kind: "not-found" }
  | { kind: "conflict" }
  | { kind: "workspace-busy" }
  | {
      kind: "scheduled";
      deletionId: string;
      eraseAfter: number;
      incompleteStep: { name: "suspend-auth" | "revoke-connector-grants"; error: Error } | null;
    };

export async function scheduleUserSelfDeletion(opts: {
  store: PlatformStateStore;
  discoverProductContext: DeletionProductContextDiscovery;
  deps: Pick<FleetRouterDeps, "suspendAuthUser" | "revokeConnectorGrantsForUser">;
  uid: string;
}): Promise<UserSelfDeletionOutcome> {
  const userRecord = await opts.store.users.records.get(opts.uid);
  if (!userRecord) return { kind: "not-found" };
  const lifecycle = userRecord.accountLifecycle ?? undefined;
  const lifecycleStatus = lifecycle?.status ?? null;
  if (userDeletionIsActive(lifecycle)) return { kind: "conflict" };
  const outcome = await runNormalFleetMutation(opts.store, {
    actor: opts.uid,
    forced: false,
    what: "schedule user deletion",
    why: USER_SELF_DELETION_REASON,
    target: { uid: opts.uid },
    preActionStatus: { lifecycleStatus },
    mutation: { kind: "schedule-user-deletion", uid: opts.uid, eraseNow: false },
    classifyResult: (result) => classifyUserDeletion(result, opts.uid),
    action: async () => claimAndCleanupUserDeletion({
      store: opts.store,
      discoverProductContext: opts.discoverProductContext,
      deps: opts.deps,
      uid: opts.uid,
      requestedBy: opts.uid,
      eraseNow: false,
    }),
  });
  if (outcome.kind === "not-found") return { kind: "not-found" };
  if (outcome.kind === "conflict") {
    return outcome.runtimeFenced ? { kind: "workspace-busy" } : { kind: "conflict" };
  }
  const claimed = outcome.kind === "partial" ? outcome.claimed : outcome;
  return {
    kind: "scheduled",
    deletionId: claimed.deletionId,
    eraseAfter: claimed.eraseAfter,
    incompleteStep: outcome.kind === "partial"
      ? { name: outcome.failedStep, error: outcome.error }
      : null,
  };
}

type ActivationLeaseTerminationOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; reason: string }
  | { kind: "adopted" }
  | { kind: "requested" };

type ActivationLeaseReturnOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; status: string | null }
  | { kind: "adopted" }
  | { kind: "requested" };

type ReasonedActivationLeaseMutationOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; reason: string }
  | { kind: "retried" | "cancelled" };

export function classifyActivationLeaseTermination(
  result: ActivationLeaseTerminationOutcome,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: ERR_USER_NOT_FOUND };
  }
  if (result.kind === "conflict") {
    return { outcome: "failed", error: result.reason };
  }
  if (result.kind === "adopted") {
    return {
      outcome: "failed",
      error: "activation lease termination was already requested",
    };
  }
  return { outcome: "completed" };
}

export function classifyActivationLeaseReturn(
  result: ActivationLeaseReturnOutcome,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: ERR_USER_NOT_FOUND };
  }
  if (result.kind === "conflict") {
    return {
      outcome: "failed",
      error: "activation lease is not the requested active generation",
    };
  }
  if (result.kind === "adopted") {
    return {
      outcome: "failed",
      error: "activation lease return was already requested",
    };
  }
  return { outcome: "completed" };
}

export function classifyReasonedActivationLeaseMutation(
  result: ReasonedActivationLeaseMutationOutcome,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: ERR_USER_NOT_FOUND };
  }
  if (result.kind === "conflict") {
    return { outcome: "failed", error: result.reason };
  }
  return { outcome: "completed" };
}

function migrationLockRef(operation: OperationRecord): {
  id: string;
  kind: string;
  status: string;
  input: unknown;
  customerMigrationV2: unknown;
} {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    input: operation.input,
    customerMigrationV2: operation.customerMigrationV2,
  };
}

type GatewayPatchRefusal = { ok: false; error: string };

async function gatewayPatchRefusal(
  transaction: PlatformStateTransaction,
  gatewayId: string,
): Promise<GatewayPatchRefusal | null> {
  const [stored, activeOperations] = await Promise.all([
    transaction.gateways.roots.get(gatewayId),
    transaction.journal.operations.listByStatus(["pending", "running"]),
  ]);
  const current = durableRootOf(stored, gatewayId);
  if (!current) return { ok: false, error: ERR_GATEWAY_NOT_FOUND };
  if (current.desiredStatus === "retired" || current.retirementClaim != null) {
    return { ok: false, error: "gateway has a current retirement claim" };
  }
  if (findActiveGatewayMigration(gatewayId, activeOperations.map(migrationLockRef))) {
    return { ok: false, error: `user migration is in flight for gateway ${gatewayId}` };
  }
  try {
    await assertGatewayRuntimeMutationUnfencedInStore(transaction, gatewayId);
  } catch (error) {
    if (!(error instanceof GatewayRetirementConflictError)) throw error;
    return { ok: false, error: error.message };
  }
  return null;
}

const IN_FLIGHT_OPERATION_STATUSES = ["pending", "running"] as const;

export function inFlightOperationsForUid(
  transaction: Pick<PlatformStateTransaction, "journal">,
  uid: string,
): Promise<readonly Stored<OperationRecord>[]> {
  return transaction.journal.operations.listForUid(uid, { statuses: [...IN_FLIGHT_OPERATION_STATUSES] });
}

export function isInFlightUserMigration(operation: OperationRecord): boolean {
  return operation.kind === OP_KIND_MIGRATE_USER &&
    (operation.status === "pending" || operation.status === "running");
}

type AddGatewayMutationOutcome =
  | { kind: "completed"; operationId: string }
  | {
      kind: "partial";
      failedStep: "initial-release" | "rollout-operation";
      error: Error;
    };

function gatewayCreationBodyError(
  body: Record<string, unknown>,
): RolloutBodyError | null {
  const persistenceError = rejectPersistenceInBody(body);
  if (persistenceError) return persistenceError;
  if (!Object.prototype.hasOwnProperty.call(body, "byosub")) return null;
  return {
    status: 400,
    body: {
      error: "gateway credential references are user-scoped and cannot be created here",
    },
  };
}

function respondToAddGatewayMutationError(
  error: unknown,
  res: Response,
  gatewayId: string,
): boolean {
  if (error instanceof GatewayAuthSecretProvisionError) {
    res.status(502).json({
      error: "failed to provision gateway auth-token secret",
      gatewayId,
      detail: error.message,
    });
    return true;
  }
  if (error instanceof InitialGatewayReleaseConflictError) {
    res.status(409).json({
      error: "gateway already exists",
      gatewayId: error.gatewayId,
    });
    return true;
  }
  return false;
}

function classifyAddGatewayMutation(
  outcome: AddGatewayMutationOutcome,
  gatewayId: string,
  artifact: GatewayArtifact,
): NormalFleetMutationResult {
  if (outcome.kind === "completed") {
    return {
      outcome: "completed",
      releaseRollout: {
        releaseId: `${gatewayId}/1`,
        releaseTag: artifact.imageTag,
        rolloutOperationId: outcome.operationId,
      },
    };
  }
  if (outcome.failedStep === "initial-release") {
    return {
      outcome: "partial",
      partialOutcome: {
        summary: "gateway auth secret was provisioned but its initial release was not created",
        details: { gatewayId, failedStep: outcome.failedStep },
      },
    };
  }
  return {
    outcome: "partial",
    partialOutcome: {
      summary: "gateway release was created but its rollout operation could not be enqueued",
      details: { gatewayId, release: 1, failedStep: outcome.failedStep },
    },
    releaseRollout: {
      releaseId: `${gatewayId}/1`,
      releaseTag: artifact.imageTag,
    },
  };
}

async function performAddGatewayMutation(opts: {
  store: PlatformStateStore;
  provisionGatewayAuthSecret: FleetRouterDeps["provisionGatewayAuthSecret"];
  gatewayServiceAccount: string;
  body: AddGatewayCreate;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  config: GatewayMutableConfig;
  artifact: GatewayArtifact;
  createdBy: string;
  now: number;
}): Promise<AddGatewayMutationOutcome> {
  let authSecretProvisioned = false;
  try {
    await writeInitialGatewayReleaseInStore(opts.store, {
      gatewayId: opts.body.gatewayId,
      createdBy: opts.createdBy,
      now: opts.now,
      desiredStatus: "running",
      config: opts.config,
      artifact: opts.artifact,
    }, async () => {
      try {
        await opts.provisionGatewayAuthSecret({
          gatewayId: opts.body.gatewayId,
          gatewayServiceAccount: opts.gatewayServiceAccount,
        });
      } catch (error) {
        throw new GatewayAuthSecretProvisionError(
          error instanceof Error ? error.message : String(error),
        );
      }
      authSecretProvisioned = true;
    });
  } catch (error) {
    if (!authSecretProvisioned || error instanceof GatewayAuthSecretProvisionError) throw error;
    return {
      kind: "partial",
      failedStep: "initial-release",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  try {
    const operationId = await createOperation(opts.store, {
      kind: "add-gateway",
      createdBy: opts.createdBy,
      input: {
        gatewayId: opts.body.gatewayId,
        imageTag: opts.artifact.imageTag,
        ...(opts.body.sourceSha ? { sourceSha: opts.body.sourceSha } : {}),
        ...(opts.body.profile ? { profile: opts.body.profile } : {}),
        gatewayClass: opts.gatewayClass,
        ...(opts.imageProfile !== "standard" ? { imageProfile: opts.imageProfile } : {}),
        ...(opts.body.sizingTier ? { sizingTier: opts.body.sizingTier } : {}),
      },
    });
    return { kind: "completed", operationId };
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "rollout-operation",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function activationLeaseForTermination(
  data: GlmDoc,
  leaseId: string,
  generation: number,
): NonNullable<ReturnType<typeof activationLeaseFromUser>> | null {
  const resolved = activationLeaseFromUser(data);
  if (
    !resolved ||
    resolved.lease.leaseId !== leaseId ||
    resolved.lease.generation !== generation
  ) {
    return null;
  }
  return resolved;
}

function sharedAssignmentServesUser(input: {
  assignment: GatewayAssignment | null;
  uid: string;
  gatewayId: string;
}): boolean {
  return input.assignment?.uid === input.uid &&
    input.assignment.gatewayId === input.gatewayId &&
    input.assignment.state === "serving" &&
    Number.isSafeInteger(input.assignment.epoch);
}

function disposableRuntimeMatchesTermination(input: {
  target: GatewayRoot | null;
  uid: string;
  leaseId: string;
  generation: number;
}): boolean {
  const allocation = isPlainRecord(input.target?.allocation)
    ? input.target.allocation
    : null;
  return input.target?.ownerUid === input.uid &&
    allocation?.kind === "disposable-builder" &&
    allocation.claimedByUid === input.uid &&
    allocation.leaseId === input.leaseId &&
    allocation.generation === input.generation;
}

function terminationStatusAt(lease: GlmDoc): number | null {
  if (lease.status === "activating") return toMillis(lease.activatingAt);
  return toMillis(lease.provisionedAt ?? lease.requestedAt);
}

function runtimeTerminationCanStart(lease: GlmDoc, now: number): boolean {
  const statusAt = terminationStatusAt(lease);
  const stale = statusAt !== null &&
    now - statusAt > ISOLATED_RUNTIME_STALE_AFTER_MS;
  return lease.status === "failed" || stale;
}

export async function requestActivationLeaseTermination(
  transaction: PlatformStateTransaction,
  input: {
    uid: string;
    leaseId: string;
    generation: number;
    sharedGatewayIds: readonly string[];
    requestedAt: number;
    requestedBy: string;
  },
): Promise<ActivationLeaseTerminationOutcome> {
  const userRecord = await transaction.users.records.get(input.uid);
  if (!userRecord) return { kind: "not-found" };
  const resolved = activationLeaseForTermination(
    userDocData(userRecord, null),
    input.leaseId,
    input.generation,
  );
  if (!resolved) {
    return { kind: "conflict", reason: "lease generation changed" };
  }
  const { lease, openclaw } = resolved;
  const targetGatewayId = asStringOrNull(lease.targetGatewayId);
  const sharedGatewayId = asStringOrNull(openclaw.gatewayId);
  if (
    !targetGatewayId ||
    !sharedGatewayId ||
    !input.sharedGatewayIds.includes(sharedGatewayId)
  ) {
    return {
      kind: "conflict",
      reason: "User is not authoritative on the shared gateway",
    };
  }
  const assignment = await transaction.gateways.assignments.get(sharedGatewayId, input.uid);
  if (!sharedAssignmentServesUser({
    assignment,
    uid: input.uid,
    gatewayId: sharedGatewayId,
  })) {
    return {
      kind: "conflict",
      reason: "canonical shared assignment is not serving",
    };
  }
  if (
    lease.status === "returning" &&
    toMillis(lease.operatorTerminateRequestedAt) !== null
  ) {
    return { kind: "adopted" };
  }
  const target = await transaction.gateways.roots.get(targetGatewayId);
  if (!disposableRuntimeMatchesTermination({
    target,
    uid: input.uid,
    leaseId: input.leaseId,
    generation: input.generation,
  })) {
    return {
      kind: "conflict",
      reason: "disposable runtime ownership changed",
    };
  }
  if (!runtimeTerminationCanStart(lease, input.requestedAt)) {
    return {
      kind: "conflict",
      reason: "runtime is neither failed nor stale",
    };
  }
  await transaction.users.records.patchActivationLease(input.uid, {
    status: "returning",
    returnRequestedAt: input.requestedAt,
    returnRequestedBy: input.requestedBy,
    operatorTerminateRequestedAt: input.requestedAt,
    operatorTerminateRequestedBy: input.requestedBy,
  }, { leaseId: input.leaseId, generation: input.generation });
  return { kind: "requested" };
}

const WORKSPACE_IDENTITIES_NOT_INITIALIZED =
  "OpenClaw workspace identities are not initialized for this boot";

function isEndpointPreflightError(error: string, operationInput: GlmDoc): boolean {
  const { fromGatewayId, toGatewayId } = operationInput;
  const preflightPrefix = [
    `source gateway ${fromGatewayId} is not migration-ready (`,
    `source gateway ${fromGatewayId} has no durable placement`,
    `target gateway ${toGatewayId} is not migration-ready (`,
    `target gateway ${toGatewayId} has no durable placement`,
    `placement rejected for ${toGatewayId}: `,
  ].some((prefix) => error.startsWith(prefix));
  const schedulerIdentityNotReady = [fromGatewayId, toGatewayId].some(
    (gatewayId) => error.startsWith(`/scheduler/${gatewayId}: 500 `),
  ) && error.includes(WORKSPACE_IDENTITIES_NOT_INITIALIZED);
  const postgresRuntimeMismatch = error ===
    "PostgreSQL agent handoff requires the same fully identified OpenClaw build on both Gateways; align their runtime pins before moving state";
  return preflightPrefix || schedulerIdentityNotReady || postgresRuntimeMismatch;
}

function rearmableUserReturnOperation(input: {
  operation: GlmDoc | undefined;
  uid: string;
  targetGatewayId: string;
}): boolean {
  const operation = input.operation;
  if (!operation || !isPlainRecord(operation.input)) return false;
  const operationInput = operation.input;
  const terminalStatus = operation.status === "failed" || operation.status === "rolled-back";
  const steps = operation.steps;
  const error = operation.error;
  const endpointPreflightFailure = Array.isArray(steps) && steps.length === 0 &&
    typeof error === "string" && isEndpointPreflightError(error, operationInput);
  const failedBeforeSourceQuiesce = operation.rolledBack === false &&
    (endpointPreflightFailure || (Array.isArray(steps) && steps.length === 1 &&
      isPlainRecord(steps[0]) && steps[0].name === "keys-sync-state" &&
      steps[0].status === "failed"));
  return [
    operation.kind === OP_KIND_MIGRATE_USER,
    terminalStatus,
    operation.rolledBack === true || failedBeforeSourceQuiesce,
    operation.origin === "automatic",
    operation.createdBy === "glm-controller-placement-policy",
    operation.inputUid === input.uid,
    operation.gatewayId === operationInput.toGatewayId,
    operationInput.uid === input.uid,
    operationInput.fromGatewayId === input.targetGatewayId,
    operationInput.source === "builder-activation-lease",
    typeof operationInput.toGatewayId === "string" && operationInput.toGatewayId.length > 0,
    operation.customerMigrationV2 === undefined,
  ].every(Boolean);
}

type UserReturnRetryLease = {
  lease: GlmDoc;
  targetGatewayId: string;
  returnOperationId: string;
};

function retryableUserReturnLease(
  data: GlmDoc,
  operationId: string,
): UserReturnRetryLease | null {
  const resolved = activationLeaseFromUser(data);
  const lease = resolved?.lease;
  const targetGatewayId = asStringOrNull(lease?.targetGatewayId);
  const returnOperationId = asStringOrNull(lease?.returnOperationId);
  if (
    !lease ||
    lease.status !== "returning" ||
    !targetGatewayId ||
    asStringOrNull(resolved?.openclaw.gatewayId) !== targetGatewayId ||
    !Number.isSafeInteger(lease.generation) ||
    (lease.generation as number) < 1 ||
    returnOperationId !== builderReturnOperationId(targetGatewayId, lease.generation as number) ||
    operationId !== returnOperationId
  ) {
    return null;
  }
  return { lease, targetGatewayId, returnOperationId };
}

type UserReturnRetryState = {
  assignment: GatewayAssignment | null;
  target: GatewayRoot | null;
  operation: GlmDoc | undefined;
};

async function readUserReturnRetryState(
  transaction: PlatformStateTransaction,
  input: { uid: string; targetGatewayId: string; returnOperationId: string },
): Promise<UserReturnRetryState> {
  const [assignment, target, operation] = await Promise.all([
    transaction.gateways.assignments.get(input.targetGatewayId, input.uid),
    transaction.gateways.roots.get(input.targetGatewayId),
    transaction.journal.operations.get(input.returnOperationId),
  ]);
  return {
    assignment,
    target,
    operation: operation === null ? undefined : recordDoc(operation.id, operation).data(),
  };
}

function matchesUserReturnRetryState(input: {
  state: UserReturnRetryState;
  uid: string;
  targetGatewayId: string;
  lease: GlmDoc;
}): boolean {
  return [
    sharedAssignmentServesUser({
      assignment: input.state.assignment,
      uid: input.uid,
      gatewayId: input.targetGatewayId,
    }),
    input.state.target?.gatewayClass === "builder",
    disposableRuntimeMatchesTermination({
      target: input.state.target,
      uid: input.uid,
      leaseId: asStringOrNull(input.lease.leaseId) ?? "",
      generation: typeof input.lease.generation === "number" ? input.lease.generation : 0,
    }),
    rearmableUserReturnOperation({
      operation: input.state.operation,
      uid: input.uid,
      targetGatewayId: input.targetGatewayId,
    }),
  ].every(Boolean);
}

export async function retryActivationLeaseReturn(
  transaction: PlatformStateTransaction,
  input: {
    uid: string;
    operationId: string;
    requestedAt: number;
    requestedBy: string;
  },
): Promise<ReasonedActivationLeaseMutationOutcome> {
  const userRecord = await transaction.users.records.get(input.uid);
  if (!userRecord) return { kind: "not-found" };
  const retryLease = retryableUserReturnLease(userDocData(userRecord, null), input.operationId);
  if (!retryLease) {
    return { kind: "conflict", reason: "User return is no longer retryable" };
  }
  const state = await readUserReturnRetryState(transaction, {
    uid: input.uid,
    targetGatewayId: retryLease.targetGatewayId,
    returnOperationId: retryLease.returnOperationId,
  });
  if (!matchesUserReturnRetryState({
    state,
    uid: input.uid,
    targetGatewayId: retryLease.targetGatewayId,
    lease: retryLease.lease,
  })) {
    return { kind: "conflict", reason: "User return no longer matches its original lease" };
  }
  await transaction.journal.operations.patch(retryLease.returnOperationId, {
    retryRequestedAt: input.requestedAt,
    retryRequestedBy: input.requestedBy,
  });
  return { kind: "retried" };
}

function sendOperatorPlacementRefusal(res: Response, refusal: OperatorPlacementRefusal, uid: string, gatewayId: string): void {
  if (refusal.reason === "user-not-found") {
    res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
    return;
  }
  if (refusal.reason === "gateway-not-found") {
    res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId });
    return;
  }
  res.status(refusal.reason === "gateway-not-shared" ? 400 : 409).json({ error: refusal.message, reason: refusal.reason, uid, gatewayId });
}

function userMountOf(userRecord: PlatformUserRecord | null): { currentGatewayId: string | null; builderSlug: string | null } {
  return { currentGatewayId: userRecord?.gateway?.gatewayId ?? null, builderSlug: userRecord?.slug ?? null };
}

export async function readPlatformRuntimeConfig(store: PlatformStateStore): Promise<PlatformRuntimeConfig> {
  const config = await store.config.orchestrator.get();
  return { disposableGatewayIdleMs: config?.disposableGatewayIdleMs ?? DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS };
}

async function setOperatorParkedIsolatedGatewayStatus(transaction: PlatformStateTransaction, gatewayId: string, input: { actor: string | undefined; uid: string; desiredStatus: "paused" | "running" }): Promise<{ dedicated: boolean; error?: string }> {
  const gateway = await transaction.gateways.roots.get(gatewayId);
  if (gateway?.gatewayClass !== "builder") return { dedicated: false };
  if (gateway.ownerUid !== input.uid || gateway.desiredStatus === "retired" || gateway.runtimeRestartFence !== undefined || gateway.retirementClaim != null) {
    return { dedicated: true, error: "dedicated gateway ownership or runtime outcome must settle before changing parking" };
  }
  await transaction.gateways.roots.patch(gatewayId, { desiredStatus: input.desiredStatus, updatedAt: Date.now(), updatedBy: input.actor ?? "unknown" });
  return { dedicated: true };
}

async function updateOperatorParkingGateway(transaction: PlatformStateTransaction, input: { gatewayId: string | null; uid: string; actor: string | undefined; park: boolean }): Promise<{ dedicated: boolean; error?: string }> {
  if (!input.gatewayId) return { dedicated: false };
  const assignment = await transaction.gateways.assignments.get(input.gatewayId, input.uid);
  if (assignment && assignment.state !== "serving") return { dedicated: false, error: `user roster state ${assignment.state} must settle before changing parking` };
  const gateway = await setOperatorParkedIsolatedGatewayStatus(transaction, input.gatewayId, { ...input, desiredStatus: input.park ? "paused" : "running" });
  if (gateway.error) return gateway;
  if (input.park && !gateway.dedicated) await transaction.gateways.assignments.delete(input.gatewayId, input.uid);
  return gateway;
}

export function createAdminFleetMutationRunner(store: PlatformStateStore) {
  return async function runAdminFleetMutation<T>(input: {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    forced?: boolean;
    action: (claim: OperationAuditActionClaim) => Promise<T>;
    classifyResult?: (result: T) => NormalFleetMutationResult;
    dryRunRefusal?: () => Promise<T | null>;
    idempotencyScope?: string;
    aliasPlan?: OperationAuditAliasPlan[];
  }): Promise<T> {
    if (isAdminDryRun(input.req)) {
      const refusal = await input.dryRunRefusal?.();
      if (refusal) return refusal;
      throw new AdminDryRunPlanned(input);
    }
    const actor = input.req as ActorRequest;
    const headerKey = input.req.get("Idempotency-Key")?.trim();
    return runNormalFleetMutation(store, {
      actor: actor.uid ?? "unknown",
      forced: input.forced === true,
      what: input.what,
      why: input.why,
      target: input.target,
      preActionStatus: input.preActionStatus,
      mutation: input.mutation,
      action: async (claim) => input.action(claim),
      classifyResult: input.classifyResult,
      ...(input.aliasPlan ? { aliasPlan: input.aliasPlan } : {}),
      ...(headerKey
        ? { idempotencyKey: `${headerKey}:${input.idempotencyScope ?? input.what}` }
      : {}),
    });
  };
}

export type AdminFleetMutationRunner = ReturnType<typeof createAdminFleetMutationRunner>;

export function respondToAdminFleetMutationError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (respondToAdminDryRun(error, res)) return;
  if (error instanceof FleetMutationIdempotencyError) {
    res.status(409).json({
      error: error.message,
      auditId: error.auditId,
      status: error.status,
    });
    return;
  }
  if (error instanceof OperationAuditIdempotencyConflictError) {
    res.status(409).json({
      error: error.message,
      auditId: error.auditId,
    });
    return;
  }
  next(error);
}

// eslint-disable-next-line max-lines-per-function -- factory mounts ~15 admin routes; splitting it would scatter the contract across files for no readability gain
export function addAdminFleetRoutes(
  router: Router,
  deps: FleetRouterDeps,
): Router {
  const { accounts, logger, store } = deps;

  const runAdminFleetMutation = createAdminFleetMutationRunner(store);

  router.use(admitAdminDryRunMarker);

  addAdminComputerRoutes(router, { store, replacementEnabled: deps.computerReplacementEnabled, journal: runAdminFleetMutation });
  addAdminUserRoutes(router, { store, accounts: deps.userAccounts, signIn: deps.userSignIn, journal: runAdminFleetMutation });

  async function handleActiveUserDeletion(input: {
    req: Request;
    res: Response;
    uid: string;
    lifecycle: AccountLifecycle | undefined;
    eraseNow: unknown;
  }): Promise<boolean> {
    const lifecycle = input.lifecycle;
    if (!userDeletionIsActive(lifecycle)) return false;
    const lifecycleStatus = lifecycle.status;
    if (!userDeletionCanAccelerate(lifecycleStatus, input.eraseNow)) {
      input.res.status(409).json({
        error: "Cleanup already in progress",
        deletionId: lifecycle.deletionId ?? null,
      });
      return true;
    }
    const acceleration = await runAdminFleetMutation({
      req: input.req,
      what: "accelerate scheduled user erasure",
      why: ADMIN_FLEET_REQUEST_REASON,
      target: { uid: input.uid, deletionId: lifecycle.deletionId ?? null },
      preActionStatus: { lifecycleStatus },
      mutation: { kind: "accelerate-user-erasure", uid: input.uid },
      classifyResult: classifyErasureAcceleration,
      action: async () => accelerateScheduledUserErasure({ store, uid: input.uid }),
    });
    input.res.status(acceleration.status).json(acceleration.body);
    return true;
  }

router.post(
    "/users/:uid/delete",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = (req.body ?? {}) as { eraseNow?: unknown };
        if (eraseNowValueIsInvalid(body.eraseNow)) {
          res.status(400).json({ error: "eraseNow must be a boolean" });
          return;
        }
        const userRecord = await store.users.records.get(uid);
        if (!userRecord) {
          res.status(404).json({ error: "User not found", uid });
          return;
        }
        const existingLifecycle = userRecord.accountLifecycle ?? undefined;
        const existingStatus = existingLifecycle?.status;
        const activeDeletionHandled = await handleActiveUserDeletion({
          req,
          res,
          uid,
          lifecycle: existingLifecycle,
          eraseNow: body.eraseNow,
        });
        if (activeDeletionHandled) return;
        const actor = req as ActorRequest;
        const admission = await runAdminFleetMutation({
          req,
          what: "schedule user deletion",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid },
          preActionStatus: { lifecycleStatus: existingStatus ?? null },
          mutation: { kind: "schedule-user-deletion", uid, eraseNow: body.eraseNow === true },
          classifyResult: (result) => classifyUserDeletion(result, uid),
          action: async () => claimAndCleanupUserDeletion({
            store,
            discoverProductContext: deps.discoverDeletionProductContext ?? noDeletionProductContext,
            deps,
            uid,
            requestedBy: actor.uid ?? "unknown",
            eraseNow: body.eraseNow === true,
          }),
        });
        respondToUserDeletionAdmission(admission, res, logger, uid);
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const includeRetired = req.query.all === "true";
        const [snapshot, sharedPoolConfig] = await Promise.all([
          readFleetSnapshot(store),
          store.transaction(
            { label: "admin.fleet.gatewaysSharedPool", readOnly: true },
            readSharedGatewayPoolConfigInStore,
          ),
        ]);
        const userDocs = userDocuments(snapshot.users, new Map());
        const handoffProgressByGateway = projectHandoffProgress(snapshot.assignments);
        const glmByGatewayId = indexAdminGatewayRuntimeDocs(fleetGatewayDocs(snapshot));
        const projectionOperations = await readFleetProjectionOperations(
          store,
          fleetProjectionOperationIds(userDocs, glmByGatewayId),
        );
        const operationsById = indexGlmDocs(projectionOperations);
        const now = Date.now();
        const isolatedRuntimes = userDocs.flatMap((doc) => {
          const runtime = projectIsolatedRuntime(
            doc,
            glmByGatewayId,
            operationsById,
            now,
          );
          return runtime ? [runtime] : [];
        });
        const visibleRetiredGatewayIds = new Set(
          isolatedRuntimes.flatMap((runtime) =>
            runtime.targetGatewayId &&
            (runtime.lifecycle === "failed" ||
              (runtime.cleanupOperationId &&
                runtime.cleanupOperationStatus !== "succeeded"))
              ? [runtime.targetGatewayId]
              : [],
          ),
        );
        for (const [gatewayId, gateway] of glmByGatewayId) {
          const retirementClaim = isPlainRecord(gateway.retirementClaim)
            ? gateway.retirementClaim
            : null;
          const operationId =
            asStringOrNull(retirementClaim?.operationId) ??
            disposableRuntimeRetireOperationId(gateway, gatewayId);
          const cleanupStatus = operationId ? operationsById.get(operationId)?.status : undefined;
          if (
            projectDesiredStatus(gateway) === "retired" &&
            projectDisposableRuntime(gateway) !== null &&
            cleanupStatus !== "succeeded"
          ) {
            visibleRetiredGatewayIds.add(gatewayId);
          }
        }
        const gatewayIds = new Set(glmByGatewayId.keys());
        const gatewayInputs = [...gatewayIds].flatMap((gatewayId) => {
          const glmDoc = glmByGatewayId.get(gatewayId);
          const retired = projectDesiredStatus(glmDoc) === "retired";
          const retiredButListed =
            retired && (includeRetired || visibleRetiredGatewayIds.has(gatewayId));
          if (retired && !retiredButListed) return [];
          const doc = effectiveHeartbeatDoc(gatewayId, glmDoc);
          if (!doc && !shouldProjectDesiredOnlyGateway(glmDoc) && !retiredButListed) return [];
          return [{ doc: doc ?? syntheticGatewayDoc(gatewayId, glmDoc), glmDoc }];
        });
        const summaries = gatewayInputs.map(({ doc, glmDoc }) =>
          projectGatewaySummary(doc, glmDoc, now),
        );
        const readBatch = deps.readGatewayPodDiagnosticsBatch;
        const gateways = readBatch
          ? await projectGatewaySummariesWithDiagnostics(deps, summaries, readBatch)
          : await Promise.all(
              gatewayInputs.map(({ doc, glmDoc }) =>
                projectGatewaySummaryWithDiagnostics(deps, doc, glmDoc, now),
              ),
            );
        attachHandoffProgress(gateways, handoffProgressByGateway);
        const gatewayById = new Map(
          gateways.map((gateway) => [gateway.gatewayId, gateway]),
        );
        const builderRuntimeViews = isolatedRuntimes.map((runtime) => {
          const target = runtime.targetGatewayId
            ? gatewayById.get(runtime.targetGatewayId)
            : undefined;
          return {
            ...runtime,
            targetPodStatus: target?.podDiagnostics?.status ?? null,
            targetPodCount: target?.podDiagnostics?.totalPods ?? null,
          };
        });
        const sharedGatewayIds = new Set(sharedPoolConfig?.sharedGatewayIds ?? []);
        const parkedUsers = userDocs.filter((doc) => {
          const resolved = activationLeaseFromUser(doc.data());
          return (
            resolved?.lease.status === "parked" &&
            sharedGatewayIds.has(asStringOrNull(resolved.openclaw.gatewayId) ?? "")
          );
        }).length;
        res.json({
          gateways: gateways.map(withAdminGatewayClass),
          isolatedRuntimes: builderRuntimeViews,
          disposableCapacity: {
            ...projectDisposableFleetCapacity(gateways, builderRuntimeViews, parkedUsers),
            operatorParkedUsers: snapshot.users.filter((userRecord) => userRecord.openclaw.managedBy === "operator").length,
          },
          stats: rollupFleetStats(
            gateways.filter((gateway) => gateway.desiredStatus !== "retired"),
          ),
          namespace: resolveFleetNamespace(),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/placement",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await readAdminPlacementResponse(store, accounts));
      } catch (e) {
        next(e);
      }
    },
  );


function activeDistributionGateways(
  glmById: ReadonlyMap<string, GlmDoc>,
  rootsById: ReadonlyMap<string, unknown>,
): Map<string, { status: string; mountedCustomers: Set<string>; mountedCount: number }> {
  const gateways = new Map<
    string,
    { status: string; mountedCustomers: Set<string>; mountedCount: number }
  >();
  for (const gatewayId of new Set([...glmById.keys(), ...rootsById.keys()])) {
    if (projectDesiredStatus(glmById.get(gatewayId)) === "retired") continue;
    const hb = effectiveHeartbeatDoc(gatewayId, glmById.get(gatewayId))?.data();
    const mounted = [...readMountedSlugs(hb)];
    gateways.set(gatewayId, {
      status: typeof hb?.status === "string" ? hb.status : "unknown",
      mountedCustomers: new Set(mounted),
      mountedCount: mounted.length,
    });
  }
  return gateways;
}

router.get(
    "/user-distribution",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [roots, runtimes, userRecords, accountsByUid] = await Promise.all([
          store.gateways.roots.list(),
          store.fleetRegistry.list(),
          store.users.records.listAll(),
          accounts.list(),
        ]);

        const rootsById = new Map(roots.map((root) => [root.gatewayId, root]));
        const glmById = indexAdminGatewayRuntimeDocs(fleetGatewayDocs({ roots, runtimes }));
        const gateways = activeDistributionGateways(glmById, rootsById);

        const assignedByGateway = new Map<string, number>();
        const mountedByGateway = new Map<string, number>();
        const pendingPlacements: PendingPlacement[] = [];
        let totalUsers = 0;
        let assigned = 0;
        let unassigned = 0;
        let mounted = 0;

        for (const doc of userDocuments(userRecords, accountsByUid)) {
          const data = doc.data();
          if (!userSlug(data)) continue;
          totalUsers++;
          const placement = classifyUserPlacement(
            doc.id,
            data,
            gateways,
          );
          if (placement.pending) pendingPlacements.push(placement.pending);
          if (placement.kind === "unassigned") {
            unassigned++;
          } else if (placement.kind !== "orphan" && placement.gid) {
            assigned++;
            assignedByGateway.set(
              placement.gid,
              (assignedByGateway.get(placement.gid) ?? 0) + 1,
            );
            if (placement.kind === "mounted") {
              mounted++;
              mountedByGateway.set(
                placement.gid,
                (mountedByGateway.get(placement.gid) ?? 0) + 1,
              );
            }
          }
        }

        const perGateway = Array.from(gateways.entries()).map(
          ([gatewayId, gw]) => ({
            gatewayId,
            status: gw.status,
            assignedCount: assignedByGateway.get(gatewayId) ?? 0,
            mountedCount: mountedByGateway.get(gatewayId) ?? 0,
          }),
        );

        res.json({
          stats: {
            totalUsers,
            assigned,
            unassigned,
            mounted,
            assignedNotMounted: assigned - mounted,
          },
          perGateway,
          pendingPlacements,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways/:id/details",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const [runtime, userRecords, accountsByUid, gatewayOperations] = await Promise.all([
          readDurableGatewayRuntime(store, id),
          store.users.records.listAll(),
          accounts.list(),
          store.journal.operations.listByGateway(id, 50),
        ]);
        if (!runtime) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const mountedSlugs = readMountedSlugs(runtime.heartbeat ?? {});

        const mountedCustomers: DrawerMountedUser[] = [];
        for (const doc of userDocuments(userRecords, accountsByUid)) {
          const data = doc.data();
          const slug = userSlug(data);
          if (!slug || !mountedSlugs.has(slug)) continue;
          mountedCustomers.push(buildMountedUser(doc.id, data, slug));
        }
        mountedCustomers.sort((a, b) => a.slug.localeCompare(b.slug));

        const recentOperations = operationDocs(gatewayOperations)
          .map((d) => shapeDrawerOperation(d.id, d.data()))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 20);

        res.json({
          mountedUsers: mountedCustomers,
          recentOperations,
          control: withAdminGatewayClass(projectGatewayControl(
            runtime.root,
            runtime.runtime ? { ...runtime.runtime } : undefined,
          )),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/users/:uid/assign",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ gatewayId: string }>;
        if (!body.gatewayId || typeof body.gatewayId !== "string") {
          res.status(400).json({ error: "missing gatewayId in body" });
          return;
        }
        const targetGatewayId = body.gatewayId;
        const plan = await planOperatorPlacement(store, { uid, gatewayId: targetGatewayId });
        if (plan.kind === "refused") {
          sendOperatorPlacementRefusal(res, plan, uid, targetGatewayId);
          return;
        }
        const repair = plan.currentGatewayId === targetGatewayId;
        const { placement, operationId } = await runAdminFleetMutation({
          req,
          what: "assign user to gateway",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, gatewayId: targetGatewayId },
          preActionStatus: { gatewayId: plan.currentGatewayId },
          mutation: {
            kind: "assign-user",
            uid,
            gatewayId: targetGatewayId,
            assignmentWrite: repair ? "create-if-missing" : "upsert",
          },
          classifyResult: (result) => result.placement.kind === "refused"
            ? { outcome: "failed", error: result.placement.message }
            : { outcome: "completed" },
          action: async (claim: OperationAuditActionClaim) => ({
            placement: await commitOperatorPlacement(store, { uid, gatewayId: targetGatewayId, source: "repair", now: Date.now() }),
            operationId: claim.auditId,
          }),
        });
        if (placement.kind === "refused") {
          sendOperatorPlacementRefusal(res, placement, uid, targetGatewayId);
          return;
        }
        res.status(repair ? 200 : 202).json({
          uid,
          gatewayId: targetGatewayId,
          gatewayProfile: SHARED_GATEWAY_MIRROR.gatewayProfile,
          ...(repair ? { repaired: true } : {}),
          operationId,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const request = await readAddGatewayRequest(store, deps, req.body);
        if ("error" in request) {
          res.status(request.error.status).json(request.error.body);
          return;
        }
        const { body, build } = request.ok;

        const gatewayServiceAccount = process.env.GATEWAY_SERVICE_ACCOUNT;
        if (!gatewayServiceAccount) {
          res.status(500).json({
            error:
              "GATEWAY_SERVICE_ACCOUNT not configured — admin cannot provision gateway auth-token secret",
          });
          return;
        }
        const gatewayClass = resolveGatewayClass(body);
        const imageProfile = resolveGatewayImageProfile(body);
        const config = buildCreateGatewayConfig({
          body,
          gatewayClass,
          imageProfile,
        });
        const artifact = build.artifact;
        let operationId: string;
        try {
          const result = await runAdminFleetMutation({
            req,
            what: "add gateway",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: body.gatewayId },
            preActionStatus: { exists: false },
            mutation: {
              kind: "add-gateway",
              gatewayId: body.gatewayId,
              build: build.kind === "named"
                ? { sourceSha: build.sourceSha, manifestDigest: build.manifestDigest }
                : "platform",
              imageTag: artifact.imageTag,
              gatewayEdgeImageTag: artifact.gatewayEdgeImage?.imageTag ?? null,
              gatewayClass,
              imageProfile,
              desiredStatus: "running",
            },
            classifyResult: (outcome) =>
              classifyAddGatewayMutation(outcome, body.gatewayId, artifact),
            action: async () => performAddGatewayMutation({
              store,
              provisionGatewayAuthSecret: deps.provisionGatewayAuthSecret,
              gatewayServiceAccount,
              body,
              gatewayClass,
              imageProfile,
              config,
              artifact,
              createdBy,
              now,
            }),
          });
          if (result.kind === "partial") throw result.error;
          operationId = result.operationId;
        } catch (e) {
          if (respondToAddGatewayMutationError(e, res, body.gatewayId)) return;
          throw e;
        }
        res.status(202).json({
          gatewayId: body.gatewayId,
          sourceSha: body.sourceSha,
          release: 1,
          imageTag: artifact.imageTag,
          gatewayEdgeImageTag: artifact.gatewayEdgeImage?.imageTag ?? null,
          operationId,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.patch(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const stored = await store.gateways.roots.get(id);
        if (!stored) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const root = durableRootOf(stored, id);
        if (!root) {
          res.status(409).json({ error: "gateway durable root is invalid", gatewayId: id });
          return;
        }
        const built = buildDurableGatewayPatch({
          gatewayId: id,
          current: root,
          body,
        });
        if ("error" in built) {
          res.status(built.error.status).json(built.error.body);
          return;
        }
        const updatedBy = (req as ActorRequest).uid ?? "unknown";
        const patchResult = await runAdminFleetMutation({
          req,
          what: "update gateway desired configuration",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { gatewayId: id },
          preActionStatus: {
            desiredStatus: root.desiredStatus,
            desiredRelease: root.desiredRelease,
          },
          mutation: { kind: "patch-gateway", gatewayId: id, patch: built.ok.patch },
          classifyResult: (result) => result.ok
            ? { outcome: "completed" }
            : { outcome: "failed", error: result.error },
          dryRunRefusal: () => store.transaction(
            { label: "admin.fleet.patchGateway.dryRun", readOnly: true },
            (transaction) => gatewayPatchRefusal(transaction, id),
          ),
          action: async (claim: OperationAuditActionClaim) => store.transaction({ label: "admin.fleet.patchGateway" }, async (transaction) => {
            const refusal = await gatewayPatchRefusal(transaction, id);
            if (refusal) return refusal;
            await transaction.gateways.roots.patch(id, {
              ...built.ok.patch,
              updatedAt: Date.now(),
              updatedBy,
            });
            return { ok: true as const, operationId: claim.auditId };
          }),
        });
        if (!patchResult.ok) {
          res.status(409).json({ error: patchResult.error, gatewayId: id });
          return;
        }
        res.status(202).json({ gatewayId: id, updated: Object.keys(built.ok.patch), operationId: patchResult.operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  async function answerFailedRetirement(input: {
    req: Request; res: Response; gatewayId: string; runtime: DurableGatewayRuntime; optionsSent: boolean;
  }): Promise<boolean> {
    const { req, res, gatewayId, runtime } = input;
    const operationId = await failedRetirementOf(store, runtime.root);
    if (!operationId) return false;
    if (input.optionsSent) {
      res.status(409).json({
        code: "retire-retry-takes-no-options",
        error: "a failed retire is driven again as it was first requested; send the request without options",
        gatewayId,
        operationId,
      });
      return true;
    }
    await runAdminFleetMutation({
      req,
      what: "retry gateway retirement",
      why: ADMIN_FLEET_REQUEST_REASON,
      target: { gatewayId },
      preActionStatus: { desiredStatus: runtime.root.desiredStatus },
      mutation: { kind: "retire-gateway", gatewayId, retryOperationId: operationId },
      action: () => rearmFailedRetirement(store, operationId),
    });
    res.status(202).json({ gatewayId, operationId, retried: true });
    return true;
  }

  router.delete(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const retainData = isTruthyQueryFlag(req.query.retainData);
        const retainServiceAccount = isTruthyQueryFlag(req.query.retainServiceAccount);
        const runtime = await readDurableGatewayRuntime(store, id);
        if (!runtime) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const optionsSent = retainData || retainServiceAccount ||
          isTruthyQueryFlag(req.query.force) || isTruthyQueryFlag(req.query.deleteHome);
        if (await answerFailedRetirement({ req, res, gatewayId: id, runtime, optionsSent })) return;
        const moves = await movesTouchingGateway(store, id);
        const refusal = await retirementRefusal(store, id, runtime, {
          blockingMove: moves.blocking,
          force: isTruthyQueryFlag(req.query.force),
          deleteHome: isTruthyQueryFlag(req.query.deleteHome),
          retainData,
        });
        if (refusal) {
          res.status(409).json(refusal);
          return;
        }

        const operationId = randomUUID();
        const createdAt = Date.now();
        try {
          await runAdminFleetMutation({
            req,
            what: "retire gateway",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: id },
            preActionStatus: {
              desiredStatus: runtime.root.desiredStatus,
              desiredRelease: runtime.root.desiredRelease,
            },
            mutation: {
              kind: "retire-gateway",
              gatewayId: id,
              ...(retainData ? { retainData: true } : {}),
              ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
            },
            action: async () => {
              return claimGatewayRetirementInStore({
                store,
                gatewayId: id,
                operationId,
                operation: {
                  kind: "retire-gateway",
                  status: "pending",
                  createdBy,
                  createdAt,
                  startedAt: null,
                  completedAt: null,
                  input: {
                    gatewayId: id,
                    ...(retainData ? { retainData: true } : {}),
                    ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
                  },
                  steps: [],
                  gatewayId: id,
                },
                now: createdAt,
                updatedBy: createdBy,
                supersededMoves: {
                  operationIds: moves.waiting,
                  cancelledBecause: `cancelled: gateway ${id} was retired by ${createdBy}`,
                },
              });
            },
          });
        } catch (error) {
          if (error instanceof GatewayRetirementConflictError) {
            res.status(409).json({ error: error.message, gatewayId: id });
            return;
          }
          throw error;
        }
        res.status(202).json({
          gatewayId: id, operationId, retainData, retainServiceAccount,
          ...(moves.waiting.length > 0 ? { cancelledOperations: moves.waiting } : {}),
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post("/gateways/:id/recover-source", async (req, res, next) => {
    try {
      const gatewayId = req.params.id as string, body = req.body ?? {}, sourceSha = body.sourceSha, predecessorId = body.supersedeRecoveryId;
      if (!validSourceRecoveryBody(body)) {
        res.status(400).json({ error: "sourceSha is required" }); return;
      }
      if (!deps.releaseAuthority) { res.status(503).json({ error: "immutable build manifests are unavailable" }); return; }
      const captured = await store.transaction({ label: "admin.fleet.recoverSource", readOnly: true }, async transaction => predecessorId === undefined
        ? { source: await readSharedSourceRecoveryAuthority(transaction, gatewayId), supersede: undefined }
        : readSharedSourceRecoverySupersession(transaction, gatewayId, predecessorId));
      const { source, supersede } = captured;
      const manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
      const payload = centralGatewayReleasePayload(manifest);
      if (supersede) {
        const priorPayload = centralGatewayReleasePayload(await centralManifestForSourceSha(deps.releaseAuthority, supersede.input.sourceRecovery.sourceSha));
        const priorImages = { gateway: `${priorPayload.imageRepository}:${priorPayload.imageTag}`,
          "gateway-edge": `${priorPayload.gatewayEdgeImage!.imageRepository}:${priorPayload.gatewayEdgeImage!.imageTag}` };
        if (priorPayload.openclawSourceSha !== payload.openclawSourceSha || !isDeepStrictEqual(priorImages, supersede.input.sourceRecovery.images)) {
          throw new SharedSourceRecoveryConflict("source recovery predecessor immutable build changed");
        }
      }
      const input = { gatewayId, sourceRecovery: { sourceSha, ...source, ...(source.postgresAgentStores ? { payload } : {}), ...(supersede ? { supersede } : {}), images: {
        gateway: `${payload.imageRepository}:${payload.imageTag}`,
        "gateway-edge": `${payload.gatewayEdgeImage!.imageRepository}:${payload.gatewayEdgeImage!.imageTag}`,
      } } };
      const operationId = await runAdminFleetMutation({ req, what: "repair Shared source before export", why: ADMIN_FLEET_REQUEST_REASON,
        target: { gatewayId }, preActionStatus: source.root, mutation: input,
        action: async () => createOperation(store, { kind: OP_KIND_RESTART_GATEWAY, createdBy: (req as ActorRequest).uid ?? "unknown", input }) });
      res.status(202).json({ gatewayId, sourceSha, operationId });
    } catch (error) {
      if (error instanceof SharedSourceRecoveryConflict) { res.status(409).json({ error: error.message }); return; }
      if (respondCentralReleaseError(res, error)) return;
      next(error);
    }
  });

  router.post("/gateways/:id/recover-restore", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const body = req.body ?? {};
      const { sourceSha, operationId, reauthorizeAttemptId, supersedeRecoveryId } = body;
      if (!validRestoreRecoveryBody(body)) {
        res.status(400).json({ error: "sourceSha and restore operationId are required" }); return;
      }
      const gateway = await readGatewayDoc(store, id);
      if (!gateway || gateway.gatewayClass !== "shared" || gateway.desiredStatus === "retired") {
        res.status(409).json({ error: "restore recovery requires a live Shared gateway" }); return;
      }
      if (!deps.releaseAuthority) { res.status(503).json({ error: "immutable build manifests are unavailable" }); return; }
      const reauthorize = await capturedRestoreAttempt(store, operationId, reauthorizeAttemptId);
      if (reauthorizeAttemptId !== undefined && reauthorize?.attemptId !== reauthorizeAttemptId) {
        res.status(409).json({ error: "retained restore attempt changed" }); return;
      }
      const supersede = supersedeRecoveryId === undefined ? undefined :
        await capturedRecoveryPredecessor(store, id, operationId, supersedeRecoveryId, reauthorize);
      if (supersedeRecoveryId !== undefined && !supersede) {
        res.status(409).json({ error: "failed restore recovery predecessor changed" }); return;
      }
      const manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
      const payload = centralGatewayReleasePayload(manifest);
      const input = restoreRecoveryOperationInput({ gatewayId: id, operationId, sourceSha, payload, reauthorize, supersede });
      const queued = await runAdminFleetMutation({ req, what: "recover fenced Shared restore runtime", why: ADMIN_FLEET_REQUEST_REASON,
        target: { gatewayId: id, operationId }, preActionStatus: { desiredRelease: gateway.desiredRelease },
        mutation: input, action: async () => createOperation(store, {
          kind: OP_KIND_RESTART_GATEWAY, createdBy: (req as ActorRequest).uid ?? "unknown", input,
        }) });
      res.status(202).json({ gatewayId: id, sourceSha, operationId: queued });
    } catch (error) {
      if (respondCentralReleaseError(res, error)) return;
      next(error);
    }
  });

  router.post(
    "/gateways/:id/restart",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const gateway = await readGatewayDoc(store, id);
        if (!gateway) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (gateway.desiredStatus === "retired") {
          res.status(409).json({ error: "cannot restart a retired gateway", gatewayId: id });
          return;
        }
        const runtime = resolveGatewayRuntime((await store.fleetRegistry.get(id))?.runtime);
        if (runtime === "gce-vm") {
          res.status(409).json({
            code: "gateway-restart-unsupported-runtime",
            error: `gateway restart works on a pod gateway only; ${id} runs on a VM, which has no restart path`,
            gatewayId: id,
            runtime,
          });
          return;
        }

        const conflicting = await findConflictingGatewayOp(store, id);
        if (conflicting) {
          res.status(409).json({
            error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
            gatewayId: id,
            operationId: conflicting.id,
            kind: conflicting.kind,
          });
          return;
        }

        const operationId = await runAdminFleetMutation({
          req,
          what: "restart gateway",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { gatewayId: id },
          preActionStatus: {
            desiredStatus: gateway.desiredStatus,
            desiredRelease: gateway.desiredRelease,
          },
          mutation: { kind: "restart-gateway", gatewayId: id },
          action: async () => createOperation(store, {
            kind: "restart-gateway",
            createdBy: (req as ActorRequest).uid ?? "unknown",
            input: { gatewayId: id },
          }),
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/deploy",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const validation = validateDeployBody(req.body);
        if ("error" in validation) {
          res.status(validation.error.status).json(validation.error.body);
          return;
        }
        const gateway = await readGatewayDoc(store, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (gateway.desiredStatus === "retired") {
          res.status(409).json({ error: "cannot deploy to a retired gateway", gatewayId: id });
          return;
        }
        if (gateway.gatewayClass === "shared") {
          res.status(409).json({ error: ERR_SHARED_GATEWAY_NOT_ROLLED_IN_PLACE, gatewayId: id });
          return;
        }
        if (!deps.releaseEnvironment || !deps.releaseAuthority) {
          res.status(503).json({ error: "immutable build manifests are unavailable" });
          return;
        }
        const { sourceSha } = validation.ok;
        const manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
        const payload = centralGatewayReleasePayload(manifest);
        const artifact = gatewayArtifactFromReleasePayload(payload);
        const actor = req as ActorRequest;
        let deployed: { release: number; operationId: string | null };
        try {
          deployed = await runAdminFleetMutation({
            req,
            what: "deploy build to gateway",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: id },
            preActionStatus: {
              desiredStatus: gateway.desiredStatus,
              desiredRelease: gateway.desiredRelease,
              latestRelease: gateway.latestRelease,
            },
            mutation: {
              kind: "deploy-gateway-build",
              gatewayId: id,
              sourceSha,
              manifestDigest: manifest.manifestDigest,
            },
            action: async () => appendGatewayRelease(store, {
              gateway,
              artifact,
              payload,
              createdBy: actor.uid ?? "unknown",
              origin: "operator",
              now: Date.now(),
              sourceRelease: gateway.latestRelease,
              note: `operator deployment of ${sourceSha}`,
            }),
          });
        } catch (error) {
          if (respondCentralReleaseError(res, error)) return;
          throw error;
        }
        res.status(202).json({
          gatewayId: id,
          sourceSha,
          release: deployed.release,
          operationId: deployed.operationId,
        });
      } catch (error) {
        if (respondCentralReleaseError(res, error)) return;
        next(error);
      }
    },
  );

  router.get(
    "/gateways/:id/releases",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const gateway = await readGatewayDoc(store, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const docs = await store.gateways.releases.list(id, "desc");
        const history = projectReleaseHistory({ gateway, releases: [...docs] });
        const payloadByRelease = new Map(docs.map((r) => [r.release, r.payload]));
        const releases = history.map((entry) => ({
          ...entry,
          payload: payloadByRelease.get(entry.release) ?? null,
        }));
        res.json({
          gatewayId: id,
          latestRelease: gateway.latestRelease,
          desiredRelease: gateway.desiredRelease,
          liveRelease: gateway.liveRelease,
          releases,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/releases/:n/rollback",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const resolved = await resolveRollbackRelease({
          store,
          gatewayId: id,
          requestedRelease: req.params.n,
          body,
        });
        if ("error" in resolved) {
          res.status(resolved.error.status).json(resolved.error.body);
          return;
        }
        const { gateway, artifact, release, note } = resolved.ok;
        let appended: { release: number; operationId: string | null };
        try {
          appended = await runAdminFleetMutation({
            req,
            what: "roll back gateway release",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: id, release },
            preActionStatus: {
              latestRelease: gateway.latestRelease,
              desiredRelease: gateway.desiredRelease,
            },
            mutation: {
              kind: "rollback-gateway-release",
              gatewayId: id,
              sourceRelease: release,
              artifact,
              note,
            },
            action: async () => appendGatewayRelease(store, {
              gateway,
              artifact,
              createdBy,
              origin: "operator",
              now,
              sourceRelease: release,
              note,
            }),
          });
        } catch (e) {
          if (respondReleaseWriteConflict(res, e)) return;
          throw e;
        }
        res
          .status(202)
          .json({ gatewayId: id, ...appended, rolledBackFrom: release });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/user-by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const slug = req.params.slug as string;
        const userRecord = await store.users.records.findBySlug(slug);
        if (userRecord) {
          res.json({ uid: userRecord.uid, currentGatewayId: userRecord.gateway?.gatewayId ?? null });
          return;
        }
        res.status(404).json({ error: "user not found", slug });
      } catch (e) {
        next(e);
      }
    },
  );

  async function findInFlightMigrateOp(
    uid: string,
  ): Promise<{ id: string } | null> {
    const operation = (await inFlightOperationsForUid(store, uid)).find(isInFlightUserMigration);
    return operation ? { id: operation.id } : null;
  }

  router.patch("/users/:uid/placement", async (req, res, next) => {
    try {
      const command = (req.body ?? {}) as { managedBy?: unknown; gatewayId?: unknown };
      const park = command.managedBy === "operator" && command.gatewayId === null;
      const release = command.managedBy === "cowboy" && command.gatewayId === undefined;
      if (!park && !release) {
        res.status(400).json({ error: "choose operator with gatewayId=null to park, or cowboy to release" });
        return;
      }
      const uid = req.params.uid as string;
      const before = await store.users.records.get(uid);
      const outcome = await runAdminFleetMutation({
        req,
        what: park ? "park user" : "release user to the fleet controller",
        why: ADMIN_FLEET_REQUEST_REASON,
        target: { uid },
        preActionStatus: { gatewayId: before?.gateway?.gatewayId ?? null },
        mutation: { kind: park ? "park-user" : "place-user", uid },
        classifyResult: result => result.status >= 400
          ? { outcome: "failed", error: String(result.body.error) }
          : { outcome: "completed" },
        action: () => store.transaction({ label: "admin.fleet.customerPlacement" }, async (transaction): Promise<{ status: number; body: Record<string, unknown> }> => {
          const [userRecord, operations] = await Promise.all([
            transaction.users.records.get(uid),
            inFlightOperationsForUid(transaction, uid),
          ]);
          if (!userRecord) return { status: 404, body: { error: ERR_USER_NOT_FOUND, uid } };
          if (isolatedRuntimeMutationFenced(userRecord)) return { status: 409, body: { error: "user restore or source transfer is unresolved — cannot change placement", uid } };
          const inFlight = operations.find(isInFlightUserMigration);
          if (inFlight) return { status: 409, body: { error: "user migration is pending or running — cannot change placement", operationId: inFlight.id, uid } };
          const gatewayId = userRecord.gateway?.gatewayId ?? null;
          const gateway = await updateOperatorParkingGateway(transaction, { gatewayId, uid, actor: (req as ActorRequest).uid, park });
          if (gateway.error) return { status: 409, body: { error: gateway.error, uid } };
          if (release) {
            const provisioningComplete = (userRecord.provisioning.status ?? userRecord.openclaw.status) === "complete";
            await transaction.users.records.patch(uid, {
              openclaw: { managedBy: "cowboy" },
              ...(provisioningComplete ? { provisioning: { status: "complete" } } : {}),
            });
            return { status: 200, body: { uid, managedBy: "cowboy" } };
          }
          await transaction.users.records.patch(uid, { openclaw: { managedBy: "operator" } });
          if (gateway.dedicated) {
            return { status: 200, body: { uid, parked: true, gatewayId, managedBy: "operator" } };
          }
          await transaction.users.records.setGatewayMirror(uid, { clear: true });
          return { status: 200, body: { uid, parked: true, managedBy: "operator" } };
        }),
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) { next(error); }
  });

  router.post("/users/:uid/isolated-gateway", async (req, res, next) => {
    try {
      const uid = req.params.uid as string;
      const sizingProfile = ((req.body ?? {}) as { sizingProfile?: unknown }).sizingProfile;
      const planned = await planOperatorIsolatedGateway(store, { uid, sizingProfile });
      if ("refusal" in planned) {
        res.status(planned.refusal.status).json(planned.refusal.body);
        return;
      }
      const allocationId = operatorAllocationId();
      const outcome = await runAdminFleetMutation({
        req,
        what: "move user to an isolated gateway",
        idempotencyScope: "give user an isolated gateway",
        why: ADMIN_FLEET_REQUEST_REASON,
        target: { uid },
        preActionStatus: { gatewayId: planned.sourceGatewayId },
        mutation: {
          kind: "move-to-isolated-gateway",
          uid,
          sizingProfile: planned.sizingKey,
          fromGatewayId: planned.sourceGatewayId,
        },
        classifyResult: (result) => result.status >= 400
          ? { outcome: "failed", error: String(result.body.error) }
          : { outcome: "completed" },
        action: () => giveOperatorIsolatedGateway(store, {
          uid,
          sizingProfile,
          actor: (req as ActorRequest).uid ?? "unknown",
          allocationId,
          now: Date.now(),
        }),
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) { next(error); }
  });

  router.post(
    "/users/:uid/migrate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ to: string }>;
        if (typeof body.to !== "string" || body.to.length === 0) {
          res
            .status(400)
            .json({ error: "missing target gateway", required: ["to"] });
          return;
        }
        const inFlight = await findInFlightMigrateOp(uid);
        if (inFlight) {
          res.status(409).json({
            error:
              "a migration for this user is already pending or running",
            operationId: inFlight.id,
            uid,
          });
          return;
        }
        // Registration is either doc; readiness comes from the relocated
        // glmGateways/{id}.heartbeat (cutover step 2).
        const target = await readGatewayRegistrationReadiness(store, body.to);
        if (!target.registered) {
          res.status(404).json({
            error: "target gateway not registered",
            gatewayId: body.to,
          });
          return;
        }
        if (target.gatewayClass !== "shared") {
          const refusal = await ownIsolatedGatewayTargetRefusal(store, uid, body.to);
          if (refusal) {
            res.status(refusal.status).json(refusal.body);
            return;
          }
        }
        if (target.status !== "ready") {
          res.status(409).json({
            error: ERR_TARGET_GATEWAY_NOT_READY,
            gatewayId: body.to,
            status: target.status ?? "unknown",
          });
          return;
        }
        const { currentGatewayId, builderSlug } = userMountOf(await store.users.records.get(uid));
        if (currentGatewayId === body.to) {
          res.status(409).json({
            error: "user is already mounted on the target gateway",
            uid,
            gatewayId: body.to,
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await runAdminFleetMutation({
          req,
          what: "migrate user",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, gatewayId: body.to },
          preActionStatus: { gatewayId: currentGatewayId ?? null },
          mutation: {
            kind: OP_KIND_MIGRATE_USER,
            uid,
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId: body.to,
          },
          action: async () => createOperation(store, {
            kind: OP_KIND_MIGRATE_USER,
            createdBy,
            input: {
              uid,
              ...(builderSlug ? { builderSlug } : {}),
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId: body.to,
            },
          }),
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  // Clears the user's gateway placement so they land in pending-placement:
  // deletes gateways/{gw}/assignments/{uid} AND clears the user mirror fields in
  // ONE transaction (same all-or-nothing discipline as commitCutoverAtomic). The
  // guard runs INSIDE that transaction — it re-reads the in-flight migrate ops
  // (a migrate enqueued between check and commit conflicts the txn's query read
  // and retries) and the assignment doc's durable `state`, refusing (409) if a
  // migrate op is pending/running OR the durable roster state is not "serving"
  // (a terminal failed roll can leave the user quiescing with no live op).
  // Never destructive beyond the placement: the user + workspace stay put.
  router.post(
    "/users/:uid/unassign",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const userBefore = await store.users.records.get(uid);
        const preActionGatewayId = userBefore?.gateway?.gatewayId ?? null;
        const outcome = await runAdminFleetMutation({
          req,
          what: "unassign user from gateway",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid },
          preActionStatus: { gatewayId: preActionGatewayId },
          mutation: {
            kind: "unassign-user",
            uid,
            ...(preActionGatewayId ? { gatewayId: preActionGatewayId } : {}),
          },
          classifyResult: (result) => result.status >= 400
            ? {
                outcome: "failed",
                error: typeof result.body.error === "string"
                  ? result.body.error
                  : `unassign returned ${result.status}`,
              }
            : { outcome: "completed" },
          action: async (claim: OperationAuditActionClaim) => store.transaction({ label: "admin.fleet.unassignCustomer" }, async (transaction): Promise<{
            status: number;
            body: Record<string, unknown>;
            from?: string;
          }> => {
            const userRecord = await transaction.users.records.get(uid);
            if (!userRecord) {
              return { status: 404, body: { error: ERR_USER_NOT_FOUND, uid } };
            }
            if (isolatedRuntimeMutationFenced(userRecord)) {
              const action = userRecord.fences.restoreFence !== undefined ? "restore" : "source transfer";
              return { status: 409, body: { error: `user ${action} outcome is unresolved — cannot unassign`, uid } };
            }
            const currentGatewayId = userRecord.gateway?.gatewayId ?? null;
            if (!currentGatewayId) {
              return { status: 409, body: { error: "user is already unassigned", uid } };
            }
            const [assignment, operations] = await Promise.all([
              transaction.gateways.assignments.get(currentGatewayId, uid),
              inFlightOperationsForUid(transaction, uid),
            ]);
            const inFlight = operations.find(isInFlightUserMigration);
            if (inFlight) {
              return {
                status: 409,
                body: {
                  error:
                    "a migration for this user is pending or running — let it finish or fail before unassigning",
                  operationId: inFlight.id,
                  uid,
                },
              };
            }
            if (assignment && assignment.state !== "serving") {
              return {
                status: 409,
                body: {
                  error: `user is mid-migration (roster state ${assignment.state}) — cannot unassign until the migration settles`,
                  uid,
                  state: assignment.state,
                },
              };
            }
            await transaction.gateways.assignments.delete(currentGatewayId, uid);
            await transaction.users.records.setGatewayMirror(uid, { clear: true });
            return {
              status: 200,
              body: {
                unassigned: true,
                uid,
                from: currentGatewayId,
                operationId: claim.auditId,
              },
              from: currentGatewayId,
            };
          }),
        });
        if (outcome.status === 200) {
          const actor = (req as ActorRequest).uid ?? "unknown";
          deps.logger.info("admin unassigned user from gateway", {
            actor,
            uid,
            from: outcome.from,
          });
        }
        res.status(outcome.status).json(outcome.body);
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/rollouts",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          gatewayId: string;
          targetRelease: number;
          imageTag: string;
        }>;
        if (
          typeof body.gatewayId !== "string" ||
          body.gatewayId.length === 0 ||
          typeof body.targetRelease !== "number" ||
          !Number.isSafeInteger(body.targetRelease) ||
          body.targetRelease < 1 ||
          typeof body.imageTag !== "string" ||
          body.imageTag.length === 0
        ) {
          res.status(400).json({
            error: "missing required fields",
            required: ["gatewayId", "targetRelease", "imageTag"],
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await runAdminFleetMutation({
          req,
          what: "roll out gateway image",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { gatewayId: body.gatewayId },
          preActionStatus: {},
          mutation: {
            kind: "rollout",
            gatewayId: body.gatewayId,
            targetRelease: body.targetRelease,
            imageTag: body.imageTag,
          },
          action: async () => createOperation(store, {
            kind: "rollout",
            createdBy,
            input: {
              gatewayId: body.gatewayId,
              targetRelease: body.targetRelease,
              imageTag: body.imageTag,
            },
          }),
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );


router.get(
    "/builds",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = (req.query.service as string) || "octogee-gateway";
        if (!BUILDS_SERVICE_ALLOWLIST.has(service)) {
          res.status(400).json({
            error:
              "service must be one of the canonical Octogee gateway-pod images",
            allowed: [...BUILDS_SERVICE_ALLOWLIST],
            got: service,
          });
          return;
        }
        const parsedLimit = parseInt(
          (req.query.limit as string) ?? "30",
          10,
        );
        const limit = Math.min(
          100,
          Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30),
        );
        try {
          const builds = await deps.listGatewayBuilds({ service, limit });
          res.json({
            service,
            builds,
            generatedAt: new Date().toISOString(),
          });
        } catch (e) {
          logger.warn("artifact-registry list failed", {
            service,
            error: (e as Error)?.message,
          });
          res.status(502).json({
            error: (e as Error)?.message ?? "artifact-registry list failed",
            service,
          });
        }
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/release-status",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const snapshot = await readReleaseStatus(store);
        res.json({ summary: summarizeReleaseStatus(snapshot), ...snapshot });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/operations",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(
          100,
          Math.max(1, parseInt((req.query.limit as string) ?? "25", 10)),
        );
        const status = req.query.status;
        if (status !== undefined && status !== "unresolved" && !isJournalStatusFilter(status)) {
          res.status(400).json({
            error: `status must be omitted, "unresolved", or one of: ${JOURNAL_STATUS_FILTERS.join(", ")}`,
            got: status,
          });
          return;
        }
        const docs = await listOperationDocsForStatus(store, status, limit);
        const operations = await withActorEmails(accounts, docs.map((doc) =>
          shapeOperationsHistoryRecord(doc.id, doc.data()),
        ));
        res.json({ operations, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

  router.get(
    "/operations/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const record = await store.journal.getRecord(id);
        if (!record) {
          res.status(404).json({ error: ERR_OPERATION_NOT_FOUND, operationId: id });
          return;
        }
        const [doc] = operationDocs([record]);
        const [operation] = await withActorEmails(accounts, [shapeOperationsHistoryRecord(doc.id, doc.data())]);
        res.json({ operation });
      } catch (e) {
        next(e);
      }
    },
  );

  router.use(refuseUnansweredAdminDryRun);

  router.use(respondToAdminFleetMutationError);

  return router;
}
