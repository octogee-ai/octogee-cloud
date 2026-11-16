import { createRepeatSquelch } from "@octogee/shared/server/repeat-squelch";
import { isValidUsername, parseAgentId } from "@octogee/shared/types/identity";
import { PROJECT_AGENT_WORKSPACE_PARTS } from "@octogee/shared/types/project";
import type { ProjectBlobHydrator } from "./project-blob-materialization.js";
import { unassignedConfiguredAgents, stagedSecretOwnersOnly, unmaterializedProjectAccountIds } from "./shared-broker-profile-readiness.js";
import { createAgentAnchorReporter } from "./agent-anchor-record.js";
import { createFleetBrokerClient } from "./fleet-broker-client.js";
import { isolatedToolchainRoot } from "./user-storage.js";
import { waitForPreparedIsolatedToolchain } from "./isolated-toolchain-preparation.js";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { workspaceIdentityReady } from "@octogee/core/openclaw-workspace-bootstrap";
import { OpenclawWireError } from "@octogee/shared/types/openclaw-wire-core";
import * as path from "node:path";
import { agentIdsFromConfig } from "./byosub-restore.js";
import { OPENCLAW_DIR, readOpenClawConfig } from "./config.js";
import { readActivationManifest } from "./migration-activation-manifest.js";
import { withUserRemoval } from "./user-removal-exclusion.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  vertexCatalogInputForBaseUrl,
  metaCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
  type BrokerProfileSweepOptions,
} from "./agent-model-token-materializer.js";
import { createBrokerTokenRefreshScheduler } from "./broker-token-refresh.js";
import { openClawRuntimeUpdateGuard } from "./openclaw-runtime-update-guard.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  FLEET_STATE_PATH,
  type FleetHealthResponse,
  type FleetStateResponse,
  type FlushGatewayResponse,
  type OpenClawProcessReport,
} from "@octogee/shared/types/fleet-controller";
import { createFleetStateHandler } from "./fleet-state-http.js";
import {
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createAbortRsyncImportHandler,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createMigrationProgressHandler,
  createQuiesceHandler,
  createSchedulerMigrationHandler,
  createSchedulerReadyHandler,
  createScheduleTransferHandler,
  createResumeHandler,
  createRestoreHandler,
  createUnmountHandler,
  createVerifyHandler,
  createCompleteSurgeHandoffHandler,
  migrationImportBusy,
  ownsFinalMigrationImport,
  type MigrationHandlerDeps,
  type SourceMountRefusal,
} from "./fleet-http-migration.js";
import {
  createSurgeReadinessGate,
  type SurgeReadinessGate,
} from "./surge-readiness.js";
import {
  createSurgeOpenClawProcessSupervisorClient,
  type SurgeOpenClawProcessGateState,
  type SurgeOpenClawProcessSupervisorClient,
} from "./surge-openclaw-process-gate.js";
import {
  createHoldSurgeOpenClawHandler,
  createResumeSurgeOpenClawHandler,
  createUnreserveSurgeOpenClawHandler,
  type SurgeOpenClawProcessHandlerDeps,
} from "./surge-openclaw-process-http.js";
import { startAfterSurgeReadiness } from "./surge-reconcile-gate.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { agentIdsForMigration } from "./user-lifecycle-broker-adapter.js";
import { createScheduleTransfer } from "./schedule-transfer.js";
import {
  addUserToGateway,
  cloneMissingProjects,
  removeUserFromGateway,
} from "./user-lifecycle.js";
import type { AddUserOptions } from "./user-lifecycle.js";
import type { AddUserResult, UserLifecycleAdapter } from "./user-lifecycle.js";
import { isPermanentConfigPatchFailure } from "@octogee/core/apply-config-patch";
import {
  userAttachPending,
  startReconcileLoop,
  type EnsureOutcome,
  type MountLane,
  type UnmountOutcome,
} from "./reconcile-loop.js";
import type { DesiredUser } from "./snapshot-fingerprint.js";
import { loadAppliedFingerprints, saveAppliedFingerprints } from "./applied-fingerprint-store.js";
import { createDeviceAuthManager } from "./byosub-device-auth.js";
import { realDeviceAuthDeps } from "./byosub-device-auth-io.js";
import { mountByosubDeviceAuth } from "./byosub-device-auth-http.js";
import { createClaudeSsoManager } from "./claude-sso-auth.js";
import { realClaudeSsoDeps } from "./claude-sso-auth-io.js";
import { mountClaudeSsoAuth } from "./claude-sso-auth-http.js";
import {
  createAgentImportDoctorHandler,
  runAgentImportDoctor,
  type AgentImportDoctorResult,
} from "./agent-import-doctor.js";
import {
  observeDashboardControl,
  probeOpenClawHealth,
} from "./system-config-runtime-health.js";
import { prepareIsolatedPrelaunchConfig } from "./system-config.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import {
  resetRecoveredUserRuntime,
  type RecoveredUserRuntimeResetResult,
} from "./recovered-user-runtime-reset.js";

const RECONCILE_LOOP_INTERVAL_MS = 2 * 1000;
export const MOUNT_CONCURRENCY = 4;
const USER_POST_START_HEALTH_TIMEOUT_MS = 600_000;

export const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

export interface CloneRetryState {
  attempts: number;
  nextAt: number;
  fingerprint: string;
}

export interface PermanentConfigPatchRetryState {
  nextAt: number;
  fingerprint: string;
  reason: string;
}

export function permanentConfigPatchRetryReady(
  prior: PermanentConfigPatchRetryState | undefined,
  desiredFingerprint: string | undefined,
  now: number,
): boolean {
  return !prior || (desiredFingerprint ?? "") !== prior.fingerprint || now >= prior.nextAt;
}

export function selectStableContentStale(
  mounted: readonly string[],
  desired: ReadonlyMap<string, string>,
  applied: ReadonlyMap<string, string>,
  pending: Map<string, string>,
): string[] {
  const mountedSet = new Set(mounted);
  const stable: string[] = [];
  for (const slug of [...pending.keys()]) {
    if (!mountedSet.has(slug) || desired.get(slug) === applied.get(slug)) {
      pending.delete(slug);
    }
  }
  for (const slug of mounted) {
    const fingerprint = desired.get(slug);
    if (fingerprint === undefined || fingerprint === applied.get(slug)) continue;
    if (pending.get(slug) === fingerprint) {
      stable.push(slug);
    } else {
      pending.set(slug, fingerprint);
    }
  }
  return stable;
}

// The mount lane is serial, so a checkout that cannot land must back off instead of
// consuming every tick and starving the pod's other cold mounts.
export const CLONE_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 300_000, 900_000];

export function cloneRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), CLONE_RETRY_DELAYS_MS.length) - 1;
  return CLONE_RETRY_DELAYS_MS[index]!;
}

export function cloneRetryReady(
  prior: CloneRetryState | undefined,
  desiredFingerprint: string | undefined,
  now: number,
): boolean {
  if (!prior) return true;
  // A genuine desired change converges immediately: a new project must never wait out a
  // backoff earned by an unrelated stranded one.
  if ((desiredFingerprint ?? "") !== prior.fingerprint) return true;
  return now >= prior.nextAt;
}

export interface UserEnsureRetryInput {
  ensureAllowed: boolean;
  cloneRetry: CloneRetryState | undefined;
  desiredFingerprint: string | undefined;
  now: number;
  permanentConfigPatchRetry: PermanentConfigPatchRetryState | undefined;
}

export function userEnsureRetryReady(input: UserEnsureRetryInput): boolean {
  return input.ensureAllowed && permanentConfigPatchRetryReady(
    input.permanentConfigPatchRetry,
    input.desiredFingerprint,
    input.now,
  ) && cloneRetryReady(input.cloneRetry, input.desiredFingerprint, input.now);
}

export interface ConvergenceHooks {
  recordApplied: (slug: string, fingerprint: string | undefined) => void;
  rememberRetry: (slug: string, state: CloneRetryState) => void;
  forgetRetry: (slug: string) => void;
}

// A pending optional project checkout must not hold the whole user stale: re-running
// the full attach re-patches config and restarts the agent on every retry (observed live
// 2026-08-14 on shared-a: 205 consecutive ~50s re-attaches, two agent restarts each). The
// applied store instead records this marker — unequal to every real fingerprint, so the
// level-triggered loop keeps selecting the slug — and ensureSlug recognizes it and retries
// ONLY the checkout. Restart-safe on durable disks because the marker persists with the
// applied-fingerprint store.
export { pendingCloneAppliedFingerprint, pendingCloneOnlyStale } from "./pending-clone-fingerprint.js";
import { pendingCloneAppliedFingerprint, pendingCloneOnlyStale } from "./pending-clone-fingerprint.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { configuredUserReport } from "./user-claim.js";

export interface SettleConvergenceInput {
  now: number;
  slug: string;
  desiredFingerprint: string | undefined;
  prior: CloneRetryState | undefined;
  result: Pick<AddUserResult, "pendingProjectClones" | "appliedFingerprint">;
}

// A converge that left a project checkout absent has NOT reached desired state, so its real
// fingerprint must not be recorded — that would mark the user clean and strand the
// checkout until unrelated drift. It records the pending-clone MARKER instead: still stale
// against every real fingerprint, so the loop keeps converging, but recognizably so — the
// retry re-runs only the checkout, never the full attach with its config write and agent
// restart.
//
// It THROWS rather than returning, and that is load-bearing. reconcile-loop fires
// onEnsureSuccess on a normal return, which clears gateways/{id}.lastError — erasing the very
// error an operator needs to see. Throwing routes it to onEnsureError instead, where it
// persists until a later converge lands the clone and clears it naturally.
export function settleConvergence(input: SettleConvergenceInput, hooks: ConvergenceHooks): void {
  const { now, slug, desiredFingerprint, prior, result } = input;
  const settledFingerprint = result.appliedFingerprint ?? desiredFingerprint;
  if (result.pendingProjectClones.length === 0) {
    hooks.forgetRetry(slug);
    hooks.recordApplied(slug, settledFingerprint);
    return;
  }
  const attempts = (prior?.attempts ?? 0) + 1;
  hooks.recordApplied(slug, pendingCloneAppliedFingerprint(settledFingerprint));
  hooks.rememberRetry(slug, {
    attempts,
    nextAt: now + cloneRetryDelayMs(attempts),
    fingerprint: desiredFingerprint ?? "",
  });
  throw new Error(
    `project checkout still absent after ${attempts} converge(s): ${result.pendingProjectClones.join(", ")}`,
  );
}

export interface FinalizeConvergedMountInput extends SettleConvergenceInput {
  uid: string;
  hooks: ConvergenceHooks;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  writeMountMarker?: (slug: string) => void;
}

// The mount itself is complete once the attach returns — the agent is wired and verified —
// so it is stamped and marked BEFORE settleConvergence's pending-clone throw. Leaving the
// user unmounted over an absent optional checkout would re-run the full attach on every
// retry instead of the checkout-only converge the pending-clone marker selects.
export async function finalizeConvergedMount(input: FinalizeConvergedMountInput): Promise<void> {
  const {
    uid,
    hooks,
    stampMounted,
    writeMountMarker,
    ...convergence
  } = input;
  await stampMounted(uid, true);
  writeMountMarker?.(input.slug);
  settleConvergence(convergence, hooks);
}

export const NEEDS_FULL_ATTACH_FINGERPRINT = "";

function requireFullAttachNextConverge(slug: string, hooks: ConvergenceHooks): void {
  hooks.forgetRetry(slug);
  hooks.recordApplied(slug, NEEDS_FULL_ATTACH_FINGERPRINT);
}

export function createMountRefusalReader(state: {
  permanentConfigPatchRetry: ReadonlyMap<string, PermanentConfigPatchRetryState>;
  desiredFingerprints: ReadonlyMap<string, string>;
  appliedFingerprints: ReadonlyMap<string, string>;
}): (slug: string) => SourceMountRefusal | null {
  return (slug) => {
    const refusal = state.permanentConfigPatchRetry.get(slug);
    if (!refusal || (state.desiredFingerprints.get(slug) ?? "") !== refusal.fingerprint) return null;
    const applied = state.appliedFingerprints.get(slug);
    return { reason: refusal.reason, converged: applied !== undefined && applied !== NEEDS_FULL_ATTACH_FINGERPRINT };
  };
}

export async function ensureUserCheckoutsOnly(
  adapter: UserLifecycleAdapter,
  input: Omit<SettleConvergenceInput, "result">,
  hooks: ConvergenceHooks,
): Promise<EnsureOutcome> {
  const { pending } = await cloneMissingProjects(adapter, input.slug);
  if (pending.length === 0) {
    requireFullAttachNextConverge(input.slug, hooks);
    return "noop";
  }
  settleConvergence(
    { ...input, result: { pendingProjectClones: pending } },
    hooks,
  );
  return "noop";
}

export function registerByosubDeviceAuth(
  app: express.Express,
  opts: StartFleetOptions,
): void {
  const internalServiceKey = opts.internalServiceKey ?? "";
  const openclawDir =
    opts.openclawDir ??
    (process.env.HOME
      ? `${process.env.HOME}/.openclaw`
      : "/home/node/.openclaw");
  const manager = createDeviceAuthManager(
    realDeviceAuthDeps({ openclawDir, internalServiceKey, log: opts.log }),
  );
  const claudeSsoManager = createClaudeSsoManager(
    realClaudeSsoDeps({ openclawDir, internalServiceKey, log: opts.log }),
  );
  mountByosubDeviceAuth(app, { manager, internalServiceKey, log: opts.log });
  mountClaudeSsoAuth(app, {
    manager: claudeSsoManager,
    internalServiceKey,
    log: opts.log,
  });
}

