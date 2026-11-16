

import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "./fleet-broker.js";

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

export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;

export const GATEWAY_UNREACHABLE_AFTER_MS = 3 * 60_000;

export const VERIFY_ACCOUNT_TIMEOUT_MS = 120_000;

export const CONFIG_PATCH_DEADLINE_MS = 120_000;

// A committed config patch makes OpenClaw reload: it re-registers the whole plugin
// surface and restarts channels before it answers a socket again, and every RPC opens
// a fresh one. A call that follows a patch is therefore budgeted in reload terms, not
// in request terms.
export const CONFIG_RELOAD_DEADLINE_MS = 120_000;

export const IMPORT_ACTIVATION_PATCH_DEADLINE_MS =
  CONFIG_PATCH_DEADLINE_MS + 2 * CONFIG_RELOAD_DEADLINE_MS;

export const ADD_USER_DEADLINE_MS = 300_000;
export const USER_IMPORT_STARTUP_TIMEOUT_MS = 600_000;
export const MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS = 300_000;
export const MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS = 180_000;
export const MIGRATION_TRANSFER_TIMEOUT_MS = ADD_USER_DEADLINE_MS + 30_000;
export const MIGRATION_IMPORT_FINISH_TIMEOUT_MS = Math.max(
  USER_IMPORT_STARTUP_TIMEOUT_MS,
  3 * MIGRATION_TRANSFER_TIMEOUT_MS + 2 * MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS + MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS,
) + ADD_USER_DEADLINE_MS + IMPORT_ACTIVATION_PATCH_DEADLINE_MS +
  CONFIG_RELOAD_DEADLINE_MS + VERIFY_ACCOUNT_TIMEOUT_MS + 30_000;

export const MIGRATION_QUIESCE_TIMEOUT_MS = 60_000;
export const MIGRATION_TRANSFER_LEASE_MS =
  3 * MIGRATION_TRANSFER_TIMEOUT_MS + MIGRATION_IMPORT_FINISH_TIMEOUT_MS + 120_000;
export const MIGRATION_UNMOUNT_TIMEOUT_MS = 2 * CONFIG_PATCH_DEADLINE_MS + 30_000;
export const MIGRATION_VERIFY_TIMEOUT_MS = VERIFY_ACCOUNT_TIMEOUT_MS + 30_000;
export const MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS = "coach-attach-in-progress";

// Window the import-handler's migrating-in pin guards a freshly-imported user from the
// reconcile evict direction. Must outlast import→cutover so a slow import never false-evicts;
// also bounds how long a failed-migration orphan lingers before lazy eviction. See
// local-default-agent-wired.ts (the pin) and fleet-provisioner getEvictObservedSlugs (the skip).
export const MIGRATING_IN_PIN_TTL_MS =
  MIGRATION_IMPORT_FINISH_TIMEOUT_MS +
  IMPORT_ACTIVATION_PATCH_DEADLINE_MS +
  MIGRATION_VERIFY_TIMEOUT_MS +
  60_000;

export const SIGNATURE_HEADER = "X-Fleet-Controller-Signature";

// Unauthenticated probe body. Reachable by the kubelet (which cannot sign) and by
// every pod the fleet ingress policy admits on the controller port, so it carries
// no tenant identity: no roster, no gatewayId, no image versions. podUid is the
// pod's own K8s UID — what a sibling needs to tell itself apart from a live
// revision of the same gateway (see surge-reconcile-gate observeReadySibling).
export interface FleetHealthResponse {
  status: string;
  podUid: string | null;
  startedAt: number;
  rsyncAttemptFencing: boolean;
}

// Tenant-bearing fleet state. Signed with the fleet controller key, which only
// the fleet controller holds — gateway pods carry the public half, so a user with terminal access in
// their own pod cannot mint one. gatewayId is signed into the body so a captured
// signature cannot be replayed against a different pod.
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

export const OPENCLAW_PROCESS_STATES = ["held", "hydrated", "starting", "serving", "unavailable"] as const;

export type OpenClawProcessState = typeof OPENCLAW_PROCESS_STATES[number];

const OPENCLAW_PROCESS_MIGRATION_ID = /^(?:mig|surge)-[A-Za-z0-9_-]{1,200}$/;

export interface OpenClawProcessReport {
  state: OpenClawProcessState;
  migrationId: string | null;
}

export function parseOpenClawProcessReport(value: unknown): OpenClawProcessReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as { state?: unknown; migrationId?: unknown };
  if (!hasOnlyFields(report, ["state", "migrationId"])) return null;
  if (!OPENCLAW_PROCESS_STATES.includes(report.state as OpenClawProcessState)) return null;
  const migrationId = report.migrationId;
  if (migrationId !== null && (typeof migrationId !== "string" || !OPENCLAW_PROCESS_MIGRATION_ID.test(migrationId))) return null;
  return { state: report.state as OpenClawProcessState, migrationId };
}

export interface ConfiguredUserReport {
  state: "claimed";
  generation: number | null;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasOnlyFields(value: object, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

export function parseConfiguredUserReport(value: unknown): ConfiguredUserReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as { state?: unknown; generation?: unknown };
  if (report.state !== "claimed" || !hasOnlyFields(report, ["state", "generation"])) return null;
  const generation = report.generation;
  return generation === null || isGeneration(generation) ? { state: "claimed", generation } : null;
}

export const FLEET_STATE_PATH = "/fleet-state";

export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL = "openclaw-dashboard-bridge" as const;
export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE =
  "dashboard_bridge.capability.json" as const;
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS = 15_000;

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

export const GATEWAYS_COLLECTION = "gateways";

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
export type MigrationConfigTransferMode =
  | "activation-manifest"
  | "configured-builder-system-config";

export const MIGRATION_RSYNC_PORT_DEFAULT = 30873;

export interface PrepareImportRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
}

export interface ExportPathsRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
}

export interface ExportPathsResponse {
  migrationId: string;
  slug: string;
  sources: Array<{ cwd: string; path: string }>;
}

export interface ActivationManifestExportRequestBody extends MigrationRequestBody {}

export interface ActivationManifestExportResponse {
  migrationId: string;
  slug: string;
  manifest: Record<string, unknown> | null;
}

export interface ActivateImportRequestBody extends MigrationRequestBody {}

export type RsyncMigrationRpcPhase =
  | "prepare-rsync-import"
  | "push-rsync-state"
  | "finish-rsync-import"
  | "abort-rsync-import";

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

export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";
export const MIGRATION_MODE_HEADER = "X-Migration-Mode";

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

// One user agent's cron job as OpenClaw `cron.add` accepts it, captured
// from the source gateway so the target can recreate it. `job` holds only
// cron.add fields and stays Firestore-safe JSON (no undefined values).
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

export type ScheduleTransferRequestBody =
  | ScheduleSnapshotRequestBody
  | ScheduleRestoreRequestBody
  | ScheduleRemoveRequestBody
  | ScheduleCheckRequestBody;

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
  failed: Array<{ jobId: string; error: string }>;
}

export interface ScheduleRestoreResult {
  migrationId: string;
  slug: string;
  op: "restore";
  created: number;
  existing: number;
  failed: Array<{ name: string; agentId: string; sourceJobId: string; error: string; retryable: boolean }>;
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

// users/{uid}/scheduleTransfers/{migrationId}
export const SCHEDULE_TRANSFERS_SUBCOLLECTION = "scheduleTransfers";

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
