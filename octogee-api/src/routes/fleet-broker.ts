import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { isBlobObjectVersion } from "@octogee/shared/types/fleet-broker";
import { gcsBlobStore, runtimeBlobStore } from "../lib/runtime-blob-store.js";
import type { WorkspaceProject } from "@octogee/core/platform-state";
import { isolatedBootMode } from "@octogee/core/isolated-prelaunch";
import type { ProvisioningProjection } from "@octogee/core/provisionSteps";
import { sharedAgentAnchorMigrationScope, sharedAssignedSourceSurgeAnchorScope } from "../lib/shared-agent-anchor-migration.js";
import { installWorkspaceBlobBrokerRoute, type WorkspaceBlobStore } from "./fleet-broker-workspace-blob.js";
import { readUserRestoreAuthoritySnapshot } from "@octogee/core/fleet-state";
import {
  FenceMismatchError,
  MalformedRecordError,
  MissingRecordError,
  type AgentStoreRecord,
  type PlatformUserRecord,
  type FleetRegistryRecord,
  type GatewayAssignment,
  type GatewayRoot,
  type MattermostTokenSecret,
  type PlatformStateRepositories,
  type PlatformStateStore,
  type Stored,
} from "@octogee/core/platform-state";
import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import { configuredUserPreparationAllowed } from "../lib/user-preparation.js";
import { completeProjectAgentReadiness } from "../lib/project-agent-readiness-delivery.js";
import { parseProjectAgentReadinessReports } from "../lib/project-agent-readiness.js";
import { streamAssignmentChanges } from "./fleet-assignment-watch.js";
import { readVmRuntimeObservation, recordVmDiskObservation, recordVmBootRecovery, recordVmImageObservation, recordVmHomeCheckpoint, persistVmPreemptionNotice } from "../lib/vm-runtime-observation.js";
import { readVmEgress, recordVmEgress } from "../lib/vm-egress-state.js";
import { isIP } from "node:net";
import {
  VM_HOME_CHECKPOINT_CONTENT_TYPE,
  VM_HOME_CHECKPOINT_KEEP,
  gatewayVmPodName,
  VM_HOME_CHECKPOINT_MAX_BYTES,
  vmHomeCheckpointName,
  isGatewayVmDiskSample,
  isGatewayVmBootRecoverySample,
  isGatewayVmImageSample,
  isGatewayEgressMode,
  isDisposableHomeCheckpoint,
  sameHomeCheckpoint,
  resolveGatewayRuntime,
  homeCheckpointOutstanding,
  type GatewayVmHomeCheckpoint,
  type GatewayVmEgressState,
  type GatewayVmHomeState,
  type GatewayVmRuntimeRequest,
  type GatewayVmRuntimeResponse,
} from "@octogee/shared/types/glm";
import {
  VmHomeCheckpointError,
  vmHomeCheckpointPath,
  vmHomeCheckpointsPrefix,
  vmHomeCurrentPath,
  createGcsVmHomeStore,
  validVmHomeCheckpointName,
  validSha256,
  type VmHomeStore,
} from "../lib/vm-home-checkpoint.js";
import { Router, type Request, type Response } from "express";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { storage } from "../../../gateway-edge/src/lib/db.js";
import { parseAgentLook, type AgentLook } from "@octogee/shared/types/agent-look";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
import { DEFAULT_AGENT_LOOK, characterSvg } from "@octogee/shared/types/agent-characters";
import {
  isValidProjectId,
  isValidUsername,
  parseAgentId,
  projectAgentId,
} from "@octogee/shared/types/identity";
import { MANIFEST_OBJECT_SUFFIX } from "@octogee/core/workspace-manifest";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { projectAgentConfigured, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import {
  createCachedUserAgentDefaultResolver,
  createCachedHouseModelResolver,
  type UserAgentDefaultResolver,
  type HouseModelResolver,
} from "../lib/platform-model-config.js";
import type {
  FleetBrokerAgentAnchor,
  FleetBrokerAuxiliaryAnchor,
  FleetBrokerAgentAnchorMigration,
  FleetBrokerAgentAnchors,
  FleetBrokerGatewayStateAnchor,
  BuilderRuntimeStateRecoveryTier,
  FleetBrokerBlobSignedUrl,
  FleetBrokerIsolatedRuntimeStatePruneResult,
  FleetBrokerVmHomeCheckpointCommit,
  FleetBrokerVmHomeCheckpointUrl,
  FleetBrokerVmHomeDownload,
  FleetBrokerVmHomePruneResult,
  FleetBrokerVmEgress,
  FleetBrokerIsolatedRuntimeStateSnapshotUrls,
  FleetBrokerAssignmentRosterEntry,
  FleetBrokerChannelBinding,
  FleetBrokerConfiguredUserBootstrap,
  FleetBrokerConfiguredUserDesk,
  FleetBrokerConfiguredUserProjectCredential,
  FleetBrokerUserRuntimeReset,
  FleetBrokerMattermostUpdate,
  FleetBrokerNpmRegistryCredentials,
  FleetBrokerPreStopFlushEvent,
  FleetBrokerPreStopFlushStep,
  FleetBrokerProjectCheckoutScope,
  FleetBrokerProjectAgent,
  FleetBrokerProjectRestore,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import { BUILDER_RUNTIME_STATE_RECOVERY_TIERS } from "@octogee/shared/types/fleet-broker";
import type { UserIdentity } from "@octogee/shared/types/builder-identity";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { isDeveloperToolchainStatus } from "@octogee/shared/types/developer-toolchain";
import {
  byotSnapshotProjectionFromSystemConfig,
  collectStoredProjectAgentStates,
} from "@octogee/core/user-snapshot-mapping";
import {
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "@octogee/shared/types/fleet-controller";
import {
  projectGatewayDesiredRootForGateway,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";
import {
  configuredUserCredentialBootstrapAllowed,
  projectGatewayMutableConfigForGateway,
  podBelongsToGateway,
  type GatewayMutableConfig,
} from "@octogee/core/gateway-live-release";
import { createCachedOwnerModelBrokerGrantResolver } from "../lib/model-broker-limits.js";
import { operatorRailRegistry, type ModelBrokerRailRegistry } from "../lib/model-broker-rails.js";
import type { FundedBudgetInterruptionHandler } from "../lib/model-broker-budget.js";
import { NO_BROKER_RECORDS, type BrokerRecords } from "../lib/broker-records.js";
import { createWebResearchService, type WebResearchExtractInput, type WebResearchSearchInput } from "../lib/web-research-service.js";
import { WebResearchError } from "../lib/web-research-error.js";
import { createBraveSearchClient, createTavilyClient } from "../lib/web-provider-clients.js";
import { isPublicIp } from "../lib/link-unfurl.js";
import { recordRevisionSystemConfigStatus } from "../lib/revision-system-config-status.js";
import { hasRunningUserMigration } from "../lib/running-user-migration.js";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";
import { createOpenClawBootSentinelStore, OPENCLAW_BUILD_PATTERN } from "../lib/openclaw-boot-sentinel.js";
import {
  createOwnerWorkspaceTurnVerifier,
  type OwnerTurnStore,
  type OwnerWorkspaceTurnVerifier,
} from "../lib/openclaw-owner-turn.js";
import {
  reconcileDefaultAgentProjectMembership,
  type ProjectAgentMembershipInput,
  type ProjectAgentMembershipResult,
} from "../lib/project-agent-membership.js";
import {
  InMemoryNpmCacheCapabilityStore,
  NPM_CACHE_CAPABILITY_AUDIENCE,
  NpmCacheCapabilityIssueError,
  npmCacheProxyRegistryUrl,
  type NpmCacheCapabilityStore,
} from "../lib/npm-cache-capabilities.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const RECONCILE_ERROR_REPORT_WINDOW_MS = 60_000;

type ReadBlobMetadata = (gcsPath: string) => Promise<{ generation?: unknown; size?: unknown; md5Hash?: unknown; storage?: "s3" }>;

type CreateBlobSignedUrl = (input: {
  gcsPath: string;
  action: "read" | "write";
  contentType?: string;
  ifGenerationMatch?: number | string;
  generation?: string;
  contentMd5?: string;
  contentLength?: number;
}) => Promise<FleetBrokerBlobSignedUrl>;

type PruneIsolatedRuntimeState = (input: {
  canonicalPath: string;
  runtimeStatePrefix: string;
  allocationGeneration: number;
  now: number;
  confirmAllocationCurrent: () => Promise<void>;
}) => Promise<number>;

type RenderAvatar = (bytes: Buffer) => Promise<Buffer>;

function validIdentityEmoji(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 32;
}

// Chat broker: the gateway skill is a thin client; PAT resolution + MM reads run
// HERE so no chat PAT ever reaches the injection-reachable agent runtime. The
// identity's PAT is the capability boundary (workspace agent → user PAT,
// project agent → its bot's project-scoped PAT).
interface ChatBrokerIdentity {
  pat: string;
  defaultAgentMmUserId: string;
  /** Agent bot's own credential — used only for the `unread` read cursor. */
  unread: { pat: string; mmUserId: string };
  slug: string;
  siteUrl: string;
  canReadChannel?: (channelId: string) => Promise<boolean>;
  includeArchivedProjectHistory?: true;
}

type ExecuteChatSearch = (
  identity: ChatBrokerIdentity,
  params: {
    query: string;
    scope?: "current_channel" | "all_visible";
    limit?: number;
    currentChannelId?: string;
  },
) => Promise<Record<string, unknown>>;

type ExecuteChatHistory = (
  identity: ChatBrokerIdentity,
  params: {
    channel?: string;
    direction?: string;
    cursor?: string;
    limit?: number;
    fromUsername?: string;
    currentChannelId?: string;
  },
) => Promise<Record<string, unknown>>;

type ResolveChatIdentity = (
  deps: { records: BrokerRecords; store: PlatformStateStore },
  input: { uid: string; slug: string; agentId: string },
) => Promise<{
  lane: "workspace" | "project";
  pat: string;
  defaultAgentMmUserId: string;
  unread: { pat: string; mmUserId: string };
  canReadChannel?: (channelId: string) => Promise<boolean>;
  includeArchivedProjectHistory?: true;
}>;

export interface ProvisionedUserReport {
  uid: string;
  slug: string | null;
  mattermostUserId: string | null;
  first: boolean;
}

interface FleetBrokerRouteDeps {
  workspaceBlobStore?: WorkspaceBlobStore;
  reconcileDefaultAgentProjectMembership?: (input: ProjectAgentMembershipInput) => Promise<ProjectAgentMembershipResult>;
  provisionMattermost?: (input: {
    uid: string;
    userData: Record<string, unknown>;
  }) => Promise<FleetBrokerMattermostUpdate>;
  markProvisioningComplete?: (input: {
    uid: string;
    userData: Record<string, unknown>;
    mmUpdate: FleetBrokerMattermostUpdate;
  }) => Promise<void>;
  provisioningProjection?: ProvisioningProjection;
  onUserProvisioned?: (report: ProvisionedUserReport) => Promise<void>;
  renderAvatar?: RenderAvatar;
  createBlobSignedUrl?: CreateBlobSignedUrl;
  createVmHomeSignedUrl?: CreateBlobSignedUrl;
  createIsolatedRuntimeStateSignedUrl?: CreateBlobSignedUrl;
  readBlobMetadata?: ReadBlobMetadata;
  pruneIsolatedRuntimeState?: PruneIsolatedRuntimeState;
  vmHomeStore?: VmHomeStore;
  executeChatSearch?: ExecuteChatSearch;
  executeChatHistory?: ExecuteChatHistory;
  resolveChatIdentity?: ResolveChatIdentity;
  verifyOwnerWorkspaceTurn?: OwnerWorkspaceTurnVerifier;
  webResearch?: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  modelBrokerRails?: ModelBrokerRailRegistry;
  onBudgetInterruption?: FundedBudgetInterruptionHandler;
  npmCacheCapabilities?: NpmCacheCapabilityStore;
  npmCacheRegistryUrl?: string;
  reportNpmCacheCapabilityFailure?: (input: {
    gatewayId: string;
    reason: "capacity-exhausted" | "rate-limited" | "unexpected-error";
  }) => void;
  now?: () => number;
}

const BLOB_SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;
const ISOLATED_RUNTIME_STATE_MAX_SIZE = 64 * 1024 * 1024;
const ISOLATED_RUNTIME_STATE_CONTENT_TYPE = "application/gzip";
const ISOLATED_RUNTIME_STATE_MINUTE_RETENTION_MS = 10 * 60_000;
const ISOLATED_RUNTIME_STATE_HOUR_RETENTION_MS = 24 * 60 * 60_000;
const ISOLATED_RUNTIME_STATE_DAY_RETENTION_MS = 30 * 24 * 60 * 60_000;

function defaultProvisionMattermost(
  projection: ProvisioningProjection | undefined,
): NonNullable<FleetBrokerRouteDeps["provisionMattermost"]> {
  return async (input) => {
    const { buildProvisioningContext, provisionMattermost, noProvisioningProjection } = await import(
      "@octogee/core/provisionSteps"
    );
    const { mattermostChannelHostFromEnv } = await import("@octogee/core/channel-host");
    return provisionMattermost(
      buildProvisioningContext(input.uid, input.userData),
      mattermostChannelHostFromEnv(),
      projection ?? noProvisioningProjection,
    );
  };
}

function defaultMarkProvisioningComplete(
  projection: ProvisioningProjection | undefined,
): NonNullable<FleetBrokerRouteDeps["markProvisioningComplete"]> {
  return async (input) => {
    const { buildProvisioningContext, markProvisioningComplete, noProvisioningProjection } = await import(
      "@octogee/core/provisionSteps"
    );
    const ctx = buildProvisioningContext(input.uid, input.userData);
    await markProvisioningComplete(ctx, input.mmUpdate, [`octogee-${ctx.slug}-coach`], projection ?? noProvisioningProjection);
  };
}

const defaultRenderAvatar: RenderAvatar = async (bytes) => {
  const { renderAvatarPng } = await import("../lib/avatar-render.js");
  return renderAvatarPng(bytes);
};

async function applyDefaultAgentLook(
  input: { uid: string; slug: string },
  deps: { renderAvatar: RenderAvatar; records: BrokerRecords },
): Promise<void> {
  try {
    const avatarPng = await deps.renderAvatar(Buffer.from(characterSvg(DEFAULT_AGENT_LOOK), "utf8"));
    await deps.records.agentIdentity.sync(input.uid, { avatarPng, look: DEFAULT_AGENT_LOOK }, { slug: input.slug });
  } catch (error) {
    logger.error("[fleet-broker] default agent look was not applied", { uid: input.uid, error });
  }
}

const defaultExecuteChatSearch: ExecuteChatSearch = async (identity, params) => {
  const { executeChatSearch } = await import(
    "../../../gateway-edge/src/lib/chat-broker/execute.js"
  );
  return executeChatSearch(identity, params);
};

const defaultExecuteChatHistory: ExecuteChatHistory = async (identity, params) => {
  const { executeChatHistory } = await import(
    "../../../gateway-edge/src/lib/chat-broker/execute.js"
  );
  return executeChatHistory(identity, params);
};

const defaultResolveChatIdentity: ResolveChatIdentity = async (deps, input) => {
  const { resolveChatIdentity } = await import(
    "../../../gateway-edge/src/lib/chat-broker/resolve-pat.js"
  );
  return resolveChatIdentity({ readAccount: deps.records.userDocuments.account, store: deps.store }, input);
};

function positiveConfigNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function createDefaultWebResearch(
  records: BrokerRecords,
  store: PlatformStateStore,
  rails: ModelBrokerRailRegistry,
  onBudgetInterruption?: FleetBrokerRouteDeps["onBudgetInterruption"],
) {
  const braveKey = process.env.BRAVE_API_KEY?.trim();
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const brave = braveKey ? createBraveSearchClient({ apiKey: braveKey }) : null;
  const tavily = tavilyKey ? createTavilyClient({ apiKey: tavilyKey }) : null;
  return createWebResearchService({
    usageStore: records.usage,
    resolveGrant: createCachedOwnerModelBrokerGrantResolver({
      rails,
      state: store,
      accounts: records.accounts,
      log: (message, fields) => logger.info(message, fields),
    }),
    rails,
    braveSearch: brave?.search,
    tavilySearch: tavily?.search,
    tavilyExtract: tavily?.extract,
    braveCostPerRequestUsd: positiveConfigNumber(
      process.env.BRAVE_SEARCH_COST_PER_REQUEST_USD,
      0.005,
      "BRAVE_SEARCH_COST_PER_REQUEST_USD",
    ),
    tavilyCostPerCreditUsd: positiveConfigNumber(
      process.env.TAVILY_COST_PER_CREDIT_USD,
      0.008,
      "TAVILY_COST_PER_CREDIT_USD",
    ),
    onError: (error) => logger.error("web research usage recording failed", { error }),
    onBudgetInterruption,
  });
}

const defaultReadBlobMetadata: ReadBlobMetadata = (key) => runtimeBlobStore().metadata(key);

const defaultCreateBlobSignedUrl: CreateBlobSignedUrl = (input) =>
  runtimeBlobStore().signedUrl(input, Date.now() + BLOB_SIGNED_URL_TTL_MS);

const createGcsBackupSignedUrl: CreateBlobSignedUrl = (input) =>
  gcsBlobStore.signedUrl(input, Date.now() + BLOB_SIGNED_URL_TTL_MS);

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = typeof req.body?.gatewayId === "string" ? req.body.gatewayId : "";
  if (claimed && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function readPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringAt(obj: Record<string, unknown> | undefined, dotted: string): string {
  const value = readPath(obj, dotted);
  return typeof value === "string" ? value : "";
}

function objectBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

const SYSTEM_CONFIG_STATES = new Set(["clean", "dirty", "syncing", "error", "unavailable"]);
const SYSTEM_CONFIG_ENUMS: Record<string, ReadonlySet<string>> = {
  doctorResult: new Set(["ok", "error"]),
  bootRecovery: new Set(["none", "recovered", "unavailable"]),
  watcherState: new Set(["running", "stopped"]),
};
const DASHBOARD_CONTROL_STATES = new Set(["ready", "missing", "stale", "invalid"]);

function isDashboardControlProtocol(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const protocol = value as Record<string, unknown>;
  return protocol.protocol === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL &&
    protocol.version === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION;
}

function isBoundedTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function copyOptionalFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
  keys: string[],
  isValid: (value: unknown) => boolean,
  nullable = false,
): boolean {
  for (const key of keys) {
    const field = input[key];
    if (field === undefined) continue;
    if (field === null && nullable) {
      out[key] = null;
      continue;
    }
    if (!isValid(field)) return false;
    out[key] = field;
  }
  return true;
}

function copyEnumFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
): boolean {
  for (const [key, allowed] of Object.entries(SYSTEM_CONFIG_ENUMS)) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !allowed.has(field)) return false;
    out[key] = field;
  }
  return true;
}

function copySystemConfigStatusFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
): boolean {
  return copyOptionalFields(input, out, ["acceptedCommit", "restoredCommit"],
    (field) => typeof field === "string" && /^[0-9a-f]{7,64}$/.test(field)) &&
    copyOptionalFields(input, out, ["configHash"],
      (field) => typeof field === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(field)) &&
    copyOptionalFields(input, out,
      ["dirtySince", "lastSyncedAt", "lastErrorAt", "runtimeHealthCheckedAt", "updatedAt"],
      isBoundedTimestamp, true) &&
    copyOptionalFields(input, out, ["lastErrorCode"],
      (field) => typeof field === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(field), true) &&
    copyEnumFields(input, out) &&
    copyOptionalFields(input, out, ["runtimeReady"], (field) => typeof field === "boolean") &&
    copyOptionalFields(input, out, ["runtimeHealth"],
      (field) => field === "repair" || field === "healthy" || field === "unhealthy") &&
    copyOptionalFields(input, out, ["schemaVersion", "rejectedCount", "recoveryCount"],
      (field) => typeof field === "number" && Number.isSafeInteger(field) && field >= 0) &&
    copyOptionalFields(input, out, ["openclawVersion"],
      (field) => typeof field === "string" && /^[A-Za-z0-9._+-]{1,80}$/.test(field)) &&
    copyOptionalFields(input, out, ["openclawForkSha"],
      (field) => typeof field === "string" &&
        (field === "unknown" || /^[0-9a-f]{7,64}$/.test(field)));
}