export interface StartFleetOptions {
  rpc: GatewayRpcClient;
  adapter: UserLifecycleAdapter;
  gatewayId: string;
  log: (msg: string) => void;
  port: number;
  publicKey: string;
  version: string;
  openclawVersion: string;
  /** Run the local assigned-roster reconcile. Desired roster and state mirrors
   *  are brokered through octogee-api. */
  localReconcile?: boolean;
  /** Credential-less local mount reconcile: trusted octogee-api returns the
   * assigned roster for this gateway identity. */
  readDesiredSlugs?: () => Promise<string[]>;
  subscribeDesiredChanges?: (wake: () => void) => () => void;
  configuredUserReport?: () => FleetStateResponse["configuredBuilder"];
  /** Desired-user source: slug → config fingerprint + mount lane (see
   *  snapshot-fingerprint.ts). When provided, it drives the desired roster (its keys), lets
   *  the reconcile re-ensure an already-mounted user whose fingerprint drifted — the
   *  level-triggered path a project-agent toggle rides — and orders the mount pool so
   *  first-time users mount ahead of movers. Takes precedence over readDesiredSlugs. */
  readDesiredUsers?: () => Promise<Map<string, DesiredUser>>;
  readEnsureAdmission?: (uid: string) => Promise<boolean>;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  readUserSnapshotForRuntimeReset?: (
    uid: string,
  ) => Promise<FleetBrokerUserSnapshot | null>;
  acknowledgeRuntimeReset?: (
    uid: string,
    operationId: string,
    generation: number,
  ) => Promise<void>;
  recordReconcileError: (slug: string, message: string) => Promise<void>;
  clearReconcileError: (slug: string) => Promise<void>;
  openclawDir?: string;
  projectBlobHydrator?: ProjectBlobHydrator;
  surgeOpenClawProcessGate?: SurgeOpenClawProcessSupervisorClient;
  internalServiceKey?: string;
  agentImportDoctorToken?: string;
  runAgentImportDoctor?: (candidate: unknown) => Promise<AgentImportDoctorResult>;
  flushLocalState?: (input: {
    slug: string;
    reason: string;
    expectedSystemConfigCommit?: string;
  }) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
}

export async function consumeRecoveredUserRuntimeReset(input: {
  gatewayId: string;
  uid: string;
  slug: string;
  openclawDir: string;
  readSnapshot: (uid: string) => Promise<FleetBrokerUserSnapshot | null>;
  acknowledge: (uid: string, operationId: string, generation: number) => Promise<void>;
  reset?: typeof resetRecoveredUserRuntime;
  log?: (message: string) => void;
}): Promise<RecoveredUserRuntimeResetResult | null> {
  const snapshot = await input.readSnapshot(input.uid);
  if (!snapshot) throw new Error(`[runtime-reset:${input.slug}] assigned user snapshot unavailable`);
  const marker = snapshot.runtimeReset;
  if (!marker) return null;
  const exact = [
    snapshot.uid === input.uid,
    snapshot.slug === input.slug,
    snapshot.gatewayId === input.gatewayId,
    marker.uid === input.uid,
    marker.slug === input.slug,
    marker.targetGatewayId === input.gatewayId,
  ].every(Boolean);
  if (!exact) throw new Error(`[runtime-reset:${input.slug}] recovery marker identity fence changed`);
  const result = (input.reset ?? resetRecoveredUserRuntime)({
    openclawDir: input.openclawDir,
    uid: input.uid,
    slug: input.slug,
    agentIds: snapshot.agentIds,
    githubProjectIds: new Set(snapshot.projectAgents?.filter(agent => agent.githubBacked).map(agent => agent.projectId)),
    log: input.log,
  });
  await input.acknowledge(input.uid, marker.operationId, marker.generation);
  input.log?.(
    `[runtime-reset:${input.slug}] acknowledged ${marker.operationId} generation ${marker.generation}`,
  );
  return result;
}

export function registerAgentImportDoctor(
  app: express.Express,
  opts: Pick<StartFleetOptions, "agentImportDoctorToken" | "runAgentImportDoctor" | "log">,
): void {
  const token = opts.agentImportDoctorToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!token) {
    app.post("/agent-import/doctor", (_req, res) => {
      res.status(503).json({ error: "agent import doctor is not configured" });
    });
    opts.log?.("[agent-import] doctor endpoint disabled: OPENCLAW_GATEWAY_TOKEN is unavailable");
    return;
  }
  app.post("/agent-import/doctor", createAgentImportDoctorHandler({
    token,
    runDoctor: opts.runAgentImportDoctor ?? runAgentImportDoctor,
  }));
}

export function reconcileAddUserOptions(
  contentConvergenceEnabled: boolean,
  evictionBatch: readonly string[] = [],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): AddUserOptions {
  return {
    ...(contentConvergenceEnabled ? { convergeContent: true } : {}),
    ...(evictionBatch.length > 0 ? { evictionBatch } : {}),
    ...(currentEvictionBatch ? { currentEvictionBatch } : {}),
  };
}

export function cancelRemovedEviction(
  adapter: UserLifecycleAdapter,
  slug: string,
  invalidate: (slug: string) => void,
): boolean {
  if (adapter.cancelPendingEviction?.(slug) !== true) return false;
  invalidate(slug);
  return true;
}

export interface StartedFleetController {
  stop: () => Promise<void>;

whenReady: Promise<void>;
  port: number;
}

export interface FleetCapabilities {
  /** Run the local reconcile loop (ensure/evict) from a brokered roster. */
  provision: boolean;
}

export function resolveFleetCapabilities(opts: {
  localReconcile?: boolean;
  hasBrokeredRoster: boolean;
}): FleetCapabilities {
  return { provision: opts.localReconcile === true && opts.hasBrokeredRoster };
}

function hasMountedRuntimeAndWorkspace(
  adapter: Pick<
    UserLifecycleAdapter,
    | "isIsolatedGateway"
    | "isConfiguredUser"
    | "configuredUserOverlayPresent"
    | "hasUserAgentRuntime"
    | "hasWorkspaceGitDir"
    | "hasGitRemote"
  >,
  slug: string,
): boolean {
  if (adapter.isIsolatedGateway?.()) {
    return adapter.isConfiguredUser?.(slug) === true
      && adapter.configuredUserOverlayPresent?.(slug) === true
      && adapter.hasWorkspaceGitDir(slug)
      && adapter.hasGitRemote(slug);
  }
  return (
    (!adapter.hasUserAgentRuntime || adapter.hasUserAgentRuntime(slug))
    && adapter.hasWorkspaceGitDir(slug)
    && adapter.hasGitRemote(slug)
  );
}


// The kubelet probes this and cannot sign, and the fleet ingress policy admits
// every gateway pod on this port, so the probe body stays tenant-free: mounted
// slugs and the gatewayId (which names its user) belong to the signed
// buildFleetStateResponse below.
export function buildFleetHealthResponse(input: {
  status: FleetRuntime["status"];
  podUid: string | null;
  startedAt: number;
}): FleetHealthResponse {
  return {
    status: input.status,
    podUid: input.podUid,
    startedAt: input.startedAt,
    rsyncAttemptFencing: true,
    provisioning: "service",
  };
}

export function fleetStatePrivateProjectAgentWorkspace(config: unknown, stateDir: string, slug: string): boolean {
  const agents = (config as { agents?: { entries?: Record<string, { workspace?: unknown }>; list?: Array<{ id?: string; workspace?: unknown }> } })?.agents;
  const entries = agents?.entries ? Object.entries(agents.entries) : (agents?.list ?? []).map(agent => [agent.id, agent] as const);
  return entries.some(([id, entry]) => {
    const parsed = parseAgentId(id ?? "");
    return parsed.kind === "project" && parsed.username === slug &&
      entry?.workspace === path.join(stateDir, "customers", slug, ...PROJECT_AGENT_WORKSPACE_PARTS, parsed.project);
  });
}

export function buildFleetStateResponse(input: {
  status: FleetRuntime["status"];
  gatewayId: string;
  podUid: string | null;
  version: string;
  openclawVersion: string;
  startedAt: number;
  users: string[];
  migratingIn: string[];
  configuredBuilder: FleetStateResponse["configuredBuilder"];
  openclawProcess?: OpenClawProcessReport | null;
}): FleetStateResponse {
  return {
    status: input.status,
    gatewayId: input.gatewayId,
    podUid: input.podUid,
    version: input.version,
    openclawVersion: input.openclawVersion,
    startedAt: input.startedAt,
    customers: input.users,
    migratingIn: input.migratingIn,
    configuredBuilder: input.configuredBuilder,
    ...(input.openclawProcess === undefined ? {} : { openclawProcess: input.openclawProcess }),
  };
}

interface ProvisioningCounter {
  beginProvisioning: () => void;
  finishProvisioning: () => void;
}

interface ProvisioningWorkLease {
  onWorkSettled: (settled: Promise<void>) => void;
  finishNow: () => void;
  finishAfterWorkSettles: () => Promise<void>;
}

function beginProvisioningWork(runtime: ProvisioningCounter): ProvisioningWorkLease {
  runtime.beginProvisioning();
  let released = false;
  let workSettled: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    runtime.finishProvisioning();
  };
  return {
    onWorkSettled: (settled) => {
      workSettled = settled.then(
        () => undefined,
        () => undefined,
      );
    },
    finishNow: release,
    finishAfterWorkSettles: () => {
      if (releasePromise) return releasePromise;
      releasePromise = workSettled
        ? workSettled.then(release, release)
        : Promise.resolve().then(release);
      return releasePromise;
    },
  };
}

export async function runProvisioningWork<T>(input: {
  provisioning: ProvisioningCounter;
  work: (onWorkSettled: (settled: Promise<void>) => void) => Promise<T>;
  onDeferredReleaseError?: (error: unknown) => void;
}): Promise<T> {
  const lease = beginProvisioningWork(input.provisioning);
  try {
    const result = await input.work(lease.onWorkSettled);
    lease.finishNow();
    return result;
  } catch (error) {
    const release = lease.finishAfterWorkSettles();
    void release.catch((releaseError) => input.onDeferredReleaseError?.(releaseError));
    throw error;
  }
}

interface FleetRuntime extends ProvisioningCounter {
  activeProvisioning: number;
  mountedCustomers: string[];
  mountRefusal: (slug: string) => SourceMountRefusal | null;
  status: "booting" | "ready";
  waitForProvisioningDrain: () => Promise<void>;
}

function createFleetRuntime(): FleetRuntime {
  const drainWaiters = new Set<() => void>();
  const runtime: FleetRuntime = {
    activeProvisioning: 0,
    mountedCustomers: [],
    mountRefusal: () => null,
    status: "booting",
    beginProvisioning: () => {
      runtime.activeProvisioning += 1;
    },
    finishProvisioning: () => {
      runtime.activeProvisioning -= 1;
      if (runtime.activeProvisioning !== 0) return;
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    },
    waitForProvisioningDrain: () => {
      if (runtime.activeProvisioning === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.add(resolve));
    },
  };
  return runtime;
}

// Only openclaw writes an agent's auth-profile store, and it can refuse the
// apply at both of the one-shot moments — the gateway-ready sweep and the
// mount's own retry — leaving the catalog in place but the broker profile
// unwritten, so the agent's first turn fails on credentials instead of on an
// unknown model. So this is level-triggered: retried on a timer until every
// rostered agent has its profile, rather than fired at two hopeful moments.
const BROKER_PROFILE_RETRY_INTERVAL_MS = 20 * 1000;

/** Last deferral set reported, so a steady state stays quiet — this runs on a
 *  timer and must not reprint the same warning forever. */
let lastDeferredSignature: string | null = null;
let brokerProfileSnapshotReloadPending = false;
let settledBrokerProfileScope: string | null = null;
let lastBrokerProfileSnapshotReloadError: string | null = null;
let brokerProfileSweepInFlight: Promise<BrokerProfileReadiness> | null = null;

/** Test seam only — the memo above is module state, so a spec exercising the
 *  quiet-once-settled behaviour must be able to start from a known point. */
export function _resetBrokerProfileLogStateForTests(): void {
  lastDeferredSignature = null;
  brokerProfileSnapshotReloadPending = false;
  settledBrokerProfileScope = null;
  lastBrokerProfileSnapshotReloadError = null;
  brokerProfileSweepInFlight = null;
}

type BrokerProfileSweep = Awaited<ReturnType<typeof materializeBrokerProfilesForAgents>>;

export interface BrokerProfileReadiness {
  settled: boolean;
  deferred: string[];
  reason?: string;
  skipped?: boolean;
}

function readBrokerProfileAgentIds(
  log: (msg: string) => void,
  readConfig: () => unknown,
): string[] | null {
  try {
    return agentIdsFromConfig(readConfig());
  } catch (error) {
    log(`⚠ [agent-model-token] post-boot sweep skipped — config unreadable: ${String(error)}`);
    return null;
  }
}

function brokerProfileSweepOptions(
  deps: {
    agentsDir?: string;
    secretsApply?: BrokerProfileSweepOptions["secretsApply"];
  },
  log: (msg: string) => void,
): BrokerProfileSweepOptions {
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
  const openAiBaseUrl = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  const metaBaseUrl = process.env.PLATFORM_META_BASE_URL?.trim();
  const vertexBaseUrl = process.env.PLATFORM_VERTEX_BASE_URL?.trim();
  return {
    logFn: log,
    ...(deps.agentsDir ? { agentsDir: deps.agentsDir } : {}),
    ...(deps.secretsApply ? { secretsApply: deps.secretsApply } : {}),
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(openAiBaseUrl ? { openAi: openAiCatalogInputForBaseUrl(openAiBaseUrl) } : {}),
    ...(metaBaseUrl ? { meta: metaCatalogInputForBaseUrl(metaBaseUrl) } : {}),
    ...(vertexBaseUrl ? { vertex: vertexCatalogInputForBaseUrl(vertexBaseUrl) } : {}),
  };
}

interface BrokerProfileReloadScope {
  excluded: Set<string>;
  agentsDir: string;
  readAssignedSlugs: () => Promise<string[]>;
  assignedSlugs: string[];
  unmaterializedProjectAccountIds: Set<string>;
  signature: string;
}

