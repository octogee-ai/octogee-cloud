import { runHeldSourceReconcile, type HeldNativeSourceKeeper } from "./held-native-source-reconcile.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { projectAgentWorkspace } from "@octogee/core/project-agent-workspaces";
import { assertSafeStagedSymlinks, RSYNC_DAEMON_SYMLINK_POLICY, STAGED_RSYNC_COPY_OPTIONS } from "./rsync-staged-symlinks.js";
import { isDeepStrictEqual } from "node:util";
import { projectCheckoutEnabled } from "@octogee/shared/types/project";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { updateVoiceMigration, type VoiceMigrationInput } from './voice-migration.js';
import {
  clearMigrationStaging, prepareMigrationStaging, readLiveImportAdmission, writeLiveImportAdmission,
  type LiveImportAdmission, type MigrationStagingIdentity,
} from "./migration-staging.js";
import { sourceTransferRsyncArgs } from "./source-transfer-rsync.js";
import { deferredProjectPlaceholderPaths } from "./deferred-project-workspace.js";
import { sourcesForPushMode } from "./source-transfer-plan.js";
import { log as provisionerLog } from "@octogee/core/config";
import { withLogContext, setLogContext, type LogContext } from "@octogee/shared/server/service-logger";


import type { Request, Response, RequestHandler } from "express";
import { findUnsafeUserGitMetadataEntry } from "@octogee/core/git-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readPostgresAgentAnchor, queryAgentStore } from "@octogee/core/agent-postgres";
import { CODEX_SNAPSHOT_EXCLUDE_ARG, CODEX_STORE_EXCLUDE_ARGS, CODEX_TEMP_EXCLUDE_ARG, discardCodexStoreSnapshots, installCodexStoreSnapshots, isCodexDatabase, omitRawCodexDatabases, omitStagedCodexTemporaryFiles, prepareCodexStoreSnapshots } from "./codex-store-snapshot.js";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  isSchedulerRequesterProfileId,
  type SchedulerMigrationRequestBody,
  type ScheduleCheckResult,
  type ScheduleRecord,
  type ScheduleRemoveResult,
  type ScheduleRestoreResult,
  type ScheduleSnapshotResult,
  type ScheduleTransferRequestBody,
  type AbortRsyncImportRequestBody,
  type ImportResponse,
  type ActivateImportRequestBody,
  type ActivationManifestExportRequestBody,
  type ActivationManifestExportResponse,
  type ExportPathsRequestBody,
  type ExportPathsResponse,
  type FinishRsyncImportRequestBody,
  type FlushGatewayRequestBody,
  type FlushGatewayResponse,
  type CompleteSurgeHandoffRequestBody,
  type MigrationConfigTransferMode,
  type MigrationLoadStrategy,
  type MigrationRequestBody,
  type MigrationProgressRequestBody,
  type MigrationTransferMode,
  type PrepareRsyncImportRequestBody,
  type PrepareRsyncImportResponse,
  type PrepareImportRequestBody,
  type PushRsyncStateRequestBody,
  type QuiesceRequestBody,
  type QuiesceResponse,
  type RsyncMigrationRpcPhase,
  type RestoreMigrationRequestBody,
  type RestoreMigrationResponse,
  type HeldNativeSourceReconcileRequest,
  type UnmountRequestBody,
  type UnmountResponse,
  type VerifyMigrationRequestBody,
  type VerifyMigrationResponse,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS,
  MIGRATION_RSYNC_PORT_DEFAULT,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerAgentAnchor } from "@octogee/shared/types/fleet-broker";
import { isValidUsername, parseAgentId } from "@octogee/shared/types/identity";
import {
  findUnreadableStore,
  listSqliteStores,
} from "./agent-store-carry.js";
import {
  findPortableAgentStores,
  AGENT_STORE_BASENAME,
  exportAgentStoreSnapshots,
  findStagedAgentSnapshots,
  findStagedLiveAgentStores,
  installPreparedAgentStores,
  isAgentSnapshotArtifact,
  prepareAgentStoreSnapshots,
  type PreparedAgentStores,
} from "./agent-store-snapshot.js";
import {
  isMigrationCertificatePem,
  openMigrationTlsEndpoint,
  reserveLoopbackPort,
  rsyncTlsConnectProgram,
  type MigrationTlsEndpoint,
  type OpenMigrationTlsEndpoint,
} from "./migration-rsync-tls.js";
import type { OpenClawCommand } from "./openclaw-cli.js";
import { upgradeImportedAgentStores } from "./openclaw-import-upgrade.js";
import { reattachUserAgents } from "./reattach-user-agents.js";
import { activeAgentProjectIds } from "./openclaw-config-users.js";
import { PROC_ROOT } from "./held-files.js";
import { heldNativeSourceReconcileJobId, gatewayScopedJobId, sourceActivationReadinessJobId, verifyFleetRequest } from "./fleet-signature.js";
import { rejectMisaddressedGateway } from "./fleet-gateway-path.js";
import type { UserLifecycleAdapter, RemoveUserResult } from "./user-lifecycle.js";
import {
  cloneMissingProjects,
  restoreUserRuntimeFromSnapshot,
  type RestoreUserRuntimeResult,
  type UserSnapshot,
} from "./user-lifecycle.js";
import { withUserRemoval } from "./user-removal-exclusion.js";
import {
  MIGRATION_ACTIVATION_DIR,
  writeActivationManifest,
  assertSourceIdentityCustody,
  captureSourceWorkspaceIdentities,
  captureTargetWorkspaceIdentities,
  privateProjectWorkspaceAgentIds,
  restoreTargetWorkspaceIdentities,
  validateTargetWorkspaceIdentities,
  assertTargetIdentityCustody,
  type TargetWorkspaceIdentities,
  type MigrationTargetIdentityCustody,
  readActivationManifest,
} from "./migration-activation-manifest.js";
import {
  disableSystemConfigWatch,
  enableSystemConfigWatch,
  isConfiguredGatewayUser,
  readSystemConfigWatchFenceGeneration,
} from "./system-config-watch-state.js";
import { dlog, OPENCLAW_DIR } from "./config.js";
import { userFileStatePaths } from "./user-file-state.js";
import { openClawConfigPath } from "./openclaw-config-path.js";
import {
  assertConfiguredUserPortableStatePlanOnDisk,
  configuredUserPortableStatePlan,
  configuredUserPortableStatePlanFromConfig,
  configuredUserStatePlanAllowsEntry,
  isSafeConfiguredAgentId,
  type ConfiguredUserPortableStatePlan,
} from "./local-default-agent-wired.js";
import {
  isSafeDefaultAgentPortableStatePath,
  SAFE_DEFAULT_AGENT_PORTABLE_STATE_PATHS,
} from "./openclaw-config-users.js";
import { OpenclawWireError } from "./gateway-rpc.js";
import { isRetryableSchedulerFailure, SchedulerRefusal } from "./scheduler-failure.js";
import type { SurgeOpenClawProcessGateState } from "./surge-openclaw-process-gate.js";
import { NEEDS_FULL_ATTACH_FINGERPRINT, importReconciliationPending, pendingCloneAppliedFingerprint, pendingImportAppliedFingerprint } from "./pending-clone-fingerprint.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;
const USER_SYSTEM_CONFIG_TRANSFER = "configured-builder-system-config" as const;
const ACTIVATION_MANIFEST_TRANSFER = "activation-manifest" as const;

export interface SourceMountRefusal {
  reason: string;
  converged: boolean;
}

export interface MigrationHandlerDeps {
  getHeldSourceKeeper?: () => HeldNativeSourceKeeper | undefined;
  readHeldSourceSnapshot?: (uid: string) => Promise<FleetBrokerUserSnapshot | null>;
  voiceMigration?: (input: VoiceMigrationInput) => Promise<{ activeCalls: number }>;
  voiceDrainWaitMs?: number;
  voiceDrainSleep?: (ms: number) => Promise<void>;
  publicKey: string;
  gatewayId: string;
  adapter: UserLifecycleAdapter;
  readTargetImportPermit?: (slug: string) => Promise<"permitted" | "held">;
  scheduleTransfer?: (
    body: ScheduleTransferRequestBody,
  ) => Promise<ScheduleSnapshotResult | ScheduleRestoreResult | ScheduleRemoveResult | ScheduleCheckResult>;

  log?: (msg: string, fields?: LogContext) => void;

  now?: () => number;

getMountedUsers?: () => readonly string[];

userAttachPending?: (slug: string) => Promise<boolean>;

sourceMountRefusal?: (slug: string) => SourceMountRefusal | null;

fetch?: typeof globalThis.fetch;

pushStateTimeoutMs?: number;

migrationRsyncPort?: number;

waitForRsyncReady?: (port: number) => Promise<void>;

flushLocalState?: (input: {
  slug: string;
  reason: string;
  expectedSystemConfigCommit?: string;
}) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
prepareSurgeTarget?: (input: { migrationId: string; slug: string; targetPodUid: string }, signal?: AbortSignal) => Promise<void>;
releaseSurgeReadiness?: (input: { migrationId: string; targetPodUid: string; importSlug?: string }) => Promise<void>;
reserveSurgeTarget?: (input: { migrationId: string; slug: string }) => Promise<void>;
surgeTargetOpenClawHeld?: (input: {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}) => Promise<boolean>;
surgeSourceOpenClawHeld?: (input: { migrationId: string; slug: string }) => Promise<boolean>;
surgeTargetLive?: (input: { migrationId: string; slug: string; targetPodUid: string }) => Promise<boolean>;
admitLiveSurgeTarget?: (input: { migrationId: string; slug: string; targetPodUid: string }) => Promise<void>;
liveSurgeTargetAssigned?: (input: { migrationId: string; slug: string; targetPodUid: string }) => Promise<boolean>;
unreserveSurgeTarget?: (input: {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}, cleanup?: (assertCurrent: () => Promise<void>) => Promise<void>) => Promise<SurgeOpenClawProcessGateState>;
pauseSystemConfigWatch?: (slug: string) => Promise<string | void>;
readSystemConfigWatchFence?: (slug: string) => Promise<string | null>;
resumeSystemConfigWatch?: (
  slug: string,
  expectedGeneration?: string | null,
) => Promise<boolean | void>;
runOpenClaw?: OpenClawCommand;
upgradeImportedAgents?: typeof upgradeImportedAgentStores;
surgeReleaseInProgress?: () => boolean;
openMigrationTlsEndpoint?: OpenMigrationTlsEndpoint;
reserveLoopbackPort?: () => Promise<number>;
procRoot?: string;
}


async function releaseAgentForImport(
  deps: MigrationHandlerDeps,
  activation: ConfiguredUserActivation | null,
  agentId: string,
  log: (message: string, fields?: LogContext) => void,
  heldTarget?: UserImportTarget,
): Promise<void> {
  if (heldTarget) {
    await assertSystemConfigImportHeld(deps, heldTarget);
    log(`[migration-rsync] OpenClaw is held for this boot; replacing ${agentId}'s database offline`);
    return;
  }
  if (activation && !activation.live) {
    if (!deps.surgeTargetOpenClawHeld) {
      throw new Error(`cannot replace agent ${agentId}'s database: Isolated target has no process gate status`);
    }
    if (await deps.surgeTargetOpenClawHeld(activation.request)) {
      log(`[migration-rsync] OpenClaw is held for this boot; replacing ${agentId}'s database offline`);
      return;
    }
  }
  if (!deps.adapter.releaseAgent) {
    throw new Error(`cannot replace agent ${agentId}'s database: this gateway cannot release agents`);
  }
  if (!activation?.live) {
    await deps.adapter.releaseAgent(agentId);
    return;
  }
  try {
    await deps.adapter.releaseAgent(agentId);
  } catch (error) {
    if (!(error instanceof Error) || !NATIVE_CLEANUP_INCOMPLETE.test(error.message)) throw error;
    log(`[migration-rsync] releasing ${agentId} left its native cleanup pending; resuming the deletion before replacing its database`);
    await deps.adapter.releaseAgent(agentId);
  }
}

const NATIVE_CLEANUP_INCOMPLETE = /native cleanup incomplete/;

async function pauseSystemConfigWatchForUser(
  deps: MigrationHandlerDeps,
  slug: string,
): Promise<string | undefined> {
  if (deps.pauseSystemConfigWatch) {
    return (await deps.pauseSystemConfigWatch(slug)) ?? undefined;
  }
  const configuredBuilder = userClaimSlug();
  if (!configuredBuilder) return undefined;
  if (!isConfiguredGatewayUser(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration user ${slug}`,
    );
  }
  return disableSystemConfigWatch(OPENCLAW_DIR, slug);
}

async function readSystemConfigWatchFenceForUser(
  deps: MigrationHandlerDeps,
  slug: string,
): Promise<string | null | undefined> {
  if (deps.readSystemConfigWatchFence) {
    return deps.readSystemConfigWatchFence(slug);
  }
  const configuredBuilder = userClaimSlug();
  if (!configuredBuilder) return undefined;
  if (!isConfiguredGatewayUser(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration user ${slug}`,
    );
  }
  return readSystemConfigWatchFenceGeneration(OPENCLAW_DIR, slug);
}