function parseDashboardControlStatus(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const state = input.dashboardControlState;
  const protocolValue = input.dashboardControlProtocol;
  const observedAt = input.dashboardControlObservedAt;
  if (state === undefined) {
    if (protocolValue === undefined && observedAt === undefined) return {};
    return null;
  }
  if (typeof state !== "string" || !DASHBOARD_CONTROL_STATES.has(state)) return null;
  if (state !== "ready") {
    if (protocolValue === undefined && observedAt === undefined) {
      return { dashboardControlState: state };
    }
    return null;
  }
  if (
    !isDashboardControlProtocol(protocolValue) ||
    !isBoundedTimestamp(observedAt)
  ) return null;
  return {
    dashboardControlState: state,
    dashboardControlProtocol: {
      protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
      version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
    },
    dashboardControlObservedAt: observedAt,
  };
}

export function parseSystemConfigObservedStatus(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.state !== "string" || !SYSTEM_CONFIG_STATES.has(input.state)) return null;
  const out: Record<string, unknown> = { state: input.state };
  if (!copySystemConfigStatusFields(input, out)) return null;
  const dashboardControl = parseDashboardControlStatus(input);
  if (!dashboardControl) return null;
  Object.assign(out, dashboardControl);
  return out;
}

function recordBodyValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validPreStopFlushEvent(
  value: Record<string, unknown>,
): FleetBrokerPreStopFlushEvent | null {
  const phase = value.phase;
  if (phase !== "started" && phase !== "completed") return null;
  if (value.reason !== "prestop") return null;
  const gatewayClass = typeof value.gatewayClass === "string" ? value.gatewayClass : "";
  if (!gatewayClass) return null;
  const resultValue = recordBodyValue(value.result);
  if (phase === "started") {
    return { gatewayClass, phase, reason: "prestop" };
  }
  if (!resultValue) return null;
  const ok = resultValue.ok;
  const durationMs = resultValue.durationMs;
  const steps = resultValue.steps;
  if (typeof ok !== "boolean" || typeof durationMs !== "number" || !Array.isArray(steps)) {
    return null;
  }
  const validSteps = steps
    .filter((step): step is Record<string, unknown> => recordBodyValue(step) !== null)
    .map((step): FleetBrokerPreStopFlushStep => {
      const status: FleetBrokerPreStopFlushStep["status"] =
        step.status === "done" || step.status === "failed" || step.status === "skipped"
          ? step.status
          : "failed";
      return {
        name: typeof step.name === "string" ? step.name : "unknown",
        status,
        ...(typeof step.error === "string" ? { error: step.error.slice(0, 1000) } : {}),
        durationMs: typeof step.durationMs === "number" ? step.durationMs : 0,
      };
    });
  return {
    gatewayClass,
    phase,
    reason: "prestop",
    result: {
      ok,
      durationMs,
      steps: validSteps,
    },
  };
}

function isDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): data is GatewayDoc & GatewayMutableConfig {
  return (
    projectGatewayDesiredRootForGateway(data, gatewayId) !== null
  );
}

function isProvisioningStatus(value: unknown): value is Exclude<FleetBrokerProvisioningStatus, ""> {
  return value === "provisioning" || value === "complete";
}

function validAgentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length === value.length ? ids : null;
}

function validAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 160) return "";
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : "";
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const USAGE_NUMBER_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "costUsd",
] as const;
const USAGE_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function finiteNonNegativeFields<T extends string>(
  data: Record<string, unknown>,
  fields: readonly T[],
): Record<T, number> | null {
  const out = {} as Record<T, number>;
  for (const field of fields) {
    const value = finiteNonNegative(data[field]);
    if (value === null) return null;
    out[field] = value;
  }
  return out;
}

function validUsageModel(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return model.length > 0 && model.length <= 200 ? model : "";
}

export function validFleetBrokerUsageData(value: unknown): FleetBrokerUsageData | null {
  const data = recordBodyValue(value);
  if (!data) return null;
  const usageNumbers = finiteNonNegativeFields(data, USAGE_NUMBER_FIELDS);
  const costBreakdown = finiteNonNegativeFields(
    recordBodyValue(data.costBreakdown) ?? {},
    USAGE_COST_FIELDS,
  );
  const model = validUsageModel(data.model);
  if (!usageNumbers || !costBreakdown || !model) return null;
  return {
    ...usageNumbers,
    model,
    costBreakdown,
  };
}

function validBlobRelativePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const p = value.trim();
  if (p.length === 0 || p.length > 1024) return "";
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return "";
  const parts = p.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part.startsWith("."))) {
    return "";
  }
  if (parts[0] === "runtime-state") return "";
  return p;
}

function validGenerationPrecondition(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:\d{1,20}|"[a-f0-9]{32}(?:-\d+)?")$/u.test(value)) return null;
  return value;
}

function validContentType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const p = value.trim();
  if (p.length === 0 || p.length > 200 || /[\r\n]/.test(p)) {
    return "application/octet-stream";
  }
  return p;
}

function validBuilderRuntimeStateRecoveryTiers(
  value: unknown,
): BuilderRuntimeStateRecoveryTier[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > BUILDER_RUNTIME_STATE_RECOVERY_TIERS.length) {
    return null;
  }
  if (!value.every((tier) => typeof tier === "string" && BUILDER_RUNTIME_STATE_RECOVERY_TIERS.includes(
    tier as BuilderRuntimeStateRecoveryTier,
  ))) return null;
  const tiers = value as BuilderRuntimeStateRecoveryTier[];
  if (!tiers.includes("minute") || new Set(tiers).size !== tiers.length) return null;
  return tiers;
}

function gcsPathForBlob(slug: string, relativePath: string): string {
  return `customers/${slug}/${relativePath}`;
}

function gcsPathForWorkspaceManifest(slug: string): string {
  return `customers/${slug}/${MANIFEST_OBJECT_SUFFIX}`;
}

function gcsPathForIsolatedRuntimeStateRoot(slug: string): string {
  return `customers/${slug}/runtime-state`;
}

function gcsPathForIsolatedRuntimeState(scope: IsolatedRuntimeStateScope): string {
  return `${gcsPathForIsolatedRuntimeStateRoot(scope.slug)}/allocations/${scope.gatewayId}-g${scope.generation}/checkpoint.tar.gz`;
}

const ALLOCATION_RUNTIME_STATE_PATH = /^allocations\/[^/]+-g([1-9]\d*)\/checkpoint\.tar\.gz$/u;

function allocationRuntimeStateGeneration(runtimeStatePrefix: string, gcsPath: string): number | null {
  if (!gcsPath.startsWith(`${runtimeStatePrefix}/`)) return null;
  const match = ALLOCATION_RUNTIME_STATE_PATH.exec(gcsPath.slice(runtimeStatePrefix.length + 1));
  const generation = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(generation) ? generation : null;
}

export class IsolatedRuntimeStateAllocationSupersededError extends Error {
  constructor(readonly scope: IsolatedRuntimeStateScope) {
    super(`runtime-state allocation ${scope.gatewayId}-g${scope.generation} is no longer current`);
    this.name = "IsolatedRuntimeStateAllocationSupersededError";
  }
}

function padUtcPart(value: number): string {
  return String(value).padStart(2, "0");
}

function runtimeStateSnapshotDate(now: number): Date {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("runtime-state snapshot time is invalid");
  return date;
}

function runtimeStateRecoveryTimestampValue(
  tier: BuilderRuntimeStateRecoveryTier,
  day: string,
  hour: string,
  minute: string,
): string {
  if (tier === "minute") return `${day}T${hour}${minute}Z`;
  if (tier === "hour") return `${day}T${hour}Z`;
  return day;
}

function runtimeStateRecoveryObjectPath(
  slug: string,
  tier: BuilderRuntimeStateRecoveryTier,
  now: number,
): string {
  const date = runtimeStateSnapshotDate(now);
  const day = `${date.getUTCFullYear()}${padUtcPart(date.getUTCMonth() + 1)}${padUtcPart(date.getUTCDate())}`;
  const timestamp = runtimeStateRecoveryTimestampValue(
    tier,
    day,
    padUtcPart(date.getUTCHours()),
    padUtcPart(date.getUTCMinutes()),
  );
  return `${gcsPathForIsolatedRuntimeStateRoot(slug)}/recovery/${tier}/${timestamp}.tar.gz`;
}

function runtimeStateRecoveryTimestampMatch(
  tier: BuilderRuntimeStateRecoveryTier,
  value: string,
): RegExpExecArray | null {
  if (tier === "minute") return /^(\d{8})T(\d{2})(\d{2})Z$/u.exec(value);
  if (tier === "hour") return /^(\d{8})T(\d{2})Z$/u.exec(value);
  return /^(\d{8})$/u.exec(value);
}

function runtimeStateRecoveryTimestamp(
  runtimeStatePrefix: string,
  gcsPath: string,
): { tier: BuilderRuntimeStateRecoveryTier; timestamp: number } | null {
  const relative = gcsPath.startsWith(`${runtimeStatePrefix}/`)
    ? gcsPath.slice(runtimeStatePrefix.length + 1)
    : "";
  const match = /^recovery\/(minute|hour|day)\/(.+)\.tar\.gz$/u.exec(relative);
  if (!match) return null;
  const tier = match[1] as BuilderRuntimeStateRecoveryTier;
  const timestampValue = match[2] ?? "";
  const timestampMatch = runtimeStateRecoveryTimestampMatch(tier, timestampValue);
  if (!timestampMatch) return null;
  const day = timestampMatch[1] ?? "";
  const hour = timestampMatch[2];
  const minute = timestampMatch[3];
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  const parsedHour = hour === undefined ? 0 : Number(hour);
  const parsedMinute = minute === undefined ? 0 : Number(minute);
  const timestamp = Date.UTC(year, month - 1, date, parsedHour, parsedMinute);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== date ||
    parsed.getUTCHours() !== parsedHour ||
    parsed.getUTCMinutes() !== parsedMinute
  ) return null;
  return { tier, timestamp };
}

function runtimeStateRetentionMs(tier: BuilderRuntimeStateRecoveryTier): number {
  if (tier === "minute") return ISOLATED_RUNTIME_STATE_MINUTE_RETENTION_MS;
  if (tier === "hour") return ISOLATED_RUNTIME_STATE_HOUR_RETENTION_MS;
  return ISOLATED_RUNTIME_STATE_DAY_RETENTION_MS;
}

export interface IsolatedRuntimeStateStoredGeneration {
  gcsPath: string;
  generation: string;
  timeCreated: string | null;
}

function expiredCanonicalRuntimeStateGeneration(input: {
  generation: IsolatedRuntimeStateStoredGeneration;
  liveCanonicalGeneration: string | null;
  cutoff: number;
}): boolean {
  if (
    input.liveCanonicalGeneration === null ||
    input.generation.generation === input.liveCanonicalGeneration
  ) return false;
  const created = input.generation.timeCreated === null
    ? Number.NaN
    : Date.parse(input.generation.timeCreated);
  if (!Number.isFinite(created)) {
    throw new Error("runtime-state noncurrent canonical generation lacks a valid creation time");
  }
  if (created > input.cutoff) return false;
  if (!input.generation.generation) {
    throw new Error("runtime-state canonical generation is missing its generation identifier");
  }
  return true;
}

function expiredRecoveryRuntimeStateGeneration(input: {
  generation: IsolatedRuntimeStateStoredGeneration;
  runtimeStatePrefix: string;
  now: number;
}): boolean {
  const recovery = runtimeStateRecoveryTimestamp(
    input.runtimeStatePrefix,
    input.generation.gcsPath,
  );
  if (!recovery || recovery.timestamp > input.now - runtimeStateRetentionMs(recovery.tier)) {
    return false;
  }
  if (!input.generation.generation) {
    throw new Error("runtime-state recovery generation is missing its generation identifier");
  }
  return true;
}

export function isolatedRuntimeStatePruneCandidates(input: {
  canonicalPath: string;
  runtimeStatePrefix: string;
  allocationGeneration: number;
  liveCanonicalGeneration: string | null;
  now: number;
  generations: readonly IsolatedRuntimeStateStoredGeneration[];
}): IsolatedRuntimeStateStoredGeneration[] {
  if (!Number.isFinite(input.now)) throw new Error("runtime-state prune time is invalid");
  const candidates: IsolatedRuntimeStateStoredGeneration[] = [];
  for (const generation of input.generations) {
    if (generation.gcsPath === input.canonicalPath) {
      if (expiredCanonicalRuntimeStateGeneration({
        generation,
        liveCanonicalGeneration: input.liveCanonicalGeneration,
        cutoff: input.now - ISOLATED_RUNTIME_STATE_MINUTE_RETENTION_MS,
      })) candidates.push(generation);
      continue;
    }
    const allocationGeneration = allocationRuntimeStateGeneration(input.runtimeStatePrefix, generation.gcsPath);
    if (allocationGeneration !== null) {
      if (allocationGeneration >= input.allocationGeneration) continue;
      if (!generation.generation) {
        throw new Error("runtime-state earlier allocation object is missing its generation identifier");
      }
      candidates.push(generation);
      continue;
    }
    if (expiredRecoveryRuntimeStateGeneration({
      generation,
      runtimeStatePrefix: input.runtimeStatePrefix,
      now: input.now,
    })) candidates.push(generation);
  }
  return candidates;
}

const defaultPruneIsolatedRuntimeState: PruneIsolatedRuntimeState = async (input) => {
  const bucket = storage.bucket();
  const [liveMetadata] = await bucket.file(input.canonicalPath).getMetadata();
  const liveGenerationValue = liveMetadata.generation;
  if (typeof liveGenerationValue !== "string" && typeof liveGenerationValue !== "number") {
    throw new Error("runtime-state live canonical object lacks a generation identifier");
  }
  const liveCanonicalGeneration = String(liveGenerationValue);
  const [files] = await bucket.getFiles({
    prefix: `${input.runtimeStatePrefix}/`,
    versions: true,
  });
  const candidates = isolatedRuntimeStatePruneCandidates({
    ...input,
    liveCanonicalGeneration,
    generations: files.map((file) => {
      const generationValue = file.generation ?? file.metadata.generation;
      return {
        gcsPath: file.name,
        generation: typeof generationValue === "string" || typeof generationValue === "number"
          ? String(generationValue)
          : "",
        timeCreated: typeof file.metadata.timeCreated === "string" ? file.metadata.timeCreated : null,
      };
    }),
  });
  await input.confirmAllocationCurrent();
  await Promise.all(candidates.map(async (candidate) => {
    await bucket.file(candidate.gcsPath, { generation: candidate.generation }).delete({
      ifGenerationMatch: candidate.generation,
    });
  }));
  return candidates.length;
};

export async function findAssignedUserByAgentId(
  store: PlatformStateRepositories,
  gatewayId: string,
  agentId: string,
): Promise<Stored<PlatformUserRecord> | null> {
  const userRecords = await store.users.records.listByGateway(gatewayId);
  return userRecords.find((userRecord) => userCarriesAgentId(userRecord, agentId)) ?? null;
}

const AGENT_ID_CANDIDATE_LIMIT = 10;

export async function findAssignedOrInboundMigratingUserByAgentId(
  store: PlatformStateRepositories,
  gatewayId: string,
  agentId: string,
): Promise<Stored<PlatformUserRecord> | null> {
  const assigned = await findAssignedUserByAgentId(store, gatewayId, agentId);
  if (assigned) return assigned;

  for (const candidate of await store.users.records.listByAgentId(agentId, AGENT_ID_CANDIDATE_LIMIT)) {
    if (await hasRunningUserMigration(store, candidate.uid, gatewayId, "inbound")) return candidate;
  }
  return null;
}

export async function findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
  store: PlatformStateRepositories,
  gatewayId: string,
  podName: string | undefined,
  agentId: string,
): Promise<Stored<PlatformUserRecord> | null> {
  const admitted = await findAssignedOrInboundMigratingUserByAgentId(store, gatewayId, agentId);
  if (admitted) return admitted;

  const [gateway, candidates] = await Promise.all([
    store.gateways.roots.get(gatewayId),
    store.users.records.listByAgentId(agentId, AGENT_ID_CANDIDATE_LIMIT),
  ]);
  return candidates.find((candidate) =>
    candidate.slug !== null &&
    configuredUserCredentialBootstrapAllowed(gateway ?? undefined, {
      gatewayId,
      podName,
      slug: candidate.slug,
      uid: candidate.uid,
    })) ?? null;
}

export async function configuredUserSlugCredentialBootstrapAllowed(
  store: PlatformStateRepositories,
  gatewayId: string,
  podName: string | undefined,
  slug: string,
): Promise<boolean> {
  const gateway = await store.gateways.roots.get(gatewayId);
  const root = projectGatewayDesiredRootForGateway(gateway ?? undefined, gatewayId);
  if (!root) return false;
  const uid = root.ownerUid;
  if (typeof uid !== "string" || !configuredUserCredentialBootstrapAllowed(gateway ?? undefined, {
      gatewayId,
      podName,
      slug,
      uid,
    })) return false;
  const userRecord = await store.users.records.get(uid);
  if (userRecord?.slug !== slug) return false;
  const assignedGatewayId = userRecord.gateway?.gatewayId;
  if (assignedGatewayId === gatewayId) return true;
  if (await hasRunningUserMigration(store, uid, gatewayId, "inbound")) return true;
  return assignedGatewayId === undefined && userRecord.openclaw.status !== "complete" &&
    root.liveRelease === null && root.latestRelease === 1;
}

function userCarriesAgentId(userRecord: PlatformUserRecord, agentId: string): boolean {
  return userRecord.openclaw.agentId === agentId || userRecord.agents.agentIds.includes(agentId);
}

function builderSlug(userRecord: PlatformUserRecord): string {
  if (!userRecord.slug) {
    throw new Error(`[load:${userRecord.uid}] cannot derive slug — neither provisioning.openclaw.slug nor users/{uid}.username is set`);
  }
  return userRecord.slug;
}

