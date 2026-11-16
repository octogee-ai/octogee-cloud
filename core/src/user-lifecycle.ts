import { withLogContext, setLogContext } from "@octogee/shared/server/service-logger";
import type { AgentModelSelections } from "@octogee/shared/types/agent-models";
import type { SchedulerMigrationRequest, SchedulerMigrationResult, CustomerSnapshot } from "@octogee/shared/types/fleet-controller";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerProjectAgent,
  FleetBrokerProjectRestore,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { ProjectRepoSource } from "@octogee/shared/types/project";
import { projectCheckoutEnabled } from "@octogee/shared/types/project";
import type { MigrationActivationManifest, MigrationSourceIdentityCustody } from "./migration-activation-manifest.js";
import {
  ADD_USER_DEADLINE_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "@octogee/shared/types/fleet-controller";
import { UNKNOWN_TIME_ZONE } from "./context-file-convergence.js";
import type { ManagedGitHost } from "./git-host/types.js";

export interface UserSnapshot {
  uid: string;
  slug: string;
  contextTemplateKey: string;
  planInputs: Record<string, unknown>;
  gatewayId: string;
  status: "" | "provisioning" | "complete";
  agentIds: string[];
  restoreAuthority?: FleetBrokerUserSnapshot["restoreAuthority"];
  repoUrl: string;
  mattermostUserId: string | null;
  channels: CustomerSnapshot["channels"];
  ownerName: string;
  persona: Record<string, unknown> | null;
  timeZone?: string | null;
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  projects?: FleetBrokerProjectRestore[];
  projectAgents?: FleetBrokerProjectAgent[];
  byotActive?: boolean;
  // The operator's house model dial, stamped by the fleet broker; drives
  // the house pin and the BYOK fallback baseline at mount-time reassert.
  freeTierModelRef?: string;
  // The operator's user agent default dial: the {primary, fallbacks} a
  // catalog agent with no explicit pick converges to at mount-time reassert.
  builderAgentDefault?: { primary: string; fallbacks: string[] };
  provisionedBy?: "service";
  systemConfig?: {
    byot?: { provider?: string; baseUrl?: string; model?: string };
    agentModels?: AgentModelSelections;
  };
}

export interface ReassertUserData {
  username: string;
  timeZone: string | null;
  byotActive?: boolean;
  systemConfig?: UserSnapshot["systemConfig"];
  planInputs: Record<string, unknown>;
  freeTierModelRef?: string;
  builderAgentDefault?: UserSnapshot["builderAgentDefault"];
  provisioning: { openclaw: { status: "complete" } };
}

export interface ProjectCloneTarget {
  projectSlug: string;
  giteaRepoName: string | null;
  repoSource?: ProjectRepoSource | null;
}

export interface ProjectCloneOptions {
  repoSource?: ProjectRepoSource | null;
  refreshRemote?: boolean;
  refreshLeaseDeadlineMs?: number;
  signal?: AbortSignal;
}

export interface UserContext {
  uid: string;
  slug: string;
  contextTemplateKey: string;
  ownerName: string;
  customerDir: string;
  today: string;
  username: string;
  templateVars: Record<string, string>;
  userData: Record<string, unknown>;
}

export type MmUpdate = Record<string, unknown>;

export type ProvisioningPath = "gateway" | "service";

export type ServiceProvisioningAnswer =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string; readonly retryAfterMs: number };

export interface ServiceProvisioningAdapter {
  readiness: (uid: string) => Promise<ServiceProvisioningAnswer>;
  serviceGitKey: (slug: string) => string;
  holdsServiceGitKey: (slug: string) => boolean;
  registerGitKey: (uid: string, publicKey: string) => Promise<ServiceProvisioningAnswer>;
  releaseGitKey: (uid: string) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const SERVICE_PROVISIONING_WAIT_MS = 90_000;
export const SERVICE_GIT_KEY_WAIT_MS = 60_000;
const SERVICE_POLL_MIN_MS = 1_000;
const SERVICE_POLL_MAX_MS = 15_000;

export interface UserLifecycleAdapter {
  log: (msg: string, fields?: { status: "failed" }) => void;

  provisioningService?: ServiceProvisioningAdapter;

  isIsolatedGateway?: () => boolean;

  /** True when this gateway is the configured disposable isolated for this exact slug. */
  isConfiguredUser?: (slug: string) => boolean;

  /**
   * True when this pod owns a readable user system-config overlay for the
   * requested user. A complete user overlay is never repaired through
   * the Shared user config projection.
   */
  configuredUserOverlayPresent?: (slug: string) => boolean;

  /**
   * Re-run the platform broker-profile materialization for this user's
   * agents. Only openclaw creates an agent's auth-profile store, so the mount's
   * first attempt runs too early and defers; this is called once the agent is
   * confirmed running+connected, when the store is guaranteed to exist.
   */
  materializeBrokerProfiles?: (slug: string) => void | Promise<void>;

  /**
   * Read-only probe of the on-disk openclaw.json: is this user's
   * agent fully wired (agent registered + MM account configured + at
   * least one binding linking the agent to the MM account)?
   * `applyAddUserConfigPatch` writes all three together — so a
   * state where only the agent is present means a prior config.patch
   * crashed mid-flight OR openclaw.json was hand-edited. The operator
   * short-circuit MUST NOT skip the full flow in either case, because
   * the agent will sit inert (no MM auth, no inbound routing).
   */
  userDefaultAgentWiredInOpenclawConfig?: (slug: string) => boolean;
  hasUserAgentRuntime?: (slug: string) => boolean;

  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;

  /** Locally-present, default-agent-wired user slugs — the pod's honest mounted set
   *  read WITHOUT Firestore, served via /health for the fleet controller's pull-model poller.
   *  Also the reconcile's heartbeat report + mount-observed basis. */
  listLocalUserSlugs?: () => string[];

  /** Raw on-disk user dirs (no default-agent-wired filter) — the reconcile's evict-observed set,
   *  so a partial/junk dir from a mount that died before its config patch is still drained
   *  once unassigned. */
  listLocalUserDirs?: () => string[];

  /** True iff the slug's mount-completion marker is present — the LAST step a successful
   *  ensure writes, AFTER the user is fully provisioned (not merely default-agent-wired). The
   *  reconcile's mount direction keys off this, so a default-agent-wired-but-incomplete mount
   *  (config patch landed, then mark-complete failed) is re-ensured rather than
   *  silently treated as done. */
  userMountMarked?: (slug: string) => boolean;

  /** Stamp the mount-completion marker for the slug — the final step of a successful mount. */
  writeMountMarker?: (slug: string) => void;

  /** True iff the slug has a fresh migrating-in pin — a migration imported + default-agent-wired it
   *  here, but cutover hasn't yet made it desired-here. The reconcile's evict direction skips
   *  such slugs so it doesn't drain a freshly-imported user mid-migration. */
  userMigratingIn?: (slug: string) => boolean;

  /** Stamp the migrating-in pin (import handler, before activation). */
  markUserMigratingIn?: (slug: string) => void;

  /** Clear the migration pin after a target-side import is aborted. */
  clearUserMigratingIn?: (slug: string) => void;

  listMigratingInSlugs?: () => string[];

  loadUserSnapshot: (uid: string, options?: { refresh?: boolean }) => Promise<UserSnapshot | null>;

  seedUserSnapshotForMigration?: (snapshot: FleetBrokerUserSnapshot) => void;

  setProvisioningStatus: (uid: string, status: "provisioning" | "complete") => Promise<void>;
  provisionDefaultAgentAutomation: (user: { slug: string; coachChannelId: string }) => Promise<void>;
  setRepoUrl: (uid: string, repoUrl: string) => Promise<void>;
  setMattermostFields: (uid: string, fields: MmUpdate) => Promise<void>;
  ensureAgentIds: (uid: string, agentIds: string[]) => Promise<void>;

  hasUserDir: (slug: string) => boolean;
  hasWorkspaceGitDir: (slug: string) => boolean;
  hasGitRemote: (slug: string) => boolean;
  ensureUserDirectories: (slug: string) => void;
  writeUserTemplateFiles: (ctx: UserContext) => Promise<void>;
  removePartialWorkspace: (slug: string) => Promise<void>;
  deleteDepartedUserState: (slug: string) => Promise<void>;