async function resumeSystemConfigWatchForUser(
  deps: MigrationHandlerDeps,
  slug: string,
  expectedGeneration?: string | null,
): Promise<void> {
  if (deps.resumeSystemConfigWatch) {
    if (expectedGeneration === undefined) {
      await deps.resumeSystemConfigWatch(slug);
    } else {
      await deps.resumeSystemConfigWatch(slug, expectedGeneration);
    }
    return;
  }
  const configuredBuilder = userClaimSlug();
  if (!configuredBuilder) return;
  if (!isConfiguredGatewayUser(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration user ${slug}`,
    );
  }
  await enableSystemConfigWatch(OPENCLAW_DIR, slug, expectedGeneration);
}

function importedActivationOptions(
  signal?: AbortSignal,
  migrationId?: string,
  beforeRuntimePublish?: () => Promise<void>,
  deferRuntimeVerification?: true,
  sharedToSharedRoster?: true,
) {
  if (!signal && !migrationId && !beforeRuntimePublish && !deferRuntimeVerification) return undefined;
  return {
    ...(signal ? { signal } : {}),
    ...(migrationId ? { migrationId } : {}),
    ...(beforeRuntimePublish ? { beforeRuntimePublish } : {}),
    ...(deferRuntimeVerification ? { deferRuntimeVerification } : {}),
    ...(sharedToSharedRoster ? { sharedToSharedRoster } : {}),
  };
}

async function importedWorkspaceIdentityRestore(input: { deps: MigrationHandlerDeps; slug: string; migrationId?: string; signal?: AbortSignal; beforeRuntimePublish?: () => Promise<void> }): Promise<(() => Promise<void>) | undefined> {
  if (input.beforeRuntimePublish) return input.beforeRuntimePublish;
  if (input.deps.adapter.isIsolatedGateway?.() !== false || !input.migrationId) return undefined;
  return sharedTargetWorkspaceRestore(input.deps, { migrationId: input.migrationId, slug: input.slug, mode: "final", rpcPhase: "finish-rsync-import" }, resolveOpenClawStateDir(), input.signal ?? AbortSignal.timeout(MIGRATION_TRANSFER_TIMEOUT_MS));
}

async function hydrateImportedProjects(
  deps: MigrationHandlerDeps,
  slug: string,
  loadStrategy: MigrationLoadStrategy,
): Promise<string[]> {
  if (
    loadStrategy === "standard" &&
    deps.adapter.projectCheckoutScope?.(slug) !== "workspace-only"
  ) {
    const { pending, deferred } = await cloneMissingProjects(deps.adapter, slug, { githubCheckouts: "defer" });
    if (deferred.length > 0) {
      deps.log?.(
        `[migration-http] GitHub checkouts for ${slug} hydrate after cutover, once this gateway holds the assignment: ${deferred.join(", ")}`,
      );
    }
    if (pending.length > 0) {
      throw new Error(
        `[migration-http] project checkout hydration incomplete for ${slug}: ${pending.join(", ")}`,
      );
    }
    return deferred;
  }
  return [];
}

async function activateImportedUserForMigration(input: {
  deferRuntimeVerification?: true;
  sharedToSharedRoster?: true;
  deps: MigrationHandlerDeps;
  slug: string;
  mode: MigrationImportMode;
  migrationId?: string;
  loadStrategy?: MigrationLoadStrategy;
  signal?: AbortSignal;
  beforeRuntimePublish?: () => Promise<void>;
}): Promise<string | undefined> {
  const { deps, slug, mode, signal, loadStrategy = "standard" } = input;
  const beforeRuntimePublish = await importedWorkspaceIdentityRestore(input);
  await ensureMigrationGiteaKey(deps, slug, "target-activation");
  const fenceGeneration = mode === "default" ? await pauseSystemConfigWatchForUser(deps, slug) : undefined;
  const deferredCheckouts = await hydrateImportedProjects(deps, slug, loadStrategy);
  const sharedToSharedRoster = beforeRuntimePublish && input.migrationId?.startsWith("mig-") &&
    (input.sharedToSharedRoster || mode === "default") ? true : undefined;
  const options = importedActivationOptions(signal, input.migrationId, beforeRuntimePublish, input.deferRuntimeVerification, sharedToSharedRoster);
  const activation = options ? await deps.adapter.activateImportedUser(slug, options) : await deps.adapter.activateImportedUser(slug);
  recordImportedActivationFingerprint(deps, slug, activation, loadStrategy, deferredCheckouts.length > 0);
  if (loadStrategy === "expedited") {
    deps.log?.(`[migration-http] expedited activation defers project hydration slug=${slug}`);
  }
  if (mode === "default") {
    await resumeSystemConfigWatchForUser(deps, slug, fenceGeneration);
  }
  return activation.verificationPending;
}

function recordImportedActivationFingerprint(
  deps: MigrationHandlerDeps,
  slug: string,
  activation: Awaited<ReturnType<UserLifecycleAdapter["activateImportedUser"]>>,
  loadStrategy: MigrationLoadStrategy,
  deferredCheckouts: boolean,
): void {
  const { appliedFingerprint, verificationPending } = activation;
  if (loadStrategy === "expedited" || importReconciliationPending(appliedFingerprint)) {
    const receipt = verificationPending === undefined ? pendingImportAppliedFingerprint(appliedFingerprint) : undefined;
    deps.adapter.recordAppliedFingerprint?.(slug, receipt ?? NEEDS_FULL_ATTACH_FINGERPRINT);
    return;
  }
  deps.adapter.recordAppliedFingerprint?.(
    slug, deferredCheckouts ? pendingCloneAppliedFingerprint(appliedFingerprint) : appliedFingerprint,
  );
}

async function ensureMigrationGiteaKey(
  deps: MigrationHandlerDeps,
  slug: string,
  phase: "source-flush" | "target-activation" | "source-resume",
): Promise<void> {
  const pubKey = deps.adapter.readLocalUserPubKey(slug);
  if (pubKey === null) {
    throw new Error(`[migration-http] local SSH public key is missing for ${slug}`);
  }
  await deps.adapter.gitHost.registerKey(slug, pubKey);
  deps.log?.(`[migration-http] Gitea SSH key claimed slug=${slug} phase=${phase}`);
}

async function ensureMigrationSourceGiteaKey(
  deps: MigrationHandlerDeps,
  slug: string,
  reason: string,
): Promise<void> {
  if (reason !== "migration-final") return;
  await ensureMigrationGiteaKey(deps, slug, "source-flush");
}

async function removeUserWithSystemConfigWatchPaused<T extends { wasMounted: boolean }>(input: {
  deps: MigrationHandlerDeps;
  slug: string;
  remove: () => Promise<T>;
}): Promise<T> {
  await pauseSystemConfigWatchForUser(input.deps, input.slug);
  return withUserRemoval(input.slug, input.remove);
}

async function resumeSystemConfigWatchAfterConvergence(
  deps: MigrationHandlerDeps,
  slug: string,
  reason: string,
  flushSucceeded: boolean,
  expectedGeneration?: string | null,
): Promise<void> {
  if (reason !== "migration-converge" || !flushSucceeded) return;
  await resumeSystemConfigWatchForUser(deps, slug, expectedGeneration);
}

function rejectInvalidSlug(slug: string, res: Response): boolean {
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid slug" });
    return true;
  }
  return false;
}

function parseAndVerifyJsonBody<T extends MigrationRequestBody>(
  req: Request,
  res: Response,
  deps: Pick<MigrationHandlerDeps, "publicKey" | "gatewayId">,
  log: (msg: string, fields?: LogContext) => void,
  scopeJobId = gatewayScopedJobId,
): T | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: T;
  try {
    body = JSON.parse(rawBody) as T;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (typeof body?.migrationId !== "string" || !body.migrationId || typeof body.slug !== "string" || !body.slug) {
    res.status(400).json({ error: "missing migrationId/slug" });
    return null;
  }
  if (rejectInvalidSlug(body.slug, res)) return null;

  const sigHeader = req.header(SIGNATURE_HEADER);

const sigValid = verifyFleetRequest(
    deps.publicKey,
    scopeJobId(body.migrationId, deps.gatewayId),
    rawBody,
    sigHeader ?? undefined,
  );
  if (!sigValid) {
    log(`[migration-http] 🔴 bad signature migrationId=${body.migrationId} slug=${body.slug}`, { status: "failed" });
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, log)) return null;
  setLogContext({ builderSlug: body.slug, operationId: body.migrationId, category: "migration", gatewayId: deps.gatewayId });
  return body;
}

function parseAndVerifySurgeBody(
  req: Request,
  res: Response,
  deps: Pick<MigrationHandlerDeps, "publicKey" | "gatewayId">,
  log: (msg: string, fields?: LogContext) => void,
): CompleteSurgeHandoffRequestBody | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: CompleteSurgeHandoffRequestBody;
  try {
    body = JSON.parse(rawBody) as CompleteSurgeHandoffRequestBody;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (
    typeof body.migrationId !== "string" ||
    body.migrationId.length === 0 ||
    typeof body.targetPodUid !== "string" ||
    body.targetPodUid.length === 0 ||
    body.targetPodUid.length > 128
  ) {
    res.status(400).json({ error: "missing or invalid migrationId/targetPodUid" });
    return null;
  }
  const signature = req.header(SIGNATURE_HEADER);
  if (!verifyFleetRequest(
    deps.publicKey,
    gatewayScopedJobId(body.migrationId, deps.gatewayId),
    rawBody,
    signature ?? undefined,
  )) {
    log(`[surge-handoff] bad signature migrationId=${body.migrationId}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, log)) return null;
  return body;
}

export function createCompleteSurgeHandoffHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifySurgeBody(req, res, deps, log);
    if (!body) return;
    if (!deps.releaseSurgeReadiness) {
      res.status(500).json({ error: "surge readiness is not configured" });
      return;
    }
    try {
      await deps.releaseSurgeReadiness({
        migrationId: body.migrationId,
        targetPodUid: body.targetPodUid,
      });
      log(`🟢 [surge-handoff] readiness released targetPodUid=${body.targetPodUid}`);
      res.status(200).json({ released: true, targetPodUid: body.targetPodUid });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`🔴 [surge-handoff] readiness release failed: ${message}`, { status: "failed" });
      res.status(500).json({
        error: "surge readiness release failed",
        message,
      });
    }
  });
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createMigrationProgressHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationProgressRequestBody>(req, res, deps, log);
    if (!body) return;
    const icons = { pending: "🟡", running: "🟡", done: "🟢", failed: "🔴", skipped: "🟡" };
    if (
      typeof body.phase !== "string" || !/^[a-zA-Z0-9:-]{1,80}$/.test(body.phase) ||
      typeof body.source !== "string" || !/^[a-zA-Z0-9.-]{1,253}$/.test(body.source) ||
      !Object.hasOwn(icons, body.status) ||
      (body.elapsedMs !== undefined && (!Number.isSafeInteger(body.elapsedMs) || body.elapsedMs < 0)) ||
      typeof body.migrationId !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(body.migrationId)
    ) {
      res.status(400).json({ error: "invalid migration progress" });
      return;
    }
    log(`Migration ${body.phase}`, {
      category: "migration", builderSlug: body.slug, operationId: body.migrationId,
      sourceGateway: body.source, gatewayId: deps.gatewayId, phase: body.phase,
      status: body.status, ...(body.elapsedMs === undefined ? {} : { durationMs: body.elapsedMs }),
    });
    res.status(200).json({ ok: true });
  });
}

const SCHEDULER_MIGRATION_PHASES = ["hold", "export", "stage", "activate", "resume", "retire", "abort"];
const SCHEDULER_RETAINING_PHASES = ["hold", "export", "stage"];

function areSchedulerExportOptionsValid(body: SchedulerMigrationRequestBody): boolean {
  const scopeValid = body.resolveAgentScope === undefined ||
    (body.resolveAgentScope === true && body.phase === "export" && body.agentIds === undefined);
  const requesterValid = body.targetRequesterProfileId === undefined ||
    (body.phase === "export" && body.retainNonportable === true && isSchedulerRequesterProfileId(body.targetRequesterProfileId));
  return scopeValid && requesterValid;
}

function isSchedulerMigrationRequest(body: SchedulerMigrationRequestBody): boolean {
  if (body.phase === "stage-requester") {
    return [body.agentIds, body.snapshot, body.retainNonportable, body.resolveAgentScope, body.targetRequesterProfileId]
      .every(value => value === undefined);
  }
  const agentIdsValid = body.agentIds === undefined ||
    (Array.isArray(body.agentIds) && body.agentIds.length > 0 && body.agentIds.every((id) => typeof id === "string" && id));
  const stageValid = body.phase !== "stage" || (body.agentIds !== undefined && body.snapshot !== undefined);
  const retainValid = body.retainNonportable === undefined ||
    (typeof body.retainNonportable === "boolean" && SCHEDULER_RETAINING_PHASES.includes(body.phase));
  return SCHEDULER_MIGRATION_PHASES.includes(body.phase) && agentIdsValid && stageValid && retainValid && areSchedulerExportOptionsValid(body);
}

export function createSchedulerMigrationHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<SchedulerMigrationRequestBody>(req, res, deps, log);
    if (!body) return;
    if (!isSchedulerMigrationRequest(body)) {
      res.status(400).json({ error: "invalid scheduler migration request" });
      return;
    }
    try {
      const result = await deps.adapter.schedulerMigration(body.slug, {
        operationId: body.migrationId, phase: body.phase,
        ...(body.resolveAgentScope ? { resolveAgentScope: true } : {}),
        ...(body.agentIds ? { agentIds: body.agentIds } : {}),
        ...(body.snapshot === undefined ? {} : { snapshot: body.snapshot }),
        ...(body.retainNonportable === undefined ? {} : { retainNonportable: body.retainNonportable }),
        ...(body.targetRequesterProfileId === undefined ? {} : { targetRequesterProfileId: body.targetRequesterProfileId }),
      });
      res.status(result.drained ? 200 : 409).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] scheduler ${body.phase} failed slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "scheduler migration failed", message, retryable: isRetryableSchedulerFailure(error) });
    }
  });
}

function isScheduleRecord(value: unknown): value is ScheduleRecord {
  return isRecord(value) && typeof value.sourceJobId === "string" && typeof value.agentId === "string" &&
    value.agentId.length > 0 && isRecord(value.job);
}

function isScheduleTransferRequest(body: ScheduleTransferRequestBody): boolean {
  if (body.op === "snapshot") return true;
  if (body.op === "remove") return Array.isArray(body.jobIds) && body.jobIds.every(id => typeof id === "string" && id.length > 0);
  return (body.op === "restore" || body.op === "check") && Array.isArray(body.records) && body.records.every(isScheduleRecord);
}

export function createScheduleTransferHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ScheduleTransferRequestBody>(req, res, deps, log);
    if (!body) return;
    if (!isScheduleTransferRequest(body)) {
      res.status(400).json({ error: "invalid schedule transfer request" });
      return;
    }
    try {
      if (!deps.scheduleTransfer) throw new SchedulerRefusal("schedule transfer is not configured");
      res.status(200).json(await deps.scheduleTransfer(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] schedule ${body.op} failed slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "schedule transfer failed", message, retryable: isRetryableSchedulerFailure(error) });
    }
  });
}