async function readUserAccountDocument(records: BrokerRecords, uid: string): Promise<Record<string, unknown>> {
  const data = await records.userDocuments.account(uid);
  if (!data) throw new Error(`users/${uid} account document is missing for an assigned user`);
  return data;
}


export async function requireAssignedUser(
  store: PlatformStateStore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; uid: string; userRecord: Stored<PlatformUserRecord> } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
  if (!uid) {
    res.status(400).json({ error: "uid_required" });
    return null;
  }
  const userRecord = await assignedUser(store, bound.gatewayId, uid);
  if (!userRecord) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid, userRecord };
}

async function requireAssignedSlug(
  store: PlatformStateStore,
  req: Request,
  res: Response,
  preparingProjectRead = false,
): Promise<{ bound: GatewayBinding; uid: string; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  const assignedUid = await findAssignedUidBySlug(store, bound.gatewayId, slug);
  const uid = assignedUid ?? (preparingProjectRead ? (await configuredUserNpmSubject(store, bound, slug, "preparation"))?.uid : null);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid, slug };
}

async function requireAssignedAgentWorkspace(
  deps: Pick<ResolvedFleetBrokerRouteDeps, "store">,
  req: Request,
  res: Response,
): Promise<{
  bound: GatewayBinding;
  agentId: string;
  uid: string;
  slug: string;
  userRecord: Stored<PlatformUserRecord>;
} | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const body = objectBody(req);
  const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_workspace_slug" });
    return null;
  }
  const agentId = validAgentId(body.agentId);
  if (!agentId) {
    res.status(400).json({ error: "invalid_agent_id" });
    return null;
  }
  const uid = await findAssignedUidBySlug(deps.store, bound.gatewayId, slug);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const userRecord = await assignedUser(deps.store, bound.gatewayId, uid);
  if (!userRecord || !userCarriesAgentId(userRecord, agentId)) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, agentId, uid, slug, userRecord };
}

export async function runBrokered(
  res: Response,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function collectChannelBindings(
  store: PlatformStateRepositories,
  slug: string,
): Promise<{
  bindings: FleetBrokerChannelBinding[];
  projectMemberships: Array<{ projectId: string; channelIds: string[] }>;
}> {
  const [workspaceChannels, projects] = await Promise.all([
    store.workspaces.channels.list({ workspaceSlug: slug, projectSlug: null }),
    store.workspaces.projects.list(slug),
  ]);

  const bindings: FleetBrokerChannelBinding[] = [];
  const projectMemberships: Array<{ projectId: string; channelIds: string[] }> = [];
  for (const channel of workspaceChannels) {
    if (channel.mattermostChannelId) bindings.push({ scope: "workspace", kind: channel.kind ?? "general", channelId: channel.mattermostChannelId });
  }
  for (const project of projects) {
    const channels = await store.workspaces.channels.list({ workspaceSlug: slug, projectSlug: project.projectSlug });
    const channelIds: string[] = [];
    for (const channel of channels) {
      if (!channel.mattermostChannelId) continue;
      bindings.push({ scope: "project", projectId: project.projectSlug, kind: channel.kind ?? "default", channelId: channel.mattermostChannelId });
      channelIds.push(channel.mattermostChannelId);
    }
    if (channelIds.length > 0) projectMemberships.push({ projectId: project.projectSlug, channelIds });
  }
  return { bindings, projectMemberships };
}

async function collectProjects(
  deps: Pick<ResolvedFleetBrokerRouteDeps, "records" | "store">,
  slug: string,
): Promise<FleetBrokerProjectRestore[]> {
  const [projects, recipes] = await Promise.all([
    deps.store.workspaces.projects.list(slug),
    deps.records.userDocuments.projectRecipes(slug),
  ]);
  return projects.map((project) => {
    const out: FleetBrokerProjectRestore = {
      projectSlug: project.projectSlug,
      giteaRepoName: project.giteaRepoName,
    };
    if (project.provisioningState !== null) {
      out.provisioningState = project.provisioningState;
    }
    if (project.checkoutEnabled === false) {
      out.checkoutEnabled = false;
    }
    const recipe = recipes.get(project.projectSlug);
    if (recipe !== undefined) {
      out.recipe = recipe;
    }
    const repoSource = projectRepoSourceFromDoc(project.repoSource ?? undefined);
    if (repoSource) {
      out.repoSource = repoSource;
    }
    return out;
  });
}

export function projectCheckoutScopeForGatewayRoot(
  gatewayData: unknown,
  gatewayId: string,
  uid: string,
  slug: string,
): FleetBrokerProjectCheckoutScope {
  const root = projectGatewayDesiredRootForGateway(gatewayData, gatewayId);
  if (!root) {
    return "workspace-only";
  }
  if (root.gatewayClass === "shared") return "workspace-and-projects";
  if (root.ownerUid !== uid || root.builderSlug !== slug) return "workspace-only";
  if (
    (root.gatewayClass === "isolated" || root.gatewayClass === "operator") &&
    root.allocation?.kind === "disposable-builder" &&
    root.allocation.claimedByUid === uid
  ) {
    return "workspace-and-projects";
  }
  return "workspace-only";
}

async function assignedUser(
  store: PlatformStateRepositories,
  gatewayId: string,
  uid: string,
): Promise<Stored<PlatformUserRecord> | null> {
  const userRecord = await store.users.records.get(uid);
  return userRecord?.gateway?.gatewayId === gatewayId ? userRecord : null;
}

// Defense-in-depth against pod identity spoofing: the KSA binds the BARE
// gateway; the pod self-reports its instance id, which under the simple-roll
// model must be the bare gateway id (legacy pods report nothing).
export function isRequestedRevisionAllowed(
  gatewayId: string,
  revisionId: string,
): boolean {
  if (!revisionId) return true; // legacy pod: no filtering
  return revisionId === gatewayId;
}

export async function resolveAssignedUsersRevisionGate(
  store: PlatformStateRepositories,
  gatewayId: string,
  podRevisionId: string,
  options: { requireDurableRoot?: boolean } = {},
): Promise<{ allowed: false } | { allowed: true }> {
  const gateway = await store.gateways.roots.get(gatewayId);
  if (
    (options.requireDurableRoot && (!gateway || !podRevisionId)) ||
    (gateway && !isDurableGatewayRoot(gateway, gatewayId))
  ) {
    return { allowed: false };
  }
  if (!isRequestedRevisionAllowed(gatewayId, podRevisionId)) return { allowed: false };
  return { allowed: true };
}

function respondInvalidRevision(res: Response, gatewayId: string, revisionId: string): void {
  res.status(400).json({ error: "invalid_revision", gatewayId, revisionId });
}

async function readAssignmentRosterForGateway(
  store: PlatformStateRepositories,
  gatewayId: string,
): Promise<FleetBrokerAssignmentRosterEntry[] | null> {
  try {
    const assignments = await store.gateways.assignments.list(gatewayId);
    return assignments.map(({ uid, state, epoch }) => ({ uid, state, epoch }));
  } catch (error) {
    if (error instanceof MalformedRecordError) return null;
    throw error;
  }
}

function configuredUserNpmOwnerUid(input: {
  gatewayData: GatewayRoot | undefined;
  bound: GatewayBinding;
  slug: string;
}): string | null {
  const gateway = projectGatewayDesiredRootForGateway(
    input.gatewayData,
    input.bound.gatewayId,
  );
  const ownerUid = gateway?.ownerUid;
  if (typeof ownerUid !== "string") return null;
  if (!configuredUserCredentialBootstrapAllowed(input.gatewayData, {
    gatewayId: input.bound.gatewayId,
    podName: input.bound.podName,
    slug: input.slug,
    uid: ownerUid,
  })) return null;
  return ownerUid;
}

function assignedUserNpmUid(assignments: readonly GatewayAssignment[], slug: string): string | null {
  const matches = assignments.filter((assignment) => assignment.slug === slug);
  return matches.length === 1 ? matches[0]!.uid : null;
}

async function configuredUserNpmSubject(
  store: PlatformStateRepositories,
  bound: GatewayBinding,
  slug: string,
  mode: "assignment-or-preparation" | "preparation" = "assignment-or-preparation",
): Promise<{ uid: string } | null> {
  if (!bound.podUid) return null;
  const [gateway, assignments] = await Promise.all([
    store.gateways.roots.get(bound.gatewayId),
    store.gateways.assignments.list(bound.gatewayId),
  ]);
  const ownerUid = configuredUserNpmOwnerUid({ gatewayData: gateway ?? undefined, bound, slug });
  if (!ownerUid) return null;
  const assignedUid = assignedUserNpmUid(assignments, slug);
  if (assignedUid === ownerUid && mode === "assignment-or-preparation") return { uid: ownerUid };
  if (assignments.length > 0 && assignedUid !== ownerUid) return null;
  return await configuredUserPreparationAllowed(store, bound, slug, ownerUid) ? { uid: ownerUid } : null;
}

function installNpmCacheCapabilityRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  router.post("/npm-registry-credentials", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
    if (!isValidUsername(slug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    const subject = await configuredUserNpmSubject(deps.store, bound, slug);
    if (!subject || !bound.podUid) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    try {
      const credentials: FleetBrokerNpmRegistryCredentials = deps.npmCacheCapabilities.issue({
        subject: {
          gatewayId: bound.gatewayId,
          uid: subject.uid,
          slug,
          podUid: bound.podUid,
        },
        registryUrl: deps.npmCacheRegistryUrl,
        nowMs: deps.now(),
      });
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      res.json(credentials);
    } catch (error) {
      const reason = error instanceof NpmCacheCapabilityIssueError
        ? error.reasonCode
        : "unexpected-error";
      deps.reportNpmCacheCapabilityFailure({ gatewayId: bound.gatewayId, reason });
      res.status(reason === "rate-limited" ? 429 : 503).json({
        error: reason === "rate-limited"
          ? "npm_registry_capability_rate_limited"
          : "npm_registry_unavailable",
      });
    }
  });

  router.post("/npm-cache-authorize", brokerRequestLimit(6000), (req, res) => {
    const bound = req.boundTenant;
    if (bound?.kind !== "platform" || bound.actor !== "npm-cache-proxy") {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const authorization = deps.npmCacheCapabilities.authorize({
      token,
      nowMs: deps.now(),
    });
    if (!authorization || authorization.audience !== NPM_CACHE_CAPABILITY_AUDIENCE) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({ authorization });
  });
}

function snapshotProvisioningStatus(userRecord: PlatformUserRecord): FleetBrokerProvisioningStatus {
  const status = userRecord.openclaw.status;
  return status === "provisioning" || status === "complete" ? status : "";
}

type StoredRuntimeReset = FleetBrokerUserRuntimeReset | (
  Omit<FleetBrokerUserRuntimeReset, "status"> & {
    status: "acknowledged";
    acknowledgedAt: unknown;
  }
);

function storedRuntimeReset(
  userRecord: PlatformUserRecord,
): StoredRuntimeReset | undefined {
  const raw: unknown = userRecord.fences.runtimeReset;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid user runtime reset marker");
  }
  const marker = raw as Record<string, unknown>;
  const stringFields = [
    "uid",
    "slug",
    "operationId",
    "sourceGatewayId",
    "targetGatewayId",
    "disposableLeaseId",
  ] as const;
  const validStrings = stringFields.every(
    (field) => typeof marker[field] === "string" && marker[field].length > 0,
  );
  const validIntegers = ["generation", "disposableLeaseGeneration", "requestedAt"].every(
    (field) => Number.isSafeInteger(marker[field]) && (marker[field] as number) >= 0,
  );
  const validStatus = marker.status === "pending" ||
    (marker.status === "acknowledged" && marker.acknowledgedAt !== undefined);
  if (!validStatus || !validStrings || !validIntegers || !isValidUsername(marker.slug)) {
    throw new Error("invalid user runtime reset marker");
  }
  return marker as unknown as StoredRuntimeReset;
}

function snapshotRuntimeReset(
  userRecord: PlatformUserRecord,
): FleetBrokerUserRuntimeReset | undefined {
  const marker = storedRuntimeReset(userRecord);
  return marker?.status === "pending" ? marker : undefined;
}

async function admittedRuntimeReset(
  store: PlatformStateRepositories,
  userRecord: PlatformUserRecord,
): Promise<FleetBrokerUserRuntimeReset | undefined> {
  const marker = snapshotRuntimeReset(userRecord);
  if (!marker) return undefined;
  const assignment = await store.gateways.assignments.get(marker.targetGatewayId, userRecord.uid);
  const exact = [
    marker.uid === userRecord.uid,
    marker.slug === userRecord.slug,
    marker.targetGatewayId === userRecord.gateway?.gatewayId,
    assignment?.gatewayId === marker.targetGatewayId,
    assignment?.epoch === marker.generation,
    assignment?.source === "repair",
    assignment?.updatedByOperationId === marker.operationId,
  ].every(Boolean);
  if (!exact) throw new Error("user runtime reset assignment fence changed");
  return marker;
}

export function snapshotGreetingPosted(greeting: unknown): boolean {
  const receipt = greeting as { ok?: unknown; jobId?: unknown } | null | undefined;
  return receipt?.ok === true && typeof receipt.jobId === "string" && receipt.jobId.trim().length > 0;
}

export function snapshotBaseFields(
  userRecord: PlatformUserRecord,
  account: Record<string, unknown>,
  slug: string,
): Omit<
  FleetBrokerUserSnapshot,
  "uid" | "slug" | "channels" | "projectCheckoutScope" | "projects" | "coachToken" | "coachMmUserId" | "coachIdentity"
> {
  const mattermostUserId = userRecord.mattermostUserId || null;
  const entitlements = userEntitlements();
  const planInputs = entitlements.pickInputs(account);
  return {
    ...entitlements.previousImageFields("user-snapshot", { ...account, persona: userRecord.persona }),
    contextTemplateKey: entitlements.seedContextTemplateKey(planInputs),
    planInputs,
    gatewayId: userRecord.gateway?.gatewayId ?? "",
    status: snapshotProvisioningStatus(userRecord),
    agentIds: [...userRecord.agents.agentIds],
    repoUrl: userRecord.provisioning.gitRepoUrl ?? "",
    mattermostUserId,
    customerMmUserId: mattermostUserId,
    ownerName: stringAt(account, "displayName") || stringAt(account, "username") || slug,
    email: stringAt(account, "email"),
    displayName: stringAt(account, "displayName"),
    lastName: stringAt(account, "lastName"),
    timeZone: storedTimeZone(account),
    photoURL: stringAt(account, "photoURL"),
    persona: userRecord.persona,
    byotActive: account.byotActive === true,
  };
}

async function defaultAgentMattermostSecret(store: PlatformStateRepositories, uid: string): Promise<MattermostTokenSecret | null> {
  const secret = await store.secrets.get(uid, "coachMattermost");
  return secret?.kind === "coach-mattermost" ? secret : null;
}

function snapshotDefaultAgentFields(
  defaultAgent: MattermostTokenSecret | null,
): Pick<FleetBrokerUserSnapshot, "coachToken" | "coachMmUserId"> {
  return {
    coachToken: defaultAgent?.personalToken ?? null,
    coachMmUserId: defaultAgent?.mattermostUserId ?? null,
  };
}

function snapshotDefaultAgentIdentity(
  agentData: Record<string, unknown> | undefined,
): Pick<FleetBrokerUserSnapshot, "coachIdentity"> | Record<string, never> {
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  return name || emoji ? { coachIdentity: { name, emoji } } : {};
}

interface SnapshotModelDials {
  freeTierModelRef: string;
  userAgentDefault: FleetBrokerUserSnapshot["builderAgentDefault"];
}

interface LoadSnapshotOptions {
  modelDials: SnapshotModelDials;
  gatewayId: string;
  gatewayData: GatewayRoot | undefined;
}

async function loadSnapshot(
  deps: Pick<ResolvedFleetBrokerRouteDeps, "records" | "store">,
  userRecord: Stored<PlatformUserRecord>,
  account: Record<string, unknown>,
  options: LoadSnapshotOptions,
): Promise<(FleetBrokerUserSnapshot & { greetingPosted: boolean }) | null> {
  const { records, store } = deps;
  const { modelDials } = options;
  const { uid, slug } = userRecord;
  if (!slug || !isValidUsername(slug)) return null;
  const projectCheckoutScope = projectCheckoutScopeForGatewayRoot(options.gatewayData, options.gatewayId, uid, slug);
  const [collectedChannels, projects, projectAgents, defaultAgent, agentData, systemConfig, runtimeReset, restoreAuthority] = await Promise.all([
    collectChannelBindings(store, slug),
    projectCheckoutScope === "workspace-and-projects"
      ? collectProjects(deps, slug)
      : Promise.resolve([]),
    collectStoredProjectAgentStates(store, uid, slug),
    defaultAgentMattermostSecret(store, uid),
    records.userDocuments.agent(uid),
    records.userDocuments.systemConfig(uid),
    admittedRuntimeReset(store, userRecord),
    readUserRestoreAuthoritySnapshot({ store }, { uid, slug, gatewayId: options.gatewayId }),
  ]);
  const credentialProjection = byotSnapshotProjectionFromSystemConfig(systemConfig);
  const baseFields = snapshotBaseFields(userRecord, account, slug);
  const channels = collectedChannels.bindings;
  const migration = readWorkspaceMigrationMarker({ migration: userRecord.fences.migration });
  const sourcePreparing = migration?.state === "preparing" && Boolean(migration.operationId)
    && (migration.phase === "preparing" || migration.phase === "waiting");
  return {
    uid,
    slug,
    ...baseFields,
    greetingPosted: snapshotGreetingPosted(userRecord.openclaw.greeting),
    runtimeMutationFenced: isolatedRuntimeMutationFenced(userRecord)
      || (userRecord.fences.migration !== undefined && !sourcePreparing),
    ...(runtimeReset ? { runtimeReset } : {}),
    ...(restoreAuthority ? { restoreAuthority } : {}),
    byotActive: credentialProjection.byotActive ?? baseFields.byotActive,
    freeTierModelRef: modelDials.freeTierModelRef,
    builderAgentDefault: modelDials.userAgentDefault,
    channels,
    projectCheckoutScope,
    projects,
    ...(projectAgents.length > 0 ? { projectAgents } : {}),
    ...snapshotDefaultAgentFields(defaultAgent),
    ...snapshotDefaultAgentIdentity(agentData),
    ...(credentialProjection.systemConfig ? { systemConfig: credentialProjection.systemConfig } : {}),
  };
}

async function findAssignedUidBySlug(
  store: PlatformStateRepositories,
  gatewayId: string,
  slug: string,
): Promise<string | null> {
  const userRecords = await store.users.records.listByGateway(gatewayId);
  return userRecords.find((userRecord) => userRecord.slug === slug)?.uid ?? null;
}

async function findUidBySlug(
  store: PlatformStateRepositories,
  gatewayId: string,
  podName: string | undefined,
  slug: string,
): Promise<string | null> {
  const assignedUid = await findAssignedUidBySlug(store, gatewayId, slug);
  if (assignedUid) return assignedUid;

  const gateway = (await store.gateways.roots.get(gatewayId)) ?? undefined;
  const uid = projectGatewayMutableConfigForGateway(gateway, gatewayId)?.ownerUid ?? null;
  if (
    typeof uid !== "string" ||
    !configuredUserCredentialBootstrapAllowed(gateway, {
      gatewayId,
      podName,
      slug,
      uid,
    })
  ) return null;

  const userRecord = await store.users.records.get(uid);
  return userRecord?.slug === slug ? uid : null;
}

async function userSnapshotAdmission(
  store: PlatformStateRepositories,
  gatewayId: string,
  podName: string | undefined,
  uid: string,
): Promise<{
  userRecord: Stored<PlatformUserRecord>;
  gatewayData: GatewayRoot | undefined;
} | null> {
  const [userRecord, gateway] = await Promise.all([
    store.users.records.get(uid),
    store.gateways.roots.get(gatewayId),
  ]);
  const gatewayData = gateway ?? undefined;
  if (!userRecord) return null;
  if (userRecord.gateway?.gatewayId === gatewayId) {
    return { userRecord, gatewayData };
  }
  const slug = userRecord.slug;
  if (
    !slug ||
    !configuredUserCredentialBootstrapAllowed(gatewayData, {
      gatewayId,
      podName,
      slug,
      uid,
    })
  ) {
    return null;
  }
  return { userRecord, gatewayData };
}

type FleetBrokerRouteOptions = { store: PlatformStateStore; records?: BrokerRecords } & FleetBrokerRouteDeps;

type ResolvedFleetBrokerRouteDeps = {
  records: BrokerRecords;
  store: PlatformStateStore;
  resolveHouseModel: HouseModelResolver;
  resolveUserAgentDefault: UserAgentDefaultResolver;
  provisionMattermost: NonNullable<FleetBrokerRouteDeps["provisionMattermost"]>;
  markProvisioningComplete: NonNullable<FleetBrokerRouteDeps["markProvisioningComplete"]>;
  onUserProvisioned: NonNullable<FleetBrokerRouteDeps["onUserProvisioned"]>;
  renderAvatar: RenderAvatar;
  createBlobSignedUrl: CreateBlobSignedUrl;
  createVmHomeSignedUrl: CreateBlobSignedUrl;
  createIsolatedRuntimeStateSignedUrl: CreateBlobSignedUrl;
  readBlobMetadata: ReadBlobMetadata;
  pruneIsolatedRuntimeState: PruneIsolatedRuntimeState;
  vmHomeStore: VmHomeStore;
  executeChatSearch: ExecuteChatSearch;
  executeChatHistory: ExecuteChatHistory;
  resolveChatIdentity: ResolveChatIdentity;
  verifyOwnerWorkspaceTurn: OwnerWorkspaceTurnVerifier;
  webResearch: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  now: () => number;
  reconcileDefaultAgentProjectMembership: (input: ProjectAgentMembershipInput) => Promise<ProjectAgentMembershipResult>;
  npmCacheCapabilities: NpmCacheCapabilityStore;
  npmCacheRegistryUrl: string;
  reportNpmCacheCapabilityFailure: NonNullable<
    FleetBrokerRouteDeps["reportNpmCacheCapabilityFailure"]
  >;
};

function ownerWorkspaceTurnVerifier(
  opts: { store: OwnerTurnStore } & FleetBrokerRouteDeps,
): OwnerWorkspaceTurnVerifier {
  return opts.verifyOwnerWorkspaceTurn ?? createOwnerWorkspaceTurnVerifier(opts.store);
}

function projectAgentMembershipReconciler(
  opts: FleetBrokerRouteDeps,
): (input: ProjectAgentMembershipInput) => Promise<ProjectAgentMembershipResult> {
  return opts.reconcileDefaultAgentProjectMembership ?? reconcileDefaultAgentProjectMembership;
}

async function verifyOwnerWorkspaceTurnFailClosed(
  verify: OwnerWorkspaceTurnVerifier,
  input: Parameters<OwnerWorkspaceTurnVerifier>[0],
  operation: string,
): Promise<boolean> {
  try {
    return await verify(input);
  } catch (error) {
    logger.error("[fleet-broker] owner turn verification failed", {
      operation,
      gatewayId: input.gatewayId,
      agentId: input.agentId,
      err: error,
    });
    return false;
  }
}

function resolveFleetBrokerRouteImplementations(
  opts: FleetBrokerRouteDeps,
) {
  return {
    provisionMattermost: opts.provisionMattermost ?? defaultProvisionMattermost(opts.provisioningProjection),
    markProvisioningComplete:
      opts.markProvisioningComplete ?? defaultMarkProvisioningComplete(opts.provisioningProjection),
    onUserProvisioned: opts.onUserProvisioned ?? (async () => {}),
    renderAvatar: opts.renderAvatar ?? defaultRenderAvatar,
    createBlobSignedUrl: opts.createBlobSignedUrl ?? defaultCreateBlobSignedUrl,
    readBlobMetadata: opts.readBlobMetadata ?? defaultReadBlobMetadata,
    pruneIsolatedRuntimeState: opts.pruneIsolatedRuntimeState ?? defaultPruneIsolatedRuntimeState,
    vmHomeStore: opts.vmHomeStore ?? createGcsVmHomeStore(),
    executeChatSearch: opts.executeChatSearch ?? defaultExecuteChatSearch,
    executeChatHistory: opts.executeChatHistory ?? defaultExecuteChatHistory,
    resolveChatIdentity: opts.resolveChatIdentity ?? defaultResolveChatIdentity,
  };
}

function resolveFleetBrokerRouteDeps(
  opts: FleetBrokerRouteOptions,
): ResolvedFleetBrokerRouteDeps {
  const records = opts.records ?? NO_BROKER_RECORDS;
  return {
    records,
    store: opts.store,
    resolveHouseModel: createCachedHouseModelResolver({
      platformConfig: opts.store.config.platform,
      onError: (err) => logger.error("fleet-broker house model dial resolution failed", { err }),
    }),
    resolveUserAgentDefault: createCachedUserAgentDefaultResolver({
      platformConfig: opts.store.config.platform,
      onError: (err) =>
        logger.error("fleet-broker user agent default dial resolution failed", { err }),
    }),
    ...resolveFleetBrokerRouteImplementations(opts),
    createVmHomeSignedUrl: opts.createVmHomeSignedUrl ?? createGcsBackupSignedUrl,
    createIsolatedRuntimeStateSignedUrl: opts.createIsolatedRuntimeStateSignedUrl ?? createGcsBackupSignedUrl,
    verifyOwnerWorkspaceTurn: ownerWorkspaceTurnVerifier(opts),
    webResearch: opts.webResearch ?? createDefaultWebResearch(
      records,
      opts.store,
      opts.modelBrokerRails ?? operatorRailRegistry(),
      opts.onBudgetInterruption,
    ),
    now: opts.now ?? Date.now,
    reconcileDefaultAgentProjectMembership: projectAgentMembershipReconciler(opts),
    npmCacheCapabilities: opts.npmCacheCapabilities ?? new InMemoryNpmCacheCapabilityStore(),
    npmCacheRegistryUrl: opts.npmCacheRegistryUrl ?? npmCacheProxyRegistryUrl(),
    reportNpmCacheCapabilityFailure: opts.reportNpmCacheCapabilityFailure ?? ((input) => {
      logger.error("[fleet-broker] npm cache capability issue failed", input);
    }),
  };
}

function installAssignmentWatchRoute(router: Router, store: PlatformStateStore): void {
  router.post("/assignment-watch", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const gate = await resolveAssignedUsersRevisionGate(store, bound.gatewayId, revisionId);
    if (!gate.allowed) {
      respondInvalidRevision(res, bound.gatewayId, revisionId);
      return;
    }
    streamAssignmentChanges(req, res, store, bound.gatewayId, (message) => logger.error(message));
  });
}