async function readBrokerProfileScope(agentIds: string[], deps: {
  agentsDir?: string;
  openclawDir?: string;
  readConfig?: () => unknown;
  readAssignedSlugs?: () => Promise<string[]>;
}): Promise<BrokerProfileReloadScope | undefined> {
  if (!deps.readAssignedSlugs) return undefined;
  const assignedSlugs = await deps.readAssignedSlugs();
  const agentsDir = deps.agentsDir ?? path.join(OPENCLAW_DIR, "agents");
  const projectAccountIds = await unmaterializedProjectAccountIds({
    config: (deps.readConfig ?? readOpenClawConfig)(), assignedSlugs, openclawDir: deps.openclawDir ?? OPENCLAW_DIR,
  });
  return {
    excluded: unassignedConfiguredAgents(agentIds, assignedSlugs), agentsDir,
    readAssignedSlugs: deps.readAssignedSlugs, assignedSlugs,
    unmaterializedProjectAccountIds: projectAccountIds,
    signature: JSON.stringify([agentsDir, [...agentIds].sort(), [...assignedSlugs].sort(), [...projectAccountIds].sort()]),
  };
}

async function verifyNonBlockingSecretWarnings(input: {
  warningCount: number;
  scope?: BrokerProfileReloadScope;
  rpc: Pick<GatewayRpcClient, "secretsReload" | "degradedSecretsStatus">;
}): Promise<boolean> {
  const { scope, rpc, warningCount } = input;
  if (!scope || !rpc.degradedSecretsStatus || warningCount <= 0) return false;
  if (!stagedSecretOwnersOnly({ owners: await rpc.degradedSecretsStatus(), ...scope })) return false;
  const current = (await scope.readAssignedSlugs()).sort();
  return JSON.stringify(current) === JSON.stringify([...scope.assignedSlugs].sort());
}

function logNonBlockingSecretWarnings(log: (msg: string) => void, warningCount: number, scope?: BrokerProfileReloadScope): void {
  const projectAccounts = [...(scope?.unmaterializedProjectAccountIds ?? [])].sort();
  const awaitingReconciler = projectAccounts.length > 0 ? ` — project accounts awaiting the reconciler: ${projectAccounts.join(", ")}` : "";
  log(`[agent-model-token] ${warningCount} secret warning(s) have no blocking owners${awaitingReconciler}`);
}

async function reloadBrokerProfileSnapshot(
  log: (msg: string) => void,
  secretsReload: Pick<GatewayRpcClient, "secretsReload" | "degradedSecretsStatus"> | undefined,
  scope?: BrokerProfileReloadScope,
): Promise<void> {
  if (scope && scope.signature !== settledBrokerProfileScope) brokerProfileSnapshotReloadPending = true;
  if (!brokerProfileSnapshotReloadPending || !secretsReload) return;
  try {
    const result = await secretsReload.secretsReload();
    const warningCount = result.warningCount ?? 0;
    const warningsNonBlocking = result.ok === true && await verifyNonBlockingSecretWarnings({ warningCount, scope, rpc: secretsReload });
    if (result.ok !== true || (warningCount > 0 && !warningsNonBlocking)) {
      throw new Error(`secrets.reload returned ok=${String(result.ok)} warnings=${warningCount}`);
    }
    if (scope) settledBrokerProfileScope = scope.signature;
    if (warningsNonBlocking) logNonBlockingSecretWarnings(log, warningCount, scope);
    brokerProfileSnapshotReloadPending = false;
    lastBrokerProfileSnapshotReloadError = null;
    log("[agent-model-token] active secret snapshot reloaded after broker profile materialization");
  } catch (error) {
    const message = String(error);
    if (message === lastBrokerProfileSnapshotReloadError) return;
    log(
      `[agent-model-token] ⚠ active secret snapshot reload deferred — ${message}; retrying every ${
        BROKER_PROFILE_RETRY_INTERVAL_MS / 1000
      }s`,
    );
    lastBrokerProfileSnapshotReloadError = message;
  }
}

function reportBrokerProfileSweep(log: (msg: string) => void, sweep: BrokerProfileSweep): void {
  const signature = sweep.deferred.join(",");
  if (signature === lastDeferredSignature) return;
  if (sweep.deferred.length > 0) {
    log(
      `[agent-model-token] broker profile still deferred for ${sweep.deferred.join(", ")}` +
        ` — ${sweep.deferralReason ?? "openclaw refused the secrets apply"}; retrying every ${
          BROKER_PROFILE_RETRY_INTERVAL_MS / 1000
        }s`,
    );
  } else if (lastDeferredSignature !== null) {
    log("[agent-model-token] broker profiles settled — every rostered agent has its profile");
  }
  lastDeferredSignature = signature;
}

/** Hand openclaw the broker profiles earlier passes could only defer. Idempotent
 *  — a profile already applied spawns nothing, so this is safe on every tick. */
async function runDeferredBrokerProfileSweep(
  log: (msg: string) => void,
  deps: {
    agentsDir?: string;
    openclawDir?: string;
    readConfig?: () => unknown;
    readAssignedSlugs?: () => Promise<string[]>;
    secretsApply?: BrokerProfileSweepOptions["secretsApply"];
    secretsReload?: Pick<GatewayRpcClient, "secretsReload" | "degradedSecretsStatus">;
  } = {},
): Promise<BrokerProfileReadiness> {
  const agentIds = readBrokerProfileAgentIds(log, deps.readConfig ?? readOpenClawConfig);
  if (!agentIds) {
    return { settled: false, deferred: [], reason: "config unreadable" };
  }
  const scope = await readBrokerProfileScope(agentIds, deps);
  const sweep = await materializeBrokerProfilesForAgents(
    agentIds.filter((id) => !scope?.excluded.has(id)),
    brokerProfileSweepOptions(deps, log),
  );
  if (sweep.materialized > 0) {
    log(`[agent-model-token] post-boot sweep materialized ${sweep.materialized} agent(s)`);
    if (deps.secretsReload) brokerProfileSnapshotReloadPending = true;
  }
  await reloadBrokerProfileSnapshot(log, deps.secretsReload, scope);
  reportBrokerProfileSweep(log, sweep);
  const reloadSettled = !brokerProfileSnapshotReloadPending;
  let reason: string | undefined;
  if (sweep.deferralReason) reason = sweep.deferralReason;
  else if (!reloadSettled) reason = "active secret snapshot reload deferred";
  return {
    settled: sweep.deferred.length === 0 && reloadSettled,
    deferred: sweep.deferred,
    ...(reason ? { reason } : {}),
  };
}

export function materializeDeferredBrokerProfiles(
  log: (msg: string) => void,
  deps: {
    agentsDir?: string;
    openclawDir?: string;
    readConfig?: () => unknown;
    readAssignedSlugs?: () => Promise<string[]>;
    secretsApply?: BrokerProfileSweepOptions["secretsApply"];
    secretsReload?: Pick<GatewayRpcClient, "secretsReload" | "degradedSecretsStatus">;
  } = {},
): Promise<BrokerProfileReadiness> {
  if (brokerProfileSweepInFlight) return brokerProfileSweepInFlight;
  const sweep = openClawRuntimeUpdateGuard.tryRun(() => runDeferredBrokerProfileSweep(log, deps));
  if (!sweep) return Promise.resolve({
    settled: false, deferred: [], skipped: true, reason: "account import is updating the runtime",
  });
  const shared = sweep.finally(() => {
    if (brokerProfileSweepInFlight === shared) brokerProfileSweepInFlight = null;
  });
  brokerProfileSweepInFlight = shared;
  return shared;
}

export async function waitForBrokerProfilesSettled(input: {
  sweep: () => Promise<BrokerProfileReadiness>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (true) {
    if ((await input.sweep()).settled) return;
    await sleep(1_000);
  }
}

/** The level-triggered half of broker-profile materialization: retried until
 *  openclaw has accepted every rostered agent's profiles. Null on gateways that
 *  do not provision — they mount no users, so there is nothing to converge. */
function startBrokerProfileRetry(
  provisions: boolean,
  log: (msg: string) => void,
  secretsReload: Pick<GatewayRpcClient, "secretsReload" | "degradedSecretsStatus">,
  onReadiness?: (readiness: BrokerProfileReadiness) => void,
  readAssignedSlugs?: () => Promise<string[]>,
): NodeJS.Timeout | null {
  if (!provisions) return null;
  let sweepInFlight = false;
  const sweep = () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void materializeDeferredBrokerProfiles(log, { secretsReload, readAssignedSlugs })
      .then((readiness) => { if (!readiness.skipped) onReadiness?.(readiness); })
      .catch((error) => {
        const reason = String(error);
        onReadiness?.({ settled: false, deferred: [], reason });
        log(`⚠ [agent-model-token] sweep failed: ${reason}`);
      })
      .finally(() => {
        sweepInFlight = false;
      });
  };
  sweep();
  return setInterval(sweep, BROKER_PROFILE_RETRY_INTERVAL_MS);
}

function startBrokerTokenRefreshAfterGatewayReady(
  rpc: Pick<GatewayRpcClient, "secretsReload">,
  openclawDir: string,
  whenReady: Promise<void>,
  log: (message: string) => void,
): () => void {
  const scheduler = createBrokerTokenRefreshScheduler({ rpc, openclawDir, log });
  void whenReady
    .then(() => scheduler.start())
    .catch((error) => log(`[agent-model-token] ⚠ refresh scheduler did not start: ${String(error)}`));
  return () => scheduler.stop();
}

export async function probeOpenClawRuntimeReady(
  probeHealthz: () => Promise<boolean>,
  identitiesReady: () => boolean = workspaceIdentityReady,
): Promise<boolean> {
  return await probeHealthz() && identitiesReady();
}

function nativeStartupAdmissionPending(error: unknown): boolean {
  if (!(error instanceof OpenclawWireError)) return false;
  if (error.code !== "auth-failed" && error.code !== "rpc-error") return false;
  const details = error.details as {
    serverCode?: unknown;
    details?: { reason?: unknown };
  } | null | undefined;
  return details?.serverCode === "UNAVAILABLE" && details.details?.reason === "startup-sidecars";
}

async function probeNativeRpcAdmission(probeAdmission?: () => Promise<unknown>): Promise<boolean> {
  try {
    await probeAdmission?.();
    return true;
  } catch (error) {
    if (!nativeStartupAdmissionPending(error)) throw error;
    return false;
  }
}

export async function waitForOpenClawHealthz(input: {
  probeHealthz: () => Promise<boolean>;
  probeAdmission?: () => Promise<unknown>;
  assertCurrent?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}): Promise<void> {
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = input.timeoutMs === undefined ? null : now() + input.timeoutMs;
  while (true) {
    await input.assertCurrent?.();
    if (await input.probeHealthz()) {
      const admitted = await probeNativeRpcAdmission(input.probeAdmission);
      await input.assertCurrent?.();
      const admissionExpired = input.probeAdmission && deadline !== null && now() > deadline;
      if (admitted && !admissionExpired) return;
    }
    if (deadline !== null && now() >= deadline) {
      throw new Error(`OpenClaw healthz did not answer within ${input.timeoutMs}ms`);
    }
    await sleep(1_000);
  }
}

export function dashboardBridgeReady(input: {
  required: boolean;
  openclawDir: string;
  gatewayId: string;
  now?: () => number;
}): { ready: boolean; state: "ready" | "missing" | "stale" | "invalid" | "not-required" } {
  if (!input.required) return { ready: true, state: "not-required" };
  const dashboard = observeDashboardControl(
    input.openclawDir,
    input.gatewayId,
    (input.now ?? Date.now)(),
  );
  const state = dashboard.dashboardControlState ?? "invalid";
  return {
    ready: state === "ready",
    state,
  };
}

export async function waitForDashboardBridgeReady(input: {
  required: boolean;
  openclawDir: string;
  gatewayId: string;
  log: (message: string) => void;
  probe?: () => { ready: boolean; state: string };
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.required) return;
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probe = input.probe ?? (() => dashboardBridgeReady(input));
  let lastState: string | null = null;
  while (true) {
    const result = probe();
    if (result.ready) return;
    if (result.state !== lastState) {
      lastState = result.state;
      input.log(`[fleet] waiting for Dashboard bridge capability handshake (state=${result.state})`);
    }
    await sleep(500);
  }
}

export async function probeSurgeReadiness(input: {
  runtimeStatus: FleetRuntime["status"];
  handoffReleased: boolean;
  provisioning?: boolean;
  processSettled?: boolean;
  probeHealthz: () => Promise<boolean>;
  brokerProfilesSettled?: boolean;
  dashboardBridgeReady?: boolean;
}): Promise<{
  ready: boolean;
  openclawUp: boolean;
  brokerProfilesSettled: boolean;
  dashboardBridgeReady: boolean;
}> {
  const brokerProfilesSettled = input.brokerProfilesSettled ?? true;
  const dashboardBridgeReady = input.dashboardBridgeReady ?? true;
  if (input.processSettled === false) {
    return { ready: false, openclawUp: false, brokerProfilesSettled, dashboardBridgeReady };
  }
  const openclawUp = input.runtimeStatus === "ready" && input.provisioning !== true
    ? await input.probeHealthz()
    : input.runtimeStatus === "ready";
  return {
    ready: input.handoffReleased && openclawUp && brokerProfilesSettled && dashboardBridgeReady,
    openclawUp,
    brokerProfilesSettled,
    dashboardBridgeReady,
  };
}

interface FleetReadinessInput {
  runtime: FleetRuntime;
  probeHealthz: () => Promise<boolean>;
  brokerProfilesSettled: () => boolean;
  dashboardBridgeReady: () => boolean;
}

async function probeFleetReadiness(
  input: FleetReadinessInput,
  handoffReleased: boolean,
  processSettled: boolean,
) {
  return probeSurgeReadiness({
    runtimeStatus: input.runtime.status,
    handoffReleased,
    provisioning: input.runtime.activeProvisioning > 0,
    processSettled,
    probeHealthz: input.probeHealthz,
    brokerProfilesSettled: input.brokerProfilesSettled(),
    dashboardBridgeReady: input.dashboardBridgeReady(),
  });
}