export function createSchedulerReadyHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps, log);
    if (!body) return;
    try {
      await deps.adapter.schedulerReady();
      res.status(200).json({ ready: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] scheduler readiness failed migrationId=${body.migrationId}: ${message}`);
      res.status(500).json({ error: "scheduler readiness failed", message });
    }
  });
}

export function createResumeHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody & { role?: "target" }>(req, res, deps, log);
    if (!body) return;
    try {
      await ensureMigrationGiteaKey(deps, body.slug, "source-resume");
      await deps.adapter.resumeUser(body.slug, { migrationId: body.migrationId, ...(body.role ? { role: body.role } : {}) });
      await (deps.voiceMigration ?? updateVoiceMigration)({ slug: body.slug, operationId: body.migrationId, phase: "resume" });
      res.status(200).json({ migrationId: body.migrationId, slug: body.slug, resumed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] resume failed slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "resume failed", message });
    }
  });
}

async function waitForVoiceDrain(deps: MigrationHandlerDeps, slug: string, operationId: string): Promise<{ activeCalls: number }> {
  const hold = () => (deps.voiceMigration ?? updateVoiceMigration)({ slug, operationId, phase: 'hold' });
  let voice = await hold();
  const waitMs = deps.voiceDrainWaitMs ?? 25_000;
  const sleep = deps.voiceDrainSleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const started = Date.now();
  for (let waited = 0; voice.activeCalls > 0 && waited < waitMs;) {
    const interval = Math.min(1_000, waitMs - waited);
    await sleep(interval);
    waited = Math.max(waited + interval, Date.now() - started);
    voice = await hold();
    waited = Math.max(waited, Date.now() - started);
  }
  return voice;
}

function releaseVoiceHold(deps: MigrationHandlerDeps, slug: string, operationId: string): Promise<{ activeCalls: number }> {
  return (deps.voiceMigration ?? updateVoiceMigration)({ slug, operationId, phase: 'resume' });
}

export function createQuiesceHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<QuiesceRequestBody>(req, res, deps, log);
    if (!body) return;

    try {
      const voice = await waitForVoiceDrain(deps, body.slug, body.migrationId);
      if (voice.activeCalls > 0) {
        log(`[migration-http] deferring quiesce slug=${body.slug}: ${voice.activeCalls} active voice call(s)`);
        res.status(200).json({ migrationId: body.migrationId, slug: body.slug, drained: false, runningCount: voice.activeCalls });
        return;
      }
      let options: { stopMattermost: boolean; schedulerMigrationId?: string; retainNonportable?: boolean } | undefined;
      if (body.stopMattermost === false) options = { stopMattermost: false };
      else if (body.schedulerHandoff === true) {
        options = {
          stopMattermost: true,
          schedulerMigrationId: body.schedulerMigrationId ?? body.migrationId,
          ...(body.retainNonportable === true ? { retainNonportable: true } : {}),
        };
      }
      const result = options
        ? await deps.adapter.quiesceUser(body.slug, body.timeoutMs ?? 60_000, options)
        : await deps.adapter.quiesceUser(body.slug, body.timeoutMs ?? 60_000);
      const response: QuiesceResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        drained: result.drained,
        runningCount: result.runningCount,
      };
      (result.drained ? dlog : log)(
        `${result.drained ? "🟢" : "🟡"} [migration-http] quiesce migrationId=${body.migrationId} slug=${body.slug} → drained=${result.drained} runningCount=${result.runningCount}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 quiesce migrationId=${body.migrationId} slug=${body.slug} failed: ${message}`, { status: "failed" });
      res.status(500).json({ error: "quiesce failed", message });
    }
  });
}

function logFlushResult(ok: boolean, log: (message: string, fields?: LogContext) => void, message: string): void {
  (ok ? dlog : log)(`${ok ? "🟢" : "🔴"} [migration-http] flush ${message}`);
}

export function createFlushHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<FlushGatewayRequestBody>(req, res, deps, log);
    if (!body) return;

    if (!deps.flushLocalState) {
      res.status(501).json({ error: "flush not configured" });
      return;
    }

    const reason = typeof body.reason === "string" && body.reason
      ? body.reason
      : "controller";
    const expectedSystemConfigCommit = body.expectedSystemConfigCommit;
    if (
      reason === "migration-converge" &&
      (typeof expectedSystemConfigCommit !== "string" ||
        !SYSTEM_CONFIG_COMMIT.test(expectedSystemConfigCommit))
    ) {
      res.status(400).json({ error: "invalid expectedSystemConfigCommit" });
      return;
    }
    if (reason !== "migration-converge" && expectedSystemConfigCommit !== undefined) {
      res.status(400).json({ error: "unexpected expectedSystemConfigCommit" });
      return;
    }

    try {
      const fenceGeneration = reason === "migration-converge"
        ? await readSystemConfigWatchFenceForUser(deps, body.slug)
        : undefined;
      await ensureMigrationSourceGiteaKey(deps, body.slug, reason);
      const result = await deps.flushLocalState({
        slug: body.slug,
        reason,
        ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
      });
      await resumeSystemConfigWatchAfterConvergence(
        deps,
        body.slug,
        reason,
        result.ok,
        fenceGeneration,
      );
      const response: FlushGatewayResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        ...result,
      };
      logFlushResult(result.ok, log,
        `migrationId=${body.migrationId} slug=${body.slug} ok=${result.ok} durationMs=${result.durationMs}`,
      );
      res.status(result.ok ? 200 : 500).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 flush migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "flush failed", message });
    }
  });
}

function restoreProjectCheckoutScope(value: unknown): UserSnapshot["projectCheckoutScope"] {
  return value === "workspace-and-projects" || value === "workspace-only" ? value : undefined;
}

const RESTORE_SNAPSHOT_MISMATCH = "snapshot mismatch";
const RESTORE_SNAPSHOT_WITHOUT_PLAN_INPUTS =
  "snapshot carries no plan inputs; the fleet controller predates this gateway image";
const RESTORE_SNAPSHOT_WITHOUT_PERSONA =
  "snapshot carries no persona; the fleet controller predates this gateway image";

type PlanInputSnapshot = Record<string, unknown> & {
  planInputs: Record<string, unknown>;
  contextTemplateKey: string;
};
type RestoreSnapshotRecord = PlanInputSnapshot & { persona: Record<string, unknown> | null };

function carriesPlanInputs(snapshot: Record<string, unknown>): snapshot is PlanInputSnapshot {
  return isRecord(snapshot.planInputs) &&
    typeof snapshot.contextTemplateKey === "string" &&
    snapshot.contextTemplateKey.length > 0;
}

function carriesPersona(snapshot: PlanInputSnapshot): snapshot is RestoreSnapshotRecord {
  return snapshot.persona === null || isRecord(snapshot.persona);
}

function restoreSnapshotRecord(body: RestoreMigrationRequestBody): RestoreSnapshotRecord | string {
  const snapshot: unknown = body.snapshot;
  if (!isRecord(snapshot)) return RESTORE_SNAPSHOT_MISMATCH;
  if (snapshot.uid !== body.uid || snapshot.slug !== body.slug) return RESTORE_SNAPSHOT_MISMATCH;
  if (!carriesPlanInputs(snapshot)) return RESTORE_SNAPSHOT_WITHOUT_PLAN_INPUTS;
  return carriesPersona(snapshot) ? snapshot : RESTORE_SNAPSHOT_WITHOUT_PERSONA;
}

function snapshotFromRestoreBody(body: RestoreMigrationRequestBody): UserSnapshot | string {
  const snapshot = restoreSnapshotRecord(body);
  if (typeof snapshot === "string") return snapshot;
  return {
    uid: snapshot.uid as string,
    slug: snapshot.slug as string,
    contextTemplateKey: snapshot.contextTemplateKey,
    planInputs: snapshot.planInputs,
    gatewayId: snapshot.gatewayId as string,
    status: snapshot.status as UserSnapshot["status"],
    ...(isRecord(snapshot.restoreAuthority) ? { restoreAuthority: snapshot.restoreAuthority as unknown as UserSnapshot["restoreAuthority"] } : {}),
    agentIds: Array.isArray(snapshot.agentIds)
      ? snapshot.agentIds.filter((id): id is string => typeof id === "string")
      : [],
    repoUrl: typeof snapshot.repoUrl === "string" ? snapshot.repoUrl : "",
    mattermostUserId:
      typeof snapshot.mattermostUserId === "string" ? snapshot.mattermostUserId : null,
    channels: Array.isArray(snapshot.channels) ? snapshot.channels as UserSnapshot["channels"] : [],
    ownerName: typeof snapshot.ownerName === "string" ? snapshot.ownerName : body.slug,
    persona: snapshot.persona,
    projects: Array.isArray(snapshot.projects) ? snapshot.projects as UserSnapshot["projects"] : [],
    projectAgents: Array.isArray(snapshot.projectAgents) ? snapshot.projectAgents as UserSnapshot["projectAgents"] : [],
    projectCheckoutScope: restoreProjectCheckoutScope(snapshot.projectCheckoutScope),
    freeTierModelRef:
      typeof snapshot.freeTierModelRef === "string" ? snapshot.freeTierModelRef : undefined,
    builderAgentDefault: isRecord(snapshot.builderAgentDefault)
      ? (snapshot.builderAgentDefault as UserSnapshot["builderAgentDefault"])
      : undefined,
    byotActive: snapshot.byotActive === true,
    systemConfig: isRecord(snapshot.systemConfig)
      ? (snapshot.systemConfig as UserSnapshot["systemConfig"])
      : undefined,
  };
}

export function createRestoreHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  const active = new Map<string, { identity: string; result: Promise<RestoreMigrationResponse> }>();
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<RestoreMigrationRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    if (typeof body.uid !== "string" || body.uid.length === 0) {
      res.status(400).json({ error: "missing uid" });
      return;
    }
    const snapshot = snapshotFromRestoreBody(body);
    if (typeof snapshot === "string") {
      log(`[migration-http] 🔴 restore migrationId=${body.migrationId} slug=${body.slug}: ${snapshot}`, { status: "failed" });
      res.status(400).json({ error: snapshot });
      return;
    }

    try {
      const identity = JSON.stringify(body);
      let entry = active.get(body.uid);
      if (entry && entry.identity !== identity) throw new Error("user restore is still settling under a different request");
      if (!entry) {
        const result = Promise.resolve().then(async () => {
          await pauseSystemConfigWatchForUser(deps, body.slug);
          deps.adapter.markUserMigratingIn?.(body.slug);
          deps.adapter.seedUserSnapshotForMigration?.(body.snapshot);
          const adapter: UserLifecycleAdapter = {
            ...deps.adapter,
            loadUserSnapshot: async (uid) => {
              const fresh = await deps.adapter.loadUserSnapshot(uid);
              return uid === snapshot.uid ? fresh ?? snapshot : fresh;
            },
            uidForSlug: async (slug) => slug === snapshot.slug ? snapshot.uid : deps.adapter.uidForSlug(slug),
          };
          const restored = await restoreUserRuntimeFromSnapshot(adapter, snapshot, deps.adapter.isIsolatedGateway?.() === false ? { migrationId: body.migrationId } : {});
          recordRestoredConvergence(deps, body.slug, restored);
          return { migrationId: body.migrationId, slug: body.slug, restored: restored.restored, steps: restored.steps };
        });
        entry = { identity, result };
        active.set(body.uid, entry);
        const owned = entry;
        const release = () => {
          if (active.get(body.uid) === owned) active.delete(body.uid);
        };
        void result.then(release, release);
      }
      const response = await entry.result;
      log(
        `[migration-http] 🟢 restore migrationId=${body.migrationId} slug=${body.slug} steps=${response.steps.join(",")}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 restore migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "restore failed", message });
    }
  });
}

function validHeldSourceBinding(body: HeldNativeSourceReconcileRequest, gatewayId: string, now: number): boolean {
  const { binding, migrationId, slug, nonce, expiresAt } = body;
  return Boolean(binding && binding.gatewayId === gatewayId && binding.slug === slug &&
    migrationId === `mig-${binding.operationId}` && /^[a-f0-9]{64}$/.test(nonce) &&
    Number.isSafeInteger(expiresAt) && expiresAt >= now && expiresAt <= now + 90_000);
}

async function restoreHeldSourceRuntime(
  deps: MigrationHandlerDeps, body: HeldNativeSourceReconcileRequest, full: FleetBrokerUserSnapshot, assertHeld: () => Promise<void>,
) {
  const { binding, migrationId, slug } = body;
  const snapshot = snapshotFromRestoreBody({ migrationId, uid: binding.uid, slug, snapshot: full });
  if (typeof snapshot === "string") throw new Error("The held source broker snapshot is invalid");
  await pauseSystemConfigWatchForUser(deps, slug);
  await assertHeld();
  deps.adapter.seedUserSnapshotForMigration!(full);
  let settled: Promise<void> | undefined;
  try {
    const restored = await restoreUserRuntimeFromSnapshot(deps.adapter, snapshot, {
      keepSourceQuiescing: true, beforeRuntimePublish: assertHeld, onWorkSettled: value => { settled = value; },
    });
    await assertHeld();
    if (!restored.convergedState || !restored.appliedFingerprint || restored.pendingProjectClones.length) {
      throw new Error("The held source did not converge");
    }
    recordRestoredConvergence(deps, slug, restored);
    return { migrationId, slug, restored: restored.restored, steps: restored.steps };
  } finally {
    await settled;
  }
}

export function createHeldNativeSourceReconcileHandler(deps: MigrationHandlerDeps) {
  const log = deps.log ?? provisionerLog;
  return (req: Request, res: Response) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<HeldNativeSourceReconcileRequest>(req, res, deps, log, heldNativeSourceReconcileJobId);
    if (!body) return;
    const { binding, migrationId, slug } = body;
    const now = (deps.now ?? Date.now)();
    if (!validHeldSourceBinding(body, deps.gatewayId, now)) {
      res.status(400).json({ error: "invalid_held_source_binding" });
      return;
    }
    const { readHeldSourceSnapshot, flushLocalState } = deps;
    const heldSourceKeeper = deps.getHeldSourceKeeper?.();
    const exportManifest = deps.adapter.exportOpenClawActivationManifest;
    if (!heldSourceKeeper || !readHeldSourceSnapshot || !flushLocalState || !exportManifest ||
        !deps.adapter.seedUserSnapshotForMigration || !deps.adapter.recordAppliedFingerprint ||
        deps.adapter.isIsolatedGateway?.() !== true) {
      res.status(409).json({ error: "held_source_maintenance_unavailable" });
      return;
    }
    try {
      const proof = await runHeldSourceReconcile(body, heldSourceKeeper, {
        readSnapshot: readHeldSourceSnapshot,
        restore: (full, assertHeld) => restoreHeldSourceRuntime(deps, body, full, assertHeld),
        drain: async () => {
          const voice = await waitForVoiceDrain(deps, slug, migrationId);
          if (voice.activeCalls) return { drained: false, runningCount: voice.activeCalls };
          return deps.adapter.quiesceUser(slug, 60_000, { stopMattermost: true, schedulerMigrationId: binding.schedulerMigrationId, retainNonportable: true });
        },
        flush: () => flushLocalState({ slug, reason: "native-return" }),
        exportManifest: () => exportManifest.call(deps.adapter, slug),
      });
      res.json({ requestId: binding.requestId, holdGeneration: binding.holdGeneration, nonce: body.nonce, proof });
    } catch (error) {
      log(`[migration-http] held source reconciliation refused for ${slug} (${error instanceof Error ? error.name : "unknown error"})`, { status: "failed" });
      res.status(409).json({ error: "held_source_reconciliation_incomplete" });
    }
  });
}