export function userIdentityForRoot(value: unknown, gatewayId: string): UserIdentity | null {
  const root = projectGatewayDesiredRootForGateway(value, gatewayId) as
    (GatewayDoc & GatewayMutableConfig & { retirementClaim?: unknown }) | null;
  if (!root) return null;
  if (root.gatewayClass !== "isolated") return { gatewayId, state: "unavailable", reason: "not-builder" };
  if (root.desiredStatus === "retired") return { gatewayId, state: "unavailable", reason: "retired" };
  if (root.retireAfter != null || root.retirementClaim != null) {
    return { gatewayId, state: "unavailable", reason: "retiring" };
  }
  if (!root.ownerUid || !root.builderSlug) return null;
  return {
    gatewayId,
    state: "claimed",
    ownerUid: root.ownerUid,
    builderSlug: root.builderSlug,
    leaseId: root.allocation?.leaseId ?? null,
    generation: root.allocation?.generation ?? null,
  };
}

function computerCaller(bound: GatewayBinding): boolean {
  return !!bound.podUid && /^\d+$/.test(bound.podUid) && bound.podName === gatewayVmPodName(bound.gatewayId, bound.podUid);
}

async function podHostedIsolatedCaller(reader: Pick<PlatformStateRepositories, "fleetRegistry">, bound: GatewayBinding): Promise<boolean> {
  return !!bound.podUid && (await reader.fleetRegistry.get(bound.gatewayId))?.runtime === "cluster";
}

const BOOT_MODE_REFUSED = Symbol("boot mode refused");

function installUserIdentityRoute(router: Router, store: PlatformStateStore): void {
  router.post("/builder-identity", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    if (!podBelongsToGateway(bound.gatewayId, bound.podName)) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const nativeBoot = req.body?.nativeBoot === true;
    const identity = await store.transaction({ label: "fleet-broker.builder-identity", readOnly: true }, async (transaction) => {
      if (nativeBoot && !computerCaller(bound) && !(await podHostedIsolatedCaller(transaction, bound))) return BOOT_MODE_REFUSED;
      const gateway = await transaction.gateways.roots.get(bound.gatewayId);
      const identity = userIdentityForRoot(gateway, bound.gatewayId);
      if (!nativeBoot || !gateway || !identity || identity.state !== "claimed") return identity;
      const boot = await isolatedBootMode({ reader: transaction, gateway });
      return { ...identity, bootMode: boot.mode, ...(boot.migrationId ? { activationMigrationId: boot.migrationId } : {}) };
    });
    if (identity === BOOT_MODE_REFUSED) {
      logger.warn("[fleet-broker] user boot mode refused: the caller is neither the gateway's computer nor a pod of a pod-hosted gateway", {
        gatewayId: bound.gatewayId,
        podName: bound.podName,
      });
      res.status(403).json(FORBIDDEN);
      return;
    }
    if (!identity) {
      logger.error("[fleet-broker] user identity refused: gateway root is missing or illegal", {
        gatewayId: bound.gatewayId,
      });
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({ identity });
  });
}

function installSnapshotRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { records, store } = deps;
  installNpmCacheCapabilityRoutes(router, deps);

  router.post("/assignment-roster", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const podRevisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const authenticatedRevisionId = revisionIdFromGatewayPodName(
      bound.gatewayId,
      bound.podName,
    );
    if (!authenticatedRevisionId || authenticatedRevisionId !== podRevisionId) {
      respondInvalidRevision(res, bound.gatewayId, podRevisionId);
      return;
    }
    const gate = await resolveAssignedUsersRevisionGate(
      store,
      bound.gatewayId,
      podRevisionId,
      { requireDurableRoot: true },
    );
    if (!gate.allowed) {
      respondInvalidRevision(res, bound.gatewayId, podRevisionId);
      return;
    }
    const assignments = await readAssignmentRosterForGateway(store, bound.gatewayId);
    if (!assignments) {
      logger.error("fleet broker rejected invalid assignment roster", {
        gatewayId: bound.gatewayId,
      });
      res.status(502).json({ error: "invalid_assignment_roster", gatewayId: bound.gatewayId });
      return;
    }
    res.json({ assignments });
  });

  installAssignmentWatchRoute(router, store);

  router.post("/assigned-users", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const completeOnly = req.body?.completeOnly === true;
    // The pod self-reports its revision ({gw}-r{n}). It's scoped to the bound
    // (bare) tenant by the KSA, but we still validate the requested revision
    // belongs to this gateway and is an active revision (defense-in-depth against
    // same-gateway revision spoofing). Empty is legal only on a pre-backfill pod.
    const podRevisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const gate = await resolveAssignedUsersRevisionGate(store, bound.gatewayId, podRevisionId);
    if (!gate.allowed) {
      respondInvalidRevision(res, bound.gatewayId, podRevisionId);
      return;
    }
    const userRecords = await store.users.records.listByGateway(
      bound.gatewayId,
      completeOnly ? { openclawStatus: "complete" } : {},
    );
    const modelDials = {
      freeTierModelRef: (await deps.resolveHouseModel()).ref,
      userAgentDefault: await deps.resolveUserAgentDefault(),
    };
    const gatewayData = (await store.gateways.roots.get(bound.gatewayId)) ?? undefined;
    const accounts = await records.userDocuments.accounts(userRecords.filter((userRecord) => userRecord.slug).map((userRecord) => userRecord.uid));
    const users: FleetBrokerUserSnapshot[] = [];
    for (const userRecord of userRecords) {
      const account = accounts.get(userRecord.uid);
      if (!userRecord.slug || !account) continue;
      const snapshot = await loadSnapshot(deps, userRecord, account, {
        gatewayId: bound.gatewayId,
        modelDials,
        gatewayData,
      });
      if (snapshot) users.push(snapshot);
    }
    res.json({ users });
  });

  router.post("/uid-for-slug", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
    if (!isValidUsername(slug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    const uid = await findUidBySlug(store, bound.gatewayId, bound.podName, slug);
    if (!uid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ uid });
  });

  router.post("/configured-builder-bootstrap", async (req, res) => {
    await handleConfiguredUserBootstrap(deps, req, res);
  });

  router.post("/user-snapshot", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
    if (!uid) {
      res.status(400).json({ error: "uid_required" });
      return;
    }
    const admission = await userSnapshotAdmission(store, bound.gatewayId, bound.podName, uid);
    if (!admission) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const { userRecord, gatewayData } = admission;
    if (!userRecord.slug) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const snapshot = await loadSnapshot(
      deps,
      userRecord,
      await readUserAccountDocument(records, uid),
      {
        gatewayId: bound.gatewayId,
        modelDials: {
          freeTierModelRef: (await deps.resolveHouseModel()).ref,
          userAgentDefault: await deps.resolveUserAgentDefault(),
        },
        gatewayData,
      },
    );
    if (!snapshot) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ user: snapshot });
  });

  router.post("/reconcile-project-coach-membership", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
    if (!uid) {
      res.status(400).json({ error: "uid_required" });
      return;
    }
    const userRecord = await assignedUser(store, bound.gatewayId, uid);
    if (!userRecord) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const slug = userRecord.slug;
    if (!slug) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const [collectedChannels, defaultAgentSecret, projectAgents] = await Promise.all([
      collectChannelBindings(store, slug),
      defaultAgentMattermostSecret(store, uid),
      collectStoredProjectAgentStates(store, uid, slug),
    ]);
    const defaultAgent = snapshotDefaultAgentFields(defaultAgentSecret);
    const agentByProject = new Map(projectAgents.map((agent) => [agent.projectId, agent]));
    const { pendingProjectIds } = await deps.reconcileDefaultAgentProjectMembership({
      defaultAgentMmUserId: defaultAgent.coachMmUserId,
      projects: collectedChannels.projectMemberships.map(({ projectId, channelIds }) => {
        const agent = agentByProject.get(projectId);
        return {
          projectId,
          projectAgentConfigured: projectAgentConfigured(agent),
          projectAgentMmUserId: agent?.mmUserId ?? null,
          channelIds,
        };
      }),
    });
    if (pendingProjectIds.length > 0) {
      logger.warn("[fleet-broker] project agents pending mint; agent mounted without them", {
        gatewayId: bound.gatewayId,
        slug,
        pendingProjectIds,
      });
    }
    res.json({ pendingProjectAgents: pendingProjectIds });
  });
}

function configuredUserBootstrapRequest(
  gatewayId: string,
  podName: string | undefined,
  body: unknown,
): { slug: string } | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const requestedRevisionId = typeof record.revisionId === "string" ? record.revisionId : "";
  const slug = typeof record.slug === "string" ? record.slug : "";
  if (!isValidUsername(slug)) return null;
  if (!podBelongsToGateway(gatewayId, podName)) return null;
  if (requestedRevisionId && requestedRevisionId !== gatewayId) return null;
  return { slug };
}

interface IsolatedRuntimeStateScope {
  gatewayId: string;
  podName: string | undefined;
  leaseId: string;
  generation: number;
  slug: string;
  uid: string;
}

async function readIsolatedRuntimeStateScope(
  store: PlatformStateRepositories,
  input: { gatewayId: string; podName: string | undefined; slug: string },
): Promise<IsolatedRuntimeStateScope | null> {
  const gateway = (await store.gateways.roots.get(input.gatewayId)) ?? undefined;
  const config = projectGatewayMutableConfigForGateway(gateway, input.gatewayId);
  const uid = config?.ownerUid;
  const allocation = config?.allocation;
  if (
    typeof uid !== "string" ||
    !allocation ||
    !configuredUserCredentialBootstrapAllowed(gateway, { ...input, uid })
  ) return null;
  return { ...input, uid, leaseId: allocation.leaseId, generation: allocation.generation };
}

interface SharedAgentAnchorScope {
  migration?: FleetBrokerAgentAnchorMigration;
  sourceSurge?: FleetBrokerAgentAnchorMigration;
  gatewayId: string;
  podName: string | undefined;
  podUid?: string;
  uid: string;
  slug: string;
  assignmentEpoch: number;
  assignmentState: "serving" | "quiescing";
}

type AgentAnchorScope = IsolatedRuntimeStateScope | SharedAgentAnchorScope;

function agentAnchorAssignment(
  scope: Pick<SharedAgentAnchorScope, "gatewayId" | "uid" | "slug">,
  assignment: GatewayAssignment | null,
): Pick<SharedAgentAnchorScope, "assignmentEpoch" | "assignmentState"> | null {
  if (!assignment || assignment.gatewayId !== scope.gatewayId || assignment.slug !== scope.slug ||
      (assignment.state !== "serving" && assignment.state !== "quiescing")) return null;
  return { assignmentEpoch: assignment.epoch, assignmentState: assignment.state };
}

function sharedAgentAnchorScopeCurrent(
  scope: Pick<SharedAgentAnchorScope, "gatewayId" | "uid" | "slug">,
  gatewayData: unknown,
  userRecord: PlatformUserRecord | null,
  assignmentRecord: GatewayAssignment | null,
): SharedAgentAnchorScope | null {
  const gateway = projectGatewayDesiredRootForGateway(gatewayData, scope.gatewayId);
  const assignment = agentAnchorAssignment(scope, assignmentRecord);
  if (!gateway || gateway.gatewayClass !== "shared" || gateway.retirementClaim != null ||
      (gateway.desiredStatus !== "running" && gateway.desiredStatus !== "draining") ||
      userRecord?.gateway?.gatewayId !== scope.gatewayId || userRecord.slug !== scope.slug ||
      !assignment) return null;
  return { ...scope, podName: undefined, ...assignment };
}

