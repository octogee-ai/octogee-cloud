import { Router, type Request, type Response, type NextFunction } from "express";
import { type GatewayClass, type GatewayImageProfile, type GatewayProfile, type GatewayRuntime, type GatewayVmState, type OperationAuditAliasPlan } from "@octogee/shared/types/glm";
import { type PlatformRuntimeConfig } from "@octogee/shared/types/platform-config";
import { type AssignmentDoc, type AssignmentState } from "@octogee/shared/types/gateway-releases";
import { type GatewayPodReplacementSummary } from "@octogee/shared/types/gateway-pod-replacements";
import type { MigrationProgressRecord } from "@octogee/shared/types/glm";
import { type GatewayArtifact } from "./gateway-live-release.js";
import { type SharedGatewayAddedBy } from "@octogee/shared/types/shared-gateway-pool";
import { type SizingTier } from "@octogee/shared/types/sizing";
import { type GatewayPricingMode } from "@octogee/shared/types/cost-estimator";
import { type UserAccounts, type UserSignInHosts } from "./admin-user-router.js";
import { type DurableGatewayRoot } from "./gateway-release-append.js";
import { type NormalFleetMutationResult } from "./normal-fleet-mutation.js";
import { type OperationAuditActionClaim } from "./operation-audit.js";
import { type UserAccountReader } from "./user-account.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { OpaqueMap, PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
import { type CentralReleaseAuthority } from "./artifact-registry.js";
export interface FleetLogger {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";
export type GatewayPodCapacityType = "spot" | "on-demand";
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
    readGatewayPodDiagnosticsBatch?: (gatewayIds: readonly string[]) => Promise<Record<string, GatewayPodDiagnostics>>;
    requestNativeReturnSourceRecovery?: (input: {
        uid: string;
        operationId: string;
        requestedAt: number;
        requestedBy: string;
    }) => Promise<boolean>;
    suspendAuthUser: (uid: string) => Promise<void>;
    revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
    userAccounts?: UserAccounts;
    userSignIn?: UserSignInHosts;
    discoverDeletionProductContext?: DeletionProductContextDiscovery;
}
export type DeletionProductContextDiscovery = (uid: string) => Promise<OpaqueMap>;
export type ActorRequest = Request & {
    uid?: string;
    user?: {
        email?: string | null;
    };
};
interface GatewayMonthlyCostUsd {
    compute: number;
    onDemandCompute: number;
    savings: number;
    pricingMode: GatewayPricingMode;
    storage: number;
    total: number;
    onDemandTotal: number;
    basis: "vm" | "size";
    perUserAtTarget: number;
    perUserAtTypical: number;
}
declare function resolveSizingForResponse(glmDoc: Record<string, unknown> | undefined, reservation: ReturnType<typeof projectGatewayReservation>): {
    tier: SizingTier;
    resolvedFrom: "explicit" | "class-default" | "profile-default";
    resources: {
        requests: {
            cpu: string;
            memory: string;
        };
        limits: {
            cpu: string;
            memory: string;
        };
    };
    capacity: {
        targetActiveUsers: number;
        typicalUsers: number;
    };
    monthlyCostUsd: GatewayMonthlyCostUsd;
};
export declare function resolveFleetNamespace(env?: NodeJS.ProcessEnv): string;
type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike {
    id: string;
    data(): GlmDoc;
}
export declare const ERR_SHARED_GATEWAY_NOT_ROLLED_IN_PLACE = "a shared gateway is not rolled in place; add a shared gateway on the new build, move its users to it, then retire this one";
type AdminPlacementDriftState = "healthy" | "pointer-drift" | "assigned-not-mounted" | "mounted-orphan" | "missing-gateway" | "in-flight";
type AdminPlacementWarningCode = "default-gateway-missing" | "default-gateway-retired" | "default-gateway-not-shared" | "pointer-drift" | "assigned-not-mounted" | "mounted-orphan" | "migration-in-flight" | "account-deletion-pending" | "shared-gateway-behind-platform-build";
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
export declare function readAdminPlacementResponse(store: PlatformStateStore, accounts: UserAccountReader): Promise<AdminPlacementResponse>;
declare function projectLastError(raw: unknown): {
    slug?: string;
    message?: string;
    at: string | null;
} | null;
export declare function isPlainRecord(v: unknown): v is Record<string, unknown>;
export declare function readGatewayRegistrationReadiness(store: PlatformStateStore, gatewayId: string): Promise<{
    registered: boolean;
    status: string | null;
    gatewayClass: DurableGatewayRoot["gatewayClass"] | null;
}>;
type ProjectedGatewayStorage = {
    mode: "emptyDir" | "pvc";
    pvcName: string | null;
    size: string | null;
    storageClassName: string | null;
    accessModes: string[];
};
declare function projectGatewayStorage(_gatewayId: string, _glmDoc: GlmDoc | undefined): ProjectedGatewayStorage;
export declare function projectGatewayReservation(glmDoc: GlmDoc | undefined, observedCapacityType?: GatewayPodCapacityType): {
    type: GatewayPricingMode;
    priceMultiplier: number;
    source: "kubernetes" | "class-default" | "vm";
};
declare function projectDisposableRuntime(glmDoc: GlmDoc | undefined): {
    ownerUid: string;
    leaseId: string;
    generation: number;
} | null;
export declare function projectGatewaySummary(doc: FirestoreDocLike, glmDoc: GlmDoc | undefined, now: number): {
    gatewayId: string;
    gateway: string;
    status: string;
    statusReason: string | null;
    desiredStatus: AdminGatewayDesiredStatus | null;
    imageTag: string | null;
    openclawVersion: string | null;
    mountedUsers: unknown[];
    ownerId: string | null;
    handoffProgress?: Record<string, MigrationProgressRecord[]>;
    lastHeartbeatAt: string | null;
    heartbeatAgeMs: number | null;
    startedAt: string | null;
    uptimeMs: number | null;
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
};
export type AdminIsolatedRuntimeLifecycle = "requested" | "provisioning" | "activating" | "active" | "returning" | "retiring" | "failed";
export declare function projectIsolatedRuntime(userDoc: FirestoreDocLike, gatewaysById: ReadonlyMap<string, GlmDoc>, operationsById: ReadonlyMap<string, GlmDoc>, now: number): {
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
    operationSteps: Array<{
        name: string;
        status: string;
    }>;
    cleanupOperationId: string | null;
    cleanupOperationStatus: string | null;
    cleanupOperationSteps: Array<{
        name: string;
        status: string;
    }>;
    cleanupError: string | null;
    error: string | null;
    terminationAvailable: boolean;
    targetPodStatus: GatewayPodDiagnosticsStatus | null;
    targetPodCount: number | null;
} | null;
export declare function projectDisposableFleetCapacity(gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>, isolatedRuntimes?: ReadonlyArray<NonNullable<ReturnType<typeof projectIsolatedRuntime>>>, parkedUsers?: number): {
    disposableInstances: number;
    stagedInstances: 0;
    byTier: Record<string, number>;
    parkedUsers: number;
    byLifecycle: Record<AdminIsolatedRuntimeLifecycle | "parked", number>;
    failedUsers: number;
    staleActivations: number;
    oldestActivationAgeMs: number | null;
};
export declare function rollupFleetStats(gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>): {
    gateways: {
        total: number;
        ready: number;
        paused: number;
        unreachable: number;
    };
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
};
export declare const ERR_USER_NOT_FOUND = "user not found";
export declare const ERR_TARGET_GATEWAY_NOT_READY = "target gateway not ready";
export declare const ADMIN_FLEET_REQUEST_REASON = "Admin fleet request";
export declare const OP_KIND_MIGRATE_USER = "migrate-user";
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
export declare function projectGatewayControl(root: DurableGatewayRoot, glmData: Record<string, unknown> | undefined): AdminGatewayControlProjection;
interface NewOperationInput {
    kind: "add-gateway" | typeof OP_KIND_MIGRATE_USER | "retire-gateway" | "restart-gateway" | "rollout" | "deprovision-user" | "suspend-user" | "erase-user";
    createdBy: string;
    origin?: "automatic" | "operator";
    input: Record<string, unknown>;
}
export declare function asStringOrNull(v: unknown): string | null;
export declare function toMillis(v: unknown): number | null;
interface RolloutBodyError {
    status: number;
    body: Record<string, unknown>;
}
export declare function validateDesiredStatusPatch(desiredStatus: string): {
    error: {
        status: number;
        body: {
            error: string;
            got?: string;
        };
    };
} | {
    ok: "running" | "paused" | "draining";
};
export declare function validateDeployBody(body: unknown): {
    error: RolloutBodyError;
} | {
    ok: {
        sourceSha: string;
    };
};
export declare function projectHandoffProgress(assignments: readonly AssignmentDoc[]): Map<string, Record<string, MigrationProgressRecord[]>>;
export declare function shapeOperationsHistoryRecord(id: string, data: Record<string, unknown>): Record<string, unknown>;
export declare function createOperation(store: PlatformStateStore, opts: NewOperationInput): Promise<string>;
export type UserSelfDeletionOutcome = {
    kind: "not-found";
} | {
    kind: "conflict";
} | {
    kind: "workspace-busy";
} | {
    kind: "scheduled";
    deletionId: string;
    eraseAfter: number;
    incompleteStep: {
        name: "suspend-auth" | "revoke-connector-grants";
        error: Error;
    } | null;
};
export declare function scheduleUserSelfDeletion(opts: {
    store: PlatformStateStore;
    discoverProductContext: DeletionProductContextDiscovery;
    deps: Pick<FleetRouterDeps, "suspendAuthUser" | "revokeConnectorGrantsForUser">;
    uid: string;
}): Promise<UserSelfDeletionOutcome>;
type ActivationLeaseTerminationOutcome = {
    kind: "not-found";
} | {
    kind: "conflict";
    reason: string;
} | {
    kind: "adopted";
} | {
    kind: "requested";
};
type ActivationLeaseReturnOutcome = {
    kind: "not-found";
} | {
    kind: "conflict";
    status: string | null;
} | {
    kind: "adopted";
} | {
    kind: "requested";
};
type ReasonedActivationLeaseMutationOutcome = {
    kind: "not-found";
} | {
    kind: "conflict";
    reason: string;
} | {
    kind: "retried" | "cancelled";
};
export declare function classifyActivationLeaseTermination(result: ActivationLeaseTerminationOutcome): NormalFleetMutationResult;
export declare function classifyActivationLeaseReturn(result: ActivationLeaseReturnOutcome): NormalFleetMutationResult;
export declare function classifyReasonedActivationLeaseMutation(result: ReasonedActivationLeaseMutationOutcome): NormalFleetMutationResult;
export declare function inFlightOperationsForUid(transaction: Pick<PlatformStateTransaction, "journal">, uid: string): Promise<readonly Stored<OperationRecord>[]>;
export declare function isInFlightUserMigration(operation: OperationRecord): boolean;
export declare function requestActivationLeaseTermination(transaction: PlatformStateTransaction, input: {
    uid: string;
    leaseId: string;
    generation: number;
    sharedGatewayIds: readonly string[];
    requestedAt: number;
    requestedBy: string;
}): Promise<ActivationLeaseTerminationOutcome>;
export declare function retryActivationLeaseReturn(transaction: PlatformStateTransaction, input: {
    uid: string;
    operationId: string;
    requestedAt: number;
    requestedBy: string;
}): Promise<ReasonedActivationLeaseMutationOutcome>;
export declare function readPlatformRuntimeConfig(store: PlatformStateStore): Promise<PlatformRuntimeConfig>;
export declare function createAdminFleetMutationRunner(store: PlatformStateStore): <T>(input: {
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
}) => Promise<T>;
export type AdminFleetMutationRunner = ReturnType<typeof createAdminFleetMutationRunner>;
export declare function respondToAdminFleetMutationError(error: unknown, _req: Request, res: Response, next: NextFunction): void;
export declare function addAdminFleetRoutes(router: Router, deps: FleetRouterDeps): Router;
export {};