export function createExportPathsHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ExportPathsRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;

    try {
      const allSources = await deps.adapter.listExportPaths(body.slug);
      const sources = sourcesForPushMode(allSources, body.slug, mode);
      if (sources.length === 0) {
        res.status(404).json({
          error: "no export paths",
          message: `nothing to export for slug=${body.slug} mode=${mode}`,
        });
        return;
      }
      const response: ExportPathsResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        sources,
      };
      dlog(
        `[migration-http] export-paths mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 export-paths migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "export-paths failed", message });
    }
  });
}

async function assertTargetImportAllowed(deps: MigrationHandlerDeps, slug: string): Promise<void> {
  if (await deps.readTargetImportPermit?.(slug) === "held") throw new Error("Migration target import is held");
}

function hasQuietTargetImportState(deps: MigrationHandlerDeps, slug: string): boolean {
  return deps.getMountedUsers?.().includes(slug) === false &&
    !migrationImportBusy() && !Array.from(rsyncImportSessions.values()).some(session => session.slug === slug);
}

export function createTargetImportHoldWitnessHandler(deps: MigrationHandlerDeps) {
  const log = deps.log ?? provisionerLog;
  return (req: Request, res: Response) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody & { nonce: string }>(req, res, deps, log);
    if (!body) return;
    if (typeof body.nonce !== "string" || !/^[a-f0-9]{32}$/.test(body.nonce)) {
      res.status(400).json({ error: "Invalid target hold nonce" });
      return;
    }
    try {
      if (await deps.readTargetImportPermit?.(body.slug) === "held" && hasQuietTargetImportState(deps, body.slug)) {
        res.status(200).json({ migrationId: body.migrationId, slug: body.slug, nonce: body.nonce, held: true });
        return;
      }
      res.status(409).json({ error: "Migration target import is not held" });
    } catch {
      res.status(503).json({ error: "Migration target import hold unavailable" });
    }
  });
}

export function createSourceActivationReadinessHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps, log, sourceActivationReadinessJobId);
    if (!body) return;

    const exportable = await deps.adapter.exportOpenClawActivationManifest?.(body.slug).then(
      () => true,
      () => false,
    ) ?? false;
    res.status(200).json({ migrationId: body.migrationId, slug: body.slug, exportable });
  });
}

export function createActivationManifestExportHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ActivationManifestExportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;

    try {
      if (!deps.adapter.exportOpenClawActivationManifest) {
        throw new Error("source gateway cannot export an OpenClaw activation manifest");
      }
      const manifest = await deps.adapter.exportOpenClawActivationManifest(body.slug);
      const response: ActivationManifestExportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        manifest: manifest as unknown as Record<string, unknown>,
      };
      dlog(
        `[migration-http] activation-manifest migrationId=${body.migrationId} slug=${body.slug} exported`,
      );
      res.status(200).json(response);
    } catch (err) {
      if (deps.adapter.isIsolatedGateway?.() === true) {
        const response: ActivationManifestExportResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          manifest: null,
        };
        const message = err instanceof Error ? err.message : String(err);
        log(
          `[migration-http] activation-manifest migrationId=${body.migrationId} slug=${body.slug} unavailable on user source: ${message}`,
        );
        res.status(200).json(response);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 activation-manifest migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "activation-manifest failed", message });
    }
  });
}

export function createPrepareImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<PrepareImportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;

    try {
      await assertTargetImportAllowed(deps, body.slug);
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(body.slug)
        : await deps.adapter.prepareImportDir(body.slug, mode);
      if (mode !== "keys") deps.adapter.markUserMigratingIn?.(body.slug);
      log(
        `[migration-http] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} dir=${importDir}`,
      );
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "prepare-import failed", message });
    }
  });
}

export function createActivateImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ActivateImportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;

    try {
      await assertTargetImportAllowed(deps, body.slug);
      deps.adapter.markUserMigratingIn?.(body.slug);
      const verificationPending = await activateImportedUserForMigration({
        deps,
        slug: body.slug,
        migrationId: body.migrationId,
        mode: "default",
      });
      deps.adapter.writeMountMarker?.(body.slug);
      deps.adapter.onMounted?.(body.slug);
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        ...(verificationPending ? { verificationPending } : {}),
      };
      log(
        `${verificationPending ? "🟡" : "🟢"} [migration-http] activate-import migrationId=${body.migrationId} slug=${body.slug}` +
        (verificationPending ? ` (verification pending: ${verificationPending})` : ""),
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 activate-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "activate-import failed", message });
    }
  });
}

async function retainedSourcePaths(plan: ConfiguredUserPortableStatePlan, stateDir: string, slug: string, authority: FleetBrokerAgentAnchor[]) {
  const sources = [];
  for (const item of plan.paths.filter(item => !isSafeDefaultAgentPortableStatePath(item.relativePath))) {
    const file = path.join(stateDir, item.relativePath);
    try { await fs.lstat(file); sources.push({ cwd: stateDir, path: item.relativePath }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const anchor of authority) {
    const relative = path.join("agents", anchor.agentId);
    if (sources.some(item => item.cwd === stateDir && (item.path === relative || item.path.startsWith(relative + path.sep)))) continue;
    const file = path.join(stateDir, relative);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isDirectory() || await fs.realpath(file) !== file) throw new Error(`Retained agent directory is not canonical: ${anchor.agentId}`);
    sources.push({ cwd: stateDir, path: relative });
  }
  for (const source of await userFileStatePaths(OPENCLAW_DIR, slug)) {
    if (!sources.some(item => item.cwd === source.cwd && item.path === source.path)) sources.push(source);
  }
  return sources;
}

async function assertRetainedSourceAnchors(sources: Array<{ cwd: string; path: string }>, authority: FleetBrokerAgentAnchor[]) {
  const stores = await findPortableAgentStores(sources);
  if (stores.length !== authority.length) throw new Error("Retained source is missing an authorized agent anchor");
  for (const store of stores) {
    const actual = readPostgresAgentAnchor(path.join(store.sourceAgentDir, AGENT_STORE_BASENAME));
    const expected = authority.find(anchor => anchor.agentId === store.agentId);
    if (!actual || !expected || actual.storeId !== expected.storeId || actual.schema !== expected.schema) {
      throw new Error(`Retained source agent anchor does not match migration authority: ${store.agentId}`);
    }
  }
}

async function retainedSourceExport(deps: MigrationHandlerDeps, body: MigrationRequestBody, signal: AbortSignal, sourceHeld: boolean) {
  const readCustody = deps.adapter.sourceMigrationIdentityCustody;
  const readAnchors = deps.adapter.sourceMigrationAgentAnchors;
  if (!readCustody || !readAnchors) throw new Error("Retained source requires current migration anchor authority");
  const manifest = await readActivationManifest(OPENCLAW_DIR, body.slug);
  const custody = await readCustody(body.slug, body.migrationId);
  if (!manifest.sourceWorkspaceIdentities) throw new Error("Retained source requires retained workspace identity custody");
  assertSourceIdentityCustody(manifest.sourceWorkspaceIdentities, custody);
  if (custody.gatewayId !== deps.gatewayId || custody.podUid !== process.env.POD_UID) throw new Error("Retained source custody addresses another allocation");
  const agents = [{ agentId: manifest.agentId, agent: manifest.agent }, ...manifest.projectAgents];
  const authority = await readAnchors(body.slug, body.migrationId);
  if (new Set(authority.map(anchor => anchor.agentId)).size !== authority.length ||
      authority.some(anchor => { const parsed = parseAgentId(anchor.agentId); return parsed.kind === "unknown" || parsed.username !== body.slug; }) ||
      agents.some(agent => !authority.some(anchor => anchor.agentId === agent.agentId))) {
    throw new Error("Retained source manifest roster does not match migration anchor authority");
  }
  const stateDir = resolveOpenClawStateDir();
  const plan = configuredUserPortableStatePlanFromConfig({ agents: { entries: Object.fromEntries(agents.map(agent => [agent.agentId, agent.agent])) } }, stateDir);
  assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan);
  const sources = await retainedSourcePaths(plan, stateDir, body.slug, authority);
  await assertRetainedSourceAnchors(sources, authority);
  const assertCurrent = async () => {
    signal.throwIfAborted();
    assertSourceIdentityCustody(custody, await readCustody(body.slug, body.migrationId));
    if ((sourceHeld && await deps.surgeSourceOpenClawHeld?.({ migrationId: body.migrationId, slug: body.slug }) !== true) ||
        !isDeepStrictEqual(await readAnchors(body.slug, body.migrationId), authority) ||
        !isDeepStrictEqual(await readActivationManifest(OPENCLAW_DIR, body.slug), manifest)) {
      throw new Error("Retained source migration export authority changed");
    }
    signal.throwIfAborted();
  };
  await assertCurrent();
  return { sources, assertCurrent };
}

async function sourceExportInventory(deps: MigrationHandlerDeps, body: PushRsyncStateRequestBody, mode: MigrationTransferMode, signal: AbortSignal) {
  const sourceHeld = mode === "final" && await deps.surgeSourceOpenClawHeld?.({ migrationId: body.migrationId, slug: body.slug }) === true;
  const retainedManifest = mode === "final" ? await readActivationManifest(OPENCLAW_DIR, body.slug).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }) : null;
  const retained = retainedManifest?.sourceWorkspaceIdentities ? await retainedSourceExport(deps, body, signal, sourceHeld) : null;
  const allSources = retained?.sources ?? await deps.adapter.listExportPaths(body.slug);
  return { sourceHeld, retained, sources: sourcesForPushMode(allSources, body.slug, mode) };
}

async function maybeMaterializeActivationManifest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody & { includeActivationManifest?: boolean },
  options: { signal: AbortSignal; timeoutMs: number; preserveForRollback?: boolean; sourceHeld?: boolean; convergeSource?: boolean },
): Promise<{ source: { cwd: string; path: string } | null; cleanup: () => Promise<void> }> {
  if (body.includeActivationManifest !== true && !options.preserveForRollback) {
    return { source: null, cleanup: async () => undefined };
  }
  if (!deps.adapter.exportOpenClawActivationManifest) {
    throw new Error("source gateway cannot export an OpenClaw activation manifest");
  }
  let manifest;
  if (options.preserveForRollback) {
    manifest = await readActivationManifest(OPENCLAW_DIR, body.slug).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (manifest && !manifest.sourceWorkspaceIdentities && !options.sourceHeld) throw new Error("Retained source activation has no original workspace identity capture");
  }
  manifest ??= await deps.adapter.exportOpenClawActivationManifest(body.slug, options);
  if (options.preserveForRollback && !options.sourceHeld) {
    const readCustody = deps.adapter.sourceMigrationIdentityCustody;
    if (!readCustody) throw new Error("Source rollback requires current identity custody");
    const custody = await readCustody(body.slug, body.migrationId);
    manifest = await captureSourceWorkspaceIdentities(manifest, resolveOpenClawStateDir(), custody);
    assertSourceIdentityCustody(custody, await readCustody(body.slug, body.migrationId));
  }
  if (options.preserveForRollback) await writeActivationManifest(OPENCLAW_DIR, manifest);
  if (body.includeActivationManifest !== true) return { source: null, cleanup: async () => undefined };
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-activation-${body.migrationId}-`));
  try {
    const source = await writeActivationManifest(tmpDir, manifest);
    return {
      source,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

type MigrationImportMode = "keys" | "pre" | "final" | "default";


const RSYNC_IMPORT_MODULE = "state";
const RSYNC_READY_TIMEOUT_MS = 5_000;
const RSYNC_DAEMON_STOP_TIMEOUT_MS = 5_000;
const RSYNC_BIN = "/usr/bin/rsync";

interface RSyncImportSession {
  key: string;
  transferAttemptId?: string;
  migrationId: string;
  slug: string;
  mode: MigrationTransferMode;
  configTransferMode: MigrationConfigTransferMode;
  stageDir: string;
  importDir: string;
  configPath: string;
  secretsPath: string;
  child: ReturnType<typeof spawn>;
  transport: MigrationTlsEndpoint;
  transportClosing?: boolean;
  baselineEntries?: string[];
}

const rsyncImportSessions = new Map<string, RSyncImportSession>();
const rsyncImportAttempts = new Map<string, { attempt: number; id: string }>();
let preparingRsyncImport = false;
let abortingRsyncImport = false;
const finishingRsyncImports = new Set<string>();

function rsyncSessionKey(
  migrationId: string,
  slug: string,
  mode: MigrationTransferMode,
): string {
  return `${migrationId}:${slug}:${mode}`;
}

function isMigrationTransferMode(value: unknown): value is MigrationTransferMode {
  return value === "keys" || value === "pre" || value === "final";
}

function isMigrationConfigTransferMode(value: unknown): value is MigrationConfigTransferMode {
  return value === ACTIVATION_MANIFEST_TRANSFER || value === USER_SYSTEM_CONFIG_TRANSFER;
}

function validateTransferMode(
  mode: unknown,
  res: Response,
): MigrationTransferMode | null {
  if (isMigrationTransferMode(mode)) return mode;
  res.status(400).json({ error: "invalid migration mode" });
  return null;
}

function validateRsyncConfigTransferMode(
  value: unknown,
  mode: MigrationTransferMode,
  res: Response,
): MigrationConfigTransferMode | null {
  if (mode !== "final") {
    if (value === undefined) return ACTIVATION_MANIFEST_TRANSFER;
    res.status(400).json({ error: "configTransferMode is valid only for final imports" });
    return null;
  }
  if (value === undefined || value === ACTIVATION_MANIFEST_TRANSFER) return ACTIVATION_MANIFEST_TRANSFER;
  if (isMigrationConfigTransferMode(value)) return value;
  res.status(400).json({ error: "invalid configTransferMode" });
  return null;
}

function requireConfiguredUserSystemConfigTransfer(
  slug: string,
  configTransferMode: MigrationConfigTransferMode,
  res: Response,
): boolean {
  if (
    configTransferMode !== USER_SYSTEM_CONFIG_TRANSFER ||
    isConfiguredGatewayUser(slug)
  ) {
    return true;
  }
  res.status(409).json({
    error: "configured user system config transfer requires the matching isolated gateway",
  });
  return false;
}

function validateMigrationLoadStrategy(
  value: unknown,
  res: Response,
): MigrationLoadStrategy | null {
  if (value === undefined || value === "standard") return "standard";
  if (value === "expedited") return value;
  res.status(400).json({ error: "invalid loadStrategy" });
  return null;
}

function validateRsyncRpcPhase(
  value: unknown,
  expected: RsyncMigrationRpcPhase,
  res: Response,
): boolean {
  if (value === expected) return true;
  res.status(400).json({ error: "invalid rsync RPC phase" });
  return false;
}

function validateRsyncCredential(value: unknown, name: string, res: Response): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    res.status(400).json({ error: `invalid ${name}` });
    return null;
  }
  return value;
}

function validateTransferAttempt(value: unknown, res: Response): boolean {
  return value === undefined || validateRsyncCredential(value, "transferAttemptId", res) !== null;
}

function ownsRsyncSession(session: RSyncImportSession | undefined, attemptId: string | undefined, res: Response): boolean {
  if (session?.transferAttemptId === attemptId) return true;
  res.status(409).json({ error: "rsync transfer attempt does not own the import session" });
  return false;
}

function admitRsyncPrepareAttempt(key: string, body: PrepareRsyncImportRequestBody, res: Response): boolean {
  const prior = rsyncImportAttempts.get(key);
  if (body.transferAttemptId === undefined && body.transferAttempt === undefined && !prior) return true;
  if (prior && body.transferAttemptId === undefined) {
    res.status(409).json({ error: "transfer attempt has already been superseded or admitted" });
    return false;
  }
  if (!body.transferAttemptId || !Number.isSafeInteger(body.transferAttempt) || body.transferAttempt! < 1) {
    res.status(400).json({ error: "transfer attempt requires a positive sequence and ID" });
    return false;
  }
  if (prior && body.transferAttempt! <= prior.attempt) {
    res.status(409).json({ error: "transfer attempt has already been superseded or admitted" });
    return false;
  }
  rsyncImportAttempts.set(key, { attempt: body.transferAttempt!, id: body.transferAttemptId });
  return true;
}

function ownsRsyncCleanup(key: string, attemptId: string | undefined, res: Response): boolean {
  const id = rsyncImportAttempts.get(key)?.id ?? rsyncImportSessions.get(key)?.transferAttemptId;
  if (id === undefined || id === attemptId) return true;
  res.status(409).json({ error: "rsync transfer attempt does not own the import session" });
  return false;
}

function validateRsyncTargetHost(value: unknown, res: Response): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    (!net.isIP(value) && !/^[A-Za-z0-9.-]+$/.test(value))
  ) {
    res.status(400).json({ error: "invalid targetHost" });
    return null;
  }
  return value;
}

function validateRsyncPort(value: unknown, res: Response): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    res.status(400).json({ error: "invalid targetPort" });
    return null;
  }
  return value;
}

function normalizeLocalAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  if (normalized === "0.0.0.0" || normalized === "::") return null;
  return net.isIP(normalized) ? normalized : null;
}

function requestLocalAddress(req: Request): string {
  const socket = (req as Request & {
    socket?: {
      localAddress?: string;
      address?: () => string | net.AddressInfo;
    };
  }).socket;
  const direct = normalizeLocalAddress(socket?.localAddress);
  if (direct) return direct;
  const address = socket?.address?.() as unknown;
  const fromAddress = typeof address === "object" && address && "address" in address
    ? normalizeLocalAddress(address.address)
    : normalizeLocalAddress(address);
  return fromAddress ?? "127.0.0.1";
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}



function rsyncPortFromDeps(deps: MigrationHandlerDeps): number {
  if (deps.migrationRsyncPort) return deps.migrationRsyncPort;
  const fromEnv = Number.parseInt(process.env.MIGRATION_RSYNC_PORT ?? "", 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : MIGRATION_RSYNC_PORT_DEFAULT;
}

async function waitForTcpPort(port: number): Promise<void> {
  const deadline = Date.now() + RSYNC_READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy(new Error(`rsync port ${port} connect timeout`));
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`rsync port ${port} did not become ready`);
}

function rsyncDaemonExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function signalRsyncDaemonAndWait(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (rsyncDaemonExited(child)) return true;
  return new Promise<boolean>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (timeout) clearTimeout(timeout);
    };
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (rsyncDaemonExited(child)) {
      onExit();
      return;
    }
    timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, RSYNC_DAEMON_STOP_TIMEOUT_MS);
    try {
      if (child.kill(signal)) return;
      if (rsyncDaemonExited(child)) {
        onExit();
        return;
      }
    } catch (err) {
      if (rsyncDaemonExited(child)) {
        onExit();
        return;
      }
      cleanup();
      reject(err);
      return;
    }
    cleanup();
    reject(new Error(`rsync daemon did not accept ${signal}`));
  });
}

async function stopRsyncDaemon(child: ReturnType<typeof spawn>): Promise<void> {
  if (await signalRsyncDaemonAndWait(child, "SIGTERM")) return;
  if (await signalRsyncDaemonAndWait(child, "SIGKILL")) return;
  throw new Error("rsync daemon did not exit after SIGTERM and SIGKILL");
}

async function stopRsyncTransfer(session: RSyncImportSession): Promise<void> {
  session.transportClosing = true;
  await session.transport.close();
  await stopRsyncDaemon(session.child);
}

async function stopRsyncSession(session: RSyncImportSession | undefined, preserveStage = false): Promise<void> {
  if (!session) return;
  await stopRsyncTransfer(session);
  rsyncImportSessions.delete(session.key);
  if (!preserveStage) await fs.rm(session.mode === "keys" ? session.stageDir : path.dirname(session.stageDir), { recursive: true, force: true });
  await fs.rm(path.dirname(session.configPath), { recursive: true, force: true }).catch(() => undefined);
}

async function stopConflictingRsyncSession(migrationId: string, port: number): Promise<void> {
  const sessions = [...rsyncImportSessions.values()];
  const conflictingSession = sessions.find((session) => session.migrationId !== migrationId);
  if (conflictingSession) {
    throw new Error(
      `rsync import port ${port} is already serving migrationId=${conflictingSession.migrationId} slug=${conflictingSession.slug}`,
    );
  }
  for (const session of sessions) {
    await stopRsyncSession(session, true);
  }
}

function stagingIdentity(deps: MigrationHandlerDeps, body: MigrationRequestBody, configTransferMode: MigrationConfigTransferMode): MigrationStagingIdentity {
  return { gatewayId: deps.gatewayId, instanceId: process.env.POD_UID?.trim() || `process-${process.pid}`, migrationId: body.migrationId, slug: body.slug, configTransferMode };
}

const GIT_METADATA_DIR = "git-metadata";

async function retainCheckoutStaging(stageDir: string): Promise<void> {
  for (const entry of await fs.readdir(stageDir)) {
    if (entry !== "customers" && entry !== GIT_METADATA_DIR) await fs.rm(path.join(stageDir, entry), { recursive: true, force: true });
  }
}

interface CheckedSpawnOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  label: string;
}

function checkedChildCloseError(code: number | null, signal: NodeJS.Signals | null, label: string, output: string): Error | undefined {
  if (signal != null) return new Error(`${label} terminated by ${signal}: ${output}`);
  return code === 0 ? undefined : new Error(`${label} failed (code=${code ?? 1}): ${output}`);
}

async function runSpawnChecked(command: string, args: string[], opts: CheckedSpawnOptions): Promise<void> {
  opts.signal?.throwIfAborted();
  const child = spawn(command, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForCheckedChildClose(child, opts);
}

function waitForCheckedChildClose(child: ChildProcess, opts: CheckedSpawnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = "", stderr = "";
    let settled = false;
    let pendingFailure: { error: unknown } | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(escalation);
      opts.signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const signalChild = (signal: NodeJS.Signals) => {
      if (settled) return;
      try { child.kill(signal); }
      catch (error) { provisionerLog(`[migration-rsync] ${opts.label} ${signal} failed: ${String(error)}`); }
    };
    const stop = (error: unknown) => {
      if (settled || pendingFailure) return;
      pendingFailure = { error };
      escalation = setTimeout(() => signalChild("SIGKILL"), RSYNC_DAEMON_STOP_TIMEOUT_MS);
      signalChild("SIGTERM");
    };
    const abort = () => stop(opts.signal?.reason ?? new Error(`${opts.label} cancelled`));
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (child.pid === undefined) settle(error);
      else stop(error);
    });
    child.on("close", (code, signal) => settle(pendingFailure
      ? pendingFailure.error
      : checkedChildCloseError(code, signal, opts.label, stderr.trim() || stdout.trim())));
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    if (opts.timeoutMs) timeout = setTimeout(() => stop(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  });
}

