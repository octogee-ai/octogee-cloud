import type { FleetBrokerProjectCheckoutScope, FleetBrokerUserSnapshot } from "./fleet-broker.js";
export type GatewayStatus = "booting" | "ready" | "draining" | "unreachable";
export interface GatewayLastError {
    slug: string;
    message: string;
    at: unknown;
}
export interface GatewayState {
    gatewayId: string;
    status: GatewayStatus;
    lastHeartbeatAt: unknown;
    version: string;
    openclawVersion: string;
    mountedCustomers: string[];
    lastError: GatewayLastError | null;
    internalUrl?: string;
    startedAt?: number;
}
export interface CustomerSnapshot {
    uid: string;
    slug: string;
    tier: string;
    gatewayId: string;
    repoUrl: string;
    agentIds: string[];
    customerMmUserId: string | null;
    channels: Array<{
        scope: "workspace" | "project";
        projectId?: string;
        kind: string;
        channelId: string;
    }>;
}
export declare const GATEWAY_HEARTBEAT_INTERVAL_MS = 15000;
export declare const GATEWAY_UNREACHABLE_AFTER_MS: number;
export declare const VERIFY_ACCOUNT_TIMEOUT_MS = 120000;
export declare const CONFIG_PATCH_DEADLINE_MS = 120000;
export declare const CONFIG_RELOAD_DEADLINE_MS = 120000;
export declare const IMPORT_ACTIVATION_PATCH_DEADLINE_MS: number;
export declare const ADD_USER_DEADLINE_MS = 300000;
export declare const USER_IMPORT_STARTUP_TIMEOUT_MS = 600000;
export declare const MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS = 300000;
export declare const MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS = 180000;
export declare const MIGRATION_TRANSFER_TIMEOUT_MS: number;
export declare const MIGRATION_IMPORT_FINISH_TIMEOUT_MS: number;
export declare const MIGRATION_QUIESCE_TIMEOUT_MS = 60000;
export declare const MIGRATION_TRANSFER_LEASE_MS: number;
export declare const MIGRATION_UNMOUNT_TIMEOUT_MS: number;
export declare const MIGRATION_VERIFY_TIMEOUT_MS: number;
export declare const MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS = "coach-attach-in-progress";
export declare const MIGRATING_IN_PIN_TTL_MS: number;
export declare const SIGNATURE_HEADER = "X-Fleet-Controller-Signature";
export interface FleetHealthResponse {
    status: string;
    podUid: string | null;
    startedAt: number;
    rsyncAttemptFencing: boolean;
}
export interface FleetStateRequestBody {
    requestId: string;
    gatewayId: string;
    privateProjectCoachSlug?: string;
}
export interface FleetStateResponse {
    privateProjectCoachWorkspace?: boolean;
    status: string;
    gatewayId: string;
    podUid: string | null;
    version: string;
    openclawVersion: string;
    startedAt: number;
    customers: string[];
    migratingIn: string[];
    configuredBuilder: ConfiguredUserReport | null;
    openclawProcess?: OpenClawProcessReport | null;
}
export declare const OPENCLAW_PROCESS_STATES: readonly ["held", "hydrated", "starting", "serving", "unavailable"];
export type OpenClawProcessState = typeof OPENCLAW_PROCESS_STATES[number];
export interface OpenClawProcessReport {
    state: OpenClawProcessState;
    migrationId: string | null;
}
export declare function parseOpenClawProcessReport(value: unknown): OpenClawProcessReport | null;
export interface ConfiguredUserReport {
    state: "claimed";
    generation: number | null;
}
export declare function parseConfiguredUserReport(value: unknown): ConfiguredUserReport | null;
export declare const FLEET_STATE_PATH = "/fleet-state";
export declare const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL: "openclaw-dashboard-bridge";
export declare const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION: 1;
export declare const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE: "dashboard_bridge.capability.json";
export declare const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS = 15000;
export interface OpenClawDashboardBridgeProtocol {
    protocol: typeof OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL;
    version: typeof OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION;
}
export interface OpenClawDashboardBridgeCapability extends OpenClawDashboardBridgeProtocol {
    revisionId: string;
    openclawVersion: string;
    openclawForkSha: string;
    instanceId: string;
    observedAt: string;
}
export interface GatewayConfigStatus {
    observedAt?: unknown;
    runtimeReady?: boolean;
    openclawVersion?: string;
    openclawForkSha?: string;
    dashboardControlState?: "ready" | "missing" | "stale" | "invalid";
    dashboardControlProtocol?: OpenClawDashboardBridgeProtocol;
    dashboardControlObservedAt?: string;
}
export declare const GATEWAYS_COLLECTION = "gateways";
export interface MigrationRequestBody {
    migrationId: string;
    slug: string;
}
export interface CompleteSurgeHandoffRequestBody {
    migrationId: string;
    targetPodUid: string;
}
export interface PushStateRequestBody extends MigrationRequestBody {
    targetGatewayId: string;
    targetUrl: string;
    targetImportSignature: string;
    includeActivationManifest?: boolean;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    mode?: "keys" | "pre" | "final";
}
export type MigrationTransferMode = "keys" | "pre" | "final";
export type MigrationLoadStrategy = "standard" | "expedited";
export type MigrationConfigTransferMode = "activation-manifest" | "configured-builder-system-config";
export declare const MIGRATION_RSYNC_PORT_DEFAULT = 30873;
export interface PrepareImportRequestBody extends MigrationRequestBody {
    mode: MigrationTransferMode;
}
export interface ExportPathsRequestBody extends MigrationRequestBody {
    mode: MigrationTransferMode;
}
export interface ExportPathsResponse {
    migrationId: string;
    slug: string;
    sources: Array<{
        cwd: string;
        path: string;
    }>;
}
export interface ActivationManifestExportRequestBody extends MigrationRequestBody {
}
export interface ActivationManifestExportResponse {
    migrationId: string;
    slug: string;
    manifest: Record<string, unknown> | null;
}
export interface ActivateImportRequestBody extends MigrationRequestBody {
}
export type RsyncMigrationRpcPhase = "prepare-rsync-import" | "push-rsync-state" | "finish-rsync-import" | "abort-rsync-import";
export interface PrepareRsyncImportRequestBody extends MigrationRequestBody {
    transferAttempt?: number;
    transferAttemptId?: string;
    rpcPhase: "prepare-rsync-import";
    mode: MigrationTransferMode;
    configTransferMode?: MigrationConfigTransferMode;
    transferUser: string;
    transferKey: string;
    sourcePodIp?: string;
}
export interface PrepareRsyncImportResponse {
    migrationId: string;
    slug: string;
    imported: boolean;
    host: string;
    port: number;
    module: string;
    certificatePem: string;
}
export interface PushRsyncStateRequestBody extends MigrationRequestBody {
    rpcPhase: "push-rsync-state";
    mode: MigrationTransferMode;
    configTransferMode?: MigrationConfigTransferMode;
    targetHost: string;
    targetPort: number;
    targetCertificatePem: string;
    transferUser: string;
    transferKey: string;
    includeActivationManifest?: boolean;
}
export interface FinishRsyncImportRequestBody extends MigrationRequestBody {
    preserveSource?: true;
    transferAttemptId?: string;
    rpcPhase: "finish-rsync-import";
    mode: MigrationTransferMode;
    configTransferMode?: MigrationConfigTransferMode;
    loadStrategy?: MigrationLoadStrategy;
}
export interface AbortRsyncImportRequestBody extends MigrationRequestBody {
    transferAttemptId?: string;
    rpcPhase: "abort-rsync-import";
    mode: MigrationTransferMode;
    configTransferMode?: MigrationConfigTransferMode;
}
export interface QuiesceRequestBody extends MigrationRequestBody {
    schedulerHandoff?: boolean;
    schedulerMigrationId?: string;
    retainNonportable?: boolean;
    stopMattermost?: boolean;
    timeoutMs?: number;
}
export interface QuiesceResponse {
    migrationId: string;
    slug: string;
    drained: boolean;
    runningCount: number;
}
export interface FlushGatewayRequestBody extends MigrationRequestBody {
    reason?: string;
    expectedSystemConfigCommit?: string;
}
export interface FlushGatewayResponse {
    migrationId: string;
    slug: string;
    ok: boolean;
    durationMs: number;
    systemConfigCommit?: string;
    steps: Array<{
        name: string;
        status: "done" | "failed" | "skipped";
        error?: string;
        durationMs: number;
    }>;
}
export interface ImportResponse {
    migrationId: string;
    slug: string;
    imported: boolean;
    alreadyMounted?: boolean;
    /** Set when the activation committed but a post-commit step could not be confirmed. */
    verificationPending?: string;
}
export interface AgentStoreUnmountCoverage {
    podUid: string;
    agentIds: string[];
}
export interface UnmountRequestBody extends MigrationRequestBody {
    agentStoreErasure?: AgentStoreUnmountCoverage;
}
export interface UnmountResponse {
    migrationId: string;
    slug: string;
    unmounted: boolean;
    agentStoreErasure?: AgentStoreUnmountCoverage;
}
export interface RestoreMigrationRequestBody extends MigrationRequestBody {
    uid: string;
    snapshot: FleetBrokerUserSnapshot;
}
export interface RestoreMigrationResponse {
    migrationId: string;
    slug: string;
    restored: boolean;
    steps: string[];
}
export interface VerifyMigrationRequestBody extends MigrationRequestBody {
    configTransferMode?: MigrationConfigTransferMode;
}
export type VerifyMigrationResponse = {
    migrationId: string;
    slug: string;
    ready: boolean;
    configTransferMode?: "activation-manifest";
    code?: typeof MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS;
    checks: {
        customerDir: boolean;
        coachWired: boolean;
        mountMarked: boolean;
    };
} | {
    migrationId: string;
    slug: string;
    ready: boolean;
    configTransferMode: "configured-builder-system-config";
    checks: {
        customerDir: boolean;
        configuredBuilderOverlay: boolean;
        mountMarked: boolean;
        workspaceGit: boolean;
        gitRemote: boolean;
    };
};
export declare const MIGRATION_ID_HEADER = "X-Migration-Id";
export declare const MIGRATION_SLUG_HEADER = "X-Migration-Slug";
export declare const MIGRATION_MODE_HEADER = "X-Migration-Mode";
export interface MigrationProgressRequestBody extends MigrationRequestBody {
    source: string;
    phase: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    elapsedMs?: number;
}
export type SchedulerMigrationPhase = "hold" | "export" | "stage" | "activate" | "resume" | "retire" | "abort";
export interface SchedulerMigrationRequest {
    resolveAgentScope?: true;
    operationId: string;
    phase: SchedulerMigrationPhase;
    agentIds?: string[];
    snapshot?: unknown;
    retainNonportable?: boolean;
}
export interface SchedulerMigrationResult {
    operationId: string;
    phase: SchedulerMigrationPhase;
    agentIds: string[];
    drained: boolean;
    snapshot?: unknown;
}
export interface SchedulerMigrationRequestBody extends MigrationRequestBody {
    resolveAgentScope?: true;
    phase: SchedulerMigrationPhase;
    agentIds?: string[];
    snapshot?: unknown;
    retainNonportable?: boolean;
}
export interface ScheduleRecord {
    sourceJobId: string;
    /** Absent on older snapshots; null means no scratch. */
    scratch?: string | null;
    agentId: string;
    job: Record<string, unknown>;
}
export interface ScheduleSkip {
    jobId: string;
    name: string;
    reason: string;
}
export interface ScheduleSnapshotRequestBody extends MigrationRequestBody {
    op: "snapshot";
}
export interface ScheduleRestoreRequestBody extends MigrationRequestBody {
    op: "restore";
    records: ScheduleRecord[];
}
export interface ScheduleRemoveRequestBody extends MigrationRequestBody {
    op: "remove";
    jobIds: string[];
}
export interface ScheduleCheckRequestBody extends MigrationRequestBody {
    op: "check";
    records: ScheduleRecord[];
}
export type ScheduleTransferRequestBody = ScheduleSnapshotRequestBody | ScheduleRestoreRequestBody | ScheduleRemoveRequestBody | ScheduleCheckRequestBody;
export interface ScheduleSnapshotResult {
    migrationId: string;
    slug: string;
    op: "snapshot";
    records: ScheduleRecord[];
    skipped: ScheduleSkip[];
}
export interface ScheduleRemoveResult {
    migrationId: string;
    slug: string;
    op: "remove";
    removed: number;
    failed: Array<{
        jobId: string;
        error: string;
    }>;
}
export interface ScheduleRestoreResult {
    migrationId: string;
    slug: string;
    op: "restore";
    created: number;
    existing: number;
    failed: Array<{
        name: string;
        agentId: string;
        sourceJobId: string;
        error: string;
        retryable: boolean;
    }>;
}
export interface ScheduleNameConflict {
    name: string;
    agentId: string;
    sourceJobId: string;
    /** The live job of the same name; null when the conflict is with another record of the same request. */
    jobId: string | null;
}
export interface ScheduleCheckResult {
    migrationId: string;
    slug: string;
    op: "check";
    conflicts: ScheduleNameConflict[];
}
export declare const SCHEDULE_TRANSFERS_SUBCOLLECTION = "scheduleTransfers";
export interface ScheduleTransferDoc {
    migrationId: string;
    slug: string;
    sourceGatewayId: string;
    targetGatewayId: string;
    records: ScheduleRecord[];
    skipped: ScheduleSkip[];
    snapshotAt: number;
    restoreAttemptedTo?: string;
    restoreAttemptedAt?: number;
    restoredTo?: string;
    restoredAt?: number;
    restoreFailures?: ScheduleRestoreFailureRecord[];
}
export interface ScheduleRestoreFailureRecord {
    name: string;
    agentId?: string;
    sourceJobId?: string;
    error: string;
}