  cloneWorkspaceRepo: (slug: string, repoUrl: string) => Promise<boolean>;
  initWorkspaceRepoFromExistingDir: (ctx: UserContext, path?: ProvisioningPath) => Promise<string | null>;

  hasUserSshKey: (slug: string) => boolean;
  generateUserSshKey: (slug: string) => string;
  gitHost: Pick<ManagedGitHost, "registerKey" | "listKeys" | "releaseKey" | "ensureOwner" | "ensureRepo">;

readLocalUserPubKey: (slug: string) => string | null;

deleteUserSshKey: (slug: string) => Promise<void>;

  blobSyncForSlug: (slug: string) => Promise<void>;

restoreByosubForAgent: (slug: string) => Promise<{ restored: boolean; present: boolean }>;

  // Re-assert the user's byot/broker model auth (the Anthropic broker token, BYOT
  // key refs) into the openclaw config. Idempotent; runs at provision AND on fresh-pod
  // re-mount, so a cattle/emptyDir pod self-heals its LLM auth after a roll/preemption.
  // userData must carry byotActive + systemConfig.byot (hydrated into the mount snapshot).
  reassertByotForUser: (userData: ReassertUserData) => Promise<void>;

  // Re-assert the platform-managed context files (AGENTS.md/TOOLS.md) for house_only
  // plans — the same convergence semantics as reassertByotForUser: idempotent,
  // only-on-drift, runs at provision AND on fresh-pod re-mount. A no-op for any plan
  // with catalog model access, including a user who WAS house_only and has since
  // gained it — that's how ownership returns to them.
  reassertConvergedContextFilesForUser: (userData: ReassertUserData) => Promise<void>;

  listProjectsNeedingClone: (slug: string) => Promise<ProjectCloneTarget[]>;

  cloneProjectRepo: (
    userSlug: string,
    projectSlug: string,
    giteaRepoName: string | null,
    opts?: ProjectCloneOptions,
  ) => Promise<boolean>;

  seedDeferredProjectWorkspace?: (userSlug: string, projectSlug: string) => Promise<void>;

  provisionMattermostUser: (ctx: UserContext) => Promise<MmUpdate>;
  applyAddUserConfigPatch: (
    snapshot: UserSnapshot,
    mmUpdate: MmUpdate | null,

opts?: {
  signal?: AbortSignal;
  byosActive?: boolean;
  evictionBatch?: readonly string[];
  currentEvictionBatch?: () => Promise<readonly string[]>;
  /** Projects whose pod checkout is absent. Their agents point at a workspace dir
   *  that does not exist, so they stay out of the config until the checkout lands. */
  withoutProjectIds?: readonly string[];
  /** Broker profile materialization started at mount start; settles (never rejects)
   *  before the runtime secrets reload that follows the config patch. */
  brokerProfilesReady?: Promise<void>;
  runtimePublication?: AddUserOptions["runtimePublication"];
  beforeRuntimePublish?: () => Promise<void>;
  migrationId?: string;
},
  ) => Promise<{ elapsedMs: number; appliedFingerprint?: string }>;
  reconcileConfiguredUserProjectAgents?: (
    snapshot: UserSnapshot,
    opts?: { signal?: AbortSignal; withoutProjectIds?: readonly string[]; runtimePublication?: AddUserOptions["runtimePublication"] },
  ) => Promise<{ elapsedMs: number; appliedFingerprint?: string }>;
  applyRemoveUserConfigPatch: (
    slug: string,
    agentId: string,
    evictionBatch?: readonly string[],
    currentEvictionBatch?: () => Promise<readonly string[]>,
  ) => Promise<readonly string[] | void>;
  cancelPendingEviction?: (slug: string) => boolean | void;
  clearMountMarker?: (slug: string) => void;

  waitForAccountHealthy: (params: { slug: string; timeoutMs: number }) => Promise<boolean>;
  projectAgentsHealthy: (snapshot: UserSnapshot) => Promise<boolean>;

  reportProvisioned: (ctx: UserContext, report: { first: boolean }) => Promise<void>;

  onMounted?: (slug: string) => void;
  onUnmounted?: (slug: string) => void;

uidForSlug: (slug: string) => Promise<string | null>;
userContextRestoreHeld?: (slug: string) => Promise<boolean>;

schedulerMigration: (slug: string, request: SchedulerMigrationRequest) => Promise<SchedulerMigrationResult>;

schedulerReady: () => Promise<void>;

resumeUser: (slug: string, opts?: { migrationId: string; role?: "target" }) => Promise<void>;
sourceMigrationIdentityCustody?: (slug: string, migrationId: string) => Promise<MigrationSourceIdentityCustody>;
sourceMigrationAgentAnchors?: (slug: string, migrationId: string) => Promise<import("@octogee/shared/types/fleet-broker").FleetBrokerAgentAnchor[]>;

quiesceUser: (
    slug: string,
    timeoutMs: number,
    opts?: { stopMattermost: boolean; schedulerMigrationId?: string; retainNonportable?: boolean },
  ) => Promise<{ drained: boolean; runningCount: number }>;

listExportPaths: (slug: string) => Promise<Array<{ cwd: string; path: string }>>;

prepareImportDir: (slug: string, mode: UserStateImportMode) => Promise<string>;
prepareKeyImportDir: (slug: string) => Promise<string>;

  targetMigrationIdentityCustody?: (slug: string, migrationId: string) => Promise<{
    custody: import("./migration-activation-manifest.js").MigrationTargetIdentityCustody;
    migration: import("@octogee/shared/types/fleet-broker").FleetBrokerAgentAnchorMigration;
    anchors: import("@octogee/shared/types/fleet-broker").FleetBrokerAgentAnchor[];
  }>;

  activateImportedUser: (
    slug: string,
    opts?: { signal?: AbortSignal; migrationId?: string; beforeRuntimePublish?: () => Promise<void>; deferRuntimeVerification?: true },
  ) => Promise<{ appliedFingerprint: string; verificationPending?: string }>;
  recordAppliedFingerprint?: (slug: string, fingerprint: string) => void;

  exportOpenClawActivationManifest?: (
    slug: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number; convergeSource?: boolean },
  ) => Promise<MigrationActivationManifest>;

  removeImportedUserBySlug?: (
    slug: string,
    evictionBatch?: readonly string[],
    currentEvictionBatch?: () => Promise<readonly string[]>,
    targetCleanup?: { migrationId: string; targetPodUid: string; assertCurrent: () => Promise<void> },
    erasureAgentIds?: readonly string[],
  ) => Promise<RemoveUserResult>;

  releaseAgent?: (agentId: string) => Promise<void>;
}

export type UserStateImportMode = "pre" | "final" | "default";

export type AddUserStep =
  | "claim-slot"
  | "ensure-dir"
  | "write-templates"
  | "clone-workspace-repo"
  | "init-workspace-repo"
  | "ssh-key"
  | "ssh-key-resync"
  | "blob-sync"
  | "byosub-restore"
  | "byot-reassert"
  | "context-files-reassert"
  | "project-clone"
  | "mattermost-provision"
  | "config-patch"
  | "verify-channel-ready"
  | "mark-complete"
  | "report-provisioned";

const VERIFY_CHANNEL_READY = "verify-channel-ready";
const CONFIG_PATCH = "config-patch";

export interface AddUserResult {
  newUser: boolean;
  steps: AddUserStep[];
  appliedFingerprint?: string;
  // Active projects whose pod checkout is STILL absent after this converge. Non-empty means
  // the converge did not reach desired state, so the caller must not record its real
  // fingerprint as applied — it parks the user on the pending-clone marker instead, which
  // keeps the checkout retried (checkout-only, no re-attach) until it lands.
  pendingProjectClones: string[];
}

export interface RestoreUserRuntimeResult {
  restored: boolean;
  steps: AddUserStep[];
  appliedFingerprint?: string;
  pendingProjectClones: string[];
  convergedState: boolean;
}

const CONVERGED_STATE_STEPS: readonly AddUserStep[] = ["byot-reassert", "context-files-reassert"];

export type RemoveUserStep =
  | "config-patch-remove"
  | "delete-dir"
  | "release-gitea-key";