async function requireAgentAnchorScope(store: PlatformStateStore, req: Request, res: Response): Promise<AgentAnchorScope | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const request = configuredUserBootstrapRequest(bound.gatewayId, bound.podName, req.body);
  if (!request) { res.status(403).json(FORBIDDEN); return null; }
  const gateway = await store.gateways.roots.get(bound.gatewayId);
  if (projectGatewayDesiredRootForGateway(gateway, bound.gatewayId)?.gatewayClass !== "shared") {
    if (!migrationAnchorRequest(req)) return requireConfiguredIsolatedRuntimeState(store, req, res);
    if (!req.path.endsWith("/read")) { res.status(403).json(FORBIDDEN); return null; }
    if (await migrationSourceGatewayId(store, req) === bound.gatewayId) return requireConfiguredIsolatedRuntimeState(store, req, res);
    return requireMigratingAgentAnchorScope(store, req, res, bound, request.slug);
  }
  if (migrationAnchorRequest(req)) {
    return requireMigratingAgentAnchorScope(store, req, res, bound, request.slug);
  }
  return requireAssignedSharedAgentAnchorScope(store, req, res, bound, { slug: request.slug, gateway });
}

async function requireAssignedSharedAgentAnchorScope(
  store: PlatformStateStore, req: Request, res: Response, bound: GatewayBinding, { slug, gateway }: { slug: string; gateway: Stored<GatewayRoot> | null },
): Promise<SharedAgentAnchorScope | null> {
  const uid: unknown = req.body?.uid;
  if (!validAnchorUid(uid)) { res.status(403).json(FORBIDDEN); return null; }
  const [userRecord, assignment] = await Promise.all([
    store.users.records.get(uid),
    store.gateways.assignments.get(bound.gatewayId, uid),
  ]);
  let scope = sharedAgentAnchorScopeCurrent({ gatewayId: bound.gatewayId, uid, slug }, gateway, userRecord, assignment);
  if (!scope) { res.status(403).json(FORBIDDEN); return null; }
  const operationId = userRecord?.fences.migration?.operationId;
  if (scope.assignmentState === "quiescing" && operationId) {
    const migrationScope = await sharedMigratingAnchorScope(store, bound, { uid, slug, operationId });
    if (!migrationScope || migrationScope.uid !== uid) { res.status(403).json(FORBIDDEN); return null; }
    scope = { ...migrationScope, podName: bound.podName };
  }
  if (req.path.endsWith("/report") &&
      (req.body.assignmentEpoch !== scope.assignmentEpoch || req.body.assignmentState !== scope.assignmentState)) {
    res.status(403).json(FORBIDDEN); return null;
  }
  return { ...scope, podName: bound.podName, podUid: bound.podUid };
}

function validAnchorUid(uid: unknown): uid is string {
  return typeof uid === "string" && uid.length > 0 && uid.length <= 128 && !uid.includes("/");
}

function sharedMigratingAnchorScope(
  store: PlatformStateStore, bound: GatewayBinding, { uid, slug, operationId }: { uid: string; slug: string; operationId: string },
) {
  return store.transaction({ label: "fleet-broker.shared-anchor-scope", readOnly: true }, async (tx) => operationId.startsWith("surge-")
    ? sharedAssignedSourceSurgeAnchorScope(tx, { gatewayId: bound.gatewayId, podUid: bound.podUid, uid, slug, migrationId: operationId })
    : sharedAgentAnchorMigrationScope(tx, { gatewayId: bound.gatewayId, slug, migrationId: `mig-${operationId}` }));
}

function migrationAnchorRequest(req: Request): boolean {
  return req.body?.migrationId !== undefined || req.body?.migration !== undefined;
}

async function migrationSourceGatewayId(store: PlatformStateRepositories, req: Request): Promise<unknown> {
  const migrationId: unknown = req.body?.migration?.migrationId ?? req.body?.migrationId;
  if (typeof migrationId !== "string" || !/^mig-[a-zA-Z0-9_-]+$/.test(migrationId)) return undefined;
  const operation = await store.journal.operations.get(migrationId.slice(4));
  return operation?.kind === "migrate-user" ? operation.input.fromGatewayId : undefined;
}

async function requireMigratingAgentAnchorScope(
  store: PlatformStateStore, req: Request, res: Response,
  bound: GatewayBinding, slug: string,
): Promise<SharedAgentAnchorScope | null> {
  const scope = await store.transaction({ label: "fleet-broker.migrating-anchor-scope", readOnly: true }, (tx) => sharedAgentAnchorMigrationScope(tx, {
    gatewayId: bound.gatewayId, podUid: bound.podUid, slug, migrationId: req.body.migration?.migrationId ?? req.body.migrationId, expected: req.body.migration,
  }));
  if (!scope || (req.body.uid !== undefined && req.body.uid !== scope.uid) ||
      (req.path.endsWith("/report") && (!req.body.migration || req.body.assignmentEpoch !== scope.assignmentEpoch || req.body.assignmentState !== scope.assignmentState))) {
    res.status(403).json(FORBIDDEN); return null;
  }
  return { ...scope, podName: bound.podName, podUid: bound.podUid };
}

const UNMATCHED_ROUTE_AGENT_ID = "octogee-unmatched-route";
const AGENT_ANCHOR_STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const AGENT_ANCHOR_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;

function agentAnchorBelongsTo(slug: string, agentId: string): boolean {
  if (agentId === UNMATCHED_ROUTE_AGENT_ID) return true;
  const parsed = parseAgentId(agentId);
  return parsed.kind !== "unknown" && parsed.username === slug;
}

function agentAnchorFor(slug: string, value: unknown): FleetBrokerAgentAnchor | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const agentId = record?.agentId;
  const storeId = record?.storeId;
  const schema = record?.schema;
  if (typeof agentId !== "string" || !agentAnchorBelongsTo(slug, agentId) ||
      typeof storeId !== "string" || !AGENT_ANCHOR_STORE_ID.test(storeId) ||
      typeof schema !== "string" || !AGENT_ANCHOR_SCHEMA.test(schema)) return null;
  return { agentId, storeId, schema };
}

interface AgentAnchorReport {
  anchors: FleetBrokerAgentAnchor[];
  configuredAgentIds: ReadonlySet<string>;
  state: FleetBrokerGatewayStateAnchor | null;
  auxiliary: FleetBrokerAuxiliaryAnchor[];
}

const GATEWAY_STATE_ANCHOR_DOC = "_gateway-state";
const GATEWAY_STATE_KIND = "gateway-state";

function gatewayStateAnchor(value: unknown): FleetBrokerGatewayStateAnchor | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const storeId = record?.storeId;
  const schema = record?.schema;
  if (typeof storeId !== "string" || !AGENT_ANCHOR_STORE_ID.test(storeId) ||
      typeof schema !== "string" || !AGENT_ANCHOR_SCHEMA.test(schema)) return null;
  return { storeId, schema };
}

const AUXILIARY_FAMILIES = ["workboard", "logbook", "team-reports"] as const;

function auxiliaryAnchor(value: unknown): FleetBrokerAuxiliaryAnchor | null {
  const record = value as Record<string, unknown> | null;
  const identity = gatewayStateAnchor(value);
  if (!identity || !record || !AUXILIARY_FAMILIES.includes(record.family as FleetBrokerAuxiliaryAnchor["family"])) return null;
  return { family: record.family as FleetBrokerAuxiliaryAnchor["family"], ...identity };
}

function reportedAuxiliaryAnchors(value: unknown): FleetBrokerAuxiliaryAnchor[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AUXILIARY_FAMILIES.length) return null;
  const parsed = value.map(auxiliaryAnchor);
  if (parsed.some(anchor => !anchor) || new Set(parsed.map(anchor => anchor?.family)).size !== parsed.length ||
      value.some(anchor => Object.keys(anchor).some(key => !["family", "schema", "storeId"].includes(key)))) return null;
  return parsed as FleetBrokerAuxiliaryAnchor[];
}

function agentStoreKey(record: AgentStoreRecord): string {
  if (record.kind === GATEWAY_STATE_KIND) return GATEWAY_STATE_ANCHOR_DOC;
  if (record.kind === "auxiliary") return `_gateway-${record.family}`;
  return record.agentId;
}

function recordedAuxiliaryAnchor(scope: IsolatedRuntimeStateScope, record: AgentStoreRecord): FleetBrokerAuxiliaryAnchor | null {
  if (record.kind !== "auxiliary" || record.gatewayId !== scope.gatewayId || record.generation !== scope.generation) return null;
  const anchor = auxiliaryAnchor({ family: record.family, storeId: record.storeId, schema: record.schema });
  if (!anchor) throw new AgentAnchorConflictError(agentStoreKey(record));
  return anchor;
}

function recordedGatewayStateAnchor(scope: IsolatedRuntimeStateScope, record: AgentStoreRecord): FleetBrokerGatewayStateAnchor | null {
  if (record.kind !== GATEWAY_STATE_KIND || record.gatewayId !== scope.gatewayId || record.generation !== scope.generation) return null;
  return gatewayStateAnchor(record);
}

function reportedConfiguredAgentIds(body: unknown): Set<string> | null {
  const ids = (body as { configuredAgentIds?: unknown } | null)?.configuredAgentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 512) return null;
  if (!ids.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128)) return null;
  return new Set(ids);
}

function reportedAgentAnchors(slug: string, body: unknown): AgentAnchorReport | null {
  const anchors = (body as { anchors?: unknown } | null)?.anchors;
  const reportedState = (body as { state?: unknown } | null)?.state;
  const state = reportedState === undefined ? null : gatewayStateAnchor(reportedState);
  if (reportedState !== undefined && !state) return null;
  const auxiliary = reportedAuxiliaryAnchors((body as { auxiliary?: unknown } | null)?.auxiliary);
  if (!auxiliary) return null;
  const configuredAgentIds = reportedConfiguredAgentIds(body);
  if (!configuredAgentIds || !Array.isArray(anchors) || anchors.length === 0 || anchors.length > 256) return null;
  const parsed = anchors.map((value) => agentAnchorFor(slug, value));
  if (parsed.some((anchor) => anchor === null || !configuredAgentIds.has(anchor.agentId))) return null;
  const seen = new Set<string>();
  for (const anchor of parsed as FleetBrokerAgentAnchor[]) {
    if (seen.has(anchor.agentId)) return null;
    seen.add(anchor.agentId);
  }
  return { anchors: parsed as FleetBrokerAgentAnchor[], configuredAgentIds, state, auxiliary };
}

function recordedAgentAnchor(scope: IsolatedRuntimeStateScope, record: AgentStoreRecord): FleetBrokerAgentAnchor | null {
  if (record.kind !== "agent" || record.gatewayId !== scope.gatewayId || record.generation !== scope.generation) return null;
  return agentAnchorFor(scope.slug, record);
}

class AgentAnchorConflictError extends Error {
  constructor(readonly agentId: string) {
    const subject = agentId === GATEWAY_STATE_ANCHOR_DOC ? "the gateway state" : "agent " + agentId;
    super(`${subject} already records a different PostgreSQL store in this allocation`);
    this.name = "AgentAnchorConflictError";
  }
}

function userAgentAnchorPruningAllowed(
  scope: IsolatedRuntimeStateScope,
  userRecord: Stored<PlatformUserRecord> | null,
  assignment: GatewayAssignment | null,
): boolean {
  return agentAnchorAssignment(scope, assignment)?.assignmentState === "serving" &&
    userRecord?.gateway?.gatewayId === scope.gatewayId && userRecord.slug === scope.slug &&
    userRecord.fences.migration === undefined && !isolatedRuntimeMutationFenced(userRecord);
}

function globalAnchorUnchanged(scope: IsolatedRuntimeStateScope, record: AgentStoreRecord, report: AgentAnchorReport): boolean {
  if (record.kind === "agent") return false;
  const prior = record.kind === GATEWAY_STATE_KIND ? recordedGatewayStateAnchor(scope, record) : recordedAuxiliaryAnchor(scope, record);
  if (!prior) return true;
  const next = "family" in prior ? report.auxiliary.find(anchor => anchor.family === prior.family) : report.state;
  if (next && (prior.storeId !== next.storeId || prior.schema !== next.schema)) throw new AgentAnchorConflictError(agentStoreKey(record));
  return true;
}

function userAnchorAllocationCurrent(scope: IsolatedRuntimeStateScope, gateway: unknown): boolean {
  const allocation = projectGatewayMutableConfigForGateway(gateway, scope.gatewayId)?.allocation;
  return configuredUserCredentialBootstrapAllowed(gateway, scope) && allocation?.leaseId === scope.leaseId && allocation.generation === scope.generation;
}

function archivedProjectAgentIds(scope: { uid: string; slug: string }, projects: readonly WorkspaceProject[]): Set<string> {
  return new Set(projects.filter(project => {
    return project.ownerUid === scope.uid && projectAgentConfigured(project.agent) &&
      (project.status === "archived" || project.commercialLifecycleStatus === "archived");
  }).map(project => projectAgentId(scope.slug, project.projectSlug)));
}

async function recordAgentAnchors(
  store: PlatformStateStore,
  scope: IsolatedRuntimeStateScope,
  report: AgentAnchorReport,
  recordedAt: number,
): Promise<void> {
  const { anchors, configuredAgentIds, state, auxiliary } = report;
  const reported = new Map(anchors.map((anchor) => [anchor.agentId, anchor]));
  const custody = { gatewayId: scope.gatewayId, generation: scope.generation, assignmentEpoch: null, recordedAt };
  await store.transaction({ label: "fleet-broker.record-agent-anchors" }, async (tx) => {
    const [existing, userRecord, assignment, gateway, projects] = await Promise.all([
      tx.users.agentStores.list(scope.uid),
      tx.users.records.get(scope.uid),
      tx.gateways.assignments.get(scope.gatewayId, scope.uid),
      tx.gateways.roots.get(scope.gatewayId),
      tx.workspaces.projects.list(scope.slug),
    ]);
    if (!userAnchorAllocationCurrent(scope, gateway)) {
      throw new SharedAgentAnchorCustodyError("Isolated gateway allocation changed before anchor reporting");
    }
    const canPrune = userAgentAnchorPruningAllowed(scope, userRecord, assignment);
    const archived = archivedProjectAgentIds(scope, projects);
    const pruned: string[] = [];
    for (const record of existing) {
      if (globalAnchorUnchanged(scope, record, report)) continue;
      const prior = recordedAgentAnchor(scope, record);
      if (!prior) continue;
      const next = reported.get(prior.agentId);
      if (!configuredAgentIds.has(prior.agentId)) {
        if (canPrune && !archived.has(prior.agentId)) pruned.push(agentStoreKey(record));
      } else if (next && (prior.storeId !== next.storeId || prior.schema !== next.schema)) {
        throw new AgentAnchorConflictError(prior.agentId);
      }
    }
    for (const key of pruned) await tx.users.agentStores.delete(scope.uid, key);
    for (const anchor of anchors) {
      await tx.users.agentStores.put(scope.uid, { kind: "agent", ...anchor, ...custody });
    }
    for (const anchor of auxiliary) {
      await tx.users.agentStores.put(scope.uid, { kind: "auxiliary", ...anchor, ...custody });
    }
    if (state) {
      await tx.users.agentStores.put(scope.uid, { kind: GATEWAY_STATE_KIND, ...state, ...custody });
    }
  });
}

function recordedSharedAgentAnchor(scope: SharedAgentAnchorScope, record: AgentStoreRecord): FleetBrokerAgentAnchor | null {
  const id = agentStoreKey(record);
  if (id === UNMATCHED_ROUTE_AGENT_ID || !agentAnchorBelongsTo(scope.slug, id)) return null;
  const anchor = agentAnchorFor(scope.slug, record);
  if (!anchor || anchor.agentId !== id || (scope.assignmentState === "quiescing" && !scope.migration &&
      (record.gatewayId !== scope.gatewayId || record.assignmentEpoch !== scope.assignmentEpoch))) {
    throw new AgentAnchorConflictError(id);
  }
  return anchor;
}

class SharedAgentAnchorCustodyError extends Error {}

function anchorCustodyGateway(scope: SharedAgentAnchorScope): string {
  return scope.migration?.sourceGatewayId ?? scope.gatewayId;
}

function unconfiguredSharedAgentAnchors(scope: SharedAgentAnchorScope, existing: readonly AgentStoreRecord[], configuredAgentIds: ReadonlySet<string>) {
  if (scope.assignmentState !== "serving" || scope.migration) return [];
  return existing.filter((record) => {
    const prior = recordedSharedAgentAnchor(scope, record);
    return prior && !configuredAgentIds.has(prior.agentId);
  });
}

function sharedAgentAnchorCustodyMatches(current: Pick<SharedAgentAnchorScope, "uid" | "assignmentEpoch" | "assignmentState"> | null, scope: SharedAgentAnchorScope): boolean {
  return [current?.uid === scope.uid, current?.assignmentEpoch === scope.assignmentEpoch, current?.assignmentState === scope.assignmentState].every(Boolean);
}

function sharedAnchorMigrationBound(scope: SharedAgentAnchorScope): boolean {
  return scope.migration !== undefined || scope.sourceSurge !== undefined;
}

async function recheckSharedAnchorMigration(tx: PlatformStateRepositories, scope: SharedAgentAnchorScope) {
  const migration = scope.sourceSurge ?? scope.migration;
  if (!migration) return null;
  const request = { gatewayId: scope.gatewayId, podUid: scope.podUid, slug: scope.slug, migrationId: migration.migrationId, expected: migration };
  return scope.sourceSurge ? sharedAssignedSourceSurgeAnchorScope(tx, { ...request, uid: scope.uid }) : sharedAgentAnchorMigrationScope(tx, request);
}

async function recordSharedAgentAnchors(
  store: PlatformStateStore,
  scope: SharedAgentAnchorScope,
  { anchors, configuredAgentIds }: AgentAnchorReport,
  recordedAt: number,
): Promise<void> {
  await store.transaction({ label: "fleet-broker.record-shared-agent-anchors" }, async (tx) => {
    const [gateway, userRecord, assignment, existing, projects] = await Promise.all([
      tx.gateways.roots.get(scope.gatewayId), tx.users.records.get(scope.uid),
      tx.gateways.assignments.get(scope.gatewayId, scope.uid), tx.users.agentStores.list(scope.uid),
      tx.workspaces.projects.list(scope.slug),
    ]);
    const current = sharedAnchorMigrationBound(scope)
      ? await recheckSharedAnchorMigration(tx, scope)
      : sharedAgentAnchorScopeCurrent(scope, gateway, userRecord, assignment);
    if (!sharedAgentAnchorCustodyMatches(current, scope)) {
      throw new SharedAgentAnchorCustodyError("Shared agent anchor custody changed before reporting");
    }
    const byKey = new Map(existing.map((record) => [agentStoreKey(record), record]));
    for (const anchor of anchors) {
      const record = byKey.get(anchor.agentId);
      const prior = record ? recordedSharedAgentAnchor(scope, record) : null;
      if ((prior && (prior.storeId !== anchor.storeId || prior.schema !== anchor.schema)) ||
          (!prior && scope.assignmentState !== "serving")) throw new AgentAnchorConflictError(anchor.agentId);
    }
    const archived = archivedProjectAgentIds(scope, projects);
    for (const record of unconfiguredSharedAgentAnchors(scope, existing, configuredAgentIds)) {
      if (!archived.has(agentStoreKey(record))) await tx.users.agentStores.delete(scope.uid, agentStoreKey(record));
    }
    for (const anchor of anchors) {
      await tx.users.agentStores.put(scope.uid, {
        kind: "agent", ...anchor, gatewayId: anchorCustodyGateway(scope), generation: byKey.get(anchor.agentId)?.generation ?? null,
        assignmentEpoch: scope.assignmentEpoch, recordedAt,
      });
    }
  });
}

function installAgentAnchorRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { store } = deps;

  router.post("/agent-anchors/report", async (req, res) => {
    const scope = await requireAgentAnchorScope(store, req, res);
    if (!scope) return;
    const report = reportedAgentAnchors(scope.slug, req.body);
    if (!report || ("assignmentEpoch" in scope && (report.state || report.auxiliary.length > 0 ||
        [...report.configuredAgentIds].some((id) => id === UNMATCHED_ROUTE_AGENT_ID || !agentAnchorBelongsTo(scope.slug, id))))) {
      res.status(400).json({ error: "invalid_agent_anchors" });
      return;
    }
    await runBrokered(res, async () => {
      const recordedAt = deps.now();
      try {
        if ("assignmentEpoch" in scope) await recordSharedAgentAnchors(store, scope, report, recordedAt);
        else await recordAgentAnchors(store, scope, report, recordedAt);
      } catch (error) {
        if (error instanceof SharedAgentAnchorCustodyError) { res.status(403).json(FORBIDDEN); return; }
        if (!(error instanceof AgentAnchorConflictError)) throw error;
        logger.error("[fleet-broker] agent anchor conflict refused", {
          gatewayId: scope.gatewayId, slug: scope.slug, agentId: error.agentId,
        });
        res.status(409).json({ error: "agent_anchor_conflict", agentId: error.agentId });
        return;
      }
      res.status(204).end();
    });
  });

  router.post("/agent-anchors/read", async (req, res) => {
    const scope = await requireAgentAnchorScope(store, req, res);
    if (!scope) return;
    await runBrokered(res, async () => {
      const records = "assignmentEpoch" in scope && sharedAnchorMigrationBound(scope)
        ? await store.transaction({ label: "fleet-broker.read-agent-anchors", readOnly: true }, async (tx) => {
          const current = await recheckSharedAnchorMigration(tx, scope);
          if (!current || current.uid !== scope.uid) return null;
          return tx.users.agentStores.list(scope.uid);
        })
        : await store.users.agentStores.list(scope.uid);
      if (!records) { res.status(403).json(FORBIDDEN); return; }
      if ("assignmentEpoch" in scope) {
        try {
          const anchors = records.map((record) => recordedSharedAgentAnchor(scope, record))
            .filter((anchor): anchor is FleetBrokerAgentAnchor => anchor !== null)
            .sort((left, right) => left.agentId.localeCompare(right.agentId));
          res.json({ anchors, assignment: { uid: scope.uid, epoch: scope.assignmentEpoch, state: scope.assignmentState }, ...(scope.migration ? { migration: scope.migration } : {}) } satisfies FleetBrokerAgentAnchors);
        } catch (error) {
          if (!(error instanceof AgentAnchorConflictError)) throw error;
          res.status(409).json({ error: "agent_anchor_conflict", agentId: error.agentId });
        }
        return;
      }
      const anchors = records
        .map((record) => recordedAgentAnchor(scope, record))
        .filter((anchor): anchor is FleetBrokerAgentAnchor => anchor !== null)
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
      const stateRecord = records.find((record) => record.kind === GATEWAY_STATE_KIND);
      const state = stateRecord ? recordedGatewayStateAnchor(scope, stateRecord) : null;
      let auxiliary: FleetBrokerAuxiliaryAnchor[];
      try {
        auxiliary = records.map(record => recordedAuxiliaryAnchor(scope, record))
          .filter((anchor): anchor is FleetBrokerAuxiliaryAnchor => anchor !== null)
          .sort((left, right) => AUXILIARY_FAMILIES.indexOf(left.family) - AUXILIARY_FAMILIES.indexOf(right.family));
      } catch (error) {
        if (!(error instanceof AgentAnchorConflictError)) throw error;
        res.status(409).json({ error: "agent_anchor_conflict", agentId: error.agentId });
        return;
      }
      const response: FleetBrokerAgentAnchors = { anchors, ...(state ? { state } : {}), ...(auxiliary.length ? { auxiliary } : {}) };
      res.json(response);
    });
  });
}

async function confirmIsolatedRuntimeStateAllocationCurrent(
  store: PlatformStateRepositories,
  scope: IsolatedRuntimeStateScope,
): Promise<void> {
  const current = await readIsolatedRuntimeStateScope(store, scope);
  if (current?.leaseId !== scope.leaseId || current.generation !== scope.generation) {
    throw new IsolatedRuntimeStateAllocationSupersededError(scope);
  }
}

async function pruneIsolatedRuntimeStateForScope(
  store: PlatformStateRepositories,
  prune: PruneIsolatedRuntimeState,
  scope: IsolatedRuntimeStateScope,
  now: number,
): Promise<number | null> {
  try {
    return await prune({
      canonicalPath: gcsPathForIsolatedRuntimeState(scope),
      runtimeStatePrefix: gcsPathForIsolatedRuntimeStateRoot(scope.slug),
      allocationGeneration: scope.generation,
      now,
      confirmAllocationCurrent: () => confirmIsolatedRuntimeStateAllocationCurrent(store, scope),
    });
  } catch (error) {
    if (!(error instanceof IsolatedRuntimeStateAllocationSupersededError)) throw error;
    logger.warn("[fleet-broker] runtime-state prune refused: allocation superseded", {
      gatewayId: scope.gatewayId, slug: scope.slug, generation: scope.generation,
    });
    return null;
  }
}

async function requireConfiguredIsolatedRuntimeState(
  store: PlatformStateRepositories,
  req: Request,
  res: Response,
): Promise<IsolatedRuntimeStateScope | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const request = configuredUserBootstrapRequest(
    bound.gatewayId,
    bound.podName,
    req.body,
  );
  if (!request) {
    res.status(403).json(FORBIDDEN);
    return null;
  }

  const scope = await readIsolatedRuntimeStateScope(store, {
    gatewayId: bound.gatewayId,
    podName: bound.podName,
    slug: request.slug,
  });
  if (!scope) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return scope;
}

function openClawBootRequest(
  bound: GatewayBinding,
  body: unknown,
): { releaseKey: string; podUid: string; podName: string; openclawBuild?: string } | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const revisionId = typeof record.revisionId === "string" ? record.revisionId : "";
  const releaseKey = typeof record.releaseKey === "string" ? record.releaseKey.trim() : "";
  const authenticatedRevisionId = revisionIdFromGatewayPodName(bound.gatewayId, bound.podName);
  if (!bound.podUid || !bound.podName || !authenticatedRevisionId || revisionId !== authenticatedRevisionId) {
    return null;
  }
  if (!releaseKey || releaseKey.length > 512) return null;
  const openclawBuild = record.openclawBuild;
  if (openclawBuild !== undefined && (typeof openclawBuild !== "string" || !OPENCLAW_BUILD_PATTERN.test(openclawBuild))) return null;
  return { releaseKey, podUid: bound.podUid, podName: bound.podName, ...(openclawBuild ? { openclawBuild } : {}) };
}

function installOpenClawBootRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  installAgentAnchorRoutes(router, deps);
  const store = createOpenClawBootSentinelStore(deps.store, deps.now);

  router.post("/openclaw-boot/claim", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body);
    if (!request) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      const result = await store.claim({ gatewayId: bound.gatewayId, ...request });
      if (!result) {
        res.status(409).json({ error: "gateway_runtime_missing" });
        return;
      }
      res.json(result);
    });
  });

  router.post("/openclaw-boot/doctor-current", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body), requestId = req.body?.requestId;
    if (!request || typeof requestId !== "string" || !requestId || requestId.includes("/")) { res.status(403).json(FORBIDDEN); return; }
    await runBrokered(res, async () => {
      await store.assertDoctor({ gatewayId: bound.gatewayId, ...request, requestId });
      res.status(204).end();
    });
  });

  router.post("/openclaw-boot/doctor-complete", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body);
    const requestId = req.body?.requestId;
    const verifiedAgentIds = req.body?.verifiedAgentIds;
    if (!request || typeof requestId !== "string" || !requestId || requestId.includes("/") ||
        !Array.isArray(verifiedAgentIds) || verifiedAgentIds.length === 0 || !verifiedAgentIds.every((id: unknown) => typeof id === "string")) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      await store.completeDoctor({ gatewayId: bound.gatewayId, ...request, requestId, verifiedAgentIds });
      res.status(204).end();
    });
  });

  router.post("/openclaw-boot/healthy", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body);
    if (!request) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      const completed = await store.complete({ gatewayId: bound.gatewayId, ...request });
      if (!completed) {
        res.status(409).json({ error: "gateway_runtime_missing" });
        return;
      }
      res.status(204).end();
    });
  });
}

export class CorruptStoredFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptStoredFieldError";
  }
}

export function storedAgentLook(agent: Record<string, unknown> | undefined): AgentLook {
  if (agent?.look === undefined || agent?.look === null) return DEFAULT_AGENT_LOOK;
  const look = parseAgentLook(agent.look);
  if (!look) throw new CorruptStoredFieldError(`agents/{uid}.look is not a drawable look: ${JSON.stringify(agent.look)}`);
  return look;
}

export function storedTimeZone(user: Record<string, unknown> | undefined): string | null {
  const raw = readPath(user, "preferences.timeZone");
  if (raw === undefined || raw === null) return null;
  const zone = parseTimeZone(raw);
  if (!zone) throw new CorruptStoredFieldError(`users/{uid}.preferences.timeZone is not an IANA zone: ${JSON.stringify(raw)}`);
  return zone;
}

export function configuredUserDesk(
  user: Record<string, unknown> | undefined,
  agent: Record<string, unknown> | undefined,
): FleetBrokerConfiguredUserDesk {
  return {
    builderName: stringAt(user, "displayName") || stringAt(user, "username"),
    agentName: stringAt(agent, "name"),
    look: storedAgentLook(agent),
    timeZone: storedTimeZone(user),
  };
}

function configuredUserBootstrapPayload(input: {
  uid: string;
  slug: string;
  userRecord: PlatformUserRecord | null;
  user: Record<string, unknown> | undefined;
  defaultAgent: MattermostTokenSecret | null;
  agent: Record<string, unknown> | undefined;
  projectCredentials: FleetBrokerConfiguredUserProjectCredential[];
}): FleetBrokerConfiguredUserBootstrap | null {
  const { uid, slug, userRecord, user, defaultAgent, agent, projectCredentials } = input;
  const agentId = `octogee-${slug}-coach`;
  if (!userRecord || userRecord.slug !== slug) return null;
  if (!userCarriesAgentId(userRecord, agentId)) return null;
  if (!defaultAgent || defaultAgent.personalToken.length === 0) return null;
  return {
    uid,
    slug,
    agentId,
    accountId: `${slug}-coach`,
    coachToken: defaultAgent.personalToken,
    projectCredentials,
    desk: configuredUserDesk(user, agent),
  };
}

function configuredUserProjectCredentials(
  slug: string,
  projectAgents: readonly FleetBrokerProjectAgent[],
): FleetBrokerConfiguredUserProjectCredential[] {
  const credentials: FleetBrokerConfiguredUserProjectCredential[] = [];
  for (const project of projectAgents) {
    if (
      !project.enabled ||
      !isValidProjectId(project.projectId) ||
      typeof project.token !== "string" ||
      project.token.length === 0
    ) continue;
    credentials.push({
      projectId: project.projectId,
      agentId: projectAgentId(slug, project.projectId),
      accountId: `${slug}-proj-${project.projectId}`,
      token: project.token,
    });
  }
  return credentials.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

async function handleConfiguredUserBootstrap(
  { records, store }: Pick<ResolvedFleetBrokerRouteDeps, "records" | "store">,
  req: Request,
  res: Response,
): Promise<void> {
  const bound = boundGateway(req, res);
  if (!bound) return;
  const request = configuredUserBootstrapRequest(bound.gatewayId, bound.podName, req.body);
  if (!request) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const gateway = (await store.gateways.roots.get(bound.gatewayId)) ?? undefined;
  const uid = projectGatewayMutableConfigForGateway(gateway, bound.gatewayId)?.ownerUid ?? null;
  if (
    typeof uid !== "string" ||
    !configuredUserCredentialBootstrapAllowed(gateway, {
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      slug: request.slug,
      uid,
    })
  ) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const [userRecord, user, defaultAgent, agent, projectAgents] = await Promise.all([
    store.users.records.get(uid),
    records.userDocuments.account(uid),
    defaultAgentMattermostSecret(store, uid),
    records.userDocuments.agent(uid),
    collectStoredProjectAgentStates(store, uid, request.slug),
  ]);
  let bootstrap: FleetBrokerConfiguredUserBootstrap | null;
  try {
    bootstrap = configuredUserBootstrapPayload({
      uid,
      slug: request.slug,
      userRecord,
      user,
      defaultAgent,
      agent,
      projectCredentials: configuredUserProjectCredentials(request.slug, projectAgents),
    });
  } catch (error) {
    if (!(error instanceof CorruptStoredFieldError)) throw error;
    logger.error("[fleet-broker] configured user bootstrap refused: corrupt stored identity", { uid, slug: request.slug, error: error.message });
    res.status(500).json({ error: "corrupt_stored_identity", detail: error.message });
    return;
  }
  if (!bootstrap) {
    res.status(404).json({ error: "configured_builder_bootstrap_unavailable" });
    return;
  }
  res.json({ bootstrap });
}

function installToolchainStatusRoute(router: Router, store: PlatformStateStore): void {
  router.post("/set-toolchain-status", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const status = objectBody(req).status;
    if (!isDeveloperToolchainStatus(status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    await runBrokered(res, async () => {
      await store.transaction({ label: "fleet-broker.set-toolchain-status" }, async (tx) => {
        const userRecord = await tx.users.records.get(assigned.uid);
        if (!userRecord) throw new MissingRecordError({ aggregate: "builder", key: assigned.uid });
        await tx.users.records.patch(assigned.uid, {
          openclaw: { toolchain: { ...userRecord.openclaw.toolchain, status, updatedAt: { serverNow: true } } },
        });
      });
      res.status(204).end();
    });
  });
}

function installRuntimeResetAckRoute(router: Router, store: PlatformStateStore): void {
  router.post("/runtime-reset-ack", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    const generation = body.generation;
    if (!operationId || !Number.isSafeInteger(generation) || (generation as number) < 0) {
      res.status(400).json({ error: "invalid_runtime_reset_ack" });
      return;
    }
    await runBrokered(res, async () => {
      const result = await store.transaction({ label: "fleet-broker.runtime-reset-ack" }, async (tx) => {
        const [userRecord, assignment] = await Promise.all([
          tx.users.records.get(assigned.uid),
          tx.gateways.assignments.get(assigned.bound.gatewayId, assigned.uid),
        ]);
        if (userRecord?.gateway?.gatewayId !== assigned.bound.gatewayId) {
          return "conflict" as const;
        }
        const marker = storedRuntimeReset(userRecord);
        if (!marker) return "missing" as const;
        if (marker.status === "acknowledged") return "missing" as const;
        const exact = [
          marker.uid === assigned.uid,
          marker.slug === userRecord.slug,
          marker.targetGatewayId === assigned.bound.gatewayId,
          marker.operationId === operationId,
          marker.generation === generation,
          assignment?.gatewayId === assigned.bound.gatewayId,
          assignment?.epoch === marker.generation,
          assignment?.source === "repair",
          assignment?.updatedByOperationId === marker.operationId,
        ].every(Boolean);
        if (!exact) return "conflict" as const;
        await tx.users.records.setFence(assigned.uid, "runtimeReset", {
          ...marker,
          status: "acknowledged",
          acknowledgedAt: { serverNow: true },
        });
        return "acked" as const;
      });
      if (result === "conflict") {
        res.status(409).json({ error: "runtime_reset_fence_changed" });
        return;
      }
      res.status(204).end();
    });
  });
}

function installProjectAgentReadinessRoute(router: Router, { store }: Pick<ResolvedFleetBrokerRouteDeps, "store">): void {
  router.post("/project-agent-readiness", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const projects = parseProjectAgentReadinessReports(objectBody(req).projects);
    if (!projects) {
      res.status(400).json({ error: "invalid_project_agent_readiness" });
      return;
    }
    await runBrokered(res, async () => {
      const accepted = await completeProjectAgentReadiness(store, {
        uid: assigned.uid,
        gatewayId: assigned.bound.gatewayId,
        slug: builderSlug(assigned.userRecord),
        projects,
      });
      if (!accepted) {
        res.status(409).json({ error: "stale_project_agent_readiness" });
        return;
      }
      res.status(204).end();
    });
  });

}

function installProvisioningRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { records, store, provisionMattermost, markProvisioningComplete, onUserProvisioned, now } = deps;
  // A pod re-reports the same mount failure every reconcile cycle, and each write
  // to gateways/{id} costs the fleet a Firestore snapshot event. Repeats inside
  // the window are acknowledged without a write; anything new lands immediately.
  const reportedReconcileErrors = new Map<string, { report: string; at: number }>();
  installToolchainStatusRoute(router, store);
  installRuntimeResetAckRoute(router, store);

  router.post("/set-provisioning-status", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const status = objectBody(req).status;
    if (!isProvisioningStatus(status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    await runBrokered(res, async () => {
      await store.users.records.patch(assigned.uid, {
        openclaw: { status },
        provisioning: { status: status === "complete" ? "complete" : "in_progress" },
      });
      res.status(204).end();
    });
  });

  router.post("/set-repo-url", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const repoUrl = objectBody(req).repoUrl;
    if (typeof repoUrl !== "string" || repoUrl.length === 0 || repoUrl.length > 2048) {
      res.status(400).json({ error: "invalid_repo_url" });
      return;
    }
    await runBrokered(res, async () => {
      await store.users.records.patch(assigned.uid, {
        provisioning: { gitRepoUrl: repoUrl, gitCreatedAt: { serverNow: true } },
      });
      res.status(204).end();
    });
  });

  router.post("/provision-mattermost", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      const mmUpdate = await provisionMattermost({
        uid: assigned.uid,
        userData: await readUserAccountDocument(records, assigned.uid),
      });
      res.json({ mmUpdate });
    });
  });

  router.post("/set-mattermost-fields", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const mmUpdate = recordBodyValue(objectBody(req).mmUpdate);
    if (!mmUpdate) {
      res.status(400).json({ error: "invalid_mm_update" });
      return;
    }
    await runBrokered(res, async () => {
      const userData = await readUserAccountDocument(records, assigned.uid);
      await markProvisioningComplete({
        uid: assigned.uid,
        userData,
        mmUpdate,
      });
      const { slug } = assigned.userRecord;
      if (slug) await applyDefaultAgentLook({ uid: assigned.uid, slug }, deps);
      res.status(204).end();
    });
  });

  router.post("/set-agent-ids", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const agentIds = validAgentIds(objectBody(req).agentIds);
    if (!agentIds) {
      res.status(400).json({ error: "invalid_agent_ids" });
      return;
    }
    await runBrokered(res, async () => {
      if (agentIds.length > 0) {
        await store.users.records.addAgents(assigned.uid, agentIds);
      }
      res.status(204).end();
    });
  });

  installProjectAgentReadinessRoute(router, deps);

  router.post("/mounted", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const mounted = objectBody(req).mounted;
    if (typeof mounted !== "boolean") {
      res.status(400).json({ error: "invalid_mounted" });
      return;
    }
    await runBrokered(res, async () => {
      await store.users.records.patch(assigned.uid, { openclaw: { mounted } });
      res.status(204).end();
    });
  });

  router.post("/reconcile-error", async (req, res) => {
    const assigned = await requireAssignedSlug(store, req, res);
    if (!assigned) return;
    const message = objectBody(req).message;
    if (typeof message !== "string" || message.length === 0) {
      res.status(400).json({ error: "invalid_message" });
      return;
    }
    const { gatewayId } = assigned.bound;
    const truncated = message.slice(0, 2000);
    const report = `${assigned.slug}\0${truncated}`;
    const at = now();
    const reported = reportedReconcileErrors.get(gatewayId);
    if (
      reported &&
      reported.report === report &&
      at - reported.at < RECONCILE_ERROR_REPORT_WINDOW_MS
    ) {
      res.status(204).end();
      return;
    }
    await runBrokered(res, async () => {
      await store.gateways.roots.patch(gatewayId, {
        lastError: { slug: assigned.slug, message: truncated, at: { serverNow: true } },
      });
      reportedReconcileErrors.set(gatewayId, { report, at });
      res.status(204).end();
    });
  });

  router.post("/clear-reconcile-error", async (req, res) => {
    const assigned = await requireAssignedSlug(store, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      try {
        await store.gateways.roots.patch(assigned.bound.gatewayId, { lastError: null }, { lastErrorSlug: assigned.slug });
      } catch (error) {
        if (!(error instanceof FenceMismatchError) && !(error instanceof MissingRecordError)) throw error;
      }
      reportedReconcileErrors.delete(assigned.bound.gatewayId);
      res.status(204).end();
    });
  });

  router.post("/provisioned", async (req, res) => {
    const assigned = await requireAssignedUser(store, req, res);
    if (!assigned) return;
    const first = objectBody(req).first;
    if (typeof first !== "boolean") {
      res.status(400).json({ error: "invalid_first" });
      return;
    }
    await runBrokered(res, async () => {
      await onUserProvisioned({
        uid: assigned.uid,
        slug: assigned.userRecord.slug,
        mattermostUserId: assigned.userRecord.mattermostUserId,
        first,
      });
      res.status(204).end();
    });
  });
}

function installWorkspaceManifestRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { createBlobSignedUrl } = deps;

  router.post("/blob/manifest/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res);
    if (!assigned) return;
    const project = objectBody(req).projectSlug;
    if (project !== undefined && (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(project))) {
      res.status(400).json({ error: "invalid_project" }); return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: project ? `customers/${assigned.slug}/projects/${project}/${MANIFEST_OBJECT_SUFFIX}` : gcsPathForWorkspaceManifest(assigned.slug),
        action: "read",
      });
      res.json(signed);
    });
  });

  router.post("/blob/manifest/write-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res);
    if (!assigned) return;
    const precondition = validGenerationPrecondition(objectBody(req).ifGenerationMatch);
    if (precondition === null) {
      res.status(400).json({ error: "invalid_generation" });
      return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForWorkspaceManifest(assigned.slug),
        action: "write",
        contentType: "application/json",
        ifGenerationMatch: precondition,
      });
      res.json(signed);
    });
  });

}

function installBlobMaterializationRoute(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  router.post("/blob/project/upload-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const { projectSlug, sha256, size, md5Hash } = body;
    if (typeof projectSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(projectSlug) ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024 ||
      typeof md5Hash !== "string" || !/^[A-Za-z0-9+/]{22}==$/u.test(md5Hash)) {
      res.status(400).json({ error: "invalid_project_asset" }); return;
    }
    await runBrokered(res, async () => {
      res.json(await deps.createBlobSignedUrl({
        gcsPath: `customers/${assigned.slug}/projects/${projectSlug}/.objects/${sha256}`,
        action: "write", contentType: validContentType(body.mimeType), ifGenerationMatch: 0,
        contentMd5: md5Hash, contentLength: size,
      }));
    });
  });
  router.post("/blob/materialization/manifest/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res, true);
    if (!assigned) return;
    const project = objectBody(req).projectSlug;
    if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(project)) {
      res.status(400).json({ error: "invalid_project" }); return;
    }
    await runBrokered(res, async () => {
      const signed = await deps.createBlobSignedUrl({ gcsPath: `customers/${assigned.slug}/projects/${project}/${MANIFEST_OBJECT_SUFFIX}`, action: "read" });
      res.json(signed);
    });
  });
  router.post("/blob/materialization/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res, true);
    if (!assigned) return;
    const body = objectBody(req);
    const relativePath = validBlobRelativePath(body.path);
    const size = body.size;
    const sha256 = body.sha256;
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256))) {
      res.status(400).json({ error: "invalid_materialization" }); return;
    }
    if (!/^projects\/[a-z0-9][a-z0-9-]*\/.+/u.test(relativePath) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024) {
      res.status(400).json({ error: "invalid_materialization" }); return;
    }
    await runBrokered(res, async () => {
      const gcsPath = sha256
        ? `customers/${assigned.slug}/projects/${relativePath.split("/")[1]}/.objects/${sha256}`
        : gcsPathForBlob(assigned.slug, relativePath);
      const metadata = await deps.readBlobMetadata(gcsPath);
      const generation = typeof metadata.generation === "string" ? metadata.generation : "";
      const objectSize = typeof metadata.size === "string" && /^(0|[1-9]\d*)$/u.test(metadata.size) ? Number(metadata.size) : NaN;
      const md5Hash = typeof metadata.md5Hash === "string" ? metadata.md5Hash : "";
      if (!isBlobObjectVersion(generation, metadata.storage) || objectSize !== size || !/^[A-Za-z0-9+/]{22}==$/u.test(md5Hash)) {
        res.status(409).json({ error: "blob_identity_changed" }); return;
      }
      const download = await deps.createBlobSignedUrl({ gcsPath, action: "read", generation });
      res.json({ download, generation, size, md5Hash });
    });
  });
}

function installGatewayOpsRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const {
    records,
    store,
    createBlobSignedUrl,
    pruneIsolatedRuntimeState,
    now,
  } = deps;

  router.post("/system-config-status", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const authenticatedRevisionId = revisionIdFromGatewayPodName(bound.gatewayId, bound.podName);
    if (!authenticatedRevisionId || authenticatedRevisionId !== revisionId) {
      respondInvalidRevision(res, bound.gatewayId, revisionId);
      return;
    }
    const status = parseSystemConfigObservedStatus(req.body?.status);
    if (!status) {
      res.status(400).json({ error: "invalid_system_config_status" });
      return;
    }
    await runBrokered(res, async () => {
      const accepted = await recordRevisionSystemConfigStatus(store, {
        gatewayId: bound.gatewayId,
        revisionId,
        status,
      });
      if (!accepted) {
        res.status(409).json({ error: "revision_not_serving_gateway" });
        return;
      }
      res.status(204).end();
    });
  });

  router.post("/prestop-flush", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const event = validPreStopFlushEvent(objectBody(req));
    if (!event) {
      res.status(400).json({ error: "invalid_prestop_flush_event" });
      return;
    }
    await runBrokered(res, async () => {
      const accepted = await deps.store.transaction({ label: "fleet-broker.prestop-flush" }, async (tx) => {
        const gateway = await tx.gateways.roots.get(bound.gatewayId);
        if (!gateway || !isDurableGatewayRoot(gateway, bound.gatewayId)) return false;
        await tx.gateways.roots.patch(bound.gatewayId, { lastPreStopFlush: { ...event, at: { serverNow: true } } });
        return true;
      });
      if (!accepted) {
        res.status(409).json({ error: "gateway_config_missing", gatewayId: bound.gatewayId });
        return;
      }
      res.status(204).end();
    });
  });

  router.post("/usage-event", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = objectBody(req);
    const agentId = validAgentId(body.agentId);
    if (!agentId) {
      res.status(400).json({ error: "invalid_agent_id" });
      return;
    }
    const usage = validFleetBrokerUsageData(body.usage);
    if (!usage) {
      res.status(400).json({ error: "invalid_usage" });
      return;
    }
    const assigned = await findAssignedUserByAgentId(deps.store, bound.gatewayId, agentId);
    if (!assigned) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      await records.recordUsageEvent({
        uid: assigned.uid,
        agentId,
        usage,
        gatewayId: bound.gatewayId,
        workspaceSlug: assigned.slug,
      });
      res.status(204).end();
    });
  });

  router.post("/blob/download-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res);
    if (!assigned) return;
    const relativePath = validBlobRelativePath(objectBody(req).path);
    if (!relativePath) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForBlob(assigned.slug, relativePath),
        action: "read",
      });
      res.json(signed);
    });
  });

  router.post("/blob/upload-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.store, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const relativePath = validBlobRelativePath(body.path);
    if (!relativePath || ((process.env.BLOB_STORE_BACKEND ?? "s3") === "s3" && relativePath.split("/")[0] === "projects")) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }
    const size = finiteNonNegative(body.size);
    if (size === null || size > BLOB_SYNC_MAX_SIZE) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForBlob(assigned.slug, relativePath),
        action: "write",
        contentType: validContentType(body.mimeType),
      });
      res.json(signed);
    });
  });

  installWorkspaceManifestRoutes(router, deps);
  installBlobMaterializationRoute(router, deps);

  router.post("/builder-runtime-state/download-url", async (req, res) => {
    const configured = await requireConfiguredIsolatedRuntimeState(deps.store, req, res);
    if (!configured) return;
    await runBrokered(res, async () => {
      const signed = await deps.createIsolatedRuntimeStateSignedUrl({
        gcsPath: gcsPathForIsolatedRuntimeState(configured),
        action: "read",
      });
      res.json(signed);
    });
  });

  router.post("/builder-runtime-state/snapshot-urls", async (req, res) => {
    const configured = await requireConfiguredIsolatedRuntimeState(deps.store, req, res);
    if (!configured) return;
    const body = objectBody(req);
    const size = finiteNonNegative(body.size);
    if (size === null || size > ISOLATED_RUNTIME_STATE_MAX_SIZE) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }
    const recoveryTiers = validBuilderRuntimeStateRecoveryTiers(body.recoveryTiers);
    if (!recoveryTiers) {
      res.status(400).json({ error: "invalid_recovery_tiers" });
      return;
    }
    await runBrokered(res, async () => {
      const snapshotAt = now();
      const live = await deps.createIsolatedRuntimeStateSignedUrl({
        gcsPath: gcsPathForIsolatedRuntimeState(configured),
        action: "write",
        contentType: ISOLATED_RUNTIME_STATE_CONTENT_TYPE,
      });
      const recovery = await Promise.all(recoveryTiers.map((tier) => deps.createIsolatedRuntimeStateSignedUrl({
        gcsPath: runtimeStateRecoveryObjectPath(configured.slug, tier, snapshotAt),
        action: "write",
        contentType: ISOLATED_RUNTIME_STATE_CONTENT_TYPE,
        ifGenerationMatch: 0,
      })));
      const response: FleetBrokerIsolatedRuntimeStateSnapshotUrls = { live, recovery };
      res.json(response);
    });
  });

  router.post("/builder-runtime-state/prune", async (req, res) => {
    const configured = await requireConfiguredIsolatedRuntimeState(deps.store, req, res);
    if (!configured) return;
    await runBrokered(res, async () => {
      const deleted = await pruneIsolatedRuntimeStateForScope(deps.store, pruneIsolatedRuntimeState, configured, now());
      if (deleted === null) {
        res.status(409).json({ error: "runtime_state_allocation_superseded" });
        return;
      }
      const response: FleetBrokerIsolatedRuntimeStatePruneResult = { deleted };
      res.json(response);
    });
  });

  installVmHomeRoutes(router, deps);
  installOpenClawBootRoutes(router, deps);
}

function validatedHomeRestore(home: Partial<GatewayVmHomeState> | undefined, res: Response): GatewayVmHomeCheckpoint | undefined | null {
  const expected = home?.restoreCheckpoint;
  if (expected !== undefined && !isDisposableHomeCheckpoint(expected)) {
    res.status(409).json({ error: "home_restore_checkpoint_invalid" });
    return null;
  }
  return expected;
}

function homeCheckpointProtocolValid(coverage: unknown, writerProtocol: unknown): boolean {
  return (coverage === undefined || coverage === "builder-home-v2") && (writerProtocol === undefined || writerProtocol === 2);
}

function vmHomeBindingValid(glm: FleetRegistryRecord | undefined, bound: GatewayBinding, gateway: ReturnType<typeof projectGatewayDesiredRootForGateway>, slug: string): boolean {
  return resolveGatewayRuntime(glm?.runtime) === "gce-vm" && glm?.vm?.instanceId === bound.podUid
    && vmHomeGatewayEligible(gateway, slug, bound.finalHomeCheckpoint === true);
}

async function requireVmHomeScope(
  store: PlatformStateRepositories,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; slug: string; instanceId: string; ownerUid: string; restoreCheckpoint?: GatewayVmHomeCheckpoint } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  if (!bound.podUid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const [glm, root] = await Promise.all([
    readVmRuntimeObservation(store, bound.gatewayId),
    store.gateways.roots.get(bound.gatewayId),
  ]);
  const gateway = projectGatewayDesiredRootForGateway(root, bound.gatewayId);
  if (!vmHomeBindingValid(glm, bound, gateway, slug)) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const restoreCheckpoint = validatedHomeRestore(glm?.vmHome, res);
  if (restoreCheckpoint === null) return null;
  return { bound, slug, instanceId: bound.podUid, ownerUid: gateway!.ownerUid as string, ...(restoreCheckpoint ? { restoreCheckpoint } : {}) };
}

function vmHomeGatewayEligible(
  gateway: (ReturnType<typeof projectGatewayDesiredRootForGateway> & { retirementClaim?: unknown }) | null,
  slug: string,
  finalHomeCheckpoint: boolean,
): boolean {
  if (gateway === null) return false;
  const lifecycleAdmits = finalHomeCheckpoint
    ? gateway.desiredStatus === "retired"
    : gateway.desiredStatus === "running" && gateway.retireAfter == null && gateway.retirementClaim == null;
  return lifecycleAdmits &&
    gateway.gatewayClass === "isolated" &&
    gateway.builderSlug === slug &&
    typeof gateway.ownerUid === "string";
}

function respondVmHomeError(res: Response, error: unknown): boolean {
  if (!(error instanceof VmHomeCheckpointError)) return false;
  res.status(409).json({ error: error.code });
  return true;
}

function installVmHomeRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { store, createVmHomeSignedUrl, vmHomeStore, now } = deps;

  router.post("/computer-home/checkpoint-url", async (req, res) => {
    const scope = await requireVmHomeScope(store, req, res);
    if (!scope) return;
    const size = finiteNonNegative(objectBody(req).size);
    if (size === null || size === 0 || size > VM_HOME_CHECKPOINT_MAX_BYTES) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }
    await runBrokered(res, async () => {
      const name = vmHomeCheckpointName(now());
      const upload = await createVmHomeSignedUrl({
        gcsPath: vmHomeCheckpointPath(scope.slug, name),
        action: "write",
        contentType: VM_HOME_CHECKPOINT_CONTENT_TYPE,
        ifGenerationMatch: 0,
      });
      const response: FleetBrokerVmHomeCheckpointUrl = { name, upload };
      res.json(response);
    });
  });

  router.post("/computer-home/commit", async (req, res) => {
    const scope = await requireVmHomeScope(store, req, res);
    if (!scope) return;
    const body = objectBody(req);
    const name = validVmHomeCheckpointName(body.name);
    const sha256 = validSha256(body.sha256);
    const size = finiteNonNegative(body.size);
    const coverage = body.coverage;
    const writerProtocol = body.writerProtocol;
    const requestedAt = body.requestedAt === null ? null : finiteNonNegative(body.requestedAt);
    if (!homeCheckpointProtocolValid(coverage, writerProtocol)
      || (body.requestedAt !== null && requestedAt === null) || (requestedAt !== null && requestedAt > now())
      || !name || !sha256 || size === null || size === 0 || size > VM_HOME_CHECKPOINT_MAX_BYTES) {
      res.status(400).json({ error: "invalid_checkpoint" });
      return;
    }
    await runBrokered(res, async () => {
      let checkpoint: GatewayVmHomeCheckpoint = { name, size, sha256, instanceId: scope.instanceId, completedAt: now(), ...(coverage === "builder-home-v2" ? { coverage } : {}), ...(writerProtocol === 2 ? { writerProtocol } : {}) };
      try {
        checkpoint = await vmHomeStore.commit({
          checkpointPath: vmHomeCheckpointPath(scope.slug, name),
          currentPath: vmHomeCurrentPath(scope.slug),
          checkpoint,
        });
      } catch (error) {
        if (respondVmHomeError(res, error)) return;
        throw error;
      }
      const home: Pick<GatewayVmHomeState, "lastCheckpoint" | "checkpointAcknowledgedAt"> = { lastCheckpoint: checkpoint, checkpointAcknowledgedAt: requestedAt };
      await recordVmHomeCheckpoint(store, scope.bound.gatewayId, home, { uid: scope.ownerUid, instanceId: scope.instanceId });
      const response: FleetBrokerVmHomeCheckpointCommit = { name, size, sha256, completedAt: checkpoint.completedAt };
      res.json(response);
    });
  });

  router.post("/computer-home/download-url", async (req, res) => {
    const scope = await requireVmHomeScope(store, req, res);
    if (!scope) return;
    await runBrokered(res, async () => {
      const current = await vmHomeStore.readCurrent(vmHomeCurrentPath(scope.slug));
      if (!current) {
        res.status(scope.restoreCheckpoint ? 409 : 404).json({ error: scope.restoreCheckpoint ? "home_restore_checkpoint_unavailable" : "no_checkpoint" });
        return;
      }
      if (scope.restoreCheckpoint && !sameHomeCheckpoint(scope.restoreCheckpoint, current)) {
        res.status(409).json({ error: "home_restore_checkpoint_mismatch" });
        return;
      }
      const download = await createVmHomeSignedUrl({
        gcsPath: vmHomeCheckpointPath(scope.slug, current.name),
        action: "read",
        ...(current.generation ? { generation: current.generation } : {}),
      });
      const response: FleetBrokerVmHomeDownload = {
        name: current.name,
        size: current.size,
        sha256: current.sha256,
        completedAt: current.completedAt,
        instanceId: current.instanceId,
        ...(current.coverage ? { coverage: current.coverage } : {}),
        ...(current.writerProtocol ? { writerProtocol: current.writerProtocol } : {}),
        ...(current.generation ? { generation: current.generation } : {}),
        download,
      };
      res.json(response);
    });
  });

  router.post("/computer-home/prune", async (req, res) => {
    const scope = await requireVmHomeScope(store, req, res);
    if (!scope) return;
    await runBrokered(res, async () => {
      const current = await vmHomeStore.readCurrent(vmHomeCurrentPath(scope.slug));
      const deleted = await vmHomeStore.prune({
        checkpointsPrefix: vmHomeCheckpointsPrefix(scope.slug),
        currentName: current?.name ?? null,
        keep: VM_HOME_CHECKPOINT_KEEP,
      });
      const response: FleetBrokerVmHomePruneResult = { deleted };
      res.json(response);
    });
  });
}