async function writeRsyncDaemonConfig(params: {
  dir: string;
  stageDir: string;
  transferUser: string;
  transferKey: string;
}): Promise<{ configPath: string; secretsPath: string }> {
  const secretsPath = path.join(params.dir, "rsyncd.secrets");
  await fs.writeFile(secretsPath, `${params.transferUser}:${params.transferKey}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const configPath = path.join(params.dir, "rsyncd.conf");
  const pidPath = path.join(params.dir, "rsyncd.pid");
  const lockPath = path.join(params.dir, "rsyncd.lock");
  await fs.writeFile(
    configPath,
    [
      "use chroot = no",
      RSYNC_DAEMON_SYMLINK_POLICY,
      "address = 127.0.0.1",
      "max connections = 1",
      "log file = /dev/stdout",
      `pid file = ${pidPath}`,
      `lock file = ${lockPath}`,
      `[${RSYNC_IMPORT_MODULE}]`,
      `  path = ${params.stageDir}`,
      "  read only = false",
      "  write only = true",
      "  list = false",
      `  auth users = ${params.transferUser}`,
      `  secrets file = ${secretsPath}`,
      "  hosts allow = 127.0.0.1",
      "",
    ].join("\n"),
    "utf-8",
  );
  return { configPath, secretsPath };
}

async function listRelativeEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(absDir: string, relDir: string): Promise<void> {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relDir ? path.posix.join(relDir, dirent.name) : dirent.name;
      entries.push(dirent.isDirectory() ? `${rel}/` : rel);
      if (dirent.isDirectory()) {
        await walk(path.join(absDir, dirent.name), rel);
      }
    }
  }
  await walk(root, "");
  return entries;
}

async function copyStageToOpenClaw(
  stageDir: string,
  importDir: string,
  slug: string,
  options: { baselineEntries?: readonly string[]; deferAgentState: boolean },
): Promise<void> {
  const { baselineEntries, deferAgentState } = options;
  const mountMarker = path.join("customers", slug, ".system", ".mounted");
  if (baselineEntries) {
    const current = new Set(await listRelativeEntries(stageDir));
    for (const relative of baselineEntries) {
      if (relative !== mountMarker && !(relative.endsWith("/") && mountMarker.startsWith(relative)) && !current.has(relative)) {
        await fs.rm(path.join(importDir, relative), { recursive: true, force: true });
      }
    }
  }
  await runSpawnChecked(
    RSYNC_BIN,
    [...STAGED_RSYNC_COPY_OPTIONS, `--exclude=/${mountMarker}`, ...CODEX_STORE_EXCLUDE_ARGS, CODEX_SNAPSHOT_EXCLUDE_ARG, CODEX_TEMP_EXCLUDE_ARG, ...(deferAgentState ? ["--exclude=/agents/"] : []), `${trimTrailingSlash(stageDir)}/`, `${trimTrailingSlash(importDir)}/`],
    { label: "rsync import copy", timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS },
  );
  if (baselineEntries) return;
  for (const directory of ["customers", GIT_METADATA_DIR]) {
    const relative = path.join(directory, slug);
    if (!await hasRealStageAncestors(stageDir, path.join(relative, ".entry"))) continue;
    await runSpawnChecked(RSYNC_BIN, [
      ...STAGED_RSYNC_COPY_OPTIONS, ...(directory === "customers" ? ["--exclude=/.system/.mounted"] : []), "--delete", `${path.join(stageDir, relative)}/`, `${path.join(importDir, relative)}/`,
    ], { label: "rsync user state copy", timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS });
  }
}

async function hasRealStageAncestors(stageDir: string, relativePath: string): Promise<boolean> {
  const root = await fs.lstat(stageDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("rsync stage root is not a real directory");
  }
  let parent = stageDir;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`rsync staged path has a non-directory ancestor: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function omitSafeDefaultAgentStateFromStage(stageDir: string): Promise<string[]> {
  const omitted: string[] = [];
  for (const { relativePath } of SAFE_DEFAULT_AGENT_PORTABLE_STATE_PATHS) {
    if (!await hasRealStageAncestors(stageDir, relativePath)) continue;
    const absolutePath = path.join(stageDir, relativePath);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await fs.rm(absolutePath, { recursive: true, force: true });
    } else {
      await fs.unlink(absolutePath);
    }
    omitted.push(relativePath);
  }
  if (!await hasRealStageAncestors(stageDir, "workspaces/.placeholder")) return omitted;
  try {
    await fs.rmdir(path.join(stageDir, "workspaces"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
  return omitted;
}

interface RsyncPhaseRequest<T extends MigrationRequestBody> {
  body: T;
  mode: MigrationTransferMode;
  configTransferMode: MigrationConfigTransferMode;
}

function parseRsyncPhaseRequest<
  T extends MigrationRequestBody & {
    rpcPhase?: unknown;
    mode?: unknown;
    configTransferMode?: unknown;
    transferAttemptId?: unknown;
  },
>(
  req: Request,
  res: Response,
  deps: MigrationHandlerDeps,
  phase: RsyncMigrationRpcPhase,
  log: (msg: string, fields?: LogContext) => void,
): RsyncPhaseRequest<T> | null {
  const body = parseAndVerifyJsonBody<T>(req, res, deps, log);
  if (!body) return null;
  if (!validateRsyncRpcPhase(body.rpcPhase, phase, res)) return null;
  if (!validateTransferAttempt(body.transferAttemptId, res)) return null;
  const mode = validateTransferMode(body.mode, res);
  if (!mode) return null;
  const configTransferMode = validateRsyncConfigTransferMode(body.configTransferMode, mode, res);
  if (!configTransferMode) return null;
  if (!requireConfiguredUserSystemConfigTransfer(body.slug, configTransferMode, res)) return null;
  return { body, mode, configTransferMode };
}

function validateRsyncTransferCredentials(
  body: { transferUser?: unknown; transferKey?: unknown },
  res: Response,
): { transferUser: string; transferKey: string } | null {
  const transferUser = validateRsyncCredential(body.transferUser, "transferUser", res);
  if (!transferUser) return null;
  const transferKey = validateRsyncCredential(body.transferKey, "transferKey", res);
  if (!transferKey) return null;
  return { transferUser, transferKey };
}

async function startRsyncTransport(input: {
  deps: MigrationHandlerDeps;
  tmpDir: string;
  configPath: string;
  publicPort: number;
  sourcePodIp?: string;
  log: (msg: string, fields?: LogContext) => void;
}): Promise<{ child: ReturnType<typeof spawn>; transport: MigrationTlsEndpoint }> {
  const { deps } = input;
  const daemonPort = await (deps.reserveLoopbackPort ?? reserveLoopbackPort)();
  const child = spawn(
    RSYNC_BIN,
    ["--daemon", "--no-detach", `--config=${input.configPath}`, `--port=${daemonPort}`],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    await (deps.waitForRsyncReady ?? waitForTcpPort)(daemonPort);
    const transport = await (deps.openMigrationTlsEndpoint ?? openMigrationTlsEndpoint)({
      dir: input.tmpDir,
      publicPort: input.publicPort,
      upstreamPort: daemonPort,
      sourceIp: input.sourcePodIp,
      log: input.log,
    });
    return { child, transport };
  } catch (error) {
    await stopRsyncDaemon(child).catch(() => undefined);
    await fs.rm(input.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readStagedSourceEntries(stageDir: string, slug: string): Promise<string[] | undefined> {
  const entries: unknown = await fs.readFile(path.join(path.dirname(stageDir), "source-entries.json"), "utf8")
    .then((value) => JSON.parse(value))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" ||
    (!entry.startsWith(`customers/${slug}/`) && !entry.startsWith(`${GIT_METADATA_DIR}/${slug}/`)) || entry.split("/").includes(".."))) {
    throw new Error("migration preparation contains unsafe source paths");
  }
  return entries;
}

async function prepareRsyncImportDirectories(
  deps: MigrationHandlerDeps,
  body: PrepareRsyncImportRequestBody,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
): Promise<{ tmpDir: string; stageDir: string; importDir: string; baselineEntries: string[] | undefined }> {
  const importDir = mode === "keys"
    ? await deps.adapter.prepareKeyImportDir(body.slug)
    : await deps.adapter.prepareImportDir(body.slug, mode);
  if (mode !== "keys") deps.adapter.markUserMigratingIn?.(body.slug);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-${body.migrationId}-`));
  try {
    const stageDir = mode === "keys"
      ? path.join(tmpDir, "stage")
      : await prepareMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, configTransferMode));
    await fs.mkdir(stageDir, { recursive: true });
    if (mode !== "keys") await retainCheckoutStaging(stageDir);
    const baselineEntries = mode === "final" ? await readStagedSourceEntries(stageDir, body.slug) : undefined;
    return { tmpDir, stageDir, importDir, baselineEntries };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

export function migrationImportBusy(): boolean {
  return preparingRsyncImport || abortingRsyncImport || finishingRsyncImports.size > 0;
}

export function ownsFinalMigrationImport(migrationId: string, slug: string): boolean {
  return !preparingRsyncImport && finishingRsyncImports.size === 1 && finishingRsyncImports.has(rsyncSessionKey(migrationId, slug, "final"));
}

function validateRsyncSourceAddress(sourcePodIp: string | undefined, res: Response): boolean {
  if (sourcePodIp === undefined || net.isIP(sourcePodIp)) return true;
  res.status(400).json({ error: "invalid sourcePodIp" });
  return false;
}

export function createPrepareRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<PrepareRsyncImportRequestBody>(
      req,
      res,
      deps,
      "prepare-rsync-import",
      log,
    );
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    const credentials = validateRsyncTransferCredentials(body, res);
    if (!credentials) return;
    const { transferUser, transferKey } = credentials;
    if (!validateRsyncSourceAddress(body.sourcePodIp, res)) return;

    if (migrationImportBusy()) {
      res.status(409).json({ error: "migration import preparation is already in progress" });
      return;
    }
    const port = rsyncPortFromDeps(deps);
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    if (!admitRsyncPrepareAttempt(key, body, res)) return;
    preparingRsyncImport = true;
    let activation: ConfiguredUserActivation | null = null;
    try {
      await assertTargetImportAllowed(deps, body.slug);
      activation = await configuredUserActivationRequest(deps, body, mode, configTransferMode);
      if (activation?.live) {
        await admitLiveConfiguredUserImport(deps, activation);
      } else if (activation) {
        await deps.reserveSurgeTarget!(activation.request);
      } else if (configTransferMode === USER_SYSTEM_CONFIG_TRANSFER) {
        await deps.reserveSurgeTarget?.({ migrationId: body.migrationId, slug: body.slug });
      }
      await stopConflictingRsyncSession(body.migrationId, port);
      const { tmpDir, stageDir, importDir, baselineEntries } = await prepareRsyncImportDirectories(deps, body, mode, configTransferMode);
      const { configPath, secretsPath } = await writeRsyncDaemonConfig({
        dir: tmpDir,
        stageDir,
        transferUser,
        transferKey,
      });
      const { child, transport } = await startRsyncTransport({
        deps,
        tmpDir,
        configPath,
        publicPort: port,
        sourcePodIp: body.sourcePodIp,
        log,
      });
      const session: RSyncImportSession = {
        key,
        transferAttemptId: body.transferAttemptId,
        migrationId: body.migrationId,
        slug: body.slug,
        mode,
        configTransferMode,
        stageDir,
        importDir,
        configPath,
        secretsPath,
        child,
        transport,
        baselineEntries,
      };
      rsyncImportSessions.set(key, session);
      child.on("exit", (code, signal) => {
        if (rsyncImportSessions.get(key) === session) rsyncImportSessions.delete(key);
        if (session.transportClosing) return;
        session.transportClosing = true;
        log(
          `[migration-rsync] 🔴 rsync daemon exited before its import finished code=${code} signal=${signal} migrationId=${body.migrationId} slug=${body.slug}; closing import port ${port}`,
          { status: "failed" },
        );
        session.transport.close().catch((error: unknown) => {
          log(
            `[migration-rsync] 🔴 import port ${port} did not close migrationId=${body.migrationId} slug=${body.slug}: ${error instanceof Error ? error.message : String(error)}`,
            { status: "failed" },
          );
        });
      });
      child.on("error", (err) => {
        log(
          `[migration-rsync] 🔴 rsync daemon error migrationId=${body.migrationId} slug=${body.slug}: ${err.message}`, { status: "failed" },
        );
      });
      const response: PrepareRsyncImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        host: requestLocalAddress(req),
        port,
        module: RSYNC_IMPORT_MODULE,
        certificatePem: transport.certificatePem,
      };
      log(
        `🟡 [migration-rsync] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} port=${port}`,
      );
      res.status(200).json(response);
    } catch (err) {
      await stopRsyncSession(rsyncImportSessions.get(key)).catch(() => undefined);
      if (activation && !activation.live) {
        await deps.unreserveSurgeTarget!(activation.request).catch((error: unknown) => {
          log(`[migration-rsync] failed to cancel user preparation migrationId=${body.migrationId} slug=${body.slug}: ${String(error)}`);
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-rsync] 🔴 prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "prepare-rsync-import failed", message });
    } finally {
      preparingRsyncImport = false;
    }
  });
}

function validateRsyncPushTarget(body: PushRsyncStateRequestBody, res: Response): {
  targetHost: string;
  targetPort: number;
  targetCertificatePem: string;
  transferUser: string;
  transferKey: string;
} | null {
  const targetHost = validateRsyncTargetHost(body.targetHost, res);
  if (!targetHost) return null;
  const targetPort = validateRsyncPort(body.targetPort, res);
  if (targetPort === null) return null;
  if (!isMigrationCertificatePem(body.targetCertificatePem)) {
    res.status(400).json({ error: "invalid targetCertificatePem" });
    return null;
  }
  const credentials = validateRsyncTransferCredentials(body, res);
  if (!credentials) return null;
  return { targetHost, targetPort, targetCertificatePem: body.targetCertificatePem, ...credentials };
}

function sourcePushConvergence(
  deps: MigrationHandlerDeps,
  body: PushRsyncStateRequestBody,
  mode: MigrationTransferMode,
  log: (msg: string, fields?: LogContext) => void,
): { convergeSource: boolean; refused?: string } {
  if (mode !== "pre") return { convergeSource: false };
  const refusal = deps.sourceMountRefusal?.(body.slug) ?? null;
  if (!refusal) return { convergeSource: true };
  if (refusal.converged) {
    log(`[migration-activation:${body.slug}] exporting the converged configuration; the pending configuration is permanently refused: ${refusal.reason}`);
    return { convergeSource: false };
  }
  const refused = `[migration-activation:${body.slug}] source has no converged configuration for ${body.slug}: its configuration was permanently refused (${refusal.reason}); ` +
    "nothing converged to carry; park and release the user so placement mounts it fresh, or erase it";
  log(`[migration-rsync] 🔴 push-state migrationId=${body.migrationId} slug=${body.slug}: ${refused}`, { status: "failed" });
  return { convergeSource: false, refused };
}

export function createPushRsyncStateHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  const timeoutMs = deps.pushStateTimeoutMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<PushRsyncStateRequestBody>(
      req,
      res,
      deps,
      "push-rsync-state",
      log,
    );
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    if (
      configTransferMode === USER_SYSTEM_CONFIG_TRANSFER &&
      body.includeActivationManifest === true
    ) {
      res.status(400).json({ error: "configured user system config transfer cannot include activation manifest" });
      return;
    }
    const target = validateRsyncPushTarget(body, res);
    if (!target) return;
    const convergence = sourcePushConvergence(deps, body, mode, log);
    if (convergence.refused) {
      res.status(409).json({ error: "source mount refused", message: convergence.refused });
      return;
    }
    const { targetHost, targetPort, targetCertificatePem, transferUser, transferKey } = target;
    const deadline = Date.now() + timeoutMs;

    let cleanupActivationManifest: () => Promise<void> = async () => {};
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-push-${body.migrationId}-`));
    const { controller, detach } = attachImportDisconnectHandlers(res, body.migrationId, body.slug, log, "export");
    const transferTimer = setTimeout(() => controller.abort(new Error("rsync push-state transfer deadline exceeded")), Math.max(0, deadline - Date.now()));
    try {
      const { sourceHeld, retained, sources } = await sourceExportInventory(deps, body, mode, controller.signal);
      if (sources.length === 0) {
        res
          .status(404)
          .json({ error: "no export paths", message: `nothing to push for slug=${body.slug}` });
        return;
      }
      const postgresHandoff = mode === "final" && (await findPortableAgentStores(sources)).some(store =>
        readPostgresAgentAnchor(path.join(store.sourceAgentDir, AGENT_STORE_BASENAME)) !== null);

      const manifestRequest = configTransferMode === USER_SYSTEM_CONFIG_TRANSFER ? { ...body, includeActivationManifest: false } : body;
      const activationManifest = mode === "keys"
        ? { source: null, cleanup: async () => {} }
        : await maybeMaterializeActivationManifest(deps, manifestRequest, {
            signal: controller.signal,
            timeoutMs: remainingTransferTimeout(deadline, controller.signal),
            preserveForRollback: postgresHandoff,
            sourceHeld,
            convergeSource: convergence.convergeSource,
          });
      cleanupActivationManifest = activationManifest.cleanup;
      if (mode === "final") {
        sources.push(...await exportAgentStoreSnapshots({
          sources,
          exportRoot: path.join(tmpDir, "snapshots"),
          signal: controller.signal,
          log,
          detachAgents: async (agentIds) => {
            if (sourceHeld) {
              await retained?.assertCurrent();
              log(`[migration-rsync] OpenClaw is held for migration ${body.migrationId}; carrying ${agentIds.length} closed anchors without detach`);
              return;
            }
            if (agentIds.length === 1) {
              controller.signal.throwIfAborted();
              if (!deps.adapter.releaseAgent) throw new Error("Gateway cannot detach PostgreSQL agents");
              await deps.adapter.releaseAgent(agentIds[0]!);
              return;
            }
            await retained?.assertCurrent();
            if (!deps.adapter.detachSourceAgents) throw new Error("Gateway cannot detach PostgreSQL agents");
            await deps.adapter.detachSourceAgents(body.slug, agentIds, controller.signal);
          },
        }));
      }

      if (activationManifest.source) sources.push(activationManifest.source);
      await retained?.assertCurrent();

      const passwordFile = path.join(tmpDir, "rsync.pass");
      await fs.writeFile(passwordFile, `${transferKey}\n`, { encoding: "utf-8", mode: 0o600 });
      const certificatePath = path.join(tmpDir, "target.crt");
      await fs.writeFile(certificatePath, targetCertificatePem, { encoding: "utf-8", mode: 0o600 });
      const destination = `rsync://${transferUser}@${targetHost}/${RSYNC_IMPORT_MODULE}/`;
      dlog(
        `[migration-rsync] push-state mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length} target=${targetHost}:${targetPort}`,
      );
      await runSpawnChecked(
        RSYNC_BIN,
        sourceTransferRsyncArgs(sources, passwordFile, destination, mode),
        {
          timeoutMs: remainingTransferTimeout(deadline, controller.signal),
          signal: controller.signal,
          label: "rsync push-state",
          env: {
            ...process.env,
            RSYNC_CONNECT_PROG: rsyncTlsConnectProgram({ certificatePath, host: targetHost, port: targetPort }),
          },
        },
      );
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      dlog(
        `[migration-rsync] 🟢 push-state migrationId=${body.migrationId} slug=${body.slug} target=${targetHost}:${targetPort} done`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] 🔴 push-state migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "push-rsync-state failed", message });
    } finally {
      clearTimeout(transferTimer);
      detach();
      await cleanupActivationManifest();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function remainingTransferTimeout(deadline: number, signal: AbortSignal): number {
  signal.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("rsync push-state preparation exhausted its transfer deadline");
  return remaining;
}

async function validateStagedGitMetadata(stageDir: string, slug: string): Promise<string | null> {
  const metadataPath = path.join(GIT_METADATA_DIR, slug);
  for (const relative of ["", GIT_METADATA_DIR, metadataPath]) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(path.join(stageDir, relative));
    } catch (error) {
      if (relative && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return `unsafe Git metadata: ${relative || "."} is not a real directory`;
    }
  }
  const unsafeEntry = findUnsafeUserGitMetadataEntry(path.join(stageDir, metadataPath));
  return unsafeEntry === null ? null : `unsafe Git metadata: ${path.join(metadataPath, unsafeEntry)}`;
}

async function discardPreCopyAgentSnapshots(
  stageDir: string,
  log: (message: string, fields?: LogContext) => void,
): Promise<void> {
  const snapshots = await findStagedAgentSnapshots(stageDir);
  if (snapshots.length === 0) return;
  for (const snapshot of snapshots) await fs.rm(path.dirname(snapshot.snapshotDir), { recursive: true, force: true });
  log(`[migration-rsync] discarded agent snapshots an older source carried in its pre-copy: ${snapshots.map((snapshot) => snapshot.agentId).join(", ")}`);
}

async function validateStagedRsyncImport(
  session: RSyncImportSession,
  slug: string,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
  log: (message: string, fields?: LogContext) => void,
): Promise<string | null> {
  const unsafeGitMetadata = await validateStagedGitMetadata(session.stageDir, slug);
  if (unsafeGitMetadata !== null) return unsafeGitMetadata;
  if (mode !== "keys") {
    const omitted = await omitSafeDefaultAgentStateFromStage(session.stageDir);
    if (omitted.length > 0) {
      log(`[migration-rsync] omitted system fallback state from staged import: ${omitted.join(",")}`);
    }
  }
  const entries = await listRelativeEntries(session.stageDir);
  const configuredUserStateDir = resolveOpenClawStateDir();
  const configuredUserStatePlan = configTransferMode === USER_SYSTEM_CONFIG_TRANSFER
    ? configuredUserPortableStatePlan(openClawConfigPath(), configuredUserStateDir)
    : undefined;
  const violation = findPathTraversalViolation(entries, slug, mode, [], configuredUserStatePlan);
  if (violation !== null) return violation;
  await omitStagedCodexTemporaryFiles(session.stageDir, log);
  await assertSafeStagedSymlinks(session.stageDir, session.importDir, slug);
  const liveStores = await findStagedLiveAgentStores(session.stageDir);
  if (liveStores.length > 0) {
    return `carried live agent database files instead of snapshots: ${liveStores.join(", ")}`;
  }
  if (mode === "pre") await discardPreCopyAgentSnapshots(session.stageDir, log);
  await omitRawCodexDatabases(session.stageDir, log);
  const staged = (await listSqliteStores(session.stageDir)).filter((store) => !isAgentSnapshotArtifact(store) &&
    !isCodexDatabase(path.relative(session.stageDir, store).split(path.sep).join("/")));
  const unreadable = await findUnreadableStore({ storePaths: staged, relativeTo: session.stageDir });
  if (unreadable) {
    return `carried agent store ${unreadable.path} does not open: ${unreadable.message}`;
  }
  if (configuredUserStatePlan) {
    if (path.resolve(configuredUserStateDir) !== path.resolve(session.importDir)) {
      throw new Error("configured user state root does not match the import root");
    }
    assertConfiguredUserPortableStatePlanOnDisk(session.stageDir, configuredUserStatePlan);
    assertConfiguredUserPortableStatePlanOnDisk(session.importDir, configuredUserStatePlan);
  }
  return null;
}

type UserImportTarget = { migrationId: string; slug: string; targetPodUid: string };

interface ConfiguredUserActivation {
  request: UserImportTarget;
  live: boolean;
}

async function configuredUserActivationRequest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
): Promise<ConfiguredUserActivation | null> {
  if (mode === "keys" || configTransferMode !== ACTIVATION_MANIFEST_TRANSFER ||
    deps.adapter.isIsolatedGateway?.() !== true) return null;
  if (deps.adapter.isConfiguredUser?.(body.slug) !== true) {
    throw new Error("import does not match the configured user");
  }
  const targetPodUid = process.env.POD_UID?.trim();
  if (!targetPodUid || !deps.reserveSurgeTarget || !deps.releaseSurgeReadiness || !deps.unreserveSurgeTarget ||
    !deps.surgeTargetLive || !deps.admitLiveSurgeTarget || !deps.liveSurgeTargetAssigned) {
    throw new Error("configured user activation requires its pod-bound process gate");
  }
  const request = { migrationId: body.migrationId, slug: body.slug, targetPodUid };
  return { request, live: await deps.surgeTargetLive(request) };
}