export interface RemoveUserResult {
  wasMounted: boolean;
  steps: RemoveUserStep[];
  retained?: boolean;
  releasedAgentIds?: string[];
}

const inFlightUids = new Map<string, symbol>();

export class ConcurrentMountError extends Error {
  override readonly name = "ConcurrentMountError";
  constructor(uid: string) {
    super(`[add:${uid}] another mount is already in-flight for this uid in this process`);
  }
}

export function _resetInFlightUidsForTests(): void {
  inFlightUids.clear();
}

export function _inFlightUidsHasForTests(uid: string): boolean {
  return inFlightUids.has(uid);
}

export type MountStep =
  | "load-snapshot"
  | "await-provisioning"
  | "ssh-key"
  | "claim-slot"
  | "workspace-repo"
  | "byos-restore"
  | "mattermost"
  | "config-patch"
  | "reassert-converged"
  | "verify-channel-ready"
  | "blob-sync"
  | "project-clones"
  | "finalize"
  | "report-provisioned";

export type MarkStep = (step: MountStep) => void;

export interface AddUserOptions {
  verifyTimeoutMs?: number;
  usersDir?: string;
  mountDeadlineMs?: number;
  convergeContent?: boolean;
  deferRuntimeVerification?: boolean;
  reclaimExistingSshKey?: boolean;
  evictionBatch?: readonly string[];
  currentEvictionBatch?: () => Promise<readonly string[]>;

  runtimePublication?: { settled: Promise<void>; invalidateFingerprint: () => void };
  beforeRuntimePublish?: () => Promise<void>;
  migrationId?: string;

signal?: AbortSignal;

onSignalCreated?: (signal: AbortSignal) => void;

onWorkSettled?: (settled: Promise<void>) => void;
}

export async function addUserToGateway(
  adapter: UserLifecycleAdapter,
  uid: string,
  opts: AddUserOptions = {},
): Promise<AddUserResult> {
  return withLogContext({}, async () => {
    return runUidMountExclusive(uid, opts, (signal, markStep) =>
      addUserToGatewayInner(adapter, uid, { ...opts, signal, markStep }),
    );
  });
}

export async function prepareUserRuntimePublication(options: { signal?: AbortSignal; beforeRuntimePublish?: () => Promise<void> } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  await options.beforeRuntimePublish?.();
  options.signal?.throwIfAborted();
}

export async function restoreUserRuntimeFromSnapshot(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
  opts: AddUserOptions = {},
): Promise<RestoreUserRuntimeResult> {
  return withLogContext({}, async () => {
    setLogContext({ builderSlug: snapshot.slug, category: "lifecycle" });
    return runUidMountExclusive(snapshot.uid, opts, (signal, markStep) =>
      restoreUserRuntimeFromSnapshotInner(adapter, snapshot, { ...opts, signal, markStep }),
    );
  });
}

