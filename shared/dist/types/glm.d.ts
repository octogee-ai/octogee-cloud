import type { SizingTier } from "./sizing.js";
export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";
export declare const GATEWAY_PROFILES: readonly ["standard", "isolated"];
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];
export declare const GATEWAY_CLASSES: readonly ["shared", "isolated"];
export type GatewayClass = (typeof GATEWAY_CLASSES)[number];
export declare const GATEWAY_IMAGE_PROFILES: readonly ["standard", "isolated"];
export type GatewayImageProfile = (typeof GATEWAY_IMAGE_PROFILES)[number];
export declare function dualReadGatewayClassValue<T>(value: T): T | "isolated";
export declare function isIsolatedGatewayClassValue(value: unknown): boolean;
export interface GatewayDesiredState {
    gatewayId: string;
    /**
     * Durable identity this instance belongs to (`shared-a`, `walter`) — bare,
     * never blue/green-suffixed. Explicit on every instance written after the
     * gateway field landed; older docs derive it from gatewayId by convention
     * via deriveGatewayIdentity until backfilled.
     */
    gateway?: string;
    imageRepository: string;
    imageTag: string;
    /**
     * Legacy overloaded image/capability selector. Keep for compatibility with
     * already-authored desired-state docs and API clients. New callers should set
     * gatewayClass + imageProfile explicitly.
     */
    profile?: GatewayProfile;
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
    desiredStatus: GatewayDesiredStatus;
    createdBy: string;
    retireAfter?: number;
    serviceAccountName?: string;
    serviceAccount?: GatewayServiceAccountSpec;
    gcpProject?: string;
    gatewayContainerSecurityContext?: Record<string, unknown>;
    builderAccess?: IsolatedGatewayAccessSpec;
    lastError?: {
        at: number;
        message: string;
    } | null;
    ownerUid?: string;
    builderSlug?: string;
    sizingTier?: SizingTier;
    modelBrokerLimits?: GatewayModelBrokerLimits;
    runtime?: GatewayRuntime;
    vmSpec?: GatewayVmSpec;
    vm?: GatewayVmState | null;
    vmEgress?: GatewayVmEgressState;
}
export declare const GATEWAY_RUNTIMES: readonly ["cluster", "gce-vm"];
export type GatewayRuntime = (typeof GATEWAY_RUNTIMES)[number];
export declare function isGatewayRuntime(value: unknown): value is GatewayRuntime;
export declare function resolveGatewayRuntime(value: unknown): GatewayRuntime;
export declare const GATEWAY_VM_BOOT_DISK_TYPES: readonly ["pd-ssd", "pd-balanced"];
export type GatewayVmBootDiskType = (typeof GATEWAY_VM_BOOT_DISK_TYPES)[number];
export declare function isGatewayVmBootDiskType(value: unknown): value is GatewayVmBootDiskType;
export declare const GATEWAY_VM_DESKTOPS: readonly ["omarchy", "x11"];
export type GatewayVmDesktop = (typeof GATEWAY_VM_DESKTOPS)[number];
export declare function isGatewayVmDesktop(value: unknown): value is GatewayVmDesktop;
export declare const GATEWAY_VM_PROVISIONING_MODELS: readonly ["SPOT", "STANDARD"];
export type GatewayVmProvisioningModel = (typeof GATEWAY_VM_PROVISIONING_MODELS)[number];
export interface GatewayVmSpec {
    zones: readonly string[];
    machineType: string;
    imageFamily: string;
    imageProject?: string;
    diskSizeGb: number;
    bootDiskType: GatewayVmBootDiskType;
    homeDiskSizeGb: number;
    provisioningModel: GatewayVmProvisioningModel;
    desktop: GatewayVmDesktop;
    serviceAccountEmail: string;
    subnetwork: string;
}
export interface RetainedUserHome {
    projectId: string;
    zone: string;
    name: string;
    id: string;
    sizeGb: number;
    diskType: "pd-balanced" | "pd-ssd";
    source: string;
}
export declare const GATEWAY_VM_STOP_REASONS: readonly ["idle", "preempted", "operator"];
export type GatewayVmStopReason = (typeof GATEWAY_VM_STOP_REASONS)[number];
export declare function isGatewayVmStopReason(value: unknown): value is GatewayVmStopReason;
export interface GatewayVmState {
    instanceName: string;
    zone: string;
    instanceId: string | null;
    internalIp: string | null;
    status: string | null;
    startedAt: number | null;
    provisioningModel: GatewayVmProvisioningModel | null;
    stopReason: GatewayVmStopReason | null;
    parkedCheckpoint?: GatewayVmParkedCheckpoint;
    updatedAt: number;
}
export declare const GATEWAY_EGRESS_MODES: readonly ["cloud", "desktop"];
export type GatewayEgressMode = (typeof GATEWAY_EGRESS_MODES)[number];
export declare function isGatewayEgressMode(value: unknown): value is GatewayEgressMode;
export interface GatewayVmEgressState {
    mode: GatewayEgressMode;
    updatedAt: number;
}
export declare function isGatewayVmEgressState(value: unknown): value is GatewayVmEgressState;
export declare const GATEWAY_EGRESS_SOCKS_HOST = "127.0.0.1";
export declare const GATEWAY_EGRESS_SOCKS_PORT = 1080;
export declare const GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES: readonly ["fresh", "stale"];
export type GatewayVmParkedCheckpointOutcome = (typeof GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES)[number];
export interface GatewayVmParkedCheckpoint {
    outcome: GatewayVmParkedCheckpointOutcome;
    requestedAt: number | null;
    completedAt: number | null;
}
export declare function isGatewayVmParkedCheckpoint(value: unknown): value is GatewayVmParkedCheckpoint;
export declare const USER_PARKED_VM_FIELD = "provisioning.computer";
export interface UserParkedVm {
    instanceName: string;
    zone: string;
    instanceId: string | null;
    gatewayId: string;
    parkedAt: number;
    checkpoint: GatewayVmParkedCheckpoint;
    homeCheckpoint?: GatewayVmHomeCheckpoint;
    bootRecovery?: GatewayVmBootRecoverySample & {
        instanceId: string;
        observedAt: number;
    };
    vmSpec?: GatewayVmSpec;
    disposable?: true;
}
export declare function isUserParkedVm(value: unknown): value is UserParkedVm;
export declare function readUserParkedVm(userData: Record<string, unknown> | undefined): UserParkedVm | null;
export declare const GLM_GATEWAY_VM_SUBCOLLECTION = "vm";
export declare const GLM_GATEWAY_VM_RUNTIME_DOC = "runtime";
export declare function gatewayVmRuntimeDocPath(gatewayId: string): string;
export interface GatewayVmRuntimeMount {
    volume: string;
    mountPath: string;
    readOnly: boolean;
    subPath: string | null;
}
export interface GatewayVmRuntimeContainer {
    name: string;
    image: string;
    env: Record<string, string>;
    command: string[] | null;
    args: string[] | null;
    mounts: GatewayVmRuntimeMount[];
}
export type GatewayVmRuntimeVolume = {
    name: string;
    kind: "emptyDir" | "ephemeral";
} | {
    name: string;
    kind: "identityToken";
    audience: string;
} | {
    name: string;
    kind: "kubernetesApi";
};
export interface RuntimeUserIdentity {
    ownerUid: string;
    builderSlug: string;
}
export declare function isRuntimeUserIdentity(value: unknown): value is RuntimeUserIdentity;
export interface GatewayVmRuntimeBundle {
    version: string;
    gatewayId: string;
    builderIdentity?: RuntimeUserIdentity;
    namespace?: string;
    imageRepository: string;
    imageTag: string;
    /** Absent on bundles rendered before VMs named their desktop; those VMs run Omarchy. */
    desktop?: GatewayVmDesktop;
    init: GatewayVmRuntimeContainer | null;
    containers: GatewayVmRuntimeContainer[];
    volumes: GatewayVmRuntimeVolume[];
    hostAliases: Record<string, string>;
    kubernetes: {
        apiHost: string;
        apiPort: string;
        caCert: string;
    };
    renderedAt: number;
    homeRestoreCheckpoint?: GatewayVmHomeCheckpoint;
}
export declare function isGatewayVmRuntimeBundle(value: unknown): value is GatewayVmRuntimeBundle;
export interface GatewayVmRuntimeResponse {
    bundle: GatewayVmRuntimeBundle;
    homeCheckpoint: {
        requestedAt: number | null;
        completedAt: number | null;
    };
}
export interface GatewayVmDiskSample {
    sizeBytes: number;
    freeBytes: number;
}
export interface GatewayVmRuntimeRequest {
    disk?: GatewayVmDiskSample;
    images?: GatewayVmImageSample;
    preempted?: true;
    bootRecovery?: GatewayVmBootRecoverySample;
}
export declare const GATEWAY_VM_IMAGE_SERVICES: readonly ["gateway", "gateway-edge"];
export interface GatewayVmContainerImage {
    name: typeof GATEWAY_VM_IMAGE_SERVICES[number];
    imageReference: string;
    digests: string[];
    running: boolean;
}
export interface GatewayVmImageSample {
    containers: GatewayVmContainerImage[];
}
export interface GatewayVmImageObservation extends GatewayVmImageSample {
    instanceId: string;
    observedAt: number;
}
export declare function isGatewayVmImageSample(value: unknown): value is GatewayVmImageSample;
export declare function isGatewayVmImageObservation(value: unknown): value is GatewayVmImageObservation;
export interface GatewayVmPreemptionNotice {
    instanceId: string;
    announcedAt: number;
}
export declare function isGatewayVmPreemptionNotice(value: unknown): value is GatewayVmPreemptionNotice;
export interface GatewayVmDiskObservation extends GatewayVmDiskSample {
    instanceId: string;
    observedAt: number;
}
export declare function isGatewayVmDiskSample(value: unknown): value is GatewayVmDiskSample;
export declare function isGatewayVmDiskObservation(value: unknown): value is GatewayVmDiskObservation;
export declare function vmDiskFreePercent(sample: GatewayVmDiskSample): number;
export declare const VM_HOME_CHECKPOINT_MAX_BYTES: number;
export declare const VM_HOME_CHECKPOINT_KEEP = 5;
export declare const VM_HOME_CHECKPOINT_NAME_RE: RegExp;
export declare const VM_HOME_CHECKPOINT_CONTENT_TYPE = "application/gzip";
export interface GatewayVmHomeCheckpoint {
    generation?: string;
    coverage?: "builder-home-v2";
    writerProtocol?: 2 | 3;
    name: string;
    size: number;
    sha256: string;
    instanceId: string | null;
    completedAt: number;
}
export interface GatewayVmHomeState {
    checkpointRequestedAt: number | null;
    checkpointAcknowledgedAt?: number | null;
    parkRequestedAt?: number;
    restoreCheckpoint?: GatewayVmHomeCheckpoint;
    lastCheckpoint: GatewayVmHomeCheckpoint | null;
}
export declare function homeCheckpointOutstanding(home: Partial<GatewayVmHomeState> | null | undefined): boolean;
export declare function isGatewayVmHomeCheckpoint(value: unknown): value is GatewayVmHomeCheckpoint;
export declare function isDisposableHomeCheckpoint(value: unknown): value is GatewayVmHomeCheckpoint & {
    generation: string;
    instanceId: string;
};
export declare function sameHomeCheckpoint(a: GatewayVmHomeCheckpoint, b: GatewayVmHomeCheckpoint): boolean;
export declare function vmHomeCheckpointName(at: number): string;
export declare function gatewayVmPodName(gatewayId: string, instanceId: string): string;
export declare const GATEWAY_VM_INSTANCE_PREFIX = "octogee-computer-";
export declare const GATEWAY_DESKTOP_NODE_CONTAINER = "desktop-node";
export declare const GATEWAY_DESKTOP_NODE_STATE_VOLUME = "desktop-node-state";
export declare const GATEWAY_DESKTOP_NODE_IDENTITY_VOLUME = "desktop-node-identity";
export declare const GATEWAY_DESKTOP_NODE_IDENTITY_DIR = "/run/octogee/desktop-node-identity";
export declare const GATEWAY_DESKTOP_NODE_IDENTITY_PATH = "/run/octogee/desktop-node-identity/identity.json";
export declare const GATEWAY_DESKTOP_NODE_NAME = "octogee-desktop";
export declare const GATEWAY_DESKTOP_RUNTIME_DIR = "/run/user/1000";
export declare function gatewayVmInstanceName(environment: string, ownerUid: string): string;
export interface GatewayModelBrokerLimits {
    spendWindowUsd?: number | null;
    spendWeekUsd?: number | null;
    requestsPerMinute?: number | null;
}
export interface GatewayServiceAccountSpec {
    create?: boolean;
    annotations?: Record<string, string>;
}
export declare const GATEWAY_CONTROL_IDENTITY_MODES: readonly ["shared-operator", "per-user"];
export type GatewayControlIdentity = (typeof GATEWAY_CONTROL_IDENTITY_MODES)[number];
export declare const DEFAULT_GATEWAY_CONTROL_IDENTITY: GatewayControlIdentity;
export declare function isGatewayControlIdentity(value: unknown): value is GatewayControlIdentity;
export declare function resolveGatewayControlIdentity(value: unknown): GatewayControlIdentity;
export interface IsolatedGatewayAccessSpec {
    controlUiEnabled?: boolean;
    controlIdentity?: GatewayControlIdentity;
    kubeApiServerEgressCidrs?: string[];
    reason?: string;
    verifiedAt?: number;
    verifiedBy?: string;
}
export declare const ISOLATED_GATEWAY_LOCKED_ACCESS: IsolatedGatewayAccessSpec;
export declare function defaultIsolatedGatewayAccess(ownerUid: string | null | undefined): IsolatedGatewayAccessSpec;
export declare function resolveIsolatedGatewayAccess(ownerUid: string | null | undefined, builderAccess: IsolatedGatewayAccessSpec | null | undefined): IsolatedGatewayAccessSpec;
export declare const ISOLATED_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export declare const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export declare const GATEWAY_ID_MAX_LENGTH = 32;
export declare const GATEWAY_ID_REQUIREMENT = "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";
export declare const ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT: GatewayServiceAccountSpec;
export declare function isValidGatewayId(id: unknown): id is string;
export declare const NEW_GATEWAY_ID_REQUIREMENT = "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit; the -blue/-green suffixes are reserved for roll roles";
export declare function isValidNewGatewayId(id: unknown): id is string;
export declare function deriveGatewayIdentity(gatewayId: string, explicitGateway?: unknown): string;
export declare function isolatedGatewayServiceAccountName(gatewayId: string): string;
export declare function isGatewayClassControlUiAccessEnabled(gatewayClass: GatewayClass | undefined, builderAccess: IsolatedGatewayAccessSpec | undefined): boolean;
export declare function resolveUserGatewayControlState(data: {
    gatewayClass?: unknown;
    profile?: unknown;
    imageProfile?: unknown;
    ownerUid?: unknown;
    builderAccess?: IsolatedGatewayAccessSpec;
} | undefined, uid: string): {
    gatewayProfile: GatewayProfile;
    controlUiEnabled: boolean;
};
export type OperationKind = "add-gateway" | "gateway-vm" | "migrate-user" | "retire-gateway" | "restart-gateway" | "recycle-gateway" | "scale-shared-member" | "rollout" | "deprovision-user" | "suspend-user" | "erase-user";
export type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "rolled-back";
export declare const OPERATION_ORIGINS: readonly ["automatic", "operator"];
export type OperationOrigin = (typeof OPERATION_ORIGINS)[number];
export declare function resolveOperationOrigin(value: unknown): OperationOrigin;
export declare const OPERATION_AUDIT_RECORD_TYPE: "audit";
export declare const OPERATION_AUDIT_SCHEMA_VERSION: 1;
export declare const OPERATION_AUDIT_LIFECYCLE_STAGES: readonly ["intent-recorded", "action-started", "action-completed", "action-partial", "action-failed"];
export type OperationAuditLifecycleStage = (typeof OPERATION_AUDIT_LIFECYCLE_STAGES)[number];
export type OperationAuditStatus = "recorded" | "in-progress" | "completed" | "failed";
export type OperationAuditOutcome = "completed" | "partial" | "failed";
export interface OperationAuditAliasPlan {
    alias: string;
    expectedTarget?: string | null;
    intendedTarget: string;
}
export type OperationAuditAliasOutcomeStatus = "applied" | "already-applied" | "skipped" | "failed";
export interface OperationAuditAliasOutcome {
    alias: string;
    status: OperationAuditAliasOutcomeStatus;
    observedTarget?: string | null;
    error?: string;
}
export interface OperationAuditReleaseRolloutLinkage {
    releaseId?: string;
    releaseTag?: string;
    rolloutOperationId?: string;
}
export interface OperationAuditTestProvenance {
    environment: "test";
    sourceCommit?: string;
    verifiedBy?: string;
    verifiedAt?: number;
}
export interface OperationAuditPartialOutcome {
    summary: string;
    details?: Record<string, unknown>;
}
export interface OperationAuditDocument {
    recordType: typeof OPERATION_AUDIT_RECORD_TYPE;
    schemaVersion: typeof OPERATION_AUDIT_SCHEMA_VERSION;
    status: OperationAuditStatus;
    lifecycleStage: OperationAuditLifecycleStage;
    idempotencyKey: string;
    mutationFingerprint: string;
    mutation: Record<string, unknown>;
    actor: string;
    forced: boolean;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    aliasPlan: OperationAuditAliasPlan[];
    aliasOutcomes?: OperationAuditAliasOutcome[];
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
    testProvenance?: OperationAuditTestProvenance;
    outcome?: OperationAuditOutcome;
    partialOutcome?: OperationAuditPartialOutcome;
    createdAt: number;
    actionClaimId?: string;
    actionStartedAt?: number;
    actionRecoveryCount?: number;
    completedAt: number | null;
    error?: string;
}
export interface OperationAuditRecord extends OperationAuditDocument {
    id: string;
}
export type GlmOperationRecord = Operation | OperationAuditRecord;
export declare function isOperationAuditRow(value: unknown): value is Record<string, unknown> & {
    recordType: typeof OPERATION_AUDIT_RECORD_TYPE;
};
export declare function isOperationAuditRecord(value: unknown): value is OperationAuditDocument;
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface MigrationProgressRecord {
    phase: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    at: number;
    elapsedMs?: number;
    migrationId: string;
    slug: string;
    source: string;
    attempt?: number;
}
export declare function isMigrationProgressRecord(value: unknown): value is MigrationProgressRecord;
export interface OperationStep {
    name: string;
    status: StepStatus;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    detail?: string;
}
export declare function readSchedulerMigrationIdentity(operationId: unknown, migrationId: unknown): {
    attempt: number;
    claimStartedAt: number;
} | null;
export interface UserActivationTargetRollbackProof {
    operationId: string;
    migrationId: string;
    uid: string;
    slug: string;
    sourceGatewayId: string;
    sourceEpoch: number;
    targetGatewayId: string;
    leaseId: string;
    generation: number;
    liveRelease: number;
    desiredRelease: number;
    latestRelease: number;
    retainedPodUid: string;
    discardedPodUid: string | null;
    rollOperationId: string;
    rollClaimStartedAt: number;
    completedAt: number;
}
export interface MigrationForwardRecovery {
    schemaVersion: 1;
    phase: "source-flushed";
    sourceEpoch: number;
    sourceSystemConfigCommit?: string;
    targetReleased?: true;
}
export interface SchedulerHandoffState {
    /** New user moves use best-effort schedule snapshots, not native handoff. */
    scheduleTransfer?: true;
    forwardRecovery?: MigrationForwardRecovery;
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    uid: string;
    slug: string;
    stageAfterCutover?: true;
    stagedAt?: number;
    sourceRecovery?: {
        migrationId: string;
        sourceEpoch: number;
        steps: OperationStep[];
        targetRollback?: UserActivationTargetRollbackProof;
    };
}
export interface SourceTransferAuthority {
    targetIdentity: string;
    targetGatewayId: string;
    targetName: string;
    targetIp: string;
    targetVm: boolean;
    operationId: string;
    claimStartedAt: number;
    migrationId: string;
    uid: string;
    slug: string;
    sourceGatewayId: string;
    assignmentEpoch: number;
    namespace: string;
    podName: string;
    podUid: string;
    image: string;
}
export interface SourceTransferExecution extends SourceTransferAuthority {
    executionId: string;
    status: 'reserved' | 'preparing' | 'prepared' | 'dispatched' | 'transferred' | 'failed' | 'unresolved';
    exitCode?: number;
    failureReason?: 'not-dispatched';
    targetCleanup?: 'pending' | 'complete';
}
export interface Operation {
    id: string;
    kind: OperationKind;
    status: OperationStatus;
    createdBy: string;
    origin?: OperationOrigin;
    createdAt: number;
    startedAt: number | null;
    queuedAt?: number;
    firstStartedAt?: number | null;
    lastResumedAt?: number;
    completedAt: number | null;
    input: Record<string, unknown>;
    steps: OperationStep[];
    error?: string;
    rolledBack?: boolean;
    lastProgressAt?: number;
    resumeCount?: number;
    waitingOn?: string | null;
    nextAttemptAt?: number | null;
    attempts?: number;
    attemptHistory?: OperationAttemptRecord[];
    output?: Record<string, unknown>;
    progress?: MigrationProgressRecord[];
    userMigrationV2?: UserMigrationV2State;
    sourceTransferExecution?: SourceTransferExecution;
    schedulerHandoff?: SchedulerHandoffState;
    schedulerHandoffReleased?: boolean;
    schedulerHandoffReleasedAt?: number;
    schedulerHandoffLost?: string;
    cutoverCommittedAt?: number;
}
export type UserMigrationV2Phase = "initialized" | "keysSynced" | "preSynced" | "sourceQuiesced" | "finalSynced" | "targetVerified" | "cutover" | "sourceRetired" | "complete" | "abortIntent" | "abortTargetUnmounted" | "aborted";
export interface UserMigrationV2GatewayRootFence {
    gatewayId: string;
    updatedAt: number;
    latestRelease: number;
    desiredRelease: number;
    liveRelease: number;
    gatewayClass: "isolated";
    ownerUid: string;
    builderSlug: string;
    configHash: string;
}
export interface UserMigrationV2State {
    phase: UserMigrationV2Phase;
    operationId: string;
    migrationId: string;
    uid: string;
    slug: string;
    sourceGatewayId: string;
    sourceRelease: number;
    sourceEpoch: number;
    sourceAssignmentMode: "assigned" | "unassigned-live";
    sourceRootFence: UserMigrationV2GatewayRootFence;
    targetGatewayId: string;
    targetRelease: number;
    targetRootFence: UserMigrationV2GatewayRootFence;
    sourceSystemConfigCommit?: string;
    cutoverAt?: number;
    schedulerStagedAt?: number;
    sourceRetiredAt?: number;
    completedAt?: number;
    abortFromPhase?: UserMigrationV2Phase;
    abortReason?: string;
    abortIntentAt?: number;
    abortedAt?: number;
}
export interface OperationAttemptRecord {
    attempt: number;
    startedAt: number;
    completedAt: number;
    error: string;
    classification: "transient" | "terminal";
    steps: OperationStep[];
}
export interface HelmInstanceValue {
    enabled: boolean;
    image: {
        repository: string;
        tag: string;
    };
    gatewayId: string;
    chartFingerprint?: string;
    deploymentIntentFingerprint?: string;
    serviceAccountName?: string;
    serviceAccount?: GatewayServiceAccountSpec;
    gatewayContainerSecurityContext?: Record<string, unknown>;
    builderAccess?: IsolatedGatewayAccessSpec;
    profile?: GatewayProfile;
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
    sizingTier?: SizingTier;
    replicas?: number;
}
export type HelmInstancesMap = Record<string, HelmInstanceValue>;
export declare const GLM_GATEWAYS_COLLECTION = "glmGateways";
export declare const GLM_OPERATIONS_COLLECTION = "glmOperations";
export declare const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION = "glmMigrationTransferTasks";
export declare function isGatewayClass(value: unknown): value is GatewayClass;
export declare function isGatewayProfile(value: unknown): value is GatewayProfile;
export declare function resolveGatewayClass(input: {
    gatewayClass?: GatewayClass;
    profile?: GatewayProfile;
    imageProfile?: GatewayImageProfile;
}): GatewayClass;
export declare function resolveGatewayImageProfile(input: {
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
    profile?: GatewayProfile;
}): GatewayImageProfile;
export interface GatewayVmBootRecoverySample {
    currentPointId: string | null;
    retainedPoints: number;
    ready: boolean;
    bundleVersion: string;
    freeBytes: number;
}
export declare function isGatewayVmBootRecoverySample(value: unknown): value is GatewayVmBootRecoverySample;