async function assertSystemConfigImportHeld(
  deps: MigrationHandlerDeps,
  request: UserImportTarget,
): Promise<void> {
  if (process.env.POD_UID?.trim() !== request.targetPodUid ||
    deps.adapter.isIsolatedGateway?.() !== true || deps.adapter.isConfiguredUser?.(request.slug) !== true ||
    await deps.surgeTargetOpenClawHeld?.(request) !== true) {
    throw new Error("system-config import requires its reserved isolated target to remain held");
  }
}

async function systemConfigImportTarget(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody,
  configTransferMode: MigrationConfigTransferMode,
): Promise<UserImportTarget | undefined> {
  if (configTransferMode !== USER_SYSTEM_CONFIG_TRANSFER) return undefined;
  const targetPodUid = process.env.POD_UID?.trim();
  if (!targetPodUid) throw new Error("system-config import requires its current isolated pod");
  const request = { migrationId: body.migrationId, slug: body.slug, targetPodUid };
  await assertSystemConfigImportHeld(deps, request);
  return request;
}

function liveImportAdmission(deps: MigrationHandlerDeps, activation: ConfiguredUserActivation): Promise<LiveImportAdmission | null> {
  return readLiveImportAdmission(os.tmpdir(), stagingIdentity(deps, activation.request, ACTIVATION_MANIFEST_TRANSFER));
}

function recordLiveImportAdmission(
  deps: MigrationHandlerDeps,
  activation: ConfiguredUserActivation,
  decision: LiveImportAdmission,
): Promise<void> {
  return writeLiveImportAdmission(os.tmpdir(), stagingIdentity(deps, activation.request, ACTIVATION_MANIFEST_TRANSFER), decision);
}

async function admitLiveConfiguredUserImport(
  deps: MigrationHandlerDeps,
  activation: ConfiguredUserActivation,
): Promise<void> {
  try {
    if (deps.adapter.userMountMarked?.(activation.request.slug) !== false) {
      throw new Error("live user import requires the configured user to be unmounted");
    }
    await deps.admitLiveSurgeTarget!(activation.request);
  } catch (error) {
    if (await liveImportAdmission(deps, activation) !== "admitted") await recordLiveImportAdmission(deps, activation, "refused");
    throw error;
  }
  await recordLiveImportAdmission(deps, activation, "admitted");
  (deps.log ?? provisionerLog)(
    `[migration-rsync] importing into live user OpenClaw migrationId=${activation.request.migrationId} slug=${activation.request.slug}`,
  );
}

async function activateUserDefaultAgent(
  deps: MigrationHandlerDeps,
  slug: string,
  signal: AbortSignal,
  loadStrategy: MigrationLoadStrategy,
  opts: { deferRuntimeVerification?: true; migrationId?: string },
): Promise<string | undefined> {
  const verificationPending = await activateImportedUserForMigration({
    ...opts,
    deps,
    slug,
    mode: "final",
    loadStrategy,
    signal,
  });
  signal.throwIfAborted();
  return verificationPending;
}