async function runUidMountExclusive<T>(
  uid: string,
  opts: AddUserOptions,
  work: (signal: AbortSignal, markStep: MarkStep) => Promise<T>,
): Promise<T> {
  if (inFlightUids.has(uid)) {
    throw new ConcurrentMountError(uid);
  }
  const claim = Symbol(uid);
  inFlightUids.set(uid, claim);
  const release = () => {
    if (inFlightUids.get(uid) === claim) inFlightUids.delete(uid);
  };
  let workSettled: Promise<void> | undefined;
  const deadlineMs = opts.mountDeadlineMs ?? ADD_USER_DEADLINE_MS;
  const controller = new AbortController();
  let step: MountStep = "load-snapshot";
  const markStep: MarkStep = (next) => {
    step = next;
  };

  const externalAbortListener = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) {
    controller.abort(opts.signal.reason);
  } else if (opts.signal) {
    opts.signal.addEventListener("abort", externalAbortListener, { once: true });
  }
  let timer: NodeJS.Timeout | null = null;
  if (!controller.signal.aborted && Number.isFinite(deadlineMs) && deadlineMs > 0) {
    timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `[add:${uid}] mountDeadlineMs=${deadlineMs}ms exceeded — step "${step}" is hung; retaining in-flight lock until work settles`,
          ),
        ),
      deadlineMs,
    );
  }
  try {
    opts.onSignalCreated?.(controller.signal);
    let workPromise: Promise<T>;
    try {
      workPromise = work(controller.signal, markStep);
    } catch (error) {
      workPromise = Promise.reject(error);
    }
    workSettled = workPromise.then(
      () => undefined,
      () => undefined,
    );
    void workSettled.then(release);
    opts.onWorkSettled?.(workSettled);
    return await raceWithSignal(workPromise, controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", externalAbortListener);
    if (!workSettled) release();
  }
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function restoreUserRuntimeFromSnapshotInner(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
  opts: AddUserOptions & { markStep?: MarkStep },
): Promise<RestoreUserRuntimeResult> {
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
  const usersDir = opts.usersDir ?? "/home/node/.openclaw/customers";
  const ctx = buildUserContext(snapshot, usersDir);
  const steps: AddUserStep[] = [];
  const { signal } = opts;
  const markStep = opts.markStep ?? (() => {});
  const { slug, uid } = snapshot;
  const startedAt = Date.now();

  adapter.log(
    `[restore:${slug}] starting durable restore for migration (repoUrl=${snapshot.repoUrl ? "set" : "empty"}, projects=${snapshot.projects?.length ?? 0})`,
  );

  throwIfAborted(signal, uid);
  markStep("ssh-key");
  steps.push(...(await ensureSshKeyAndGitea(adapter, slug, true)));
  throwIfAborted(signal, uid);

  markStep("workspace-repo");
  const workspaceSteps = snapshot.repoUrl
    ? await convergeWorkspaceCheckout(adapter, uid, snapshot, ctx)
    : [];
  steps.push(...workspaceSteps);
  if (!workspaceSteps.includes("write-templates")) {
    adapter.ensureUserDirectories(slug);
    await adapter.writeUserTemplateFiles(ctx);
    steps.push("write-templates");
  }
  throwIfAborted(signal, uid);

  markStep("project-clones");
  const projectClones = rehydratesProjectCheckouts(adapter, snapshot)
    ? await cloneProjectsFromSnapshot(adapter, snapshot, { signal })
    : { steps: [], pending: [] };
  steps.push(...projectClones.steps);
  throwIfAborted(signal, uid);

  markStep("byos-restore");
  const byos = await restoreByos(adapter, slug);
  steps.push(...byos.steps);
  throwIfAborted(signal, uid);

  markStep(CONFIG_PATCH);
  const appliedFingerprint = await applyConfigPatchAndMount(adapter, snapshot, null, {
    byosActive: byos.present,
    signal,
    withoutProjectIds: projectClones.pending,
    runtimePublication: opts.runtimePublication,
    beforeRuntimePublish: opts.beforeRuntimePublish,
    migrationId: opts.migrationId,
  });
  steps.push(CONFIG_PATCH);
  throwIfAborted(signal, uid);

  markStep("reassert-converged");
  const reassertSteps = await reassertConvergedState(adapter, snapshot);
  steps.push(...reassertSteps);
  const convergedState = CONVERGED_STATE_STEPS.every((step) => reassertSteps.includes(step));
  throwIfAborted(signal, uid);

  markStep(VERIFY_CHANNEL_READY);
  await verifyChannelReady(adapter, slug, verifyTimeoutMs);
  steps.push(VERIFY_CHANNEL_READY);
  throwIfAborted(signal, uid);

  const admittedSnapshot = {
    ...snapshot,
    projectAgents: snapshot.projectAgents?.filter((agent) => !projectClones.pending.includes(agent.projectId)),
  };
  if (!await adapter.projectAgentsHealthy(admittedSnapshot)) {
    throw new Error(`[restore:${slug}] project agents are not connected to their configured channels`);
  }
  throwIfAborted(signal, uid);

  markStep("report-provisioned");
  steps.push(...(await reportProvisioned(adapter, ctx, false)));
  throwIfAborted(signal, uid);

  adapter.writeMountMarker?.(slug);
  adapter.log(
    `[restore:${slug}] durable restore complete in ${Date.now() - startedAt}ms`,
  );
  return {
    restored: true,
    steps,
    pendingProjectClones: projectClones.pending,
    convergedState,
    ...(appliedFingerprint !== undefined ? { appliedFingerprint } : {}),
  };
}

function githubRepoSourceOf(target: ProjectCloneTarget): ProjectRepoSource | null {
  return target.repoSource?.provider === "github" ? target.repoSource : null;
}

function projectCloneOptions(target: ProjectCloneTarget, signal?: AbortSignal): ProjectCloneOptions | undefined {
  const repoSource = githubRepoSourceOf(target);
  if (!repoSource && !signal) return undefined;
  return { ...(repoSource ? { repoSource } : {}), ...(signal ? { signal } : {}) };
}

function projectCloneSourceLabel(target: ProjectCloneTarget): string {
  const repoSource = githubRepoSourceOf(target);
  return repoSource ? `github:${repoSource.owner}/${repoSource.repo}` : "Gitea";
}

function hasProjectCloneSource(target: ProjectCloneTarget): boolean {
  return githubRepoSourceOf(target) !== null || Boolean(target.giteaRepoName);
}

export async function cloneProjectsFromSnapshot(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<{ steps: AddUserStep[]; pending: string[] }> {
  const steps: AddUserStep[] = [];
  const pending: string[] = [];
  const refreshOptions: ProjectCloneOptions = {
    refreshRemote: true,
    refreshLeaseDeadlineMs: performance.now() + ADD_USER_DEADLINE_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  for (const project of snapshot.projects ?? []) {
    options.signal?.throwIfAborted();
    if (project.provisioningState !== undefined && project.provisioningState !== "active") continue;
    if (!projectCheckoutEnabled(project.checkoutEnabled)) {
      adapter.log(
        `[restore:${snapshot.slug}/${project.projectSlug}] project checkout is turned off by its owner`,
      );
      continue;
    }
    if (!hasProjectCloneSource(project)) {
      adapter.log(
        `[restore:${snapshot.slug}/${project.projectSlug}] ✖ project checkout skipped — no Gitea repo and no GitHub repoSource`,
      );
      pending.push(project.projectSlug);
      continue;
    }
    try {
      const cloned = await adapter.cloneProjectRepo(
        snapshot.slug,
        project.projectSlug,
        project.giteaRepoName,
        githubRepoSourceOf(project)
          ? projectCloneOptions(project)
          : refreshOptions,
      );
      options.signal?.throwIfAborted();
      if (cloned) steps.push("project-clone");
      else pending.push(project.projectSlug);
    } catch (error) {
      options.signal?.throwIfAborted();
      pending.push(project.projectSlug);
      adapter.log(
        `[restore:${snapshot.slug}/${project.projectSlug}] ⚠ project clone failed (non-fatal): ${String(error)}`,
      );
    }
  }
  return { steps, pending: pending.sort() };
}

function rehydratesProjectCheckouts(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
): boolean {
  const scope = snapshot.projectCheckoutScope ?? adapter.projectCheckoutScope?.(snapshot.slug);
  return scope === "workspace-and-projects";
}

function throwIfAborted(signal: AbortSignal | undefined, uid: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(`[add:${uid}] aborted: ${String(reason ?? "operation cancelled")}`);
}

function configuredUserOverlayIsReady(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
): boolean {
  const { slug } = snapshot;
  return snapshot.status === "complete"
    && Boolean(adapter.isIsolatedGateway?.())
    && Boolean(adapter.isConfiguredUser?.(slug));
}

async function attachConfiguredUserOverlay(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
  opts: {
    usersDir: string;
    convergeContent: boolean | undefined;
    deferRuntimeVerification: boolean | undefined;
    reclaimExistingSshKey: boolean | undefined;
    signal: AbortSignal | undefined;
    markStep: MarkStep;
    runtimePublication?: AddUserOptions["runtimePublication"];
  },
): Promise<AddUserResult> {
  const { slug, uid } = snapshot;
  const ctx = buildUserContext(snapshot, opts.usersDir);
  const steps: AddUserStep[] = [];
  opts.markStep("ssh-key");
  steps.push(...(await ensureSshKeyAndGitea(adapter, slug, opts.reclaimExistingSshKey === true)));
  throwIfAborted(opts.signal, uid);

  opts.markStep("workspace-repo");
  steps.push(...(await convergeWorkspaceCheckout(adapter, uid, snapshot, ctx)));
  throwIfAborted(opts.signal, uid);

  opts.markStep("byos-restore");
  steps.push(...(await restoreByos(adapter, slug)).steps);
  throwIfAborted(opts.signal, uid);

  opts.markStep("project-clones");
  const projectClones = opts.convergeContent && rehydratesProjectCheckouts(adapter, snapshot)
    ? await cloneMissingProjects(adapter, slug)
    : { steps: [], pending: [] };
  steps.push(...projectClones.steps);
  throwIfAborted(opts.signal, uid);

  let appliedFingerprint: string | undefined;
  if (opts.deferRuntimeVerification) {
    adapter.log(`[add:${slug}] project runtime reconciliation deferred until OpenClaw starts`);
  } else if (adapter.reconcileConfiguredUserProjectAgents) {
    opts.markStep(CONFIG_PATCH);
    const result = await adapter.reconcileConfiguredUserProjectAgents(snapshot, {
      signal: opts.signal,
      withoutProjectIds: projectClones.pending,
      runtimePublication: opts.runtimePublication,
    });
    appliedFingerprint = result.appliedFingerprint;
    steps.push(CONFIG_PATCH);
    throwIfAborted(opts.signal, uid);
  } else if (snapshot.projectAgents?.length) {
    throw new Error(`[add:${slug}] configured user project reconciliation is unavailable`);
  }

  if (!adapter.userDefaultAgentWiredInOpenclawConfig?.(slug)) {
    adapter.log(
      `[add:${slug}] configured user overlay has no platform MM agent wiring; retaining workspace config`,
    );
  }
  if (adapter.onMounted) adapter.onMounted(slug);
  return { newUser: false, steps, pendingProjectClones: projectClones.pending, appliedFingerprint };
}

async function addUserToGatewayInner(
  adapter: UserLifecycleAdapter,
  uid: string,
  opts: {
    verifyTimeoutMs?: number;
    usersDir?: string;
    signal?: AbortSignal;
    markStep?: MarkStep;
    convergeContent?: boolean;
    deferRuntimeVerification?: boolean;
    reclaimExistingSshKey?: boolean;
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
    runtimePublication?: AddUserOptions["runtimePublication"];
  } = {},
): Promise<AddUserResult> {
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
  const usersDir = opts.usersDir ?? "/home/node/.openclaw/customers";
  const { signal } = opts;
  const markStep = opts.markStep ?? (() => {});
  const steps: AddUserStep[] = [];
  const attachStartedAt = Date.now();

  throwIfAborted(signal, uid);
  const prepared = await loadAndPrepareForMount(adapter, uid, usersDir);
  let snapshot = prepared.snapshot;
  const { ctx, newUser } = prepared;
  const { slug } = snapshot;
  setLogContext({ builderSlug: slug, category: "lifecycle" });

  if (configuredUserOverlayIsReady(adapter, snapshot)) {
    if (!adapter.configuredUserOverlayPresent?.(slug)) {
      throw new Error(`[add:${slug}] configured user system-config overlay is unavailable`);
    }
    return attachConfiguredUserOverlay(adapter, snapshot, {
      usersDir,
      convergeContent: opts.convergeContent,
      deferRuntimeVerification: opts.deferRuntimeVerification,
      reclaimExistingSshKey: opts.reclaimExistingSshKey,
      runtimePublication: opts.runtimePublication,
      signal,
      markStep,
    });
  }

  if (snapshot.status !== "complete") {
    markStep("claim-slot");
    await adapter.setProvisioningStatus(uid, "provisioning");
    await adapter.ensureAgentIds(uid, [`octogee-${slug}-coach`]);
    steps.push("claim-slot");
  }

  const brokerProfilesReady = startBrokerProfiles(adapter, slug);

  const remote = await provisionUserState(adapter, uid, snapshot, ctx, markStep, signal);
  snapshot = remote.snapshot;
  const { workspace, mm } = remote;
  steps.push(...workspace.steps, ...mm.steps);
  throwIfAborted(signal, uid);
  const { projectClones, byos } = workspace;

  markStep(CONFIG_PATCH);
  const appliedFingerprint = await applyConfigPatchAndMount(adapter, snapshot, mm.mmUpdate, {
    byosActive: byos.present,
    signal,
    evictionBatch: opts.evictionBatch,
    currentEvictionBatch: opts.currentEvictionBatch,
    withoutProjectIds: projectClones.pending,
    runtimePublication: opts.runtimePublication,
    ...(brokerProfilesReady ? { brokerProfilesReady } : {}),
  });
  steps.push(CONFIG_PATCH);
  throwIfAborted(signal, uid);

  markStep(VERIFY_CHANNEL_READY);
  await verifyChannelReady(adapter, slug, verifyTimeoutMs);
  steps.push(VERIFY_CHANNEL_READY);
  throwIfAborted(signal, uid);

  markStep("reassert-converged");
  steps.push(...(await reassertConvergedState(adapter, snapshot)));
  throwIfAborted(signal, uid);

  markStep("finalize");
  adapter.log(
    `✅ [add:${slug}] agent attach complete in ${Date.now() - attachStartedAt}ms`,
  );
  steps.push(...(await markCompleteIfNeeded(adapter, uid, snapshot, newUser, mm.mmUpdate)));

  markStep("blob-sync");
  steps.push(...(await runBlobSync(adapter, slug)));
  throwIfAborted(signal, uid);

  markStep("report-provisioned");
  steps.push(...(await reportProvisioned(adapter, ctx, newUser)));

  return {
    newUser,
    steps,
    pendingProjectClones: projectClones.pending,
    ...(appliedFingerprint ? { appliedFingerprint } : {}),
  };
}

type WorkspaceProvisioning = Awaited<ReturnType<typeof provisionWorkspace>>;
type ChatProvisioning = Awaited<ReturnType<typeof provisionMattermostIfMissing>>;

function serviceProvisioningFor(adapter: UserLifecycleAdapter, snapshot: UserSnapshot): ServiceProvisioningAdapter | null {
  if (snapshot.provisionedBy !== "service") return null;
  if (!adapter.provisioningService) {
    throw new Error(`[add:${snapshot.slug}] the platform provisions this user through the provisioning service, but this gateway has no provisioning service adapter`);
  }
  return adapter.provisioningService;
}

async function provisionUserState(
  adapter: UserLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: UserContext,
  markStep: MarkStep,
  signal: AbortSignal | undefined,
): Promise<{ snapshot: UserSnapshot; workspace: WorkspaceProvisioning; mm: ChatProvisioning }> {
  const { slug } = snapshot;
  const service = serviceProvisioningFor(adapter, snapshot);
  if (service) {
    markStep("await-provisioning");
    const ready = await awaitServiceProvisioning(adapter, service, snapshot, signal);
    markStep("ssh-key");
    const workspace = await provisionWorkspace(adapter, uid, ready, ctx, markStep, { service, signal });
    return { snapshot: ready, workspace, mm: { mmUpdate: null, steps: [] } };
  }
  markStep("ssh-key");
  const [workspace, mm] = await settleBoth(
    adapter,
    slug,
    provisionWorkspace(adapter, uid, snapshot, ctx, markStep),
    provisionMattermostIfMissing(adapter, uid, snapshot, ctx),
  );
  throwIfAborted(signal, uid);
  const refreshed = mm.mmUpdate ? (await adapter.loadUserSnapshot(uid)) ?? snapshot : snapshot;
  return { snapshot: refreshed, workspace, mm };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForServiceProvisioning(
  adapter: UserLifecycleAdapter,
  service: ServiceProvisioningAdapter,
  wait: { slug: string; what: string; boundMs: number; signal: AbortSignal | undefined },
  probe: () => Promise<ServiceProvisioningAnswer>,
): Promise<void> {
  const now = service.now ?? Date.now;
  const sleep = service.sleep ?? abortableSleep;
  const startedAt = now();
  for (let round = 0; ; round += 1) {
    const answer = await probe();
    const waited = now() - startedAt;
    if (answer.ready) {
      if (round > 0) adapter.log(`[add:${wait.slug}] ${wait.what}: ready after ${waited}ms`);
      return;
    }
    const backoff = SERVICE_POLL_MIN_MS * 2 ** Math.min(round, 4);
    const delay = Math.min(Math.max(answer.retryAfterMs, backoff), SERVICE_POLL_MAX_MS);
    if (waited + delay > wait.boundMs) {
      throw new Error(
        `[add:${wait.slug}] gave up waiting for ${wait.what} after ${waited}ms (bound ${wait.boundMs}ms, last reason ${answer.reason}); failing the mount, the mount retry takes over`,
      );
    }
    adapter.log(`[add:${wait.slug}] waiting for ${wait.what} (reason ${answer.reason}, next check in ${delay}ms, waited ${waited}ms)`);
    await sleep(delay, wait.signal);
  }
}

async function awaitServiceProvisioning(
  adapter: UserLifecycleAdapter,
  service: ServiceProvisioningAdapter,
  snapshot: UserSnapshot,
  signal: AbortSignal | undefined,
): Promise<UserSnapshot> {
  const { slug, uid } = snapshot;
  await waitForServiceProvisioning(
    adapter,
    service,
    { slug, what: "the provisioning service to report chat and git ready", boundMs: SERVICE_PROVISIONING_WAIT_MS, signal },
    () => service.readiness(uid),
  );
  const refreshed = await adapter.loadUserSnapshot(uid, { refresh: true });
  if (!refreshed) throw new Error(`[add:${slug}] the user snapshot vanished after the provisioning service reported the user ready`);
  return refreshed;
}

async function ensureServiceGitKey(
  adapter: UserLifecycleAdapter,
  service: ServiceProvisioningAdapter,
  uid: string,
  slug: string,
  signal: AbortSignal | undefined,
): Promise<AddUserStep[]> {
  const publicKey = service.serviceGitKey(slug);
  await waitForServiceProvisioning(
    adapter,
    service,
    { slug, what: "the provisioning service to register this gateway's git key", boundMs: SERVICE_GIT_KEY_WAIT_MS, signal },
    () => service.registerGitKey(uid, publicKey),
  );
  return ["ssh-key"];
}

async function settleBoth<A, B>(
  adapter: UserLifecycleAdapter,
  slug: string,
  workspace: Promise<A>,
  mattermost: Promise<B>,
): Promise<[A, B]> {
  const [workspaceResult, mattermostResult] = await Promise.allSettled([workspace, mattermost]);
  if (workspaceResult.status === "rejected" && mattermostResult.status === "rejected") {
    adapter.log(`[add:${slug}] ⚠ Mattermost provisioning also failed: ${String(mattermostResult.reason)}`);
  }
  if (workspaceResult.status === "rejected") throw workspaceResult.reason;
  if (mattermostResult.status === "rejected") throw mattermostResult.reason;
  return [workspaceResult.value, mattermostResult.value];
}

function startBrokerProfiles(
  adapter: UserLifecycleAdapter,
  slug: string,
): Promise<void> | undefined {
  const materialize = adapter.materializeBrokerProfiles;
  if (!materialize) return undefined;
  return (async () => {
    try {
      await materialize(slug);
    } catch (err) {
      adapter.log(
        `[add:${slug}] ⚠ early broker profile materialization failed (the post-verify retry and the sweep cover it): ${String(err)}`,
      );
    }
  })();
}

async function provisionWorkspace(
  adapter: UserLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: UserContext,
  markStep: MarkStep,
  through?: { service: ServiceProvisioningAdapter; signal: AbortSignal | undefined },
): Promise<{
  steps: AddUserStep[];
  projectClones: { steps: AddUserStep[]; pending: string[] };
  byos: { restored: boolean; present: boolean; steps: AddUserStep[] };
}> {
  const { slug } = snapshot;
  const steps: AddUserStep[] = [];
  steps.push(...(through
    ? await ensureServiceGitKey(adapter, through.service, uid, slug, through.signal)
    : await ensureSshKeyAndGitea(adapter, slug)));
  markStep("workspace-repo");
  steps.push(...(through
    ? await convergeWorkspaceCheckout(adapter, uid, snapshot, ctx, "service")
    : await ensureWorkspaceRepo(adapter, uid, snapshot, ctx)));
  markStep("project-clones");
  const projectClones = rehydratesProjectCheckouts(adapter, snapshot)
    ? await cloneMissingProjects(adapter, slug)
    : { steps: [], pending: [] };
  steps.push(...projectClones.steps);
  markStep("byos-restore");
  const byos = await restoreByos(adapter, slug);
  steps.push(...byos.steps);
  return { steps, projectClones, byos };
}

async function loadAndPrepareForMount(
  adapter: UserLifecycleAdapter,
  uid: string,
  usersDir: string,
): Promise<{ snapshot: UserSnapshot; ctx: UserContext; newUser: boolean }> {
  const snapshot = await adapter.loadUserSnapshot(uid);
  if (!snapshot) {
    throw new Error(`[add:${uid}] user doc not found in Firestore`);
  }
  const newUser = snapshot.status !== "complete";
  const ctx = buildUserContext(snapshot, usersDir);
  adapter.log(
    `🟢 [add:${snapshot.slug}] starting (status=${snapshot.status || "<empty>"}, repoUrl=${snapshot.repoUrl ? "set" : "empty"}, mmUserId=${snapshot.mattermostUserId ? "set" : "empty"})`,
  );
  return { snapshot, ctx, newUser };
}

async function ensureSshKeyAndGitea(
  adapter: UserLifecycleAdapter,
  slug: string,
  reclaimExistingSshKey = false,
): Promise<AddUserStep[]> {
  if (!adapter.hasUserSshKey(slug)) {
    await registerFirstTimeSshKey(adapter, slug);
    return ["ssh-key"];
  }
  return resyncSshKeyIfDrifted(adapter, slug, reclaimExistingSshKey);
}

async function registerFirstTimeSshKey(
  adapter: UserLifecycleAdapter,
  slug: string,
): Promise<void> {
  const pubKey = adapter.generateUserSshKey(slug);
  try {
    await adapter.gitHost.registerKey(slug, pubKey);
    const giteaPubKeys = await adapter.gitHost.listKeys(slug);
    if (!giteaPubKeys.some((candidate) => pubKeysMatch(candidate, pubKey))) {
      throw new Error(
        `Gitea did not register the new SSH key (giteaPub=${giteaPubKeys.length === 0 ? "absent" : "mismatch"})`,
      );
    }
  } catch (err) {
    await adapter.deleteUserSshKey(slug).catch(() => {});
    throw new Error(`[add:${slug}] SSH key registration failed: ${String(err)}`);
  }
  adapter.log(`[add:${slug}] SSH key + Gitea user registered`);
}

async function resyncSshKeyIfDrifted(
  adapter: UserLifecycleAdapter,
  slug: string,
  reclaimExistingSshKey: boolean,
): Promise<AddUserStep[]> {
  const localPub = adapter.readLocalUserPubKey(slug);
  if (localPub === null) {
    await adapter.deleteUserSshKey(slug).catch(() => {});
    throw new Error(
      `[add:${slug}] SSH key dir exists but pubkey is unreadable; cleared, retry will regenerate`,
    );
  }
  const giteaPubKeys = await adapter.gitHost.listKeys(slug);
  const registered = giteaPubKeys.some((candidate) => pubKeysMatch(candidate, localPub));
  if (!reclaimExistingSshKey && registered) return [];

  const giteaState = giteaPubKeys.length === 0 ? "absent" : "mismatch";
  let reason = `SSH key drift (giteaPub=${giteaState})`;
  if (reclaimExistingSshKey && registered) reason = "ownership reclaim";
  adapter.log(`[add:${slug}] resync triggered: ${reason}`);
  await adapter.gitHost.registerKey(slug, localPub);
  const recheck = await adapter.gitHost.listKeys(slug);
  if (!recheck.some((candidate) => pubKeysMatch(candidate, localPub))) {
    throw new Error(`[add:${slug}] SSH key resync did not persist in Gitea`);
  }
  return ["ssh-key-resync"];
}

async function ensureWorkspaceRepo(
  adapter: UserLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: UserContext,
): Promise<AddUserStep[]> {
  await adapter.gitHost.ensureOwner(snapshot.slug);
  // A user born onto a shared pod never runs the non-shared pre-boot
  // restore, which is the only other thing that creates this repo. Without it
  // the migration flush reads a head that does not exist and the move retries
  // forever (#3196).
  await adapter.gitHost.ensureRepo(snapshot.slug, { kind: "system-config" });
  return convergeWorkspaceCheckout(adapter, uid, snapshot, ctx);
}

async function convergeWorkspaceCheckout(
  adapter: UserLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: UserContext,
  path: ProvisioningPath = "gateway",
): Promise<AddUserStep[]> {
  const { slug } = snapshot;
  if (adapter.hasWorkspaceGitDir(slug)) {
    if (adapter.hasGitRemote(slug)) return [];
    if (snapshot.repoUrl) {
      adapter.log(`[add:${slug}] workspace Git metadata is incomplete; repairing from canonical Gitea`);
      return cloneExistingWorkspaceRepo(adapter, snapshot, ctx);
    }
    return recoverMissingWorkspaceRemote(adapter, uid, ctx, path);
  }
  if (snapshot.repoUrl) {
    return cloneExistingWorkspaceRepo(adapter, snapshot, ctx);
  }
  return initNewWorkspaceRepo(adapter, uid, ctx, path);
}

async function recoverMissingWorkspaceRemote(
  adapter: UserLifecycleAdapter,
  uid: string,
  ctx: UserContext,
  path: ProvisioningPath,
): Promise<AddUserStep[]> {
  const repoUrl = await adapter.initWorkspaceRepoFromExistingDir(ctx, path);
  if (!repoUrl) {
    throw new Error(`[add:${ctx.slug}] recovery workspace repo creation failed`);
  }
  await adapter.setRepoUrl(uid, repoUrl);
  adapter.ensureUserDirectories(ctx.slug);
  adapter.log(`[add:${ctx.slug}] workspace remote recovered + Firestore updated (${repoUrl})`);
  return ["init-workspace-repo"];
}

async function cloneExistingWorkspaceRepo(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
  ctx: UserContext,
): Promise<AddUserStep[]> {
  const { slug, repoUrl } = snapshot;
  if (adapter.hasUserDir(slug) && !adapter.hasWorkspaceGitDir(slug)) {
    adapter.log(`[add:${slug}] removing partial workspace before clone; projects stay`);
    await adapter.removePartialWorkspace(slug);
  }
  const cloned = await adapter.cloneWorkspaceRepo(slug, repoUrl);
  if (!cloned) {
    throw new Error(`[add:${slug}] workspace clone from ${repoUrl} failed`);
  }
  adapter.ensureUserDirectories(slug);
  await adapter.writeUserTemplateFiles(ctx);
  adapter.log(
    `[add:${slug}] workspace cloned from Gitea; template files ensured`,
  );
  return ["clone-workspace-repo", "write-templates"];
}

async function initNewWorkspaceRepo(
  adapter: UserLifecycleAdapter,
  uid: string,
  ctx: UserContext,
  path: ProvisioningPath,
): Promise<AddUserStep[]> {
  adapter.ensureUserDirectories(ctx.slug);
  await adapter.writeUserTemplateFiles(ctx);
  const repoUrl = await adapter.initWorkspaceRepoFromExistingDir(ctx, path);
  if (!repoUrl) {
    throw new Error(`[add:${ctx.slug}] initial workspace repo creation failed`);
  }
  await adapter.setRepoUrl(uid, repoUrl);
  adapter.log(`[add:${ctx.slug}] workspace repo initialized + pushed (${repoUrl})`);
  return ["write-templates", "init-workspace-repo"];
}

async function runBlobSync(
  adapter: UserLifecycleAdapter,
  slug: string,
): Promise<AddUserStep[]> {
  try {
    await adapter.blobSyncForSlug(slug);
    return ["blob-sync"];
  } catch (err) {
    adapter.log(`[add:${slug}] ⚠ blob sync failed (non-fatal): ${String(err)}`);
    return [];
  }
}

async function restoreByos(
  adapter: UserLifecycleAdapter,
  slug: string,
): Promise<{ restored: boolean; present: boolean; steps: AddUserStep[] }> {
  const result = await adapter.restoreByosubForAgent(slug);
  if (!result.restored) {
    return { ...result, steps: [] };
  }
  adapter.log(`[add:${slug}] BYOS oauth activated from user integration broker`);
  return { ...result, steps: ["byosub-restore"] };
}

// The byot userData that syncByotForUser (via deriveDesiredByotState) needs to make a
// NON-destructive decision. deriveDesiredByotState gates BYOT derivation on
// provisioning.openclaw.status === "complete"; below that it returns input=null, and on a
// shared GW a null state runs applyByotState(slug, null), which REMOVES a non-anthropic
// user's models.json. reassertByot is called ONLY after applyConfigPatchAndMount has
// registered + mounted the agent, so the runtime IS complete here — but the in-memory
// snapshot.status is the PRE-mount Firestore value, still "" / "provisioning" on a
// first-time provision (loadAndPrepareForMount never advances it). Forwarding that stale
// status would derive input=null and skip writing a first-time BYOK user's model files
// (and clear them on a retry that already has managed files). So pin status to "complete":
// it reflects the just-mounted runtime, not the stale doc. byotActive + systemConfig.byot
// drive the provider; planInputs drive the house model pin.
function byotUserDataFromSnapshot(snapshot: UserSnapshot): ReassertUserData {
  return {
    username: snapshot.slug,
    timeZone: snapshot.timeZone ?? null,
    byotActive: snapshot.byotActive,
    systemConfig: snapshot.systemConfig,
    planInputs: snapshot.planInputs,
    freeTierModelRef: snapshot.freeTierModelRef,
    builderAgentDefault: snapshot.builderAgentDefault,
    provisioning: { openclaw: { status: "complete" } },
  };
}

// Re-assert the user's broker-routed model auth into the openclaw config. The
// Anthropic provider key on a shared GW is a broker token set via config.patch, not a
// file — so a fresh emptyDir pod (roll / Spot preemption) loses it and boot-sync's
// restoreByos (BYOS oauth) alone does not restore it. Runs here so it's re-applied on
// every provision AND re-mount. Idempotent; non-fatal so a transient broker hiccup
// doesn't strand the whole mount — the change-trigger and next re-mount re-run it.
async function refreshSnapshotForReassert(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
): Promise<UserSnapshot> {
  try {
    return (await adapter.loadUserSnapshot(snapshot.uid)) ?? snapshot;
  } catch (err) {
    adapter.log(
      `[add:${snapshot.slug}] ⚠ refresh before byot re-assert failed; using mount snapshot: ${String(err)}`,
    );
    return snapshot;
  }
}

// Re-asserts BYOT model auth and the platform-converged context files
// (AGENTS.md/TOOLS.md for house_only plans) off ONE fresh snapshot fetch —
// both are idempotent/non-fatal convergence steps that must run on every
// provision AND re-mount, but they are independent failure domains: one
// failing must never skip the other, and neither should cost a user a
// second Firestore read.
async function reassertConvergedState(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
): Promise<AddUserStep[]> {
  const refreshed = await refreshSnapshotForReassert(adapter, snapshot);
  const userData = byotUserDataFromSnapshot(refreshed);
  const steps: AddUserStep[] = [];

  try {
    await adapter.reassertByotForUser(userData);
    steps.push("byot-reassert");
  } catch (err) {
    adapter.log(
      `[add:${snapshot.slug}] ⚠ byot re-assert failed (non-fatal; retry on next sync/re-mount): ${String(err)}`,
    );
  }

  try {
    await adapter.reassertConvergedContextFilesForUser(userData);
    steps.push("context-files-reassert");
  } catch (err) {
    adapter.log(
      `[add:${snapshot.slug}] ⚠ context-file re-assert failed (non-fatal; retry on next sync/re-mount): ${String(err)}`,
    );
  }

  return steps;
}

type ProjectCheckoutAdapter = Pick<UserLifecycleAdapter,
  "listProjectsNeedingClone" | "cloneProjectRepo" | "seedDeferredProjectWorkspace" |
  "isIsolatedGateway" | "isConfiguredUser" | "log">;

function githubCheckoutsHydrateHere(adapter: ProjectCheckoutAdapter, slug: string): boolean {
  if (!adapter.isIsolatedGateway || !adapter.isConfiguredUser) return true;
  return adapter.isIsolatedGateway() && adapter.isConfiguredUser(slug);
}

export interface CloneMissingProjectsOptions {
  githubCheckouts?: "hydrate-here" | "defer";
  signal?: AbortSignal;
}

export async function cloneMissingProjects(
  adapter: ProjectCheckoutAdapter,
  slug: string,
  options: CloneMissingProjectsOptions = {},
): Promise<{ steps: AddUserStep[]; pending: string[]; deferred: string[] }> {
  throwIfAborted(options.signal, slug);
  const toClone = await adapter.listProjectsNeedingClone(slug);
  throwIfAborted(options.signal, slug);
  const steps: AddUserStep[] = [];
  const deferred = new Set<string>();
  const ownerRuntime = options.githubCheckouts !== "defer" && githubCheckoutsHydrateHere(adapter, slug);
  for (const p of toClone) {
    throwIfAborted(options.signal, slug);
    if (!hasProjectCloneSource(p)) {
      adapter.log(
        `[add:${slug}/${p.projectSlug}] ✖ project checkout skipped — no Gitea repo and no GitHub repoSource`,
      );
      continue;
    }
    if (githubRepoSourceOf(p) && !ownerRuntime) {
      deferred.add(p.projectSlug);
      await adapter.seedDeferredProjectWorkspace?.(slug, p.projectSlug);
      throwIfAborted(options.signal, slug);
      adapter.log(
        options.githubCheckouts === "defer"
          ? `[add:${slug}/${p.projectSlug}] GitHub checkout deferred until the user is assigned here — the reconcile clones it after cutover`
          : `[add:${slug}/${p.projectSlug}] GitHub checkout deferred — it hydrates on ${slug}'s own isolated runtime`,
      );
      continue;
    }
    try {
      const ok = await adapter.cloneProjectRepo(
        slug,
        p.projectSlug,
        p.giteaRepoName,
        projectCloneOptions(p, options.signal),
      );
      throwIfAborted(options.signal, slug);
      if (ok) {
        steps.push("project-clone");
        adapter.log(`[add:${slug}/${p.projectSlug}] cloned from ${projectCloneSourceLabel(p)}`);
      }
    } catch (err) {
      throwIfAborted(options.signal, slug);
      adapter.log(`[add:${slug}/${p.projectSlug}] ✖ project clone failed: ${String(err)}`);
    }
  }

  // On-disk truth, not cloneProjectRepo's boolean: it returns false for several non-error
  // reasons (repo absent upstream, no SSH key), so only a re-probe can say whether the
  // checkout actually landed.
  const remaining = await adapter.listProjectsNeedingClone(slug);
  throwIfAborted(options.signal, slug);
  const pending = remaining
    .map((p) => p.projectSlug)
    .filter((projectSlug) => !deferred.has(projectSlug))
    .sort();
  if (pending.length > 0) {
    adapter.log(
      `[add:${slug}] ✖ project checkout still absent after converge: ${pending.join(", ")} — the pending-checkout retry lane re-runs the clone`,
    );
  }
  return { steps, pending, deferred: [...deferred].sort() };
}

async function provisionMattermostIfMissing(
  adapter: UserLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: UserContext,
): Promise<{ mmUpdate: MmUpdate | null; steps: AddUserStep[] }> {
  if (snapshot.mattermostUserId) {
    return { mmUpdate: null, steps: [] };
  }
  const mmUpdate = await adapter.provisionMattermostUser(ctx);
  await adapter.setMattermostFields(uid, mmUpdate);
  return { mmUpdate, steps: ["mattermost-provision"] };
}

async function applyConfigPatchAndMount(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  options: {
    byosActive: boolean;
    signal?: AbortSignal;
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
    withoutProjectIds?: readonly string[];
    brokerProfilesReady?: Promise<void>;
    runtimePublication?: AddUserOptions["runtimePublication"];
    beforeRuntimePublish?: () => Promise<void>;
    migrationId?: string;
  },
): Promise<string | undefined> {
  const patchResult = await adapter.applyAddUserConfigPatch(snapshot, mmUpdate, {
    signal: options.signal,
    ...(options.beforeRuntimePublish ? { beforeRuntimePublish: options.beforeRuntimePublish } : {}),
    ...(options.migrationId ? { migrationId: options.migrationId } : {}),
    byosActive: options.byosActive,
    evictionBatch: options.evictionBatch,
    currentEvictionBatch: options.currentEvictionBatch,
    withoutProjectIds: options.withoutProjectIds,
    ...(options.brokerProfilesReady ? { brokerProfilesReady: options.brokerProfilesReady } : {}),
    ...(options.runtimePublication ? { runtimePublication: options.runtimePublication } : {}),
  });
  adapter.log(`[add:${snapshot.slug}] config patch in ${patchResult.elapsedMs}ms`);
  if (adapter.onMounted) adapter.onMounted(snapshot.slug);
  return patchResult.appliedFingerprint;
}

async function verifyChannelReady(
  adapter: UserLifecycleAdapter,
  slug: string,
  verifyTimeoutMs: number,
): Promise<void> {
  adapter.log(
    `[add:${slug}] verify: waiting for agent MM account to report running+connected (timeoutMs=${verifyTimeoutMs})`,
  );
  const startedAt = Date.now();
  const healthy = await adapter.waitForAccountHealthy({ slug, timeoutMs: verifyTimeoutMs });
  const elapsed = Date.now() - startedAt;
  if (!healthy) {
    throw new Error(
      `[add:${slug}] channel didn't reach running+connected within ${verifyTimeoutMs}ms (waited ${elapsed}ms) — failing the mount; fleet will retry`,
    );
  }
  adapter.log(`[add:${slug}] ✅ verify: channel ready (running+connected) in ${elapsed}ms`);
  await adapter.materializeBrokerProfiles?.(slug);
}

async function markCompleteIfNeeded(
  adapter: UserLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  newUser: boolean,
  mmUpdate: MmUpdate | null,
): Promise<AddUserStep[]> {
  if (!newUser && snapshot.agentIds.length > 0) return [];
  if (newUser) {
    const defaultAgentChannels = snapshot.channels.filter((channel) => channel.scope === "workspace" && channel.kind === "coach-dm");
    const existingDefaultAgentChannelId = defaultAgentChannels.length === 1 ? defaultAgentChannels[0].channelId : null;
    const coachChannelId = mmUpdate ? mmUpdate["mattermost.channelId"] : existingDefaultAgentChannelId;
    if (typeof coachChannelId !== "string" || !coachChannelId) {
      throw new Error(`Initial agent monitoring for ${snapshot.slug} has no private agent channel`);
    }
    await adapter.provisionDefaultAgentAutomation({ slug: snapshot.slug, coachChannelId });
  }
  const userDefaultAgentId = `octogee-${snapshot.slug}-coach`;
  await adapter.ensureAgentIds(uid, [userDefaultAgentId]);
  await adapter.setProvisioningStatus(uid, "complete");
  return ["mark-complete"];
}

async function reportProvisioned(
  adapter: UserLifecycleAdapter,
  ctx: UserContext,
  first: boolean,
): Promise<AddUserStep[]> {
  try {
    await adapter.reportProvisioned(ctx, { first });
    return ["report-provisioned"];
  } catch (err) {
    adapter.log(
      `[add:${ctx.slug}] ✖ provisioned report failed for a ${first ? "first provisioning, and a first report is not sent again" : "re-mount"}: ${String(err)}`,
      { status: "failed" },
    );
    return [];
  }
}

function retainConfiguredUserOverlay(
  adapter: UserLifecycleAdapter,
  slug: string,
  steps: RemoveUserStep[],
): RemoveUserResult {
  if (!adapter.configuredUserOverlayPresent?.(slug)) {
    throw new Error(`[remove:${slug}] configured user system-config overlay is unavailable`);
  }
  adapter.clearMountMarker?.(slug);
  adapter.clearUserMigratingIn?.(slug);
  adapter.onUnmounted?.(slug);
  adapter.log(`[remove:${slug}] retained configured user system-config overlay`);
  return { wasMounted: true, steps, retained: true };
}

async function evictionWasCancelled(
  slug: string,
  remaining: readonly string[] | undefined | void,
  currentEvictionBatch: (() => Promise<readonly string[]>) | undefined,
): Promise<boolean> {
  if (remaining && !remaining.includes(slug)) return true;
  return currentEvictionBatch !== undefined && !(await currentEvictionBatch()).includes(slug);
}

export async function removeUserFromGateway(
  adapter: UserLifecycleAdapter,
  uid: string,
  opts: {
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
  } = {},
): Promise<RemoveUserResult> {
  return withLogContext({}, async () => {
    const steps: RemoveUserStep[] = [];
    const snapshot = await adapter.loadUserSnapshot(uid);
    if (!snapshot) {
      throw new Error(`[remove:${uid}] user doc not found in Firestore`);
    }
    const { slug } = snapshot;
    setLogContext({ builderSlug: slug, category: "lifecycle" });
    const wasMounted =
      adapter.hasUserDir(slug) || snapshot.status === "complete";
    if (!wasMounted) {
      adapter.log(`[remove:${slug}] nothing to do (no dir, status=${snapshot.status})`);
      return { wasMounted: false, steps };
    }

    if (adapter.isIsolatedGateway?.() && adapter.isConfiguredUser?.(slug)) {
      return retainConfiguredUserOverlay(adapter, slug, steps);
    }

    const remaining = await adapter.applyRemoveUserConfigPatch(
      slug,
      `octogee-${slug}-coach`,
      opts.evictionBatch,
      opts.currentEvictionBatch,
    );
    steps.push("config-patch-remove");
    adapter.log(`[remove:${slug}] removed from openclaw config`);

    if (await evictionWasCancelled(slug, remaining, opts.currentEvictionBatch)) {
      adapter.cancelPendingEviction?.(slug);
      return { wasMounted: true, steps, retained: true };
    }

    await adapter.deleteDepartedUserState(slug);
    steps.push("delete-dir");
    adapter.log(`[remove:${slug}] user state deleted`);

    if (await releaseUnmountedGiteaKey(adapter, snapshot)) steps.push("release-gitea-key");

    if (adapter.onUnmounted) adapter.onUnmounted(slug);
    return { wasMounted: true, steps };
  });
}

async function releaseUnmountedGiteaKey(
  adapter: UserLifecycleAdapter,
  snapshot: UserSnapshot,
): Promise<boolean> {
  const { slug } = snapshot;
  const pubKey = adapter.readLocalUserPubKey(slug);
  if (pubKey === null) return false;
  const service = snapshot.provisionedBy === "service" ? adapter.provisioningService : undefined;
  try {
    if (service?.holdsServiceGitKey(slug)) await service.releaseGitKey(snapshot.uid);
    else await adapter.gitHost.releaseKey(slug, pubKey);
  } catch (err) {
    adapter.log(
      `⚠ [remove:${slug}] Gitea key release failed; local keypair kept for the preStop release: ${String(err)}`,
    );
    return false;
  }
  await adapter.deleteUserSshKey(slug);
  adapter.log(`[remove:${slug}] Gitea key released and local keypair removed`);
  return true;
}

export function pubKeysMatch(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const parts = s.trim().split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : s.trim();
  };
  return norm(a) === norm(b);
}

function buildUserContext(snapshot: UserSnapshot, usersDir: string): UserContext {
  const today = new Date().toISOString().slice(0, 10);
  const username = snapshot.slug;
  return {
    uid: snapshot.uid,
    slug: snapshot.slug,
    contextTemplateKey: snapshot.contextTemplateKey,
    ownerName: snapshot.ownerName,
    customerDir: `${usersDir}/${snapshot.slug}`,
    today,
    username,
    templateVars: {
      ...personaTemplateVars(snapshot.persona),
      uid: snapshot.uid,
      ownerName: snapshot.ownerName,
      username,
      createdAt: today,
      slug: snapshot.slug,
      timeZone: snapshot.timeZone ?? UNKNOWN_TIME_ZONE,
    },
    userData: {},
  };
}

function personaTemplateVars(persona: UserSnapshot["persona"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(persona ?? {}).flatMap(([key, value]) =>
      typeof value === "string" ? [[`persona.${key}`, value]] : []),
  );
}