export function createSurgeReadinessHandler(input: {
  surgeReadiness: SurgeReadinessGate;
  readiness: FleetReadinessInput;
  prelaunchState?: (state?: SurgeOpenClawProcessGateState) => Promise<IsolatedPrelaunchState>;
  processGateState?: () => Promise<SurgeOpenClawProcessGateState | undefined>;
  log: (message: string) => void;
}): express.RequestHandler {
  return async (_req, res) => {
    try {
      const handoffReleased = await input.surgeReadiness.released();
      const gate = await input.processGateState?.();
      const prelaunchState = input.prelaunchState
        ? await input.prelaunchState(gate)
        : "none";
      const terminalTarget = gate?.terminalTarget ? { ...gate.terminalTarget,
        processHeld: gate.podUid === process.env.POD_UID?.trim() && gate.role === "normal" && gate.mode === "held" && gate.phase === "held",
      } : undefined;
      const processSettled = prelaunchState === "none" || prelaunchState === "serving";
      const readiness = await probeFleetReadiness(input.readiness, handoffReleased, processSettled);
      res.status(readiness.ready ? 200 : 503).json({
        ...readiness,
        runtimeStatus: input.readiness.runtime.status,
        handoffReleased,
        prelaunchState,
        ...(terminalTarget ? { terminalTarget } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const admitted = readinessFailures.admit("surge-handoff", message);
      if (admitted) input.log(`[surge-handoff] readiness probe failed: ${message}${admitted.note}`);
      res.status(500).json({ ready: false, error: message });
    }
  };
}

const readinessFailures = createRepeatSquelch({ windowMs: 60_000 });

export function createToolchainReadinessHandler(input: {
  adapter: UserLifecycleAdapter;
  prelaunchState: () => Promise<IsolatedPrelaunchState>;
  log: (message: string) => void;
}): express.RequestHandler {
  return async (_req, res) => {
    try {
      const slug = configuredUserSlug(input.adapter);
      const prelaunchState = await input.prelaunchState();
      const ready = Boolean(slug && configuredUserMountProven(input.adapter) &&
        ["hydrated", "starting", "serving", "none"].includes(prelaunchState));
      res.status(ready ? 200 : 503).json({ ready, prelaunchState });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const admitted = readinessFailures.admit("builder-toolchain", message);
      if (admitted) input.log(`[isolated-toolchain] readiness failed: ${message}${admitted.note}`);
      res.status(500).json({ ready: false, error: message });
    }
  };
}

export function createStartupReadinessHandler(input: {
  readiness: FleetReadinessInput;
  prelaunchState?: () => Promise<IsolatedPrelaunchState>;
  log: (message: string) => void;
}): express.RequestHandler {
  return async (_req, res) => {
    try {
      const prelaunchState = input.prelaunchState
        ? await input.prelaunchState()
        : "none";
      if (prelaunchState === "held" || prelaunchState === "hydrated") {
        res.status(200).json({
          ready: true, openclawUp: false,
          brokerProfilesSettled: input.readiness.brokerProfilesSettled(),
          dashboardBridgeReady: input.readiness.dashboardBridgeReady(),
          runtimeStatus: input.readiness.runtime.status, prelaunchState,
        });
        return;
      }
      const processSettled = prelaunchState === "none" || prelaunchState === "serving";
      const readiness = await probeFleetReadiness(input.readiness, true, processSettled);
      res.status(readiness.ready ? 200 : 503).json({
        ...readiness,
        runtimeStatus: input.readiness.runtime.status,
        prelaunchState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[fleet] startup readiness probe failed: ${message}`);
      res.status(500).json({ ready: false, error: message });
    }
  };
}

// Evict-observed: RAW on-disk dir presence (NOT default-agent-wired), minus migrating-in. Drives the
// reconcile's evict direction only. Raw — so a partial/junk dir left by a mount that died
// before its config patch is still drained once it's unassigned (a default-agent-wired-only view
// would never see it). Minus migrating-in — so a freshly-imported user (present before
// cutover makes it desired-here) isn't drained mid-migration. This is the ONLY consumer of
// the migrating-in pin: the heartbeat report and mount-observed are deliberately pin-blind,
// so a successfully-migrated user is reported + considered mounted the moment it's
// default-agent-wired, not suppressed for the pin's TTL.
export function getEvictObservedSlugs(adapter: UserLifecycleAdapter): string[] {
  const dirs = adapter.listLocalUserDirs?.() ?? adapter.listLocalUserSlugs?.() ?? [];
  const migratingIn = adapter.userMigratingIn;
  return dirs
    .filter((slug) => {
      if (migratingIn?.(slug)) return false;
      return !(
        adapter.isIsolatedGateway?.() &&
        adapter.isConfiguredUser?.(slug)
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

export function getMountObservedSlugs(adapter: UserLifecycleAdapter): string[] {
  const locallyAdmitted = adapter.listLocalUserSlugs?.() ?? [];
  const marked = adapter.userMountMarked;
  return locallyAdmitted
    .filter(
      (slug) =>
        hasMountedRuntimeAndWorkspace(adapter, slug)
        && (!marked || marked(slug)),
    )
    .sort((a, b) => a.localeCompare(b));
}

function recordReconcileError(opts: StartFleetOptions, slug: string, message: string): void {
  opts
    .recordReconcileError(slug, message)
    .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ broker lastError write failed: ${String(err)}`));
}

function clearReconcileError(opts: StartFleetOptions, slug: string): void {
  opts
    .clearReconcileError(slug)
    .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ broker lastError clear failed: ${String(err)}`));
}

interface EvictLocalUserInput {
  adapter: UserLifecycleAdapter;
  slug: string;
  evictionBatch?: readonly string[];
  currentEvictionBatch?: () => Promise<readonly string[]>;
  onRetainedAfterConfigRemoval?: (slug: string) => void;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  onLocalStateRemoved: (slug: string) => void;
}

function retainLocalUser(input: EvictLocalUserInput): UnmountOutcome {
  input.onRetainedAfterConfigRemoval?.(input.slug);
  return "noop";
}

function configuredUserOverlayIsOwned(
  adapter: UserLifecycleAdapter,
  slug: string,
): boolean {
  return adapter.isIsolatedGateway?.() === true &&
    adapter.isConfiguredUser?.(slug) === true;
}

function retainConfiguredUserOverlay(input: EvictLocalUserInput): UnmountOutcome {
  const { adapter, slug } = input;
  if (!adapter.configuredUserOverlayPresent?.(slug)) {
    throw new Error(`[evict:${slug}] configured user system-config overlay is unavailable`);
  }
  adapter.clearMountMarker?.(slug);
  adapter.clearUserMigratingIn?.(slug);
  adapter.onUnmounted?.(slug);
  return retainLocalUser(input);
}

async function evictKnownUser(
  input: EvictLocalUserInput,
  uid: string,
): Promise<UnmountOutcome> {
  const result = await removeUserFromGateway(input.adapter, uid, {
    evictionBatch: input.evictionBatch,
    currentEvictionBatch: input.currentEvictionBatch,
  });
  if (result.retained) return retainLocalUser(input);
  await input.stampMounted(uid, false);
  input.onLocalStateRemoved(input.slug);
  return result.wasMounted ? "drained" : "noop";
}

async function evictImportedUser(
  input: EvictLocalUserInput,
  removeImported: NonNullable<UserLifecycleAdapter["removeImportedUserBySlug"]>,
): Promise<UnmountOutcome> {
  const result = await removeImported(
    input.slug,
    input.evictionBatch,
    input.currentEvictionBatch,
  );
  if (result.retained) return retainLocalUser(input);
  if (!result.wasMounted) input.adapter.cancelPendingEviction?.(input.slug);
  input.adapter.onUnmounted?.(input.slug);
  input.onLocalStateRemoved(input.slug);
  return result.wasMounted ? "deleted-user" : "noop";
}

async function evictSlugOnlyUser(
  input: EvictLocalUserInput,
): Promise<UnmountOutcome> {
  const { adapter, slug, evictionBatch, currentEvictionBatch } = input;
  const agentId = `octogee-${slug}-coach`;
  const remaining = await adapter.applyRemoveUserConfigPatch(
    slug,
    agentId,
    evictionBatch,
    currentEvictionBatch,
  );
  if (remaining && !remaining.includes(slug)) {
    adapter.cancelPendingEviction?.(slug);
    return retainLocalUser(input);
  }
  if (currentEvictionBatch && !(await currentEvictionBatch()).includes(slug)) {
    adapter.cancelPendingEviction?.(slug);
    return retainLocalUser(input);
  }
  await adapter.deleteDepartedUserState(slug);
  adapter.onUnmounted?.(slug);
  input.onLocalStateRemoved(slug);
  return "deleted-user";
}

export function evictLocalUser(
  input: EvictLocalUserInput,
): Promise<UnmountOutcome> {
  return withUserRemoval(input.slug, () => evictLocalUserNow(input));
}

async function evictLocalUserNow(
  input: EvictLocalUserInput,
): Promise<UnmountOutcome> {
  if (configuredUserOverlayIsOwned(input.adapter, input.slug)) {
    return retainConfiguredUserOverlay(input);
  }
  const uid = await input.adapter.uidForSlug(input.slug);
  if (uid) return evictKnownUser(input, uid);
  try {
    const removeImported = input.adapter.removeImportedUserBySlug;
    return removeImported
      ? evictImportedUser(input, removeImported)
      : evictSlugOnlyUser(input);
  } catch (err) {
    throw new Error(
      `slug-only cleanup failed for ${input.slug} (no user doc): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function evictLocalUserIfStillUndesired(input: {
  slug: string;
  evictionBatch: readonly string[];
  readDesired: () => Promise<string[]>;
  cancelPendingEviction?: (slug: string) => void;
  evict: (
    currentEvictionBatch: readonly string[],
    readCurrentEvictionBatch: () => Promise<readonly string[]>,
  ) => Promise<UnmountOutcome>;
}): Promise<UnmountOutcome> {
  const desired = new Set(await input.readDesired());
  for (const slug of input.evictionBatch) {
    if (desired.has(slug)) input.cancelPendingEviction?.(slug);
  }
  if (desired.has(input.slug)) return "noop";
  const currentEvictionBatch = input.evictionBatch.filter((slug) => !desired.has(slug));
  return input.evict(currentEvictionBatch, async () => {
    const latest = new Set(await input.readDesired());
    for (const slug of input.evictionBatch) {
      if (latest.has(slug)) input.cancelPendingEviction?.(slug);
    }
    return input.evictionBatch.filter((slug) => !latest.has(slug));
  });
}

function createCurrentEvictionBatchReader(input: {
  readDesired: () => Promise<string[]>;
  pendingEvictions: () => readonly string[];
  cancelPendingEviction: (slug: string) => void;
}): () => Promise<readonly string[]> {
  return async () => {
    const desired = new Set(await input.readDesired());
    const current = input.pendingEvictions();
    for (const staleSlug of current) {
      if (desired.has(staleSlug)) input.cancelPendingEviction(staleSlug);
    }
    return current.filter((staleSlug) => !desired.has(staleSlug));
  };
}

function createReconcileUnmountSlug(input: {
  runtime: FleetRuntime;
  canReconcile?: () => Promise<boolean>;
  readDesired: () => Promise<string[]>;
  cancelPendingEviction: (slug: string) => void;
  wrappedAdapter: UserLifecycleAdapter;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  invalidateConfigRemovedSlug: (slug: string) => void;
  onLocalStateRemoved: (slug: string) => void;
}): (slug: string, evictionBatch: readonly string[]) => Promise<UnmountOutcome> {
  return async (slug, evictionBatch) => {
    input.runtime.beginProvisioning();
    try {
      if (input.canReconcile && !(await input.canReconcile())) return "noop";
      return await evictLocalUserIfStillUndesired({
        slug,
        evictionBatch,
        readDesired: input.readDesired,
        cancelPendingEviction: input.cancelPendingEviction,
        evict: (currentEvictionBatch, readCurrentEvictionBatch) => evictLocalUser({
          adapter: input.wrappedAdapter,
          slug,
          evictionBatch: currentEvictionBatch,
          currentEvictionBatch: readCurrentEvictionBatch,
          onRetainedAfterConfigRemoval: input.invalidateConfigRemovedSlug,
          stampMounted: input.stampMounted,
          onLocalStateRemoved: input.onLocalStateRemoved,
        }),
      });
    } finally {
      input.runtime.finishProvisioning();
    }
  };
}

export function createReconcileConvergenceHooks(input: {
  userSource: StartFleetOptions["readDesiredUsers"];
  appliedFp: Map<string, string>;
  cloneRetry: Map<string, CloneRetryState>;
  persistAppliedFp: () => void;
}): ConvergenceHooks {
  const recordApplied = (slug: string, fingerprint: string | undefined): void => {
    if (!input.userSource || fingerprint === undefined) return;
    const previous = input.appliedFp.get(slug);
    input.appliedFp.set(slug, fingerprint);
    try {
      input.persistAppliedFp();
    } catch (error) {
      if (previous === undefined) input.appliedFp.delete(slug);
      else input.appliedFp.set(slug, previous);
      throw error;
    }
  };
  const rememberRetry = (slug: string, state: CloneRetryState): void => {
    input.cloneRetry.set(slug, state);
  };
  const forgetRetry = (slug: string): void => {
    input.cloneRetry.delete(slug);
  };
  return { recordApplied, rememberRetry, forgetRetry };
}

type AssignedSlugReader = () => Promise<string[]>;
type RosterSourceOptions = Pick<StartFleetOptions, "gatewayId" | "readDesiredUsers" | "readDesiredSlugs">;

function assignedRosterReader(
  opts: RosterSourceOptions,
): AssignedSlugReader | null {
  const users = opts.readDesiredUsers;
  if (users) return async () => [...(await users()).keys()];
  return opts.readDesiredSlugs ?? null;
}

function createUserAgentAnchorReporter(opts: Pick<StartFleetOptions, "gatewayId" | "log">): () => Promise<void> {
  let report: (() => Promise<void>) | null = null;
  return async () => {
    if (opts.gatewayId.startsWith("shared-")) return;
    const slug = userClaimSlug();
    if (!slug) return;
    report ??= createAgentAnchorReporter({
      stateDir: process.env.OPENCLAW_STATE_DIR?.trim() || OPENCLAW_DIR,
      slug,
      broker: createFleetBrokerClient(opts.gatewayId),
      readAgentIds: () => agentIdsFromConfig(readOpenClawConfig()),
      log: opts.log,
    });
    await report();
  };
}

export function brokerProfileRoster(
  opts: RosterSourceOptions,
): AssignedSlugReader | undefined {
  if (opts.gatewayId.startsWith("shared-")) return assignedRosterReader(opts) ?? undefined;
  return async () => {
    const slug = userClaimSlug();
    return slug ? [slug] : [];
  };
}

export function createVerifyAttachPending(input: {
  provision: boolean;
  opts: RosterSourceOptions;
}): ((slug: string) => Promise<boolean>) | undefined {
  const readAssigned = input.provision ? assignedRosterReader(input.opts) : null;
  if (!readAssigned) return undefined;
  return (slug) => userAttachPending(slug, async () => (await readAssigned()).includes(slug));
}

function createDesiredRosterReader(input: {
  opts: StartFleetOptions;
  userSource: StartFleetOptions["readDesiredUsers"];
  desiredFingerprints: Map<string, string>;
  desiredUids: Map<string, string>;
  desiredLanes: Map<string, MountLane>;
  ensureAllowed: Map<string, boolean>;
}): AssignedSlugReader | null {
  const userSource = input.userSource;
  if (userSource) {
    return async () => {
      const next = await userSource();
      input.desiredFingerprints.clear();
      input.desiredUids.clear();
      input.desiredLanes.clear();
      input.ensureAllowed.clear();
      for (const [slug, user] of next) {
        input.desiredFingerprints.set(slug, user.fingerprint);
        input.desiredUids.set(slug, user.uid);
        input.desiredLanes.set(slug, user.lane);
        input.ensureAllowed.set(slug, user.ensureAllowed);
      }
      return [...next.keys()];
    };
  }
  return input.opts.readDesiredSlugs ?? null;
}

async function mountUserWithPublication(input: {
  adapter: UserLifecycleAdapter;
  uid: string;
  slug: string;
  desiredFingerprint: string | undefined;
  prior: CloneRetryState | undefined;
  options: AddUserOptions;
  hooks: ConvergenceHooks;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  onWorkSettled: (work: Promise<void>) => void;
}): Promise<EnsureOutcome> {
  let releasePublication!: () => void;
  const settled = new Promise<void>((resolve) => { releasePublication = resolve; });
  let mountSettled = Promise.resolve();
  try {
    const result = await addUserToGateway(input.adapter, input.uid, {
      ...input.options,
      onWorkSettled: (work) => {
        mountSettled = work;
        input.onWorkSettled(work);
      },
      runtimePublication: {
        settled,
        invalidateFingerprint: () => input.hooks.recordApplied(input.slug, NEEDS_FULL_ATTACH_FINGERPRINT),
      },
    });
    await finalizeConvergedMount({
      now: Date.now(),
      slug: input.slug,
      uid: input.uid,
      desiredFingerprint: input.desiredFingerprint,
      prior: input.prior,
      result,
      hooks: input.hooks,
      stampMounted: input.stampMounted,
      writeMountMarker: input.adapter.writeMountMarker,
    });
    return result.newUser ? "mounted" : "noop";
  } finally {
    void mountSettled.then(releasePublication, releasePublication);
  }
}

function startMaybeReconcileLoop(params: {
  provision: boolean;
  opts: StartFleetOptions;
  wrappedAdapter: UserLifecycleAdapter;
  runtime: FleetRuntime;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  surgeReadiness: SurgeReadinessGate;
  canReconcile?: () => Promise<boolean>;
}): () => void {
  const {
    provision,
    opts,
    wrappedAdapter,
    runtime,
    stampMounted,
    surgeReadiness,
    canReconcile,
  } = params;

  // Content-convergence bookkeeping (only when a fingerprint source is wired). desiredFp
  // is refreshed every tick by readDesired; appliedFp records the fingerprint that was
  // live at each user's last successful ensure. getContentStale reports mounted
  // users where the two diverge — the signal that makes a snapshot-only change (e.g.
  // a project-agent toggle) reconverge without a remount. appliedFp mirrors to disk
  // (when openclawDir is known) so a container restart with the emptyDir intact does not
  // re-ensure an unchanged fleet; a MISSING entry is stale by definition — see
  // applied-fingerprint-store.ts.
  const { readDesiredUsers: userSource, readEnsureAdmission } = opts;
  if (userSource && !readEnsureAdmission) throw new Error("user roster requires canonical ensure admission");
  const desiredUids = new Map<string, string>();
  const desiredFp = new Map<string, string>();
  const desiredLanes = new Map<string, MountLane>();
  const ensureAllowed = new Map<string, boolean>();
  const appliedFpFile =
    userSource && opts.openclawDir
      ? path.join(opts.openclawDir, "applied-fingerprints.json")
      : null;
  const appliedFp = appliedFpFile ? loadAppliedFingerprints(appliedFpFile) : new Map<string, string>();
  const pendingContentFp = new Map<string, string>();
  const cloneRetry = new Map<string, CloneRetryState>();
  const permanentConfigPatchRetry = new Map<string, PermanentConfigPatchRetryState>();
  const persistAppliedFp = (): void => {
    if (!appliedFpFile) return;
    try {
      saveAppliedFingerprints(appliedFpFile, appliedFp);
    } catch (err) {
      opts.log(`[reconcile] ⚠ applied-fingerprint persist failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
  const invalidateConfigRemovedSlug = (slug: string): void => {
    wrappedAdapter.clearMountMarker?.(slug);
    appliedFp.delete(slug);
    const current = desiredFp.get(slug);
    if (current !== undefined) pendingContentFp.set(slug, current);
    persistAppliedFp();
  };
  const cancelPendingEviction = (slug: string): void => {
    cancelRemovedEviction(wrappedAdapter, slug, invalidateConfigRemovedSlug);
  };
  const onLocalStateRemoved = (slug: string): void => {
    cloneRetry.delete(slug);
    pendingContentFp.delete(slug);
    permanentConfigPatchRetry.delete(slug);
    if (appliedFp.delete(slug)) persistAppliedFp();
  };
  runtime.mountRefusal = createMountRefusalReader({ permanentConfigPatchRetry, desiredFingerprints: desiredFp, appliedFingerprints: appliedFp });
  const readDesired = createDesiredRosterReader({
    opts,
    userSource,
    desiredUids,
    desiredLanes,
    ensureAllowed,
    desiredFingerprints: desiredFp,
  });
  if (!provision || !readDesired) return () => undefined;

  const getContentStale = userSource
    ? (): string[] =>
        selectStableContentStale(
          getMountObservedSlugs(wrappedAdapter),
          desiredFp,
          appliedFp,
          pendingContentFp,
        )
    : undefined;
  const convergenceHooks = createReconcileConvergenceHooks(
    { userSource, appliedFp, cloneRetry, persistAppliedFp },
  );
  if (userSource) wrappedAdapter.recordAppliedFingerprint = convergenceHooks.recordApplied;
  const start = () => startReconcileLoop({
    gatewayId: opts.gatewayId,
    intervalMs: opts.subscribeDesiredChanges ? 60_000 : RECONCILE_LOOP_INTERVAL_MS,
    subscribe: opts.subscribeDesiredChanges,
    maxConcurrent: MOUNT_CONCURRENCY,
    ...(userSource ? { mountLane: (slug: string) => desiredLanes.get(slug) ?? "move" } : {}),
    log: opts.log,
    getMountObserved: () => {
      const mounted = getMountObservedSlugs(wrappedAdapter);
      runtime.mountedCustomers = mounted;
      return mounted;
    },
    getEvictObserved: () => getEvictObservedSlugs(wrappedAdapter),
    ...(getContentStale ? { getContentStale } : {}),
    ...(canReconcile ? { canReconcile } : {}),
    readDesired,
    shouldEnsureSlug: (slug) => userEnsureRetryReady({
      ensureAllowed: userSource ? ensureAllowed.get(slug) === true : true,
      cloneRetry: cloneRetry.get(slug),
      desiredFingerprint: desiredFp.get(slug),
      now: Date.now(),
      permanentConfigPatchRetry: permanentConfigPatchRetry.get(slug),
    }),
    ...(userSource && readEnsureAdmission ? {
      canEnsureSlug: async (slug: string) => {
        const uid = desiredUids.get(slug);
        if (!uid) throw new Error(`missing desired user UID for ${slug}`);
        return readEnsureAdmission(uid);
      },
    } : {}),
    onPendingEvictionCancelled: cancelPendingEviction,
    ensureSlug: async (
      slug: string,
      evictionBatch: readonly string[],
      pendingEvictions: () => readonly string[],
    ) => runProvisioningWork({
      provisioning: runtime,
      onDeferredReleaseError: (error) => {
        opts.log(
          `[reconcile] provisioning lease release failed for ${slug}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      },
      work: async (onWorkSettled) => {
        if (canReconcile && !(await canReconcile())) return "noop";
        wrappedAdapter.cancelPendingEviction?.(slug);
        const uid = await wrappedAdapter.uidForSlug(slug);
        if (!uid) throw new Error(`no user doc for assigned slug ${slug}`);
        if (opts.readUserSnapshotForRuntimeReset || opts.acknowledgeRuntimeReset) {
          if (!opts.readUserSnapshotForRuntimeReset || !opts.acknowledgeRuntimeReset) {
            throw new Error("recovered runtime reset requires both snapshot read and acknowledgement");
          }
          await consumeRecoveredUserRuntimeReset({
            gatewayId: opts.gatewayId,
            uid,
            slug,
            openclawDir: opts.openclawDir ?? path.join(process.env.HOME ?? "/home/node", ".openclaw"),
            readSnapshot: opts.readUserSnapshotForRuntimeReset,
            acknowledge: opts.acknowledgeRuntimeReset,
            log: opts.log,
          });
        }
        if (pendingCloneOnlyStale(appliedFp.get(slug), desiredFp.get(slug))) {
          return ensureUserCheckoutsOnly(
            wrappedAdapter,
            {
              now: Date.now(),
              slug,
              desiredFingerprint: desiredFp.get(slug),
              prior: cloneRetry.get(slug),
            },
            convergenceHooks,
          );
        }
        const readCurrentEvictionBatch = createCurrentEvictionBatchReader({
          readDesired,
          pendingEvictions,
          cancelPendingEviction,
        });
        return mountUserWithPublication({
          adapter: wrappedAdapter,
          uid,
          slug,
          desiredFingerprint: desiredFp.get(slug),
          prior: cloneRetry.get(slug),
          options: reconcileAddUserOptions(
            userSource !== undefined, evictionBatch, readCurrentEvictionBatch,
          ),
          hooks: convergenceHooks,
          stampMounted,
          onWorkSettled,
        });
      },
    }),
    onEnsureError: (slug, message, error) => {
      if (isPermanentConfigPatchFailure(error)) {
        permanentConfigPatchRetry.set(slug, {
          fingerprint: desiredFp.get(slug) ?? "",
          nextAt: Date.now() + 60_000,
          reason: message,
        });
      }
      recordReconcileError(opts, slug, message);
    },
    onEnsureSuccess: (slug) => {
      permanentConfigPatchRetry.delete(slug);
      clearReconcileError(opts, slug);
    },
    unmountSlug: createReconcileUnmountSlug({
      runtime, canReconcile, readDesired, cancelPendingEviction, wrappedAdapter, stampMounted,
      invalidateConfigRemovedSlug, onLocalStateRemoved,
    }),
  });
  return startAfterSurgeReadiness({
    released: surgeReadiness.released,
    start,
    log: opts.log,
  });
}


function configuredUserSlug(adapter: UserLifecycleAdapter): string | null {
  const slug = userClaimSlug();
  if (!slug || adapter.isIsolatedGateway?.() !== true) return null;
  return adapter.isConfiguredUser?.(slug) === true &&
      adapter.configuredUserOverlayPresent?.(slug) === true
    ? slug
    : null;
}

export function createConfiguredUserAssignmentMatcher(
  opts: Pick<
    StartFleetOptions,
    "readDesiredUsers" | "readDesiredSlugs"
  >,
): (slug: string) => Promise<boolean> {
  const readDesiredUsers = opts.readDesiredUsers;
  if (readDesiredUsers) {
    return async (slug) => (await readDesiredUsers()).has(slug);
  }
  const readDesiredSlugs = opts.readDesiredSlugs;
  if (readDesiredSlugs) {
    return async (slug) => (await readDesiredSlugs()).includes(slug);
  }
  return async () => false;
}

export function createConfiguredUserReconcileAdmission(input: {
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null;
  hasServingAssignment: () => Promise<boolean>;
  log: (message: string) => void;
}): () => Promise<boolean> {
  let lastBlocked: string | null = null;
  return async () => {
    if (!input.processGate) return true;
    try {
      const state = await input.processGate.status();
      let blocked = `${state.role}/${state.mode}`;
      if (state.mode === "permitted") {
        if (await input.hasServingAssignment()) {
          lastBlocked = null;
          return true;
        }
        blocked = "awaiting canonical user assignment";
      }
      if (lastBlocked !== blocked) {
        input.log(`[surge-handoff] reconcile paused while configured user process gate is ${blocked}`);
        lastBlocked = blocked;
      }
      return false;
    } catch (error) {
      const blocked = `status error: ${error instanceof Error ? error.message : String(error)}`;
      if (lastBlocked !== blocked) {
        input.log(`[surge-handoff] reconcile paused while configured user process gate has ${blocked}`);
        lastBlocked = blocked;
      }
      return false;
    }
  };
}

function configuredUserMountProven(adapter: UserLifecycleAdapter): boolean {
  const slug = configuredUserSlug(adapter);
  return slug !== null && getMountObservedSlugs(adapter).includes(slug);
}

type IsolatedPrelaunchState = "none" | "held" | "hydrated" | "starting" | "serving";

async function clearInheritedUserMountProof(
  adapter: UserLifecycleAdapter,
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null,
  log: (message: string) => void,
): Promise<void> {
  const slug = configuredUserSlug(adapter);
  if (!slug || !processGate || !adapter.userMountMarked?.(slug)) return;
  const state = await processGate.status();
  if (state.podUid !== process.env.POD_UID?.trim() || state.role !== "normal" ||
      state.mode !== "held" || state.phase !== "held") return;
  if (!adapter.clearMountMarker) throw new Error("configured user cannot invalidate its inherited mount proof");
  adapter.clearMountMarker(slug);
  log(`[fleet] cleared inherited mount proof before configured isolated prelaunch: ${slug}`);
}

async function isolatedPrelaunchState(
  adapter: UserLifecycleAdapter,
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null,
  observedState?: SurgeOpenClawProcessGateState,
): Promise<IsolatedPrelaunchState> {
  if (!processGate || configuredUserSlug(adapter) === null) return "none";
  const state = observedState ?? await processGate.status();
  if (state.mode === "held") {
    return state.role === "target" && configuredUserMountProven(adapter)
      ? "hydrated"
      : "held";
  }
  return state.phase === "running" ? "serving" : "starting";
}

const processReportFailures = createRepeatSquelch({ windowMs: 10 * 60_000 });

export const OPENCLAW_PROCESS_REPORT_TIMEOUT_MS = 1_000;

export async function openclawProcessReport(input: {
  adapter: UserLifecycleAdapter;
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null;
  log: (message: string) => void;
}): Promise<OpenClawProcessReport | null> {
  if (!input.processGate || configuredUserSlug(input.adapter) === null) return null;
  let state: SurgeOpenClawProcessGateState;
  try {
    state = await input.processGate.status({ timeoutMs: OPENCLAW_PROCESS_REPORT_TIMEOUT_MS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const admitted = processReportFailures.admit("openclaw-process", message);
    if (admitted) input.log(`[fleet] OpenClaw supervisor did not answer: ${message}${admitted.note}`);
    return { state: "unavailable", migrationId: null };
  }
  const reported = await isolatedPrelaunchState(input.adapter, input.processGate, state);
  if (reported === "none") return null;
  return { state: reported, migrationId: state.migrationId ?? null };
}

// Pending project checkouts never block the mount (see finalizeConvergedMount):
// OpenClaw starts with the workspace and the reconcile loop converges the rest.
async function attachConfiguredUserBeforeOpenClaw(input: {
  adapter: UserLifecycleAdapter;
  log?: (message: string) => void;
  onWorkSettled?: (settled: Promise<void>) => void;
}): Promise<string> {
  const slug = configuredUserSlug(input.adapter);
  if (!slug) throw new Error("configured user overlay is unavailable for prelaunch attach");
  const uid = await input.adapter.uidForSlug(slug);
  if (!uid) throw new Error(`configured user is unavailable for prelaunch attach: ${slug}`);
  const result = await addUserToGateway(input.adapter, uid, {
    convergeContent: true,
    deferRuntimeVerification: true,
    reclaimExistingSshKey: true,
    onWorkSettled: input.onWorkSettled,
  });
  input.adapter.recordAppliedFingerprint?.(slug, NEEDS_FULL_ATTACH_FINGERPRINT);
  if (result.pendingProjectClones.length > 0) {
    if (process.env.OCTOGEE_PROJECTS_MOUNT) throw new Error(`User project restoration is incomplete: ${result.pendingProjectClones.join(", ")}`);
    input.log?.(
      `[surge-handoff] configured user project checkouts still pending for ${slug}; ` +
      `the reconcile loop converges them: ${result.pendingProjectClones.join(", ")}`,
    );
  }
  input.adapter.writeMountMarker?.(slug);
  if (!input.adapter.userMountMarked?.(slug) || !configuredUserMountProven(input.adapter)) {
    throw new Error(`configured isolated prelaunch mount proof failed for ${slug}`);
  }
  return slug;
}

async function verifyConfiguredUserAfterOpenClaw(input: {
  adapter: UserLifecycleAdapter;
  waitForGatewayReady: () => Promise<void>;
  log: (message: string) => void;
  permittedAt?: number;
}): Promise<string> {
  const slug = configuredUserSlug(input.adapter);
  if (!slug || !configuredUserMountProven(input.adapter)) {
    throw new Error("configured user is not durably mounted after OpenClaw start");
  }
  await input.waitForGatewayReady();
  if (input.permittedAt !== undefined) {
    input.log(`[surge-handoff] configured user OpenClaw ready ${Date.now() - input.permittedAt}ms after permit: ${slug}`);
  }
  return slug;
}

function wrapAdapterWithRuntime(
  adapter: UserLifecycleAdapter,
  runtime: FleetRuntime,
): UserLifecycleAdapter {
  return {
    ...adapter,
    onMounted: (slug: string) => {
      if (!runtime.mountedCustomers.includes(slug)) {
        runtime.mountedCustomers = [...runtime.mountedCustomers, slug];
      }
    },
    onUnmounted: (slug: string) => {
      runtime.mountedCustomers = runtime.mountedCustomers.filter((s) => s !== slug);
    },
  };
}


// Every handler below proves a fleet-controller signature before it looks at the
// path's gatewayId (rejectMisaddressedGateway), so an unsigned caller cannot use
// the rejection to learn which gateway answers here.
function registerMigrationRoutes(
  app: express.Express,
  migrationDeps: MigrationHandlerDeps,
  processControlDeps: SurgeOpenClawProcessHandlerDeps,
): void {
  const quota = rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: "draft-7", legacyHeaders: false });
  const restore = createRestoreHandler(migrationDeps);
  app.post("/restore/:gatewayId", quota, restore);
  app.post("/resume-restore/:gatewayId", quota, restore);
  app.post("/migration-progress/:gatewayId", quota, createMigrationProgressHandler(migrationDeps));
  app.post("/resume/:gatewayId", quota, createResumeHandler(migrationDeps));
  app.post("/scheduler/:gatewayId", quota, createSchedulerMigrationHandler(migrationDeps));
  app.post("/scheduler-ready/:gatewayId", quota, createSchedulerReadyHandler(migrationDeps));
  app.post("/schedules/:gatewayId", quota, createScheduleTransferHandler(migrationDeps));
  app.post("/quiesce/:gatewayId", quota, createQuiesceHandler(migrationDeps));
  app.post("/flush/:gatewayId", quota, createFlushHandler(migrationDeps));
  app.post("/verify/:gatewayId", quota, createVerifyHandler(migrationDeps));
  app.post("/export-paths/:gatewayId", quota, createExportPathsHandler(migrationDeps));
  app.post(
    "/export-activation-manifest/:gatewayId", quota,
    createActivationManifestExportHandler(migrationDeps),
  );
  app.post("/prepare-import/:gatewayId", quota, createPrepareImportHandler(migrationDeps));
  app.post("/activate-import/:gatewayId", quota, createActivateImportHandler(migrationDeps));
  app.post("/prepare-rsync-import/:gatewayId", quota, createPrepareRsyncImportHandler(migrationDeps));
  app.post("/push-rsync-state/:gatewayId", quota, createPushRsyncStateHandler(migrationDeps));
  app.post("/finish-rsync-import/:gatewayId", quota, createFinishRsyncImportHandler(migrationDeps));
  app.post("/abort-rsync-import/:gatewayId", quota, createAbortRsyncImportHandler(migrationDeps));
  app.post(
    "/hold-surge-openclaw/:gatewayId", quota,
    createHoldSurgeOpenClawHandler(processControlDeps),
  );
  app.post(
    "/resume-surge-openclaw/:gatewayId", quota,
    createResumeSurgeOpenClawHandler(processControlDeps),
  );
  app.post(
    "/unreserve-surge-openclaw/:gatewayId", quota,
    createUnreserveSurgeOpenClawHandler(processControlDeps),
  );
  app.post("/complete-surge-handoff/:gatewayId", quota, createCompleteSurgeHandoffHandler(migrationDeps));
  app.post("/unmount/:gatewayId", quota, createUnmountHandler(migrationDeps));
}

interface IsolatedSurgeGateWiring {
  prepareSurgeTarget: (input: IsolatedSurgeTargetRequest, signal?: AbortSignal) => Promise<void>;
  reserveSurgeTarget: (input: { migrationId: string; slug: string }) => Promise<void>;
  unreserveSurgeTarget: (input: {
    migrationId: string;
    slug: string;
    targetPodUid: string;
  }, cleanup?: (assertCurrent: () => Promise<void>) => Promise<void>) => Promise<SurgeOpenClawProcessGateState>;
  surgeTargetOpenClawHeld: (input: IsolatedSurgeTargetRequest) => Promise<boolean>;
  surgeTargetLive: (input: IsolatedSurgeTargetRequest) => Promise<boolean>;
  admitLiveSurgeTarget: (input: IsolatedSurgeTargetRequest) => Promise<void>;
  liveSurgeTargetAssigned: (input: IsolatedSurgeTargetRequest) => Promise<boolean>;
  releaseSurgeReadiness: (input: { migrationId: string; targetPodUid: string; importSlug?: string }) => Promise<void>;
  surgeReleaseInProgress: () => boolean;
}

interface ActiveIsolatedSurgeRelease {
  migrationId: string;
  targetPodUid: string;
  cancelled: boolean;
  promise: Promise<void> | null;
}

interface IsolatedSurgeTargetRequest {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}

type ConfiguredUserAttach = (input: {
  adapter: UserLifecycleAdapter;
  log?: (message: string) => void;
  onWorkSettled?: (settled: Promise<void>) => void;
}) => Promise<string>;

function requireOwnPodUid(purpose: string): string {
  const currentPodUid = process.env.POD_UID?.trim();
  if (!currentPodUid) throw new Error(`POD_UID is required to ${purpose}`);
  return currentPodUid;
}

async function returnToHoldAfterFailure(
  error: unknown,
  hold: () => Promise<unknown>,
  message: string,
): Promise<never> {
  try {
    await hold();
  } catch (holdError) {
    throw new AggregateError([error, holdError], message);
  }
  throw error;
}

function throwIfIsolatedSurgeReleaseCancelled(release: ActiveIsolatedSurgeRelease): void {
  if (release.cancelled) throw new Error("configured isolated target release was cancelled");
}

function scheduleIsolatedTargetHoldFinalization(input: {
  log: (message: string) => void;
  processGate: SurgeOpenClawProcessSupervisorClient;
  release: ActiveIsolatedSurgeRelease;
  request: IsolatedSurgeTargetRequest;
  runCancellation: <T>(work: () => Promise<T>) => Promise<T>;
  waitForActiveProvisioningDrain: () => Promise<void>;
}): void {
  void input.runCancellation(async () => {
    await input.waitForActiveProvisioningDrain();
    if (input.release.cancelled) return;
    await input.processGate.finalizeTargetCancellation(input.request);
  }).catch((error) => {
    input.log(
      `[surge-handoff] configured isolated target cancellation could not be finalized: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function releasedIsolatedTargetMatches(
  state: SurgeOpenClawProcessGateState,
  request: IsolatedSurgeTargetRequest,
): boolean {
  const terminal = state.terminalTarget;
  return terminal?.migrationId === request.migrationId && terminal.slug === request.slug &&
    terminal.targetPodUid === request.targetPodUid;
}

function reservedIsolatedTargetMatches(state: SurgeOpenClawProcessGateState, request: IsolatedSurgeTargetRequest): boolean {
  return state.role === "target" && state.migrationId === request.migrationId &&
    state.slug === request.slug && state.targetPodUid === request.targetPodUid;
}

function settledUserCancellation(state: SurgeOpenClawProcessGateState): boolean {
  return state.mode === "held" && state.phase === "held";
}

async function assertIsolatedTargetCleanupCurrent(
  processGate: SurgeOpenClawProcessSupervisorClient,
  request: IsolatedSurgeTargetRequest,
  configuredUserAssigned: (slug: string) => Promise<boolean>,
): Promise<void> {
  const current = await processGate.status();
  if (current.role !== "target" || current.mode !== "held" ||
      !["held", "cancelling"].includes(current.phase) ||
      current.migrationId !== request.migrationId || current.slug !== request.slug ||
      current.targetPodUid !== request.targetPodUid || current.podUid !== request.targetPodUid) {
    throw new Error("User import cleanup no longer owns its held target");
  }
  if (await configuredUserAssigned(request.slug)) throw new Error("cannot clean a user with a serving assignment");
}

async function unreserveWarmIsolatedTarget(
  input: Parameters<typeof unreserveConfiguredIsolatedTarget>[0],
  cleanup: () => Promise<void>,
  observed: SurgeOpenClawProcessGateState,
): Promise<SurgeOpenClawProcessGateState> {
  const { processGate, request } = input;
  if (!input.cleanup) return processGate.unreserve(request);
  if (await input.configuredUserAssigned(request.slug)) throw new Error("cannot clean a user with a serving assignment");
  await processGate.holdNormal();
  await processGate.hydrate(request);
  await input.waitForActiveProvisioningDrain();
  await cleanup();
  const released = await processGate.unreserve(request);
  if (observed.mode !== "permitted") return released;
  return restartIsolatedPrelaunch(input);
}

async function restartIsolatedPrelaunch(
  input: Pick<Parameters<typeof unreserveConfiguredIsolatedTarget>[0], "processGate" | "request" | "prepareIsolatedPrelaunch">,
): Promise<SurgeOpenClawProcessGateState> {
  return openClawRuntimeUpdateGuard.run(async () => {
    await input.prepareIsolatedPrelaunch(input.request.slug);
    return input.processGate.permitNormal();
  });
}

function servingAfterWarmCleanup(state: SurgeOpenClawProcessGateState): boolean {
  return state.mode === "permitted" && state.terminalTarget?.completionStarted === false;
}

async function cancelReleasedIsolatedTarget(
  input: Parameters<typeof unreserveConfiguredIsolatedTarget>[0],
  cleanup: () => Promise<void>,
  observed: SurgeOpenClawProcessGateState,
): Promise<SurgeOpenClawProcessGateState> {
  const { processGate, request } = input;
  if (await input.configuredUserAssigned(request.slug)) {
    throw new Error("cannot cancel a released user with a serving assignment");
  }
  if (!input.cleanup && settledUserCancellation(observed)) return observed;
  await processGate.reholdReleasedTarget(request);
  await input.waitForActiveProvisioningDrain();
  await cleanup();
  const cancelled = await processGate.finalizeTargetCancellation(request);
  return input.cleanup && servingAfterWarmCleanup(observed) ? restartIsolatedPrelaunch(input) : cancelled;
}

async function unreserveConfiguredIsolatedTarget(input: {
  activeRelease: ActiveIsolatedSurgeRelease | null;
  configuredUserAssigned: (slug: string) => Promise<boolean>;
  processGate: SurgeOpenClawProcessSupervisorClient;
  request: IsolatedSurgeTargetRequest;
  waitForActiveProvisioningDrain: () => Promise<void>;
  prepareIsolatedPrelaunch: (slug: string) => Promise<void>;
  cleanup?: (assertCurrent: () => Promise<void>) => Promise<void>;
}): Promise<SurgeOpenClawProcessGateState> {
  const { activeRelease, processGate, request, waitForActiveProvisioningDrain } = input;
  const release = activeRelease?.migrationId === request.migrationId &&
    activeRelease.targetPodUid === request.targetPodUid
    ? activeRelease
    : null;
  if (release) release.cancelled = true;
  const assertCleanupCurrent = () => assertIsolatedTargetCleanupCurrent(processGate, request, input.configuredUserAssigned);
  const cleanup = async () => {
    if (!input.cleanup) return;
    await assertCleanupCurrent();
    await input.cleanup(assertCleanupCurrent);
    await assertCleanupCurrent();
  };
  const state = await processGate.status();
  if (state.role === "normal") {
    return releasedIsolatedTargetMatches(state, request)
      ? cancelReleasedIsolatedTarget(input, cleanup, state)
      : unreserveWarmIsolatedTarget(input, cleanup, state);
  }
  if (!reservedIsolatedTargetMatches(state, request)) {
    if (input.cleanup) throw new Error("User import cleanup has no matching target reservation");
    return processGate.unreserve(request);
  }
  if (await input.configuredUserAssigned(request.slug)) {
    throw new Error("cannot cancel a user with a serving assignment");
  }
  const reheld = await processGate.rehold(request);
  await waitForActiveProvisioningDrain();
  await cleanup();
  if (reheld.phase !== "cancelling") return processGate.unreserve(request);
  return processGate.finalizeTargetCancellation(request);
}

interface IsolatedSurgeGateWiringOptions {
  openclawDir?: string;
  projectBlobHydrator?: ProjectBlobHydrator;
  adapter: UserLifecycleAdapter;
  processGate: SurgeOpenClawProcessSupervisorClient | null;
  surgeReadiness: SurgeReadinessGate;
  waitForGatewayReady: () => Promise<void>;
  log: (message: string) => void;
  provisioning: ProvisioningCounter;
  waitForActiveProvisioningDrain?: () => Promise<void>;
  attachConfiguredUserBeforeOpenClaw?: ConfiguredUserAttach;
  configuredUserAssigned?: (slug: string) => Promise<boolean>;
  prepareIsolatedPrelaunch?: (slug: string) => Promise<void>;
}

function reservedTargetOpenClawHeld(
  state: SurgeOpenClawProcessGateState,
  request: IsolatedSurgeTargetRequest,
): boolean {
  if (
    state.role !== "target" ||
    state.migrationId !== request.migrationId ||
    state.slug !== request.slug ||
    state.targetPodUid !== request.targetPodUid
  ) {
    throw new Error("configured isolated target is not reserved by this migration");
  }
  if (state.mode === "permitted") return false;
  if (state.completionStarted) throw new Error("configured user Native completion has already started");
  if (state.phase !== "held") {
    throw new Error(`configured user OpenClaw is still stopping (phase ${state.phase})`);
  }
  return true;
}

export async function userSourceOpenClawHeld(
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null,
  request: { migrationId: string; slug: string },
): Promise<boolean> {
  if (!processGate) return false;
  const state = await processGate.status();
  if (state.role !== "source" || state.mode === "permitted") return false;
  if (state.migrationId !== request.migrationId || state.slug !== request.slug) {
    throw new Error("configured user source is held by another migration");
  }
  if (state.phase !== "held") {
    throw new Error(`configured user source OpenClaw is still stopping (phase ${state.phase})`);
  }
  return true;
}

function liveIsolatedTarget(
  state: SurgeOpenClawProcessGateState,
  request: IsolatedSurgeTargetRequest,
): boolean {
  return state.role === "normal" && state.mode === "permitted" && !releasedIsolatedTargetMatches(state, request);
}

async function admitLiveIsolatedTarget(input: {
  adapter: UserLifecycleAdapter;
  processGate: SurgeOpenClawProcessSupervisorClient;
  surgeReadiness: SurgeReadinessGate;
  request: IsolatedSurgeTargetRequest;
}): Promise<void> {
  const { adapter, request } = input;
  const state = await input.processGate.status();
  if (state.podUid !== request.targetPodUid || !liveIsolatedTarget(state, request)) {
    throw new Error("configured isolated target is not a live permitted OpenClaw on this pod");
  }
  if (state.phase !== "running") {
    throw new Error(`configured user OpenClaw is not running for a live import (phase ${state.phase})`);
  }
  if (!(await input.surgeReadiness.released())) {
    throw new Error("configured user live import requires released readiness");
  }
  if (configuredUserSlug(adapter) !== request.slug) {
    throw new Error("configured user live import requires its retained overlay");
  }
  if (configuredUserMountProven(adapter)) {
    throw new Error("configured user live import target already mounts its user");
  }
}

function liveIsolatedTargetOperations(input: {
  adapter: UserLifecycleAdapter;
  processGate: SurgeOpenClawProcessSupervisorClient | null;
  surgeReadiness: SurgeReadinessGate;
  configuredUserAssigned: (slug: string) => Promise<boolean>;
}): Pick<IsolatedSurgeGateWiring, "surgeTargetLive" | "admitLiveSurgeTarget" | "liveSurgeTargetAssigned"> {
  const requireGate = (): SurgeOpenClawProcessSupervisorClient => {
    if (!input.processGate) throw new Error("configured user OpenClaw process gate is unavailable");
    return input.processGate;
  };
  return {
    surgeTargetLive: async (request) => liveIsolatedTarget(await requireGate().status(), request),
    admitLiveSurgeTarget: async (request) => admitLiveIsolatedTarget({
      adapter: input.adapter, processGate: requireGate(), surgeReadiness: input.surgeReadiness, request,
    }),
    liveSurgeTargetAssigned: (request) => input.configuredUserAssigned(request.slug),
  };
}

type PreparedIsolatedTarget = IsolatedSurgeTargetRequest & { inputs: string };

async function userPreparationInputs(adapter: UserLifecycleAdapter, openclawDir: string, slug: string) {
  const uid = await adapter.uidForSlug(slug);
  if (!uid) throw new Error("prepared user no longer has an owner");
  const snapshot = await adapter.loadUserSnapshot(uid, { refresh: true });
  if (!snapshot || snapshot.slug !== slug) throw new Error("prepared user ownership changed");
  return { snapshot, manifest: await readActivationManifest(openclawDir, slug) };
}

async function userPreparationFingerprint(adapter: UserLifecycleAdapter, openclawDir: string, slug: string): Promise<string> {
  return JSON.stringify(await userPreparationInputs(adapter, openclawDir, slug));
}

async function prepareConfiguredIsolatedTarget(input: {
  request: IsolatedSurgeTargetRequest;
  signal?: AbortSignal;
  adapter: UserLifecycleAdapter;
  processGate: SurgeOpenClawProcessSupervisorClient | null;
  attachConfigured: ConfiguredUserAttach;
  log: (message: string) => void;
  provisioning: ProvisioningCounter;
  waitForActiveProvisioningDrain: () => Promise<void>;
  openclawDir: string;
  projectBlobHydrator?: ProjectBlobHydrator;
}): Promise<PreparedIsolatedTarget> {
  const { request, adapter, processGate, attachConfigured, log, provisioning } = input;
  input.signal?.throwIfAborted();
  if (!processGate || !reservedTargetOpenClawHeld(await processGate.status(), request)) {
    throw new Error("User preparation requires its reserved OpenClaw process to remain held");
  }
  await input.waitForActiveProvisioningDrain();
  const prepared = await userPreparationInputs(adapter, input.openclawDir, request.slug);
  const inputs = JSON.stringify(prepared);
  await runProvisioningWork({ provisioning, work: async (onWorkSettled) => {
    const attachedSlug = await attachConfigured({ adapter, log, onWorkSettled });
    if (attachedSlug !== request.slug) throw new Error("User preparation attached the wrong user");
    input.signal?.throwIfAborted();
    const checkouts = await cloneMissingProjects(adapter, request.slug, { signal: input.signal });
    input.signal?.throwIfAborted();
    if (checkouts.pending.length > 0) throw new Error(`User preparation has pending repositories: ${checkouts.pending.join(", ")}`);
  } });
  const lockSha256 = process.env.OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256?.trim();
  const groupsSha256 = process.env.OCTOGEE_BUILDER_TOOL_GROUPS_SHA256?.trim();
  if (lockSha256 && groupsSha256) {
    await waitForPreparedIsolatedToolchain({ root: isolatedToolchainRoot(), lockSha256, groupsSha256 });
  }
  if (!reservedTargetOpenClawHeld(await processGate.status(), request)) throw new Error("User process started during preparation");
  log(`[surge-handoff] User prepared while OpenClaw remains held slug=${request.slug} migrationId=${request.migrationId}`);
  return { ...request, inputs };
}

async function reholdFailedIsolatedTarget(input: {
  request: IsolatedSurgeTargetRequest;
  release: ActiveIsolatedSurgeRelease;
  processGate: SurgeOpenClawProcessSupervisorClient;
  log: (message: string) => void;
  runCancellation: <T>(work: () => Promise<T>) => Promise<T>;
  waitForActiveProvisioningDrain: () => Promise<void>;
}): Promise<void> {
  if (input.release.cancelled) return;
  const current = await input.processGate.status();
  if (current.podUid === input.request.targetPodUid && reservedIsolatedTargetMatches(current, input.request) &&
      current.mode === "held" && current.phase === "held") return;
  const state = await input.processGate.rehold(input.request);
  if (state.phase === "cancelling" && !input.release.cancelled) {
    scheduleIsolatedTargetHoldFinalization(input);
  }
}

export function createIsolatedSurgeGateWiring(input: IsolatedSurgeGateWiringOptions): IsolatedSurgeGateWiring {
  const {
    adapter,
    openclawDir = OPENCLAW_DIR,
    processGate,
    surgeReadiness,
    waitForGatewayReady,
    log,
    provisioning,
    waitForActiveProvisioningDrain = async () => undefined,
    attachConfiguredUserBeforeOpenClaw: attachConfigured = attachConfiguredUserBeforeOpenClaw,
    configuredUserAssigned = async () => false,
    prepareIsolatedPrelaunch = (slug: string) => prepareIsolatedPrelaunchConfig(openclawDir, slug),
  } = input;
  let activeRelease: ActiveIsolatedSurgeRelease | null = null;
  let preparedTarget: PreparedIsolatedTarget | null = null;
  let cancellationQueue = Promise.resolve();
  const runCancellation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = cancellationQueue.then(work, work);
    cancellationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const reholdAfterReleaseFailure = (
    request: { migrationId: string; slug: string; targetPodUid: string },
    release: ActiveIsolatedSurgeRelease,
  ): Promise<void> => runCancellation(() => reholdFailedIsolatedTarget({
    request, release, processGate: processGate!, log, runCancellation, waitForActiveProvisioningDrain,
  }));
  const attachClaimedTargetWithProvisioning = (
    request: { migrationId: string; slug: string; targetPodUid: string },
    release: ActiveIsolatedSurgeRelease,
  ): Promise<void> => runProvisioningWork({
    provisioning,
    onDeferredReleaseError: (error) => {
      log(
        `[surge-handoff] configured user completion lease release failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    },
    work: async (onWorkSettled) => {
      throwIfIsolatedSurgeReleaseCancelled(release);
      await processGate!.claimTargetCompletion(request);
      throwIfIsolatedSurgeReleaseCancelled(release);
      await processGate!.claimTargetCompletion(request);
      throwIfIsolatedSurgeReleaseCancelled(release);
      await processGate!.claimTargetCompletion(request);
      const attachedSlug = preparedTarget?.migrationId === request.migrationId && preparedTarget.targetPodUid === request.targetPodUid &&
        preparedTarget.slug === request.slug && configuredUserMountProven(adapter) &&
        preparedTarget.inputs === await userPreparationFingerprint(adapter, openclawDir, request.slug)
        ? preparedTarget.slug
        : await attachConfigured({ adapter, log, onWorkSettled });
      if (attachedSlug !== request.slug) {
        throw new Error(
          `configured isolated prelaunch attach returned ${attachedSlug}, expected ${request.slug}`,
        );
      }
    },
  });
  const releasePermittedTarget = async (
    request: { migrationId: string; slug: string; targetPodUid: string },
    release: ActiveIsolatedSurgeRelease,
    permittedAt?: number,
  ): Promise<void> => {
    throwIfIsolatedSurgeReleaseCancelled(release);
    await verifyConfiguredUserAfterOpenClaw({ adapter, waitForGatewayReady, log, permittedAt });
    throwIfIsolatedSurgeReleaseCancelled(release);
    await processGate!.releaseTarget(request);
  };
  const releaseSurgeReadinessOnce = async ({
    migrationId,
    targetPodUid,
    release,
  }: {
    migrationId: string;
    targetPodUid: string;
    release: ActiveIsolatedSurgeRelease;
  }): Promise<void> => {
    const ownPodUid = process.env.POD_UID?.trim();
    if (ownPodUid && ownPodUid !== targetPodUid) {
      throw new Error(`target pod UID mismatch: expected ${ownPodUid}, received ${targetPodUid}`);
    }
    if (!processGate) {
      await surgeReadiness.release({ targetPodUid });
      return;
    }
    if (!ownPodUid) throw new Error("POD_UID is required to permit configured user OpenClaw");
    const slug = configuredUserSlug(adapter);
    if (!slug) throw new Error("configured user overlay is unavailable for surge release");
    const reservation = await processGate.status();
    if (
      reservation.role !== "target" ||
      reservation.migrationId !== migrationId ||
      reservation.slug !== slug ||
      reservation.targetPodUid !== targetPodUid
    ) {
      throw new Error("configured isolated target is not reserved by this migration");
    }
    const request = { migrationId, slug, targetPodUid };
    if (reservation.mode === "held") {
      await waitForActiveProvisioningDrain();
      try {
        await attachClaimedTargetWithProvisioning(request, release);
        const permittedAt = Date.now();
        await processGate.permit(request);
        await releasePermittedTarget(request, release, permittedAt);
      } catch (error) {
        await returnToHoldAfterFailure(
          error,
          () => reholdAfterReleaseFailure(request, release),
          "configured isolated target failed prelaunch attach and could not be returned to hold",
        );
      }
    } else if (reservation.mode !== "permitted") {
      throw new Error("configured isolated target has an invalid surge reservation mode");
    } else {
      try {
        await releasePermittedTarget(request, release);
      } catch (error) {
        await returnToHoldAfterFailure(
          error,
          () => reholdAfterReleaseFailure(request, release),
          "configured isolated target failed to release and could not be returned to hold",
        );
      }
    }
  };
  return {
    async prepareSurgeTarget(request, signal) {
      preparedTarget = await prepareConfiguredIsolatedTarget({ request, signal, adapter, processGate, attachConfigured,
        log, provisioning, waitForActiveProvisioningDrain, openclawDir, projectBlobHydrator: input.projectBlobHydrator });
    },
    async reserveSurgeTarget({ migrationId, slug }) {
      if (!processGate || configuredUserSlug(adapter) !== slug) return;
      await processGate.hydrate({
        migrationId,
        slug,
        targetPodUid: requireOwnPodUid("reserve the configured user migration target"),
      });
      await waitForActiveProvisioningDrain();
    },
    async surgeTargetOpenClawHeld(request) {
      if (!processGate) throw new Error("configured user OpenClaw process gate is unavailable");
      return reservedTargetOpenClawHeld(await processGate.status(), request);
    },
    ...liveIsolatedTargetOperations({ adapter, processGate, surgeReadiness, configuredUserAssigned }),
    async unreserveSurgeTarget(request, cleanup) {
      preparedTarget = null;
      if (!processGate) throw new Error("configured user OpenClaw process gate is unavailable");
      return runCancellation(() => unreserveConfiguredIsolatedTarget({
        activeRelease, configuredUserAssigned, processGate, request,
        waitForActiveProvisioningDrain, prepareIsolatedPrelaunch, cleanup,
      }));
    },
    releaseSurgeReadiness(input) {
      if (activeRelease) {
        if (
          activeRelease.migrationId === input.migrationId &&
          activeRelease.targetPodUid === input.targetPodUid
        ) {
          return activeRelease.promise!;
        }
        return Promise.reject(new Error("configured isolated target already has a release in progress"));
      }
      if (processGate && migrationImportBusy() &&
          (!input.importSlug || configuredUserSlug(adapter) !== input.importSlug ||
            !ownsFinalMigrationImport(input.migrationId, input.importSlug))) {
        return Promise.reject(new Error("configured user import is in progress"));
      }
      const release: ActiveIsolatedSurgeRelease = { ...input, cancelled: false, promise: null };
      activeRelease = release;
      const promise = releaseSurgeReadinessOnce({ ...input, release });
      release.promise = promise;
      void promise.then(
        () => {
          if (activeRelease === release) activeRelease = null;
        },
        () => {
          if (activeRelease === release) activeRelease = null;
        },
      );
      return promise;
    },
    surgeReleaseInProgress: () => activeRelease !== null,

  };
}


// eslint-disable-next-line max-lines-per-function -- controller startup owns one ordered lifecycle for listeners, reconciliation, health, and shutdown.
export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const caps = resolveFleetCapabilities({
    localReconcile: opts.localReconcile,
    hasBrokeredRoster: !!opts.readDesiredSlugs || !!opts.readDesiredUsers,
  });
  const adapter = opts.adapter;

  const runtime = createFleetRuntime();
  const openclawDir = opts.openclawDir ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  const surgeReadiness = createSurgeReadinessGate(openclawDir, process.env.POD_UID?.trim() || undefined);
  const wrappedAdapter = wrapAdapterWithRuntime(adapter, runtime);
  const userProcessGate = adapter.isIsolatedGateway?.() === true
    ? opts.surgeOpenClawProcessGate ?? createSurgeOpenClawProcessSupervisorClient(openclawDir)
    : null;
  await clearInheritedUserMountProof(wrappedAdapter, userProcessGate, opts.log);
  const configuredUserAssigned = createConfiguredUserAssignmentMatcher(opts);
  const canReconcile = createConfiguredUserReconcileAdmission({
    processGate: userProcessGate,
    hasServingAssignment: async () => {
      const slug = configuredUserSlug(wrappedAdapter);
      return slug !== null && await configuredUserAssigned(slug);
    },
    log: opts.log,
  });

  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || "18789";
  const dashboardBridgeRequired = process.env.OPENCLAW_DASHBOARD_BRIDGE_REQUIRED === "true";
  const sharedProfileRoster = brokerProfileRoster(opts);
  let brokerProfilesSettled = !caps.provision;

  const probeHealthz = () => probeOpenClawRuntimeReady(
    () => probeOpenClawHealth(`http://127.0.0.1:${gatewayPort}/healthz`),
  );
  const probeDashboardBridge = () => dashboardBridgeReady({
    required: dashboardBridgeRequired,
    openclawDir,
    gatewayId: opts.gatewayId,
  });
  const readiness: FleetReadinessInput = {
    runtime,
    probeHealthz,
    brokerProfilesSettled: () => brokerProfilesSettled,
    dashboardBridgeReady: () => probeDashboardBridge().ready,
  };
  const waitForOpenClawUp = async (timeoutMs?: number): Promise<void> => {
    await waitForOpenClawHealthz({ probeHealthz, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (caps.provision) {
      let lastSweepError: string | null = null;
      await waitForBrokerProfilesSettled({
        sweep: async () => {
          try {
            const profileReadiness = await materializeDeferredBrokerProfiles(opts.log, {
              secretsReload: opts.rpc,
              readAssignedSlugs: sharedProfileRoster,
            });
            brokerProfilesSettled = profileReadiness.settled;
            lastSweepError = null;
            return profileReadiness;
          } catch (error) {
            const reason = String(error);
            brokerProfilesSettled = false;
            if (reason !== lastSweepError) {
              opts.log(`⚠ [agent-model-token] startup sweep failed: ${reason}`);
              lastSweepError = reason;
            }
            return { settled: false, deferred: [], reason };
          }
        },
      });
    }
    await waitForDashboardBridgeReady({
      required: dashboardBridgeRequired,
      openclawDir,
      gatewayId: opts.gatewayId,
      log: opts.log,
      probe: probeDashboardBridge,
    });
    if (runtime.status === "ready") return;
    runtime.status = "ready";
    opts.log(
      `[fleet] OpenClaw healthz, workspace identities, broker profiles, and Dashboard bridge ready; ` +
        `transitioning gateways/${opts.gatewayId} to status=ready`,
    );
  };
  const waitForGatewayReady = async (): Promise<void> => {
    if (runtime.status === "ready") return;
    await waitForOpenClawUp();
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(["/scheduler", "/schedules"], express.json({
    limit: "9mb",
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }));
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/toolchain-ready", createToolchainReadinessHandler({
    adapter: wrappedAdapter,
    prelaunchState: () => isolatedPrelaunchState(wrappedAdapter, userProcessGate),
    log: opts.log,
  }));

  app.get("/health", (_req, res) => {
    res.json(buildFleetHealthResponse({
      status: runtime.status,
      podUid: process.env.POD_UID ?? null,
      startedAt: PROCESS_STARTED_AT_MS,
    }));
  });

  const fleetStateQuota = rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: "draft-7", legacyHeaders: false });
  app.post(`${FLEET_STATE_PATH}/:gatewayId`, fleetStateQuota, createFleetStateHandler({
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    log: opts.log,
    readState: async ({ privateProjectCoachSlug }) => ({
      ...buildFleetStateResponse({
        status: runtime.status,
        gatewayId: opts.gatewayId,
        podUid: process.env.POD_UID ?? null,
        version: opts.version,
        openclawVersion: opts.openclawVersion,
        startedAt: PROCESS_STARTED_AT_MS,
        users: getMountObservedSlugs(adapter),
        migratingIn: adapter.listMigratingInSlugs?.() ?? [],
        configuredBuilder: (opts.configuredUserReport ?? configuredUserReport)(),
        openclawProcess: await openclawProcessReport({ adapter: wrappedAdapter, processGate: userProcessGate, log: opts.log }),
      }),
      ...(isValidUsername(privateProjectCoachSlug) ? {
        privateProjectCoachWorkspace: fleetStatePrivateProjectAgentWorkspace(readOpenClawConfig(), openclawDir, privateProjectCoachSlug),
      } : {}),
    }),
  }));

  app.get("/startup-ready", createStartupReadinessHandler({
    readiness,
    prelaunchState: () => isolatedPrelaunchState(wrappedAdapter, userProcessGate),
    log: opts.log,
  }));

  app.get("/surge-ready", createSurgeReadinessHandler({
    surgeReadiness,
    readiness,
    prelaunchState: (state) => isolatedPrelaunchState(wrappedAdapter, userProcessGate, state),
    processGateState: async () => userProcessGate?.status(),
    log: opts.log,
  }));

  const reportUserAgentAnchors = createUserAgentAnchorReporter(opts);
  const brokerProfileTimer = startBrokerProfileRetry(
    caps.provision,
    opts.log,
    opts.rpc,
    (profileReadiness) => {
      brokerProfilesSettled = profileReadiness.settled;
      if (profileReadiness.settled) {
        reportUserAgentAnchors().catch((error: unknown) => opts.log(`⚠ [agent-anchors] report pass failed: ${String(error)}`));
      }
    },
    sharedProfileRoster,
  );

  const surgeGate = createIsolatedSurgeGateWiring({
    openclawDir: opts.openclawDir,
    projectBlobHydrator: opts.projectBlobHydrator,
    adapter: wrappedAdapter,
    processGate: userProcessGate,
    surgeReadiness,
    waitForGatewayReady: () => waitForOpenClawUp(USER_POST_START_HEALTH_TIMEOUT_MS),
    log: opts.log,
    provisioning: runtime,
    waitForActiveProvisioningDrain: runtime.waitForProvisioningDrain,
    configuredUserAssigned,
  });
  const migrationDeps = {
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    adapter: wrappedAdapter,
    log: opts.log,
    getMountedUsers: () => runtime.mountedCustomers,
    sourceMountRefusal: (slug: string) => runtime.mountRefusal(slug),
    userAttachPending: createVerifyAttachPending({ provision: caps.provision, opts }),
    flushLocalState: opts.flushLocalState,
    prepareSurgeTarget: surgeGate.prepareSurgeTarget,
    reserveSurgeTarget: surgeGate.reserveSurgeTarget,
    surgeTargetOpenClawHeld: surgeGate.surgeTargetOpenClawHeld,
    surgeSourceOpenClawHeld: (request: { migrationId: string; slug: string }) => userSourceOpenClawHeld(userProcessGate, request),
    surgeTargetLive: surgeGate.surgeTargetLive,
    admitLiveSurgeTarget: surgeGate.admitLiveSurgeTarget,
    liveSurgeTargetAssigned: surgeGate.liveSurgeTargetAssigned,
    releaseSurgeReadiness: surgeGate.releaseSurgeReadiness,
    surgeReleaseInProgress: surgeGate.surgeReleaseInProgress,
    unreserveSurgeTarget: surgeGate.unreserveSurgeTarget,
    scheduleTransfer: createScheduleTransfer({
      readConfig: async () => (await opts.rpc.configGet()).config,
      localAgentIds: agentIdsForMigration,
      connect: async () => ({ request: (method, params) => opts.rpc.cronRequest(method, params), close: () => {} }),
      log: opts.log,
    }),
  };
  registerMigrationRoutes(app, migrationDeps, {
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    configuredBuilder: (slug) => configuredUserSlug(wrappedAdapter) === slug,
    processGate: userProcessGate ?? undefined,
    unreserveConfiguredIsolatedTarget: surgeGate.unreserveSurgeTarget,
    waitForActiveProvisioningDrain: runtime.waitForProvisioningDrain,
    log: opts.log,
  });

  registerByosubDeviceAuth(app, opts);
  registerAgentImportDoctor(app, opts);

  const stopReconcileLoop = startMaybeReconcileLoop({
    provision: caps.provision,
    opts,
    wrappedAdapter,
    runtime,
    stampMounted: opts.stampMounted,
    surgeReadiness,
    canReconcile,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  const boundPort = (server.address() as AddressInfo).port;
  const whenReady = waitForGatewayReady();
  const stopBrokerTokenRefresh = startBrokerTokenRefreshAfterGatewayReady(
    opts.rpc,
    openclawDir,
    whenReady,
    opts.log,
  );
  let reconcileLoopStatus = "disabled";
  if (caps.provision) {
    reconcileLoopStatus = opts.subscribeDesiredChanges ? "push; repair=60000ms" : `${RECONCILE_LOOP_INTERVAL_MS}ms`;
  }
  opts.log(
    `[fleet] listening on 0.0.0.0:${boundPort}; gatewayId=${opts.gatewayId}; reconcile-loop=${reconcileLoopStatus}`,
  );

return {
    port: boundPort,
    whenReady,
    stop: async () => {
      if (brokerProfileTimer) clearInterval(brokerProfileTimer);
      stopBrokerTokenRefresh();
      stopReconcileLoop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