async function activateConfiguredUserImport(
  deps: MigrationHandlerDeps,
  activation: ConfiguredUserActivation,
  signal: AbortSignal,
  loadStrategy: MigrationLoadStrategy,
  deferRuntimeVerification?: true,
): Promise<string | undefined> {
  if (activation.live) {
    signal.throwIfAborted();
    return activateUserDefaultAgent(deps, activation.request.slug, signal, loadStrategy, {
      deferRuntimeVerification, migrationId: activation.request.migrationId,
    });
  }
  const { request } = activation;
  let cancellation: Promise<void> | null = null;
  let cancellationFailure: Error | null = null;
  const cancel = (): void => {
    cancellation ??= Promise.resolve().then(() => deps.unreserveSurgeTarget!(request)).then(
      () => undefined,
      (error: unknown) => { cancellationFailure = error instanceof Error ? error : new Error(String(error)); },
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const releaseStartedAt = Date.now();
    await deps.releaseSurgeReadiness!({
      migrationId: request.migrationId,
      targetPodUid: request.targetPodUid,
      importSlug: request.slug,
    });
    (deps.log ?? provisionerLog)(
      `[migration-rsync] isolated-release migrationId=${request.migrationId} slug=${request.slug}`,
      { durationMs: Date.now() - releaseStartedAt },
    );
    signal.throwIfAborted();
    return await activateUserDefaultAgent(deps, request.slug, signal, loadStrategy, { deferRuntimeVerification });
  } catch (error) {
    (deps.log ?? provisionerLog)(
      `[migration-rsync] User activation failed migrationId=${request.migrationId} slug=${request.slug}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    cancel();
    await cancellation;
    if (cancellationFailure) {
      throw new AggregateError([error, cancellationFailure], "User activation failed and could not be cancelled");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function recordRestoredConvergence(
  deps: MigrationHandlerDeps,
  slug: string,
  restored: RestoreUserRuntimeResult,
): void {
  if (!deps.adapter.recordAppliedFingerprint) return;
  const log = deps.log ?? provisionerLog;
  if (!restored.convergedState) {
    log(
      `⚠ [migration-http] restore of ${slug} left its re-assert incomplete; no fingerprint recorded so the reconcile re-ensures it`,
    );
    return;
  }
  if (restored.appliedFingerprint === undefined) {
    log(
      `⚠ [migration-http] restore of ${slug} reported no applied fingerprint; the reconcile re-ensures it as content-stale`,
    );
    return;
  }
  deps.adapter.recordAppliedFingerprint(
    slug,
    restored.pendingProjectClones.length > 0
      ? pendingCloneAppliedFingerprint(restored.appliedFingerprint)
      : restored.appliedFingerprint,
  );
}

function targetIdentityCustody(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, uid: string): MigrationTargetIdentityCustody {
  const podUid = process.env.POD_UID?.trim();
  if (!podUid) throw new Error("target identity requires its current pod");
  const custody = { migrationId: body.migrationId, uid, gatewayId: deps.gatewayId, podUid };
  assertTargetIdentityCustody(custody, custody);
  return custody;
}

async function sharedTargetWorkspaceRestore(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, importDir: string, signal: AbortSignal, stageDir?: string): Promise<(() => Promise<void>) | undefined> {
  if (deps.adapter.isIsolatedGateway?.() !== false) return undefined;
  signal.throwIfAborted();
  return sharedManifestWorkspaceRestore({ deps, body, importDir, signal, stageDir });
}

type TargetWorkspaceRestoreInput = { deps: MigrationHandlerDeps; body: FinishRsyncImportRequestBody; importDir: string; signal: AbortSignal; stageDir?: string };

async function sharedManifestWorkspaceRestore({ deps, body, importDir, signal, stageDir }: TargetWorkspaceRestoreInput): Promise<() => Promise<void>> {
  const readAuthority = deps.adapter.targetMigrationIdentityCustody;
  if (!readAuthority) throw new Error("Shared target requires current migration identity authority");
  const authority = await readAuthority(body.slug, body.migrationId), custody = authority.custody;
  assertTargetIdentityCustody(custody, targetIdentityCustody(deps, body, custody.uid));
  const incoming = await readActivationManifest(stageDir ?? importDir, body.slug);
  const agentIds = [incoming.agentId, ...incoming.projectAgents.map(agent => agent.agentId)];
  const previous = stageDir ? await readActivationManifest(importDir, body.slug).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") { return null; } throw error; }) : incoming;
  const prior = previous?.targetWorkspaceIdentities;
  let capture: TargetWorkspaceIdentities;
  if (prior?.migrationId === body.migrationId) {
    assertTargetIdentityCustody(prior, custody);
    const withoutCapture = (manifest: typeof incoming) => { const rest = { ...manifest }; delete rest.targetWorkspaceIdentities; return rest; };
    if (!isDeepStrictEqual(withoutCapture(previous!), withoutCapture(incoming))) throw new Error("Shared target activation manifest changed");
    capture = validateTargetWorkspaceIdentities(prior, body.slug, agentIds);
  } else {
    if (!stageDir) throw new Error("Shared target requires original workspace identity retransmission");
    capture = await captureTargetWorkspaceIdentities(body.slug, agentIds, stageDir, custody, privateProjectWorkspaceAgentIds(incoming));
  }
  const retained = { ...incoming, targetWorkspaceIdentities: capture };
  if (stageDir) {
    await writeActivationManifest(importDir, retained);
    await writeActivationManifest(stageDir, retained);
  }
  const assertCurrent = async () => {
    signal.throwIfAborted();
    if (!isDeepStrictEqual(await readAuthority(body.slug, body.migrationId), authority)) throw new Error("Shared target migration identity authority changed");
    assertTargetIdentityCustody(custody, targetIdentityCustody(deps, body, custody.uid));
    if (!isDeepStrictEqual(await readActivationManifest(importDir, body.slug), retained)) throw new Error("Shared target workspace identity capture changed");
    signal.throwIfAborted();
  };
  await assertCurrent();
  return () => restoreTargetWorkspaceIdentities(capture, body.slug, agentIds, importDir, { custody, assertCurrent, privateWorkspaces: privateProjectWorkspaceAgentIds(incoming) });
}

async function activateFinishedRsyncImport(input: {
  deps: MigrationHandlerDeps;
  body: FinishRsyncImportRequestBody;
  configTransferMode: MigrationConfigTransferMode;
  loadStrategy: MigrationLoadStrategy;
  signal: AbortSignal;
  beforeRuntimePublish?: () => Promise<void>;
}): Promise<string | undefined> {
  const { deps, body, configTransferMode, loadStrategy, signal } = input;
  deps.adapter.markUserMigratingIn?.(body.slug);
  if (configTransferMode === ACTIVATION_MANIFEST_TRANSFER) {
    await pauseSystemConfigWatchForUser(deps, body.slug);
    const activation = await configuredUserActivationRequest(deps, body, "final", configTransferMode);
    let verificationPending: string | undefined;
    if (activation) {
      verificationPending = await activateConfiguredUserImport(deps, activation, signal, loadStrategy, body.preserveSource);
    } else {
      verificationPending = await activateImportedUserForMigration({
        deps,
        slug: body.slug,
        migrationId: body.migrationId,
        mode: "final",
        loadStrategy,
        signal,
        beforeRuntimePublish: input.beforeRuntimePublish,
        ...(input.beforeRuntimePublish && !body.preserveSource
          ? { sharedToSharedRoster: true }
          : {}),
      });
    }
    deps.adapter.writeMountMarker?.(body.slug);
    deps.adapter.onMounted?.(body.slug);
    return verificationPending;
  }
  return undefined;
}

async function removeObsoletePreparedProjects(deps: MigrationHandlerDeps, session: RSyncImportSession, slug: string): Promise<void> {
  if (!session.baselineEntries) return;
  const projectsDir = path.join(session.importDir, "customers", slug, "projects");
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length === 0) return;
  const uid = await deps.adapter.uidForSlug(slug);
  if (!uid) throw new Error("prepared user no longer has an owner");
  const snapshot = await deps.adapter.loadUserSnapshot(uid, { refresh: true });
  if (!snapshot || snapshot.slug !== slug) throw new Error("prepared user ownership changed");
  const desired = new Set((snapshot.projects ?? []).filter(project => projectCheckoutEnabled(project.checkoutEnabled) &&
    (project.provisioningState === undefined || project.provisioningState === "active")).map(project => project.projectSlug));
  for (const entry of entries) {
    if (desired.has(entry.name)) continue;
    const relative = path.join("customers", slug, "projects", entry.name);
    const sourcePresent = await fs.lstat(path.join(session.stageDir, relative)).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (sourcePresent) continue;
    await fs.rm(path.join(session.importDir, relative), { recursive: true, force: true });
    await fs.rm(path.join(session.importDir, GIT_METADATA_DIR, slug, "projects", `${entry.name}.git`), { recursive: true, force: true });
  }
}

interface StagedImportInput {
  preserveSource?: true;
  deps: MigrationHandlerDeps;
  session: RSyncImportSession;
  slug: string;
  mode: MigrationTransferMode;
  activation: ConfiguredUserActivation | null;
  heldTarget?: UserImportTarget;
  signal: AbortSignal;
  log: (msg: string, fields?: LogContext) => void;
}

async function carriedUserWorkspace(input: StagedImportInput, agentId: string): Promise<string | null> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown" || parsed.username !== input.slug) return null;
  const uid = await input.deps.adapter.uidForSlug(input.slug);
  if (!uid) throw new Error("Carried user workspace has no current owner");
  const snapshot = await input.deps.adapter.loadUserSnapshot(uid, { refresh: true });
  if (!snapshot || snapshot.uid !== uid || snapshot.slug !== input.slug) throw new Error("Carried user workspace ownership changed");
  const workspace = path.join(input.session.importDir, "customers", input.slug);
  if (parsed.kind === "coach") return workspace;
  if (!activeAgentProjectIds(snapshot.projectAgents ?? []).has(parsed.project)) return null;
  const privateWorkspace = snapshot.projectAgents?.some(agent => agent.projectId === parsed.project && agent.githubBacked);
  return privateWorkspace ? projectAgentWorkspace(workspace, parsed.project) : path.join(workspace, "projects", parsed.project);
}

async function heldUserImport(input: StagedImportInput): Promise<UserImportTarget | null> {
  if (input.heldTarget) {
    await assertSystemConfigImportHeld(input.deps, input.heldTarget);
    return input.heldTarget;
  }
  const activation = input.activation;
  if (!activation || activation.live) return null;
  return await input.deps.surgeTargetOpenClawHeld?.(activation.request) === true ? activation.request : null;
}

function upgradesCarriedAgents(input: StagedImportInput): boolean {
  return input.deps.adapter.isIsolatedGateway?.() === false || Boolean(input.activation);
}

async function upgradeCarriedAgents(input: StagedImportInput, prepared: PreparedAgentStores): Promise<void> {
  const readAuthority = input.deps.adapter.targetMigrationIdentityCustody;
  if (!readAuthority) throw new Error("target requires current migration agent authority");
  const authority = await readAuthority(input.slug, input.session.migrationId);
  const body = { migrationId: input.session.migrationId } as FinishRsyncImportRequestBody;
  assertTargetIdentityCustody(authority.custody, targetIdentityCustody(input.deps, body, authority.custody.uid));
  const expected = authority.anchors;
  if (!Array.isArray(expected) || expected.length !== prepared.stores.length ||
      new Set(expected.map(anchor => anchor.agentId)).size !== expected.length ||
      new Set(prepared.stores.map(store => store.agentId)).size !== prepared.stores.length) {
    throw new Error("carried agent roster does not match migration authority");
  }
  if (prepared.stores.length === 0) return;
  const stores = prepared.stores.map(store => {
    const anchor = expected.find(item => item.agentId === store.agentId);
    if (!anchor) throw new Error(`carried agent is not authorized: ${store.agentId}`);
    return { ...anchor, anchorPath: store.destinationPath };
  });
  const assertCurrent = async () => {
    input.signal.throwIfAborted();
    if (!isDeepStrictEqual(await readAuthority(input.slug, input.session.migrationId), authority)) {
      throw new Error("target migration agent authority changed");
    }
    assertTargetIdentityCustody(authority.custody, targetIdentityCustody(input.deps, body, authority.custody.uid));
    input.signal.throwIfAborted();
  };
  await (input.deps.upgradeImportedAgents ?? upgradeImportedAgentStores)({ stores, allowUpgrade: !input.preserveSource, assertCurrent, signal: input.signal,
    log: message => input.log(message), run: input.deps.runOpenClaw });
}

async function reattachOfflineUserAgents(input: StagedImportInput, prepared: PreparedAgentStores, offlineTarget: UserImportTarget): Promise<void> {
  if (input.heldTarget || prepared.stores.length === 0) return;
  const { deps, session, log } = input;
  const startedAt = Date.now();
  await reattachUserAgents({
    stores: prepared.stores,
    diagnosticIdentity: offlineTarget,
    env: { ...process.env, OPENCLAW_STATE_DIR: session.importDir, OPENCLAW_DIR: session.importDir, OPENCLAW_CONFIG_PATH: openClawConfigPath() },
    run: deps.runOpenClaw,
    resolveCarriedWorkspace: agentId => carriedUserWorkspace(input, agentId),
    signal: input.signal,
    log,
    assertHeld: async () => {
      if (await deps.surgeTargetOpenClawHeld?.(offlineTarget) !== true) {
        throw new Error("Native user restoration requires the migration target to remain held");
      }
    },
  });
  log(`[migration-rsync] final-import agent-reattach migrationId=${session.migrationId} slug=${input.slug} agents=${prepared.stores.length}`, { durationMs: Date.now() - startedAt });
}

async function deliverStagedImport(input: StagedImportInput): Promise<void> {
  const { deps, session, log } = input;
  if (input.preserveSource && input.activation && !input.activation.live) {
    throw new Error("Isolated target did not finish normal startup before import; source retained");
  }
  const deferAgentState = input.mode === "pre" && (!input.activation || input.activation.live);
  const copyOptions = { baselineEntries: session.baselineEntries, deferAgentState };
  if (input.mode !== "final") {
    if (input.activation) await removeObsoletePreparedProjects(deps, session, input.slug);
    await copyStageToOpenClaw(session.stageDir, session.importDir, input.slug, copyOptions);
    return;
  }
  const snapshotStartedAt = Date.now();
  const prepared = await prepareAgentStoreSnapshots({
    stageDir: session.stageDir,
    importDir: session.importDir,
    migrationId: session.migrationId,
    signal: input.signal,
    log,
  });
  log(`[migration-rsync] final-import agent-snapshots migrationId=${session.migrationId} slug=${input.slug}`, { durationMs: Date.now() - snapshotStartedAt });
  if (input.activation) await removeObsoletePreparedProjects(deps, session, input.slug);
  const codex = await prepareCodexStoreSnapshots(session.stageDir, log);
  const copyFinalFiles = async () => {
    const copyStartedAt = Date.now();
    await copyStageToOpenClaw(session.stageDir, session.importDir, input.slug, copyOptions);
    log(`[migration-rsync] final-import file-copy migrationId=${session.migrationId} slug=${input.slug}`, { durationMs: Date.now() - copyStartedAt });
  };
  try {
    const offlineTarget = await heldUserImport(input);
    if (!offlineTarget) await copyFinalFiles();
    const installStartedAt = Date.now();
    await installPreparedAgentStores({
      prepared,
      releaseAgent: (agentId) => releaseAgentForImport(deps, input.activation, agentId, log, input.heldTarget),
      procRoot: deps.procRoot ?? PROC_ROOT,
      log,
    });
    log(`[migration-rsync] final-import agent-install migrationId=${session.migrationId} slug=${input.slug}`, { durationMs: Date.now() - installStartedAt });

    if (upgradesCarriedAgents(input)) {
      const upgradeStartedAt = Date.now();
      await upgradeCarriedAgents(input, prepared);
      if (prepared.stores.length > 0) {
        log(`[migration-rsync] final-import agent-upgrade migrationId=${session.migrationId} slug=${input.slug}`, { durationMs: Date.now() - upgradeStartedAt });
      }
    }
    if (offlineTarget) {
      await reattachOfflineUserAgents(input, prepared, offlineTarget);
      await copyFinalFiles();
    }
    await installCodexStoreSnapshots({ prepared: codex, importDir: session.importDir, procRoot: deps.procRoot ?? PROC_ROOT, log, signal: input.signal });
  } finally {
    await discardCodexStoreSnapshots(codex, log);
  }
}

async function finishTargetPreparation(
  deps: MigrationHandlerDeps,
  session: RSyncImportSession,
  body: FinishRsyncImportRequestBody,
  configTransferMode: MigrationConfigTransferMode,
  signal: AbortSignal,
): Promise<void> {
  const activation = await configuredUserActivationRequest(deps, body, "pre", configTransferMode);
  const placeholders = new Set(activation ? deferredProjectPlaceholderPaths(session.stageDir, body.slug) : []);
  const sourceEntries = (await listRelativeEntries(session.stageDir)).filter(entry =>
    (entry.startsWith(`customers/${body.slug}/`) || entry.startsWith(`${GIT_METADATA_DIR}/${body.slug}/`)) &&
    !placeholders.has(entry));
  await fs.writeFile(path.join(path.dirname(session.stageDir), "source-entries.json"), JSON.stringify(sourceEntries), { mode: 0o600 });
  if (!activation || activation.live) return;
  if (!deps.prepareSurgeTarget) throw new Error("Isolated target preparation is unavailable");
  await deps.prepareSurgeTarget(activation.request, signal);
}

function validateRsyncImportSessionPolicy(session: RSyncImportSession, body: FinishRsyncImportRequestBody, configTransferMode: MigrationConfigTransferMode, res: Response): boolean {
  if (session.configTransferMode !== configTransferMode) {
    res.status(409).json({ error: "rsync import config transfer mode does not match prepared session" });
    return false;
  }
  return true;
}

function completedImportResponse(body: MigrationRequestBody, verificationPending: string | undefined): ImportResponse {
  return { migrationId: body.migrationId, slug: body.slug, imported: true,
    ...(verificationPending ? { verificationPending } : {}) };
}

function finishedImportLog(body: MigrationRequestBody, mode: string, verificationPending: string | undefined, stageMs: number, activateMs: number): string {
  return `${verificationPending ? "🟡" : "🟢"} [migration-rsync] finish-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} ${verificationPending ? "verification-pending" : "done"}` +
    ` stageMs=${stageMs} activateMs=${activateMs}` +
    (verificationPending ? ` (verification pending: ${verificationPending})` : "");
}

function importCompletionBlocker(deps: MigrationHandlerDeps): string | null {
  if (migrationImportBusy()) return "migration import completion is already in progress";
  if (deps.adapter.isIsolatedGateway?.() === true && deps.surgeReleaseInProgress?.()) return "User surge release is already in progress";
  return null;
}

export function createFinishRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<FinishRsyncImportRequestBody>(
      req,
      res,
      deps,
      "finish-rsync-import",
      log,
    );
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    const loadStrategy = validateMigrationLoadStrategy(body.loadStrategy, res);
    if (!loadStrategy) return;
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    const session = rsyncImportSessions.get(key);
    if (!ownsRsyncSession(session, body.transferAttemptId, res)) return;
    if (!session) {
      res.status(404).json({ error: "rsync import session not found" });
      return;
    }
    if (!validateRsyncImportSessionPolicy(session, body, configTransferMode, res)) return;
    const blocker = importCompletionBlocker(deps);
    if (blocker) {
      res.status(409).json({ error: blocker });
      return;
    }
    finishingRsyncImports.add(key);
    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      body.migrationId,
      body.slug,
      log,
    );
    let preserveStage = false;
    let sessionReleased = false;
    try {
      await assertTargetImportAllowed(deps, body.slug);
      const startedAt = Date.now();
      await stopRsyncTransfer(session);
      const rejection = await validateStagedRsyncImport(session, body.slug, mode, configTransferMode, log);
      if (rejection !== null) {
        log(
          `[migration-rsync] 🔴 finish-import migrationId=${body.migrationId} slug=${body.slug} rejected: ${rejection}`, { status: "failed" },
        );
        res.status(400).json({ error: "rsync import failed validation", message: rejection });
        return;
      }
      const activation = await configuredUserActivationRequest(deps, body, mode, configTransferMode);
      const beforeRuntimePublish = mode === "final" ? await sharedTargetWorkspaceRestore(deps, body, session.importDir, controller.signal, session.stageDir) : undefined;
      await deliverStagedImport({
        preserveSource: body.preserveSource,
        deps,
        session,
        slug: body.slug,
        mode,
        activation,
        heldTarget: await systemConfigImportTarget(deps, body, configTransferMode),
        signal: controller.signal,
        log,
      });
      const stagedAt = Date.now();
      if (mode === "pre") {
        await finishTargetPreparation(deps, session, body, configTransferMode, controller.signal);
        preserveStage = true;
      }
      const verificationPending = mode === "final"
        ? await activateFinishedRsyncImport({
          deps,
          body,
          configTransferMode,
          loadStrategy,
          signal: controller.signal,
          beforeRuntimePublish,
        })
        : undefined;
      const activatedAt = Date.now();
      const response = completedImportResponse(body, verificationPending);
      await stopRsyncSession(session, preserveStage);
      sessionReleased = true;
      finishingRsyncImports.delete(key);
      controller.signal.throwIfAborted();
      log(finishedImportLog(body, mode, verificationPending, stagedAt - startedAt, activatedAt - stagedAt));
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] 🔴 finish-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      respondImportFailure(res, controller.signal, err);
    } finally {
      detach();
      if (!sessionReleased) {
        try { await stopRsyncSession(session, preserveStage); } finally { finishingRsyncImports.delete(key); }
      }
    }
  });
}

export function createAbortRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<AbortRsyncImportRequestBody>(req, res, deps, "abort-rsync-import", log);
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    if (migrationImportBusy()) {
      res.status(409).json({ error: "migration import is still in progress" });
      return;
    }
    if (!ownsRsyncCleanup(key, body.transferAttemptId, res)) return;
    if (!rsyncImportSessions.has(key) && rsyncImportSessions.size > 0) {
      res.status(200).json({ migrationId: body.migrationId, slug: body.slug, imported: false });
      return;
    }
    abortingRsyncImport = true;
    try {
      await stopRsyncSession(rsyncImportSessions.get(key));
      await clearMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, configTransferMode));
      let activation: ConfiguredUserActivation | null = null;
      try {
        activation = await configuredUserActivationRequest(deps, body, mode, configTransferMode);
        if (activation && !await releaseAbortedUserImport(deps, activation)) {
          log(`[migration-rsync] abort-import left the live user untouched: import was never admitted migrationId=${body.migrationId} slug=${body.slug}`);
          res.status(200).json({ migrationId: body.migrationId, slug: body.slug, imported: false });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`🔴 [migration-rsync] abort-import failed migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
        res.status(500).json({ error: "abort-import failed", message });
        return;
      }
      if (activation || configTransferMode === USER_SYSTEM_CONFIG_TRANSFER) {
        deps.adapter.clearMountMarker?.(body.slug);
        deps.adapter.clearUserMigratingIn?.(body.slug);
        deps.adapter.onUnmounted?.(body.slug);
      }
      log(`🟢 [migration-rsync] abort-import migrationId=${body.migrationId} slug=${body.slug}`);
      res.status(200).json({ migrationId: body.migrationId, slug: body.slug, imported: false });
    } finally {
      abortingRsyncImport = false;
    }
  });
}