// A chat-broker caller is validated in three layers:
// gateway binding (boundGateway) -> workspace assigned to that gateway ->
// exact workspace-owner turn proof -> user PAT resolution.
function validChatBrokerSiteUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

function forbiddenChatIdentityCode(code: unknown): boolean {
  return code === "foreign-agent" ||
    code === "no-builder-pat" ||
    code === "no-coach-identity" ||
    code === "no-project-pat" ||
    code === "project-archived";
}

function respondChatIdentityError(res: Response, error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "invalid-agent") {
    res.status(400).json({ error: "invalid_agent_id", code });
    return true;
  }
  if (!forbiddenChatIdentityCode(code)) return false;
  res.status(403).json({ error: "forbidden", code });
  return true;
}

async function assignedChatOwnerTurnAllowed(input: {
  deps: ResolvedFleetBrokerRouteDeps;
  req: Request;
  gatewayId: string;
  uid: string;
  userRecord: PlatformUserRecord | null;
  agentId: string;
}): Promise<boolean> {
  if (!input.userRecord || !userCarriesAgentId(input.userRecord, input.agentId)) return false;
  return verifyOwnerWorkspaceTurnFailClosed(input.deps.verifyOwnerWorkspaceTurn, {
    req: input.req,
    gatewayId: input.gatewayId,
    agentId: input.agentId,
    ownerUid: input.uid,
    owner: input.userRecord,
  }, "agent-chat");
}

async function requireAssignedChatIdentity(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
): Promise<{ identity: ChatBrokerIdentity; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const body = objectBody(req);
  const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_workspace_slug" });
    return null;
  }
  const agentId = validAgentId(body.agentId);
  if (!agentId) {
    res.status(400).json({ error: "invalid_agent_id" });
    return null;
  }
  const siteUrl = validChatBrokerSiteUrl(body.siteUrl);
  if (!siteUrl) {
    res.status(400).json({ error: "invalid_site_url" });
    return null;
  }
  const uid = await findAssignedUidBySlug(deps.store, bound.gatewayId, slug);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const userRecord = await assignedUser(deps.store, bound.gatewayId, uid);
  if (!await assignedChatOwnerTurnAllowed({
    deps,
    req,
    gatewayId: bound.gatewayId,
    uid,
    userRecord,
    agentId,
  })) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  try {
    const resolved = await deps.resolveChatIdentity(deps, { uid, slug, agentId });
    return {
      slug,
      identity: {
        pat: resolved.pat,
        defaultAgentMmUserId: resolved.defaultAgentMmUserId,
        unread: resolved.unread,
        slug,
        siteUrl,
        ...(resolved.canReadChannel
          ? { canReadChannel: resolved.canReadChannel }
          : {}),
        ...(resolved.includeArchivedProjectHistory === true
          ? { includeArchivedProjectHistory: true as const }
          : {}),
      },
    };
  } catch (err) {
    if (respondChatIdentityError(res, err)) return null;
    throw err;
  }
}

async function respondChatBrokerError(res: Response, err: unknown): Promise<void> {
  const { chatBrokerErrorStatus } = await import(
    "../../../gateway-edge/src/lib/chat-broker/execute.js"
  );
  const { status, code } = chatBrokerErrorStatus(err);
  res.status(status).json({
    error: err instanceof Error ? err.message : String(err),
    code,
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items = value.map((item) => boundedString(item, 1, maxLength));
  return items.every((item): item is string => item !== null) ? items : undefined;
}

function publicHttpUrl(value: unknown): string | null {
  const raw = boundedString(value, 1, 4_096);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const internalName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal");
    const nonPublicIp = isIP(host) !== 0 && !isPublicIp(host);
    return internalName || nonPublicIp ? null : parsed.toString();
  } catch {
    return null;
  }
}

function httpUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const urls = value.map(publicHttpUrl);
  return urls.every((url): url is string => url !== null) ? urls : null;
}

type WebAgentAttribution = {
  gatewayId: string;
  ownerUid: string;
  agentId: string;
  requestId: string;
};

type WebSearchInputResult =
  | { input: WebResearchSearchInput }
  | { error: "invalid_query" | "invalid_provider" | "invalid_search_options" };

function optionalField<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function braveWebSearchInput(
  body: Record<string, unknown>,
  assigned: WebAgentAttribution,
  query: string,
): WebSearchInputResult {
  const count = boundedInteger(body.count, 1, 10);
  const country = boundedString(body.country, 2, 2);
  const searchLang = boundedString(body.searchLang, 2, 10);
  const uiLang = boundedString(body.uiLang, 2, 10);
  const freshness = enumValue(body.freshness, ["day", "week", "month", "year"] as const);
  const invalid =
    (body.count !== undefined && count === undefined) ||
    (body.country !== undefined && country === null) ||
    (body.searchLang !== undefined && searchLang === null) ||
    (body.uiLang !== undefined && uiLang === null) ||
    (body.freshness !== undefined && freshness === undefined);
  if (invalid) return { error: "invalid_search_options" };
  return {
    input: {
      ...assigned,
      provider: "brave",
      query,
      ...optionalField("count", count),
      ...optionalField("country", country?.toUpperCase()),
      ...optionalField("searchLang", searchLang),
      ...optionalField("uiLang", uiLang),
      ...optionalField("freshness", freshness),
    },
  };
}

function tavilyWebSearchInput(
  body: Record<string, unknown>,
  assigned: WebAgentAttribution,
  query: string,
): WebSearchInputResult {
  const maxResults = boundedInteger(body.maxResults, 1, 20);
  const includeDomains = stringList(body.includeDomains, 20, 253);
  const excludeDomains = stringList(body.excludeDomains, 20, 253);
  const invalid =
    (body.maxResults !== undefined && maxResults === undefined) ||
    (body.includeDomains !== undefined && includeDomains === undefined) ||
    (body.excludeDomains !== undefined && excludeDomains === undefined);
  if (invalid) return { error: "invalid_search_options" };
  const searchDepth = enumValue(body.searchDepth, ["basic", "advanced"] as const);
  const topic = enumValue(body.topic, ["general", "news", "finance"] as const);
  const timeRange = enumValue(body.timeRange, ["day", "week", "month", "year"] as const);
  return {
    input: {
      ...assigned,
      provider: "tavily",
      query,
      ...optionalField("searchDepth", searchDepth),
      ...optionalField("topic", topic),
      ...optionalField("maxResults", maxResults),
      ...optionalField("timeRange", timeRange),
      ...optionalField("includeDomains", includeDomains),
      ...optionalField("excludeDomains", excludeDomains),
    },
  };
}

function webSearchInput(
  body: Record<string, unknown>,
  assigned: WebAgentAttribution,
): WebSearchInputResult {
  const query = boundedString(body.query, 2, 500);
  if (!query) return { error: "invalid_query" };
  const provider = enumValue(body.provider, ["brave", "tavily"] as const);
  if (!provider) return { error: "invalid_provider" };
  return provider === "brave"
    ? braveWebSearchInput(body, assigned, query)
    : tavilyWebSearchInput(body, assigned, query);
}

async function assignedWebAgent(
  store: PlatformStateRepositories,
  req: Request,
  res: Response,
): Promise<WebAgentAttribution | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const body = objectBody(req);
  const agentId = validAgentId(body.agentId);
  const requestId = boundedString(body.requestId, 1, 200);
  if (!agentId) {
    res.status(400).json({ error: "invalid_agent_id" });
    return null;
  }
  if (!requestId) {
    res.status(400).json({ error: "invalid_request_id" });
    return null;
  }
  const assigned = await findAssignedUserByAgentId(store, bound.gatewayId, agentId);
  if (!assigned) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { gatewayId: bound.gatewayId, ownerUid: assigned.uid, agentId, requestId };
}

function respondWebResearchError(res: Response, error: unknown): void {
  if (error instanceof WebResearchError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error("web research broker failed", { error });
  res.status(502).json({ error: "Web research provider failed", code: "provider_error" });
}

async function recordVmDiskReport(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
  bound: GatewayBinding,
  observation: FleetRegistryRecord | undefined,
): Promise<boolean> {
  const disk = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.disk;
  if (disk === undefined) return true;
  if (!isGatewayVmDiskSample(disk)) {
    res.status(400).json({ error: "invalid_disk_sample" });
    return false;
  }
  if (!bound.podUid || observation?.vm?.instanceId !== bound.podUid) return true;
  try {
    await recordVmDiskObservation(deps.store, bound.gatewayId, observation?.vmDisk, { ...disk, instanceId: bound.podUid, observedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] VM disk observation failed", { gatewayId: bound.gatewayId, error });
  }
  return true;
}

async function recordVmPreemptionNotice(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
  bound: GatewayBinding,
  observation: FleetRegistryRecord | undefined,
): Promise<boolean> {
  const preempted = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.preempted;
  if (preempted === undefined) return true;
  if (preempted !== true) {
    res.status(400).json({ error: "invalid_preemption_notice" });
    return false;
  }
  if (!bound.podUid || observation?.vm?.instanceId !== bound.podUid) return true;
  logger.warn("[fleet-broker] VM announced its Spot preemption", { gatewayId: bound.gatewayId, instanceId: bound.podUid });
  try {
    await persistVmPreemptionNotice(deps.store, bound.gatewayId, { instanceId: bound.podUid, announcedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] VM preemption notice not recorded", { gatewayId: bound.gatewayId, error });
    res.status(503).json({ error: "preemption_notice_unrecorded" });
    return false;
  }
  return true;
}

async function recordVmImageReport(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
  bound: GatewayBinding,
): Promise<boolean> {
  const images = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.images;
  if (images === undefined) return true;
  if (!isGatewayVmImageSample(images)) {
    res.status(400).json({ error: "invalid_image_sample" });
    return false;
  }
  if (!bound.podUid) return true;
  const containers = images.containers.map(({ name, imageReference, digests, running }) => ({ name, imageReference, digests, running }));
  try {
    await recordVmImageObservation(deps.store, bound.gatewayId, { containers, instanceId: bound.podUid, observedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] VM image observation failed", { gatewayId: bound.gatewayId, error });
    res.status(503).json({ error: "image_observation_unrecorded" });
    return false;
  }
  return true;
}

async function recordVmBootRecoveryReport(deps: ResolvedFleetBrokerRouteDeps, req: Request, res: Response, bound: GatewayBinding, bundleVersion: string): Promise<boolean> {
  const sample = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.bootRecovery;
  if (sample === undefined) return true;
  if (!isGatewayVmBootRecoverySample(sample)) { res.status(400).json({ error: "invalid_boot_recovery_sample" }); return false; }
  if (!bound.podUid || sample.ready && sample.bundleVersion !== bundleVersion) return true;
  const { currentPointId, retainedPoints, ready, freeBytes } = sample;
  try {
    await recordVmBootRecovery(deps.store, bound.gatewayId, { currentPointId, retainedPoints, ready, freeBytes, bundleVersion: sample.bundleVersion, instanceId: bound.podUid, observedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] VM boot recovery observation failed", { gatewayId: bound.gatewayId, error });
    res.status(503).json({ error: "boot_recovery_unrecorded" }); return false;
  }
  return true;
}

function vmRuntimeCheckpointSignal(home: Partial<GatewayVmHomeState> | undefined): GatewayVmRuntimeResponse["homeCheckpoint"] {
  return {
    requestedAt: typeof home?.checkpointRequestedAt === "number" ? home.checkpointRequestedAt : null,
    completedAt: !homeCheckpointOutstanding(home) && typeof home?.lastCheckpoint?.completedAt === "number" ? home.lastCheckpoint.completedAt : null,
  };
}

function installVmRuntimeRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { store } = deps;
  router.post("/vm-runtime", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const [stored, observation] = await Promise.all([
      store.gateways.vmRuntime.get(bound.gatewayId),
      readVmRuntimeObservation(store, bound.gatewayId),
    ]);
    if (!stored) {
      res.status(404).json({ error: "vm_runtime_not_rendered" });
      return;
    }
    const { revision: _revision, ...bundle } = stored;
    if (!(await recordVmBootRecoveryReport(deps, req, res, bound, bundle.version))) return;
    if (!(await recordVmImageReport(deps, req, res, bound))) return;
    if (!(await recordVmPreemptionNotice(deps, req, res, bound, observation))) return;
    if (!(await recordVmDiskReport(deps, req, res, bound, observation))) return;
    const home = observation?.vmHome;
    const restoreCheckpoint = validatedHomeRestore(home, res);
    if (restoreCheckpoint === null) return;
    const response: GatewayVmRuntimeResponse = {
      bundle: { ...bundle, ...(restoreCheckpoint ? { homeRestoreCheckpoint: restoreCheckpoint } : {}) },
      homeCheckpoint: vmRuntimeCheckpointSignal(home),
    };
    res.set("cache-control", "no-store");
    res.json(response);
  });
}

function installVmEgressRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { store, now } = deps;
  router.post("/computer-egress", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const requested = objectBody(req).mode;
    if (requested !== undefined && !isGatewayEgressMode(requested)) {
      res.status(400).json({ error: "invalid_egress_mode" });
      return;
    }
    const record = await readVmEgress(store, bound.gatewayId);
    if (record.kind === "missing") {
      res.status(404).json({ error: "gateway_not_found" });
      return;
    }
    let egress: GatewayVmEgressState | null = null;
    if (requested) {
      egress = { mode: requested, updatedAt: now() };
      if (await recordVmEgress(store, bound.gatewayId, egress) === "missing") {
        res.status(404).json({ error: "gateway_not_found" });
        return;
      }
    } else if (record.kind === "malformed") {
      logger.error("[fleet-broker] stored VM egress record is malformed", { gatewayId: bound.gatewayId, stored: record.stored });
      res.status(409).json({ error: "egress_record_malformed" });
      return;
    } else if (record.kind === "stored") {
      egress = record.egress;
    }
    const response: FleetBrokerVmEgress = { egress };
    res.set("cache-control", "no-store").json(response);
  });
}

function installAgentRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { renderAvatar, records } = deps;

  router.post("/agent/chat-search", async (req, res) => {
    const assigned = await requireAssignedChatIdentity(deps, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length < 2) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    try {
      const payload = await deps.executeChatSearch(assigned.identity, {
        query,
        scope: body.scope === "current_channel" ? "current_channel" : "all_visible",
        limit: optionalInt(body.limit),
        currentChannelId: optionalString(body.currentChannelId),
      });
      res.json(payload);
    } catch (err) {
      await respondChatBrokerError(res, err);
    }
  });

  router.post("/agent/chat-history", async (req, res) => {
    const assigned = await requireAssignedChatIdentity(deps, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    try {
      const payload = await deps.executeChatHistory(assigned.identity, {
        channel: optionalString(body.channel),
        direction: optionalString(body.direction),
        cursor: optionalString(body.cursor),
        limit: optionalInt(body.limit),
        fromUsername: optionalString(body.fromUsername),
        currentChannelId: optionalString(body.currentChannelId),
      });
      res.json(payload);
    } catch (err) {
      await respondChatBrokerError(res, err);
    }
  });

  router.post("/agent/web-search", async (req, res) => {
    const assigned = await assignedWebAgent(deps.store, req, res);
    if (!assigned) return;
    const parsed = webSearchInput(objectBody(req), assigned);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      res.json(await deps.webResearch.search(parsed.input));
    } catch (error) {
      respondWebResearchError(res, error);
    }
  });

  router.post("/agent/web-extract", async (req, res) => {
    const assigned = await assignedWebAgent(deps.store, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const urls = httpUrls(body.urls);
    if (!urls) {
      res.status(400).json({ error: "invalid_urls" });
      return;
    }
    const query = body.query === undefined ? undefined : boundedString(body.query, 1, 500);
    if (body.query !== undefined && !query) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const extractDepth = enumValue(body.extractDepth, ["basic", "advanced"] as const);
    if (body.extractDepth !== undefined && !extractDepth) {
      res.status(400).json({ error: "invalid_extract_depth" });
      return;
    }
    const input: WebResearchExtractInput = {
      ...assigned,
      urls,
      ...(query ? { query } : {}),
      ...(extractDepth ? { extractDepth } : {}),
    };
    try {
      res.json(await deps.webResearch.extract(input));
    } catch (error) {
      respondWebResearchError(res, error);
    }
  });

  router.post("/agent/set-coach-identity", brokerRequestLimit(240), async (req, res) => {
    const assigned = await requireAssignedAgentWorkspace(deps, req, res);
    if (!assigned) return;
    if (!await verifyOwnerWorkspaceTurnFailClosed(deps.verifyOwnerWorkspaceTurn, {
      req,
      gatewayId: assigned.bound.gatewayId,
      agentId: assigned.agentId,
      ownerUid: assigned.uid,
      owner: assigned.userRecord,
    }, "set-coach-identity")) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const body = objectBody(req);

    const patch: { name?: string; persona?: string; emoji?: string; avatarPng?: Buffer } = {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name) {
      if (name.length > 80) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      patch.name = name;
    }
    if (body.emoji !== undefined) {
      if (!validIdentityEmoji(body.emoji)) {
        res.status(400).json({ error: "invalid_emoji" }); return;
      }
      patch.emoji = body.emoji.trim();
    }
    const vibe = typeof body.vibe === "string" ? body.vibe : body.persona;
    if (typeof vibe === "string") {
      if (vibe.length > 2000) {
        res.status(400).json({ error: "invalid_persona" });
        return;
      }
      patch.persona = vibe;
    }
    if (typeof body.avatarBase64 === "string" && body.avatarBase64) {
      const raw = Buffer.from(body.avatarBase64, "base64");
      try {
        patch.avatarPng = await renderAvatar(raw);
      } catch {
        res.status(400).json({ error: "invalid_avatar" });
        return;
      }
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "empty_identity" });
      return;
    }

    await runBrokered(res, async () => {
      const updated = await records.agentIdentity.sync(assigned.uid, {
        name: patch.name,
        persona: patch.persona,
        ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
        avatarPng: patch.avatarPng,
      }, { slug: assigned.slug });
      res.json({ updated });
    });
  });
}

export function createFleetBrokerRoutes(opts: FleetBrokerRouteOptions): Router {
  const router = Router();
  const deps = resolveFleetBrokerRouteDeps(opts);
  installSnapshotRoutes(router, deps);
  installUserIdentityRoute(router, deps.store);
  installProvisioningRoutes(router, deps);
  installGatewayOpsRoutes(router, deps);
  installVmRuntimeRoutes(router, deps);
  installVmEgressRoutes(router, deps);
  installAgentRoutes(router, deps);
  installWorkspaceBlobBrokerRoute(router, { store: deps.store, blobStore: opts.workspaceBlobStore, authorize: async (req, res, slug) => {
    req.body = { slug };
    const assigned = await requireAssignedSlug(deps.store, req, res);
    return assigned ? { uid: assigned.uid, slug: assigned.slug, gatewayId: assigned.bound.gatewayId } : null;
  } });
  return router;
}