async function releaseAbortedUserImport(deps: MigrationHandlerDeps, activation: ConfiguredUserActivation): Promise<boolean> {
  if (!activation.live) {
    let cleaned = false;
    const state = await deps.unreserveSurgeTarget!(activation.request, async assertCurrent => {
      const remove = deps.adapter.removeImportedUserBySlug;
      if (!remove) throw new Error("held user import cannot be returned without imported-user removal");
      await removeUserWithSystemConfigWatchPaused({ deps, slug: activation.request.slug,
        remove: () => remove(activation.request.slug, undefined, undefined, { ...activation.request, assertCurrent }) });
      cleaned = true;
    });
    if (!cleaned) throw new Error("User import cleanup was not executed before unreserve");
    if (state.mode !== "held") throw new Error("cannot clear an import while its user process is permitted");
    return true;
  }
  if (await liveImportAdmission(deps, activation) !== "admitted") return false;
  const remove = deps.adapter.removeImportedUserBySlug;
  if (!remove) throw new Error("live user import cannot be returned without imported-user removal");
  await assertLiveUserUnassigned(deps, activation);
  const { slug } = activation.request;
  await removeUserWithSystemConfigWatchPaused({ deps, slug, remove: () => remove(slug) });
  return true;
}

async function assertLiveUserUnassigned(deps: MigrationHandlerDeps, activation: ConfiguredUserActivation): Promise<void> {
  if (await deps.liveSurgeTargetAssigned!(activation.request)) {
    throw new Error("cannot remove a live user that its assignment serves");
  }
}

async function prepareUnmountedImport(
  deps: MigrationHandlerDeps,
  body: UnmountRequestBody,
  activation: ConfiguredUserActivation | null,
): Promise<boolean> {
  if (activation) {
    if (!activation.live) return true;
    if (await liveImportAdmission(deps, activation) === "refused") return false;
    await assertLiveUserUnassigned(deps, activation);
  }
  await clearUnmountedImportStaging(deps, body);
  return true;
}

function configuredUserVerifyChecks(
  deps: MigrationHandlerDeps,
  slug: string,
): Extract<VerifyMigrationResponse, { configTransferMode: "configured-builder-system-config" }>["checks"] {
  return {
    customerDir: deps.adapter.hasUserDir(slug),
    configuredBuilderOverlay:
      deps.adapter.isIsolatedGateway?.() === true &&
      deps.adapter.isConfiguredUser?.(slug) === true &&
      deps.adapter.configuredUserOverlayPresent?.(slug) === true,
    mountMarked: deps.adapter.userMountMarked?.(slug) ?? false,
    workspaceGit: deps.adapter.hasWorkspaceGitDir(slug),
    gitRemote: deps.adapter.hasGitRemote(slug),
  };
}

function activationDefaultAgentWired(deps: MigrationHandlerDeps, slug: string): boolean {
  return deps.adapter.userDefaultAgentWiredInOpenclawConfig?.(slug)
    ?? deps.getMountedUsers?.().includes(slug)
    ?? false;
}

async function verifyMigrationResponse(
  deps: MigrationHandlerDeps,
  body: VerifyMigrationRequestBody,
): Promise<VerifyMigrationResponse> {
  if (body.configTransferMode === USER_SYSTEM_CONFIG_TRANSFER ||
      (deps.adapter.isIsolatedGateway?.() === true &&
       deps.adapter.isConfiguredUser?.(body.slug) === true)) {
    const checks = configuredUserVerifyChecks(deps, body.slug);
    return {
      migrationId: body.migrationId,
      slug: body.slug,
      ready: Object.values(checks).every(Boolean),
      configTransferMode: USER_SYSTEM_CONFIG_TRANSFER,
      checks,
    };
  }
  const coachWired = activationDefaultAgentWired(deps, body.slug);
  const checks = {
    customerDir: deps.adapter.hasUserDir(body.slug),
    coachWired,
    mountMarked: deps.adapter.userMountMarked?.(body.slug) ?? coachWired,
  };
  if ((!checks.coachWired || !checks.mountMarked) && await deps.userAttachPending?.(body.slug) === true) {
    return { migrationId: body.migrationId, slug: body.slug, ready: false, code: MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS, checks };
  }
  return { migrationId: body.migrationId, slug: body.slug, ready: Object.values(checks).every(Boolean), checks };
}

export function createVerifyHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<VerifyMigrationRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    if (
      body.configTransferMode !== undefined &&
      !isMigrationConfigTransferMode(body.configTransferMode)
    ) {
      res.status(400).json({ error: "invalid configTransferMode" });
      return;
    }
    if (
      body.configTransferMode === USER_SYSTEM_CONFIG_TRANSFER &&
      !requireConfiguredUserSystemConfigTransfer(body.slug, body.configTransferMode, res)
    ) {
      return;
    }
    try {
      const response = await verifyMigrationResponse(deps, body);
      log(
        `${response.ready ? "🟢" : "🔴"} [migration-http] verify migrationId=${body.migrationId} slug=${body.slug} ` +
        `mode=${response.configTransferMode ?? ACTIVATION_MANIFEST_TRANSFER} ` +
        `ready=${response.ready} checks=${JSON.stringify(response.checks)}`, { status: response.ready ? "done" : "failed" },
      );
      res.status(response.ready ? 200 : 409).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 verify migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "verify failed", message });
    }
  });
}

function attachImportDisconnectHandlers(
  res: Response,
  migrationId: string,
  slug: string,
  log: (msg: string, fields?: LogContext) => void,
  phase: "import" | "export" = "import",
): { controller: AbortController; detach: () => void } {

const controller = new AbortController();
  const onResClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    log(
      `[migration-http] client closed connection before response sent migrationId=${migrationId} slug=${slug} — aborting`,
    );
    controller.abort(new Error(`client disconnected mid-${phase}`));
  };
  res.on("close", onResClose);
  return {
    controller,
    detach: () => {
      res.removeListener("close", onResClose);
    },
  };
}

function respondImportFailure(
  res: Response,
  controllerSignal: AbortSignal,
  err: unknown,
): void {
  if (res.writableEnded) return;
  const message = err instanceof Error ? err.message : String(err);
  if (controllerSignal.aborted && !res.headersSent) {

res.status(499).json({ error: "client disconnected", message });
    return;
  }
  if (!res.headersSent) {
    res.status(500).json({ error: "import failed", message });
    return;
  }
  res.destroy(err instanceof Error ? err : new Error(message));
}

function allowedMigrationPrefixes(slug: string, mode: MigrationImportMode): string[] {
  const durablePrefixes = [
    `customers/${slug}/`,
    `git-metadata/${slug}/`,
    `${MIGRATION_ACTIVATION_DIR}/${slug}/`,
  ];
  if (mode === "keys") return [`customer-keys/${slug}/`];
  if (mode === "pre" || mode === "final") return durablePrefixes;
  return [...durablePrefixes, `customer-keys/${slug}/`];
}

function agentStateEntryAllowed(input: {
  raw: string;
  entry: string;
  slug: string;
  mode: MigrationImportMode;
  configuredAgentIds: readonly string[];
  configuredUserStatePlan: ConfiguredUserPortableStatePlan | undefined;
}): boolean {
  if (input.mode === "keys") return false;
  return input.configuredUserStatePlan
    ? !isSafeDefaultAgentPortableStatePath(input.entry) &&
      configuredUserStatePlanAllowsEntry(input.raw, input.configuredUserStatePlan)
    : isOwnedAgentStatePath(input.raw, input.entry, input.slug, input.configuredAgentIds);
}

export function findPathTraversalViolation(
  entries: readonly string[],
  slug: string,
  mode: MigrationImportMode = "default",
  configuredAgentIds: readonly string[] = [],
  configuredUserStatePlan?: ConfiguredUserPortableStatePlan,
): string | null {
  const allowedPrefixes = allowedMigrationPrefixes(slug, mode);
  const stateTransfer = mode === "pre" || mode === "final";
  for (const raw of entries) {
    const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (entry.startsWith("/")) {
      return `absolute path in tarball: ${raw}`;
    }
    if (entry.split("/").includes("..")) {
      return `path traversal '..' in tarball: ${raw}`;
    }
    const allowed =
      agentStateEntryAllowed({ raw, entry, slug, mode, configuredAgentIds, configuredUserStatePlan }) ||
      allowedPrefixes.some((p) => matchesAllowedMigrationPath(raw, entry, p)) ||
      (stateTransfer && raw === "customer-keys/");
    if (!allowed) {
      const allowlist = allowedPrefixes.map((prefix) => prefix.replace(/\/$/u, "")).join(", ");
      return `path '${raw}' is outside the per-slug allowlist (${allowlist})`;
    }
  }
  return null;
}

function isOwnedAgentStatePath(
  raw: string,
  entry: string,
  slug: string,
  configuredAgentIds: readonly string[],
): boolean {
  const configured = new Set(configuredAgentIds.filter(isSafeConfiguredAgentId));
  const segments = entry.split("/");
  if (segments[0] === "agents") {
    if (segments.length === 1) return raw.endsWith("/");
    if (configured.has(segments[1]!)) return true;
    const parsed = parseAgentId(segments[1]!);
    return parsed.kind !== "unknown" && parsed.username === slug;
  }
  if (segments[0] !== "memory") return false;
  if (segments.length === 1) return raw.endsWith("/");
  if (segments.length !== 2) return false;
  const suffix = [".sqlite-wal", ".sqlite-shm", ".sqlite"].find((candidate) =>
    segments[1]!.endsWith(candidate),
  );
  if (!suffix) return false;
  const agentId = segments[1]!.slice(0, -suffix.length);
  if (configured.has(agentId)) return true;
  const parsed = parseAgentId(agentId);
  return parsed.kind !== "unknown" && parsed.username === slug;
}

function matchesAllowedMigrationPath(raw: string, entry: string, allowedPrefix: string): boolean {
  const isDirectoryPrefix = allowedPrefix.endsWith("/");
  const exactPrefix = isDirectoryPrefix ? allowedPrefix.slice(0, -1) : allowedPrefix;
  return (
    entry === exactPrefix ||
    entry.startsWith(allowedPrefix) ||
    (raw.endsWith("/") && exactPrefix.startsWith(`${entry}/`))
  );
}

async function removeUnmountedUserImport(
  deps: MigrationHandlerDeps,
  body: UnmountRequestBody,
  activation: ConfiguredUserActivation | null,
): Promise<RemoveUserResult> {
  const { slug } = body;
  let result: RemoveUserResult | undefined;
  const remove = async (assertCurrent?: () => Promise<void>) => {
    if (assertCurrent) {
      for (const session of rsyncImportSessions.values()) {
        if (session.migrationId === body.migrationId && session.slug === slug) await stopRsyncSession(session);
      }
      await assertCurrent();
      await clearUnmountedImportStaging(deps, body);
    }
    result = await removeUserWithSystemConfigWatchPaused({
      deps, slug,
      remove: () => assertCurrent && activation
        ? deps.adapter.removeImportedUserBySlug!(slug, undefined, undefined, { ...activation.request, assertCurrent })
        : deps.adapter.removeImportedUserBySlug!(slug),
    });
  };
  if (activation) {
    const state = await deps.unreserveSurgeTarget!(activation.request, remove);
    if (state.role !== "normal") throw new Error("User import cleanup did not release its target custody");
    if (activation.live && state.mode !== "permitted") throw new Error("live user cleanup did not restart its prelaunch OpenClaw");
  } else await remove();
  if (!result) throw new Error("User import cleanup was not executed before unreserve");
  return result;
}

function validSharedErasureUnmount(deps: MigrationHandlerDeps, body: UnmountRequestBody): boolean {
  const coverage = body.agentStoreErasure;
  return Boolean(coverage && deps.gatewayId.startsWith("shared-") && !deps.adapter.isIsolatedGateway?.() &&
    typeof coverage.podUid === "string" && coverage.podUid && coverage.podUid === process.env.POD_UID &&
    Array.isArray(coverage.agentIds) && coverage.agentIds.length <= 512 &&
    coverage.agentIds.every(id => typeof id === "string" && agentIdBelongsToSlug(id, body.slug)) &&
    new Set(coverage.agentIds).size === coverage.agentIds.length);
}

async function completeSharedErasureUnmount(deps: MigrationHandlerDeps, body: UnmountRequestBody, res: Response): Promise<void> {
  if (!validSharedErasureUnmount(deps, body)) {
    res.status(400).json({ error: "invalid Shared user erasure coverage or pod identity" });
    return;
  }
  const coverage = body.agentStoreErasure!;
  if (!deps.adapter.removeImportedUserBySlug) throw new Error("Shared user erasure requires Native user cleanup");
  const result = await removeUserWithSystemConfigWatchPaused({ deps, slug: body.slug,
    remove: () => deps.adapter.removeImportedUserBySlug!(body.slug, undefined, undefined, undefined, coverage.agentIds) });
  if (result.retained || !Array.isArray(result.releasedAgentIds) ||
      !isDeepStrictEqual([...result.releasedAgentIds].sort(), [...coverage.agentIds].sort())) {
    throw new Error("Shared user erasure did not confirm exact Native agent cleanup");
  }
  deps.adapter.onUnmounted?.(body.slug);
  res.status(200).json({ migrationId: body.migrationId, slug: body.slug, unmounted: result.wasMounted,
    agentStoreErasure: coverage } satisfies UnmountResponse);
}

async function clearUnmountedImportStaging(deps: MigrationHandlerDeps, body: UnmountRequestBody): Promise<void> {
  await clearMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, ACTIVATION_MANIFEST_TRANSFER));
  await clearMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, USER_SYSTEM_CONFIG_TRANSFER));
}

async function unmountImportedUser(
  deps: MigrationHandlerDeps,
  body: UnmountRequestBody,
  activation: ConfiguredUserActivation | null,
): Promise<UnmountResponse> {
  if (!deps.adapter.removeImportedUserBySlug) throw new Error("unmount requires imported-user removal");
  const { slug, migrationId } = body;
  const result = await removeUnmountedUserImport(deps, body, activation);
  if (result.wasMounted) deps.adapter.onUnmounted?.(slug);
  await releaseVoiceHold(deps, slug, migrationId);
  dlog(
    `[migration-http] 🟢 unmount migrationId=${migrationId} slug=${slug} wasMounted=${result.wasMounted} steps=${result.steps.join(",")}`,
  );
  return { migrationId, slug, unmounted: result.wasMounted };
}

export function createUnmountHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<UnmountRequestBody>(req, res, deps, log);
    if (!body) return;

    const user = deps.adapter.isIsolatedGateway?.() === true;
    if (user && migrationImportBusy()) {
      res.status(409).json({ error: "migration import is still in progress" });
      return;
    }
    if (user) abortingRsyncImport = true;
    try {
      if (body.agentStoreErasure !== undefined) {
        await completeSharedErasureUnmount(deps, body, res);
        return;
      }
      const activation = await configuredUserActivationRequest(deps, body, "final", ACTIVATION_MANIFEST_TRANSFER);
      if (!await prepareUnmountedImport(deps, body, activation)) {
        log(`[migration-http] unmount left the live user untouched: import was never admitted migrationId=${body.migrationId} slug=${body.slug}`);
        res.status(200).json({ migrationId: body.migrationId, slug: body.slug, unmounted: false } satisfies UnmountResponse);
        return;
      }
      res.status(200).json(await unmountImportedUser(deps, body, activation));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 unmount migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({
        error: "unmount failed",
        message,
        ...(err instanceof OpenclawWireError ? { code: err.code } : {}),
      });
    } finally {
      if (user) abortingRsyncImport = false;
    }
  });
}

export function userDefaultAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

export function resolveOpenClawStateDir(): string {
  const fromEnv = process.env.OPENCLAW_STATE_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? "/home/node";
  return path.join(home, ".openclaw");
}

export interface SessionsJson {
  sessions: AgentSessionEntry[];
}

export interface AgentSessionEntry {
  key?: string;
  sessionId?: string;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
}

export async function readAgentSessions(
  stateDir: string,
  agentId: string,
): Promise<SessionsJson["sessions"]> {
  return readAgentSessionsAtPath(
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
  );
}

export async function readAgentSessionsAtPath(
  sessionsPath: string,
): Promise<SessionsJson["sessions"]> {
  const storePath = sessionsPath.endsWith(".sqlite")
    ? sessionsPath
    : path.join(path.dirname(path.dirname(sessionsPath)), "agent", "openclaw-agent.sqlite");
  try {
    await fs.stat(storePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const anchor = readPostgresAgentAnchor(storePath);
  if (anchor) {
    return queryAgentStore<AgentSessionEntry & Record<string, unknown>>(anchor,
      'SELECT session_key AS key, current_session_id AS "sessionId", status FROM $schema.session_nodes');
  }
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare("SELECT session_key AS key, current_session_id AS sessionId, status FROM session_nodes")
      .all() as AgentSessionEntry[];
  } finally {
    db.close();
  }
}
