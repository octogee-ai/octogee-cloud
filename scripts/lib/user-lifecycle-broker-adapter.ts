import { initializeRelocatedProjectAgent, projectAgentWorkspace, restoreProjectAgentWorkspaces } from "@octogee/core/project-agent-workspaces";
import { enableSystemConfigWatch } from "./system-config-watch-state.js";
import { readAcceptedUserConfig } from "./system-config.js";
import { parseAgentId, projectAgentId } from "@octogee/shared/types/identity";
import { cloneMissingProjects, prepareUserRuntimePublication } from "./user-lifecycle.js";
import { prepareSharedUserAgentAnchors } from "./agent-anchor-record.js";
import { readProjectRestoreReady } from "@octogee/core/project-asset-state";
import { prepareUserProjectAssets } from "./user-project-assets.js";
import { createBrokeredProjectBlobHydrator } from "./project-blob-materialization.js";
import { sharedMigrationAgentIds, sharedMigrationExportPaths } from "./source-transfer-plan.js";
import { migrateUserScheduler, setUserChannelsRunning } from "./user-channel-quiesce.js";
import { quiesceUserSessionsBounded, sessionStoreForPath } from "./user-session-quiesce.js";
import { userFileStatePaths, removeDepartedUserFileState } from "./user-file-state.js";
import { openClawRuntimeUpdateGuard } from "./openclaw-runtime-update-guard.js";
import {
  userOwnerCommandsPatch,
  configuredUserManagedProjectIds,
  configuredUserProjectAgentPatch,
  configuredUserWorkspacePatch,
  validOwnerMmUserId,
} from "./configured-user-project-agents.js";
import { projectAgentsRuntimeReady, reportProjectAgentReadiness } from "./project-agent-readiness.js";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerProjectRestore,
  FleetBrokerAssignmentRosterEntry,
  FleetBrokerUserSnapshot,
} from "../../shared/types/fleet-broker.js";
import {
  DEFAULT_USER_AGENT_MODEL_REF,
  DEFAULT_HOUSE_MODEL_REF,
  parseUserAgentModelDefault,
  type UserAgentModelDefault,
} from "../../shared/types/platform-config.js";
import {
  USER_IMPORT_STARTUP_TIMEOUT_MS,
  CONFIG_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
} from "../../shared/types/fleet-controller.js";
import {
  MIGRATION_QUIESCE_GRACE_MS,
  MIGRATION_QUIESCE_STOP_RECHECK_MS,
} from "../../shared/types/workspace-migration.js";
import { agentIdBelongsToSlug, catalogEntryForModelRef } from "../../shared/types/agent-models.js";
import { projectCheckoutEnabled, projectRepoSourceFromDoc } from "../../shared/types/project.js";
import { mattermostAccountEndpointsForTarget } from "../../shared/types/openclaw-mattermost-accounts.js";
import {
  applyConfigPatch,
  userAgentRosterPatch,
  userConfigAgentRosterReplacePaths,
  userConfigReplacePaths,
  mergeUserBindings,
  orderIsolatedGatewayRoster,
  preserveMountedAgentModels,
  replaceUserAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
  type ConfigCache,
} from "./apply-config-patch.js";
import {
  userAgentIdsInRoster,
  deleteRosterAgents,
} from "./agent-roster-deletion.js";
import {
  createRosterAgents,
  rosterAgentSpecsFromEntries,
} from "./agent-roster-creation.js";
import {
  type UserContext,
  type UserLifecycleAdapter,
  type UserStateImportMode,
  type MmUpdate,
  type ProjectCloneOptions,
  type ProjectCloneTarget,
  type RemoveUserResult,
  type UserSnapshot,
} from "./user-lifecycle.js";

import {
  dlog,
  logLevel,
  AGENTS_DIR,
  CUSTOMER_KEYS_DIR,
  CUSTOMERS_DIR,
  OPENCLAW_CONFIG,
  OPENCLAW_DIR,
  readOpenClawConfig,
} from "./config.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";
import {
  userDefaultAgentId,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";
import { OpenclawWireError, provisionDefaultAgentAutomation, type ConfigGetResult, type GatewayRpcClient } from "./gateway-rpc.js";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import {
  cloneProjectRepo,
  cloneWorkspaceRepo,
  userRepositoryHasCanonicalRemote,
  userSshKeyPath,
  deleteUserSshKey,
  generateUserSshKey,
  initWorkspaceRepo,
  projectCheckoutMatchesSource,
  readLocalUserPubKey,
  removePartialWorkspace,
  setRepoSshCommand,
} from "./git.js";
import { brokeredGitHost } from "./gitea-admin-broker-client.js";
import {
  hasMountedMarker,
  clearMountedMarker,
  clearMigratingInPin,
  assertConfiguredUserPortableStatePlanOnDisk,
  configuredUserPortableStatePlan,
  isMigratingInPinned,
  userDefaultAgentWiredInOpenclawConfig,
  listLocalDefaultAgentWiredSlugs,
  listLocalUserDirs,
  listMigratingInSlugs,
  writeMigratingInPin,
  writeMountedMarker,
} from "./local-default-agent-wired.js";
import {
  SAFE_DEFAULT_AGENT_ID,
  activeAgentProjectIds,
  buildSafeDefaultAgent,
  buildUserAgent,
  buildUserBindings,
  buildMattermostAccounts,
  buildProjectAgentAccounts,
  buildProjectAgents,
  gatewayAgentRoster,
  isSafeDefaultAgentPortableStatePath,
  mattermostAccountBindingsNeedingActivation,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
  rebindPlatformEmbeddingRefs,
  resolveDefaultAgentIdentity,
} from "./openclaw-config-users.js";
import { runOpenClaw, type OpenClawCommandResult } from "./openclaw-cli.js";
import { createSurgeOpenClawProcessSupervisorClient, type SurgeOpenClawProcessGateState } from "./surge-openclaw-process-gate.js";
import { uninitializedUserState } from "./uninitialized-user-state.js";
import {
  PLATFORM_MODEL_POLICY_ALLOW_PATH,
  userMountConfigPatch,
  userSecurityProjectionReplacePaths,
  platformModelAllowlistPatch,
  refreshModelCredentialRuntimeSessions,
  restoreModelCredentialOauthStoreForSlug,
  syncModelCredentialsForUser,
} from "./model-credential-sync-runtime.js";
import { MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS } from "./model-credential-materializer.js";
import {
  byosDefaultAgentConfigPatch,
  convergedDefaultAgentToolsValue,
  isPlatformProviderRef,
  platformDefaultAgentModelInputForUser,
  platformProjectAgentModelForUser,
} from "./byot-sync.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  vertexCatalogInputForBaseUrl,
  metaCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
} from "./agent-model-token-materializer.js";
import { blobSyncForSlug } from "./blob-sync.js";
import { createBrokeredBlobStore } from "./blob-sync-broker.js";
import {
  activationManifestAgentIds,
  applyOpenClawActivationManifest,
  MIGRATION_ACTIVATION_DIR,
  readActivationManifest,
  removeActivationManifest,
  assertSourceIdentityCustody,
  restoreSourceWorkspaceIdentities,
  captureSourceWorkspaceIdentities,
  captureTargetWorkspaceIdentities,
  privateProjectWorkspaceAgentIds,
  restoreTargetWorkspaceIdentities,
  assertTargetIdentityCustody,
  writeActivationManifest,
  type MigrationTargetIdentityCustody,
  type TargetWorkspaceIdentities,
  type MigrationActivationManifest,
  type MigrationSourceIdentityCustody,
} from "./migration-activation-manifest.js";
import { assertNotHeld, type HeldPathOptions, matchUnder, PROC_ROOT } from "./held-files.js";
import {
  exportActivationManifestWithSecret,
  materializeActivationManifestSecret,
} from "./migration-activation-secrets.js";
import {
  configSecretMaterialChangeReasons,
  createSecretMaterialLedger,
  type SecretMaterialLedger,
} from "./secret-material-change.js";
import { isConfiguredGatewayUser } from "./system-config-watch-state.js";
import { userAgentRuntimePresent } from "./user-agent-runtime.js";
import { writeTierTemplateFiles } from "./tier-template-files.js";
import { reassertConvergedContextFilesForSlug } from "./context-file-convergence.js";
import {
  mattermostProjectAccountSecretChange,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import { quarantineMalformedDefaultAgentMattermostAccount } from "./mattermost-default-agent-quarantine.js";
import {
  activateMattermostRoutingAfterConfigPatch,
  activatePendingMattermostRouting,
  captureMattermostRoutingActivationBaseline,
  discardMattermostRoutingActivationForUsers,
  markMattermostRoutingActivationPending,
  mattermostRoutingActivationPending,
  stopStaleMattermostRoutingAccounts,
} from "./mattermost-routing-activation.js";
import { snapshotConfigFingerprint } from "./snapshot-fingerprint.js";
import { loadAppliedFingerprints } from "./applied-fingerprint-store.js";
import { userClaimOverlaySlug, userClaimSlug } from "@octogee/shared/server/user-claim";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE: FleetBrokerProjectCheckoutScope = "workspace-only";

const DEFAULT_AGENT = {
  name: "Octo",
  emoji: "",
  model: DEFAULT_USER_AGENT_MODEL_REF,
};

type AddUserConfigPatchOptions = Parameters<
  UserLifecycleAdapter["applyAddUserConfigPatch"]
>[2];

function evictionSlugsExcept(
  mountedSlug: string,
  batch: readonly string[] | undefined,
): string[] {
  return [...new Set(batch ?? [])].filter((slug) => slug !== mountedSlug);
}

async function stillEvictedSlugs(
  mountedSlug: string,
  admitted: readonly string[],
  readCurrent: (() => Promise<readonly string[]>) | undefined,
): Promise<string[]> {
  const batch = readCurrent ? (await readCurrent()).filter((slug) => admitted.includes(slug)) : admitted;
  return evictionSlugsExcept(mountedSlug, batch);
}

function brokerProjectAgents(
  brokerSnapshot: FleetBrokerUserSnapshot,
  withoutProjectIds?: readonly string[],
): NonNullable<UserSnapshot["projectAgents"]> {
  const agents = brokerSnapshot.projectAgents ?? [];
  if (!withoutProjectIds?.length) return agents;
  const excluded = new Set(withoutProjectIds);
  return agents.filter((p) => !excluded.has(p.projectId));
}

function brokerUserMattermostUserId(
  brokerSnapshot: FleetBrokerUserSnapshot | null,
  snapshot: UserSnapshot,
): string | null | undefined {
  return brokerSnapshot ? brokerSnapshot.customerMmUserId : snapshot.mattermostUserId;
}

interface BuildBrokeredLifecycleAdapterOptions {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string, fields?: { status: "failed" }) => void;
  isIsolatedGateway?: () => boolean;
  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
  procRoot?: string;
}

interface BrokerCtx {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  isIsolatedGateway: () => boolean;
  configCache: ConfigCache;
  snapshotsByUid: Map<string, FleetBrokerUserSnapshot>;
  snapshotsBySlug: Map<string, FleetBrokerUserSnapshot>;
  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
  configRemovedForEviction: Set<string>;
  pendingRuntimeSecrets: Map<string, SecretMaterialLedger>;
  procRoot: string;
}

async function exportSourceActivationManifest(ctx: BrokerCtx, slug: string,
  options: { signal?: AbortSignal; timeoutMs?: number; convergeSource?: boolean } = {}): Promise<MigrationActivationManifest> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let waiting = false;
  while (true) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for source runtime configuration to converge for ${slug}`);
    const manifest = await openClawRuntimeUpdateGuard.run(async () => {
      if (options.convergeSource && !ctx.isIsolatedGateway()) {
        const uid = await ctx.client.uidForSlug(slug);
        const snapshot = uid ? await ctx.client.userSnapshot(uid) : null;
        if (!snapshot || snapshot.uid !== uid || snapshot.slug !== slug || snapshot.runtimeMutationFenced !== false) {
          throw new Error(`Source runtime convergence requires unfenced serving custody for ${slug}`);
        }
        const applied = loadAppliedFingerprints(path.join(OPENCLAW_DIR, "applied-fingerprints.json")).get(slug);
        if (applied !== snapshotConfigFingerprint(cacheSnapshot(ctx, snapshot))) return null;
      }
      options.signal?.throwIfAborted();
      return exportActivationManifestWithSecret(OPENCLAW_CONFIG, OPENCLAW_DIR, slug);
    }, { signal: options.signal, timeoutMs: remaining, slug });
    if (manifest) return manifest;
    if (!waiting) ctx.log(`[migration-activation:${slug}] waiting for source runtime configuration to converge`);
    waiting = true;
    await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
  }
}

// The roster and the departing agents' bindings are `agents.delete`'s job —
// 2026.7.2 rejects any config write that drops roster entries without the
// allowance only that RPC carries. What is left for the patch is the Mattermost
// accounts openclaw's agent deletion does not touch.
function buildRemoveUserAccountsPatch(
  current: unknown,
  slugs: readonly string[],
): { channels: { mattermost: { accounts: Record<string, null> } } } {
  const currentAccounts =
    (current as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } })
      ?.channels?.mattermost?.accounts ?? {};
  const accounts: Record<string, null> = {};
  for (const slug of slugs) {
    accounts[`${slug}-coach`] = null;
    for (const accountId of Object.keys(currentAccounts)) {
      if (accountId.startsWith(`${slug}-proj-`)) accounts[accountId] = null;
    }
  }
  return { channels: { mattermost: { accounts } } };
}

async function freshRosterConfig(ctx: BrokerCtx): Promise<unknown> {
  const fetched = await ctx.rpc.configGet();
  ctx.configCache.current = fetched.config;
  ctx.configCache.hash = fetched.hash;
  return fetched.config;
}

function invalidateConfigCache(ctx: BrokerCtx): void {
  ctx.configCache.current = undefined;
  ctx.configCache.hash = "";
}

function postgresAgentStoreConfigured(): boolean {
  const database = fs.existsSync(OPENCLAW_CONFIG)
    ? (readOpenClawConfig() as { database?: { engine?: string; families?: { agent?: { engine?: string } } } }).database : undefined;
  return (database?.families?.agent?.engine ?? database?.engine) === "postgres";
}

async function prepareUserSharedAnchors(ctx: BrokerCtx, input: {
  uid?: string; slug: string; agentIds: readonly string[]; allowQuiescingExisting?: boolean; migrationId?: string;
}): Promise<(() => Promise<void>) | undefined> {
  if (ctx.isIsolatedGateway() || !postgresAgentStoreConfigured()) return undefined;
  const uid = input.uid ?? await ctx.client.uidForSlug(input.slug);
  if (!uid && !input.migrationId) throw new Error(`Shared imported agent anchors require an assigned owner for ${input.slug}`);
  const surgeTarget = !input.allowQuiescingExisting && process.env.GATEWAY_ID &&
    input.migrationId?.startsWith(`surge-${process.env.GATEWAY_ID}-`);
  return prepareSharedUserAgentAnchors({ ...input, uid: uid ?? undefined, migrationId: uid && !surgeTarget ? undefined : input.migrationId, stateDir: resolveOpenClawStateDir(), broker: ctx.client });
}

async function releaseAgentsAndInvalidateCache(
  ctx: BrokerCtx,
  agentIds: readonly string[],
  logPrefix: string,
  options: { purgeStore?: boolean } = {},
): Promise<void> {
  if (agentIds.length === 0) return;
  const postgres = postgresAgentStoreConfigured();
  const failures: unknown[] = [];
  try {
    for (const agentId of agentIds) {
      try {
        const file = path.join(resolveOpenClawStateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
        await deleteRosterAgents([agentId], {
          rpc: ctx.rpc, log: ctx.log, logPrefix,
          preserveStore: !options.purgeStore && (postgres || readPostgresAgentAnchor(file) !== null),
        });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("; "));
  } finally {
    // Each delete rewrites the roster and prunes bindings, so any cached
    // snapshot — and its base hash — is stale the moment the first one lands.
    invalidateConfigCache(ctx);
  }
}

function agentStateRelease(ctx: BrokerCtx, logPrefix: string): AgentStateRelease {
  return {
    releaseAgents: (agentIds) => releaseAgentsAndInvalidateCache(ctx, agentIds, logPrefix),
    procRoot: ctx.procRoot,
  };
}

async function deleteDepartingUserAgents(
  ctx: BrokerCtx,
  slugs: readonly string[],
  logPrefix: string,
): Promise<void> {
  if (slugs.length === 0) return;
  const current = await freshRosterConfig(ctx);
  await releaseAgentsAndInvalidateCache(
    ctx,
    slugs.flatMap((slug) => userAgentIdsInRoster(current, slug)),
    logPrefix,
  );
}

async function deleteSupersededUserAgents(
  ctx: BrokerCtx,
  input: {
    slug: string;
    evictionSlugs: readonly string[];
    keepAgentIds: readonly string[];
    logPrefix: string;
    purpose: "reconcile" | "import";
  },
): Promise<void> {
  const current = await freshRosterConfig(ctx);
  const keep = new Set(input.keepAgentIds);
  await releaseAgentsAndInvalidateCache(
    ctx,
    input.evictionSlugs.flatMap((slug) => userAgentIdsInRoster(current, slug)),
    input.logPrefix,
  );
  await releaseAgentsAndInvalidateCache(
    ctx,
    userAgentIdsInRoster(current, input.slug).filter((agentId) => !keep.has(agentId)),
    input.logPrefix,
    { purgeStore: input.purpose === "reconcile" },
  );
}

async function ensureUserRosterAgents(
  ctx: BrokerCtx,
  agentEntries: readonly unknown[],
  logPrefix: string,
  opts: { signal?: AbortSignal; waitForAppliedRevision?: boolean } = {},
): Promise<void> {
  const specs = rosterAgentSpecsFromEntries(agentEntries);
  if (specs.length === 0) return;
  await Promise.all(specs.map((spec) => fsp.mkdir(spec.workspace, { recursive: true })));
  try {
    for (const spec of specs) {
      throwIfConfigApplicationWaitAborted(opts.signal);
      const [created] = await createRosterAgents([spec], { rpc: ctx.rpc, log: ctx.log, logPrefix });
      if (created.status === "created" && opts.waitForAppliedRevision !== false) {
        await waitForAppliedConfigRevision(ctx.rpc, spec.agentId, {
          timeoutMs: 60_000,
          logPrefix,
          signal: opts.signal,
          acceptSupersedingRevision: true,
        });
      }
    }
  } finally {
    invalidateConfigCache(ctx);
  }
}

async function reconcileUserRosterAgents(
  ctx: BrokerCtx,
  slug: string,
  evictionSlugs: readonly string[],
  keepAgentIds: readonly string[],
  agentEntries: readonly unknown[],
): Promise<void> {
  const logPrefix = `[add:${slug}]`;
  await deleteSupersededUserAgents(ctx, {
    slug,
    evictionSlugs,
    keepAgentIds,
    logPrefix,
    purpose: "reconcile",
  });
  await ensureUserRosterAgents(ctx, agentEntries, logPrefix);
}

function cacheSnapshot(ctx: BrokerCtx, snapshot: FleetBrokerUserSnapshot): FleetBrokerUserSnapshot {
  const runtimeScope = ctx.projectCheckoutScope?.(snapshot.slug)
    ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
  const projectCheckoutScope =
    runtimeScope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE ||
      snapshot.projectCheckoutScope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE
      ? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE
      : snapshot.projectCheckoutScope
        ?? runtimeScope
        ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
  const projected = {
    ...snapshot,
    projectCheckoutScope,
    projects: projectCheckoutScope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE ? [] : snapshot.projects,
  };
  ctx.snapshotsByUid.set(projected.uid, projected);
  ctx.snapshotsBySlug.set(projected.slug, projected);
  return projected;
}

function invalidateSnapshot(ctx: BrokerCtx, uid: string): void {
  const cached = ctx.snapshotsByUid.get(uid);
  if (cached) ctx.snapshotsBySlug.delete(cached.slug);
  ctx.snapshotsByUid.delete(uid);
}

async function snapshotForUid(ctx: BrokerCtx, uid: string): Promise<FleetBrokerUserSnapshot | null> {
  const cached = ctx.snapshotsByUid.get(uid);
  if (cached) return cached;
  const snapshot = await ctx.client.userSnapshot(uid);
  return snapshot ? cacheSnapshot(ctx, snapshot) : null;
}

async function snapshotForUidWithProjectMembershipIsolation(
  ctx: BrokerCtx,
  uid: string,
): Promise<FleetBrokerUserSnapshot | null> {
  const snapshot = await snapshotForUid(ctx, uid);
  await ctx.client.reconcileProjectAgentMembership(uid);
  return snapshot;
}

async function snapshotForSlug(ctx: BrokerCtx, slug: string): Promise<FleetBrokerUserSnapshot | null> {
  const cached = ctx.snapshotsBySlug.get(slug);
  if (cached) return cached;
  const uid = await ctx.client.uidForSlug(slug);
  return uid ? snapshotForUid(ctx, uid) : null;
}

function toUserSnapshot(snapshot: FleetBrokerUserSnapshot): UserSnapshot {
  return {
    uid: snapshot.uid,
    slug: snapshot.slug,
    contextTemplateKey: snapshot.contextTemplateKey,
    planInputs: snapshot.planInputs,
    gatewayId: snapshot.gatewayId,
    status: snapshot.status,
    agentIds: snapshot.agentIds,
    restoreAuthority: snapshot.restoreAuthority,
    repoUrl: snapshot.repoUrl,
    mattermostUserId: snapshot.mattermostUserId,
    channels: snapshot.channels,
    ownerName: snapshot.ownerName,
    persona: snapshot.persona,
    timeZone: snapshot.timeZone ?? null,
    projectCheckoutScope: snapshot.projectCheckoutScope,
    projects: snapshot.projects,
    projectAgents: snapshot.projectAgents,
    byotActive: snapshot.byotActive,
    freeTierModelRef: snapshot.freeTierModelRef,
    builderAgentDefault: snapshot.builderAgentDefault,
    systemConfig: snapshot.systemConfig,
  };
}

function ensureUserDirectories(slug: string): void {
  const dir = path.join(CUSTOMERS_DIR, slug);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".system"), { recursive: true });
}

async function writeUserTemplateFiles(ctx: UserContext): Promise<void> {
  fs.mkdirSync(path.join(ctx.customerDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, ".system"), { recursive: true });
  writeTierTemplateFiles(ctx.customerDir, ctx.contextTemplateKey, ctx.templateVars);
}

async function listProjectsNeedingClone(
  ctx: BrokerCtx,
  slug: string,
): Promise<ProjectCloneTarget[]> {
  const snapshot = await snapshotForSlug(ctx, slug);
  if (!snapshot) return [];
  return projectsNeedingClone(ctx, slug, snapshot.projects);
}

async function projectsNeedingClone(ctx: BrokerCtx, slug: string, projects: readonly FleetBrokerProjectRestore[]): Promise<ProjectCloneTarget[]> {
  return (await Promise.all(projects.map(async (p) => {
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return [];
    if (!projectCheckoutEnabled(p.checkoutEnabled)) {
      ctx.log(`[add:${slug}/${p.projectSlug}] project checkout is turned off by its owner`);
      return [];
    }
    const repoSource = projectRepoSourceFromDoc(p.repoSource);
    const target = {
      projectSlug: p.projectSlug,
      giteaRepoName: p.giteaRepoName,
      ...(repoSource ? { repoSource } : {}),
    };
    if (!repoSource && !p.giteaRepoName) {
      ctx.log(
        `[add:${slug}/${p.projectSlug}] ✖ no checkout source — the project has no Gitea repo and no GitHub repoSource`,
      );
      return [target];
    }
    if (
      projectCheckoutMatchesSource(
        slug,
        p.projectSlug,
        p.giteaRepoName ?? "",
        repoSource,
      )
      && userRepositoryHasCanonicalRemote(
        path.join(CUSTOMERS_DIR, slug, "projects", p.projectSlug),
      )
    ) {
      await restoreUserProjectAssets(ctx, slug, p.projectSlug);
      return [];
    }
    return [target];
  }))).flat();
}

async function restoreGithubProjectAgentWorkspaces(slug: string, projects: readonly string[], signal?: AbortSignal): Promise<void> {
  if (projects.length === 0) return;
  signal?.throwIfAborted();
  await brokeredGitHost.ensureRepo(slug, { kind: "project-coaches" });
  await restoreProjectAgentWorkspaces({ customerDir: path.join(CUSTOMERS_DIR, slug), slug, projects, assertCurrent: async () => {
    signal?.throwIfAborted();
  } });
}

type ProjectRosterEntry = { id?: string; workspace?: unknown; cwd?: unknown; sandbox?: Record<string, unknown> };

function projectRosterConfig(current: unknown) {
  return (current as { agents?: { defaults?: ProjectRosterEntry; entries?: Record<string, ProjectRosterEntry>; list?: ProjectRosterEntry[] } })?.agents;
}

function currentProjectEntry(current: unknown, id: string): ProjectRosterEntry | undefined {
  const agents = projectRosterConfig(current);
  return agents?.entries?.[id] ?? agents?.list?.find(agent => agent.id === id);
}

function githubCheckoutReady(snapshot: FleetBrokerUserSnapshot, projectId: string): boolean {
  const project = snapshot.projects.find(row => row.projectSlug === projectId);
  return snapshot.projectCheckoutScope === "workspace-and-projects" && project?.repoSource?.provider === "github" &&
    projectCheckoutEnabled(project.checkoutEnabled) &&
    projectCheckoutMatchesSource(snapshot.slug, projectId, project.giteaRepoName ?? "", project.repoSource) &&
    userRepositoryHasCanonicalRemote(path.join(CUSTOMERS_DIR, snapshot.slug, "projects", projectId));
}

async function initializeRelocatedGithubProjectAgents(slug: string, projectAgents: readonly Record<string, unknown>[], current: unknown): Promise<void> {
  const customerDir = path.join(CUSTOMERS_DIR, slug);
  for (const entry of projectAgents) {
    const id = String(entry.id), parsed = parseAgentId(id);
    if (parsed.kind !== "project" || entry.workspace !== projectAgentWorkspace(customerDir, parsed.project)) continue;
    if (currentProjectEntry(current, id)?.workspace !== path.join(customerDir, "projects", parsed.project)) continue;
    const identity = entry.identity as { name: string; emoji: string };
    await initializeRelocatedProjectAgent({ customerDir, project: parsed.project, ...identity });
  }
}

async function prepareBrokerProjectWorkspaces(ctx: BrokerCtx, snapshot: FleetBrokerUserSnapshot,
  projectAgents: NonNullable<UserSnapshot["projectAgents"]>,
  options: { signal?: AbortSignal; migrationId?: string }): Promise<void> {
  const selected = activeAgentProjectIds(projectAgents);
  const githubProjectAgents = projectAgents.filter(agent => agent.githubBacked && selected.has(agent.projectId)).map(agent => agent.projectId);
  await restoreGithubProjectAgentWorkspaces(snapshot.slug, githubProjectAgents, options.signal);
  if (snapshot.projectCheckoutScope !== "workspace-and-projects") return;
  if (selected.size === 0) return;
  const projects = snapshot.projects.filter(project => selected.has(project.projectSlug));
  const missing = [...selected].filter(id => !projects.some(project => project.projectSlug === id));
  if (missing.length > 0) throw new Error(`Project Agent checkout source is unavailable: ${missing.join(", ")}`);
  const { pending } = await cloneMissingProjects({
    listProjectsNeedingClone: slug => projectsNeedingClone(ctx, slug, projects),
    cloneProjectRepo: (slug, project, repo, opts) => cloneProjectRepoForTarget(ctx, slug, project, repo, opts),
    isIsolatedGateway: ctx.isIsolatedGateway,
    isConfiguredUser: isConfiguredGatewayUser,
    log: ctx.log,
  }, snapshot.slug, { signal: options.signal, ...(options.migrationId ? { githubCheckouts: "defer" as const } : {}) });
  if (pending.length > 0) throw new Error(`Project checkout is not ready for Native agent registration: ${pending.join(", ")}`);
}

async function restoreUserProjectAssets(ctx: BrokerCtx, slug: string, project: string): Promise<void> {
  if (!ctx.isIsolatedGateway() || !process.env.OCTOGEE_PROJECTS_MOUNT) return;
  const projects = path.join(CUSTOMERS_DIR, slug, "projects");
  if (await readProjectRestoreReady(path.join(projects, project), slug, project)) return;
  await prepareUserProjectAssets({ projects, slug, project, hydrate: createBrokeredProjectBlobHydrator(ctx.client), log: ctx.log });
}

async function cloneProjectRepoForTarget(
  ctx: BrokerCtx,
  userSlug: string,
  projectSlug: string,
  giteaRepoName: string | null,
  opts?: ProjectCloneOptions,
): Promise<boolean> {
  const cloned = await cloneProjectRepo(userSlug, projectSlug, giteaRepoName ?? "", opts);
  if (cloned) await restoreUserProjectAssets(ctx, userSlug, projectSlug);
  return cloned;
}

function coachToken(
  mmUpdate: MmUpdate | null,
  brokerSnapshot: Awaited<ReturnType<typeof snapshotForUid>>,
): string | null {
  if (typeof mmUpdate?._coachPersonalToken === "string") {
    return mmUpdate._coachPersonalToken;
  }
  return brokerSnapshot?.coachToken ?? null;
}

async function materializeUserBrokerProfiles(
  agentIds: string[],
  slug: string,
  logFn: (message: string) => void,
  secretMaterial: SecretMaterialLedger,
  logPrefix = `[add:${slug}]`,
): Promise<void> {
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
  const platformOpenAiBaseUrl = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  const metaBaseUrl = process.env.PLATFORM_META_BASE_URL?.trim();
  const platformVertexBaseUrl = process.env.PLATFORM_VERTEX_BASE_URL?.trim();
  const materialized = await materializeBrokerProfilesForAgents(agentIds, {
    logFn,
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(platformOpenAiBaseUrl
      ? { openAi: openAiCatalogInputForBaseUrl(platformOpenAiBaseUrl) }
      : {}),
    ...(metaBaseUrl ? { meta: metaCatalogInputForBaseUrl(metaBaseUrl) } : {}),
    ...(platformVertexBaseUrl
      ? { vertex: vertexCatalogInputForBaseUrl(platformVertexBaseUrl) }
      : {}),
  });
  if (materialized.materialized > 0) {
    secretMaterial.note(brokerProfileMaterializationReason(materialized.materialized));
    logFn(`${logPrefix} broker model profiles materialized before config hot-reload`);
  }
  if (materialized.deferred.length > 0) {
    logFn(
      `${logPrefix} broker profile deferred for ${materialized.deferred.join(", ")}` +
        ` — ${materialized.deferralReason ?? "openclaw refused the secrets apply"};` +
        ` the post-boot sweep retries it`,
    );
  }
  if (materialized.deferred.length > 0) {
    throw new Error(`Agent model profiles are not ready: ${materialized.deferred.join(", ")}`);
  }
}

async function writeMountAccountSecrets(
  slug: string,
  accountId: string,
  defaultAgentPat: string,
  projectAgents: Parameters<typeof mattermostProjectAccountSecretChange>[1],
  evictionSlugs: readonly string[],
): Promise<{ changed: boolean }> {
  const projectSecretChange = mattermostProjectAccountSecretChange(slug, projectAgents);
  return updateMattermostAccountSecrets(OPENCLAW_DIR, {
    set: { [accountId]: defaultAgentPat, ...projectSecretChange.set },
    remove: [...projectSecretChange.remove, ...evictionSlugs.map((evicted) => `${evicted}-coach`)],
    removePrefixes: evictionSlugs.map((evicted) => `${evicted}-proj-`),
  });
}

function brokerProfileMaterializationReason(materialized: number): string | null {
  if (materialized === 0) return null;
  return `broker model profiles materialized for ${materialized} agent(s)`;
}

async function mountPatchSecretMaterialReasons(
  ctx: BrokerCtx,
  before: unknown,
  noop: boolean,
): Promise<string[]> {
  if (noop) return [];
  return configSecretMaterialChangeReasons(before, (await ctx.rpc.configGet()).config);
}

function agentIdsFromEntries(entries: ReadonlyArray<Record<string, unknown>>): string[] {
  return entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
}

function initialHouseDefaultAgentPatch(snapshot: UserSnapshot) {
  return byosDefaultAgentConfigPatch(platformDefaultAgentModelInputForUser(snapshot.slug, snapshot));
}

function sharedByosubSuppressed(snapshot: UserSnapshot): boolean {
  if (snapshot.byotActive !== true || isConfiguredGatewayUser(snapshot.slug)) return false;
  const provider = snapshot.systemConfig?.byot?.provider;
  return provider !== undefined &&
    MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS[provider as keyof typeof MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS]?.mode === "oauth";
}

function userModelCredentialsActive(snapshot: UserSnapshot): boolean {
  return snapshot.byotActive === true && !sharedByosubSuppressed(snapshot);
}

function initialDefaultAgentModelSelection(snapshot: UserSnapshot): UserAgentModelDefault | null {
  if (userModelCredentialsActive(snapshot)) return null;
  const housePatch = initialHouseDefaultAgentPatch(snapshot);
  if (housePatch) return housePatch.agents.list[0].model as UserAgentModelDefault;
  const agentId = `octogee-${snapshot.slug}-coach`;
  return snapshot.systemConfig?.agentModels?.[agentId]
    ?? parseUserAgentModelDefault(snapshot.builderAgentDefault);
}

function initialDefaultAgentTools(snapshot: UserSnapshot, current: unknown) {
  if (userModelCredentialsActive(snapshot)) return current;
  const tools = initialHouseDefaultAgentPatch(snapshot)?.agents.list[0].tools;
  return tools ? convergedDefaultAgentToolsValue(current, tools) : current;
}

function platformModelDefaults(
  selection: UserAgentModelDefault | null,
): Record<string, object> | null {
  if (!selection) return null;
  const refs = [selection.primary, ...selection.fallbacks].filter(isPlatformProviderRef);
  return refs.length > 0 ? Object.fromEntries(refs.map((ref) => [ref, {}])) : null;
}

function userAgentDefaults(
  current: unknown,
  defaultAgentModelDefaults: Record<string, object> | null,
  isolatedGateway: boolean,
): Record<string, unknown> {
  if (isolatedGateway) {
    return {
      ...(defaultAgentModelDefaults ? { models: defaultAgentModelDefaults } : {}),
      authInheritance: { agentId: SAFE_DEFAULT_AGENT_ID },
    };
  }
  const platform = platformModelAllowlistPatch(current, false).agents.defaults;
  const models = { ...platform.models };
  for (const [ref, definition] of Object.entries(defaultAgentModelDefaults ?? {})) {
    if (models[ref] === undefined) models[ref] = definition;
  }
  return { models, modelPolicy: platform.modelPolicy };
}

function userGatewayAgentRoster(
  current: unknown,
  slug: string,
  userAgentEntries: readonly unknown[],
  isolatedGateway: boolean,
): unknown[] {
  const nextAgents = replaceUserAgentsInFullAgentList(
    current,
    slug,
    preserveMountedAgentModels(current, userAgentEntries),
  );
  const roster = gatewayAgentRoster(nextAgents, isolatedGateway ? slug : "");
  return isolatedGateway
    ? orderIsolatedGatewayRoster(
      [...roster, buildSafeDefaultAgent()],
      `octogee-${slug}-coach`,
      SAFE_DEFAULT_AGENT_ID,
    )
    : roster;
}

function convergedConfigRpc(ctx: BrokerCtx): BrokerCtx["rpc"] {
  return {
    ...ctx.rpc,
    configPatch: (
      patch: object,
      baseHash: string,
      options?: { replacePaths?: readonly string[] },
    ) => ctx.rpc.configPatchAndWaitForChange(patch, baseHash, options),
  };
}

async function captureRoutingActivationBaseline(
  ctx: BrokerCtx,
  accountId: string,
  projectAccounts: Readonly<Record<string, unknown>>,
): Promise<{ accountIds: string[]; baseline: Record<string, number> }> {
  const accountIds = [accountId, ...Object.keys(projectAccounts)];
  return {
    accountIds,
    baseline: await captureMattermostRoutingActivationBaseline(ctx.rpc, accountIds),
  };
}

async function reloadRuntimeSecretsIfChanged(
  ctx: BrokerCtx,
  logPrefix: string,
  ledger: SecretMaterialLedger,
  signal?: AbortSignal,
): Promise<void> {
  if (!ledger.changed) {
    ctx.log(`${logPrefix} secrets.reload skipped — no secret material changed`);
    return;
  }
  const precedingWrites = ledger.reasons.join("; ");
  ctx.log(`${logPrefix} secrets.reload — ${precedingWrites}`);
  await reloadRuntimeSecrets(ctx, logPrefix, { precedingWrites, signal });
}

function isSecretsReloadUnavailable(error: unknown): boolean {
  if (!(error instanceof OpenclawWireError) || error.code !== "rpc-error") return false;
  const details = error.details as { serverCode?: unknown } | undefined;
  return details?.serverCode === "UNAVAILABLE";
}

async function secretsReloadAfterSupersession(
  ctx: BrokerCtx,
  logPrefix: string,
  opts: { precedingWrites?: string; signal?: AbortSignal },
): Promise<Awaited<ReturnType<GatewayRpcClient["secretsReload"]>>> {
  try {
    return await ctx.rpc.secretsReload();
  } catch (error) {
    if (!isSecretsReloadUnavailable(error)) throw error;
    ctx.log(
      `${logPrefix} ⚠ secrets.reload refused (${String(error)}); waiting for the newer config write to apply, then reloading once more`,
    );
  }
  await waitForAppliedConfigRevision(ctx.rpc, "", {
    signal: opts.signal,
    logPrefix,
    acceptSupersedingRevision: true,
  });
  try {
    return await ctx.rpc.secretsReload();
  } catch (error) {
    if (!isSecretsReloadUnavailable(error)) throw error;
    throw new Error(
      `${logPrefix} secrets.reload was refused twice after: ${opts.precedingWrites ?? "an unrecorded config write"} ` +
        `(${String(error)}; the gateway log names the superseding write)`,
      { cause: error },
    );
  }
}

async function reloadRuntimeSecrets(
  ctx: BrokerCtx,
  logPrefix: string,
  opts: { precedingWrites?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const result = await secretsReloadAfterSupersession(ctx, logPrefix, opts);
  const warningCount = result.warningCount ?? 0;
  if (result.ok !== true) {
    throw new Error(`${logPrefix} secrets.reload did not acknowledge success`);
  }
  if (warningCount === 0) {
    ctx.log(`${logPrefix} secrets.reload complete`);
    return;
  }
  const warningLabel = warningCount === 1 ? "warning" : "warnings";
  ctx.log(`${logPrefix} secrets.reload complete with ${warningCount} ${warningLabel}`);
}

function throwIfConfigApplicationWaitAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("config application wait aborted");
}

export async function waitForAppliedConfigRevision(
  rpc: Pick<GatewayRpcClient, "configGet">,
  slug: string,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    logPrefix?: string;
    /** Settle once the runtime has applied whatever revision is current, instead of
     *  the exact revision observed first. Revisions are cumulative, so an additive
     *  write from a concurrent lane never fails this wait. */
    acceptSupersedingRevision?: boolean;
  } = {},
): Promise<void> {
  const logPrefix = opts.logPrefix ?? `[import:${slug}]`;
  const timeoutMs = opts.timeoutMs ?? CONFIG_PATCH_DEADLINE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastReadError: string | null = null;
  let targetRevisionHash: string | null = null;
  let appliedConfigHash: string | null = null;
  const idle = (): Promise<void> => new Promise<void>((resolve) =>
    setTimeout(resolve, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now()))));
  // The patch this waits on is what makes the runtime reload, and a reloading
  // runtime refuses the socket every poll opens. A read that fails is therefore
  // the expected shape of "not applied yet", not a failed import.
  const readSnapshot = async (): Promise<ConfigGetResult | null> => {
    throwIfConfigApplicationWaitAborted(opts.signal);
    try {
      const snapshot = await rpc.configGet();
      throwIfConfigApplicationWaitAborted(opts.signal);
      return snapshot;
    } catch (error) {
      throwIfConfigApplicationWaitAborted(opts.signal);
      if (!(error instanceof OpenclawWireError &&
          (error.code === "connect-failed" || error.code === "timeout"))) throw error;
      lastReadError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  const observe = (snapshot: ConfigGetResult): boolean => {
    if (opts.acceptSupersedingRevision) {
      targetRevisionHash = snapshot.configRevisionHash;
    } else {
      targetRevisionHash ??= snapshot.configRevisionHash;
      if (snapshot.configRevisionHash !== targetRevisionHash) {
        throw new Error(
          `${logPrefix} config revision changed while waiting ` +
            `(expected=${targetRevisionHash}, observed=${snapshot.configRevisionHash})`,
        );
      }
    }
    appliedConfigHash = snapshot.appliedConfigHash;
    return targetRevisionHash === appliedConfigHash;
  };
  for (;;) {
    const snapshot = await readSnapshot();
    if (snapshot !== null && observe(snapshot)) return;
    if (Date.now() >= deadline) break;
    await idle();
  }
  if (targetRevisionHash === null) {
    throw new Error(
      `${logPrefix} config revision was unreadable for ${timeoutMs}ms: ${lastReadError}`,
    );
  }
  throw new Error(
    `${logPrefix} active config did not reach revision ${targetRevisionHash} ` +
      `within ${timeoutMs}ms (applied=${appliedConfigHash ?? lastReadError ?? "none"})`,
  );
}

async function requiredDefaultAgentMattermostAccount(
  ctx: BrokerCtx,
  slug: string,
  account: ReturnType<typeof buildMattermostAccounts>[string] | undefined,
) {
  if (account) return account;
  await quarantineMalformedDefaultAgentMattermostAccount(slug, convergedConfigRpc(ctx), ctx.configCache, ctx.log);
  throw new Error(`[add:${slug}] fleet broker account fragment was empty`);
}

function projectMountPolicy(
  current: unknown,
  patch: Record<string, unknown>,
  snapshot: UserSnapshot,
  isolatedGateway: boolean,
): Record<string, unknown> {
  if (isolatedGateway || userModelCredentialsActive(snapshot)) return patch;
  return userMountConfigPatch(current, patch, snapshot.slug, mountSafeModelRef(snapshot), {
    gatewayEnv: process.env,
    forceSafeAll: sharedByosubSuppressed(snapshot),
  });
}

function mountSafeModelRef(snapshot: UserSnapshot): string {
  const selected = initialDefaultAgentModelSelection(snapshot)?.primary;
  if (selected && catalogEntryForModelRef(selected)) return selected;
  return parseUserAgentModelDefault(snapshot.builderAgentDefault)?.primary
    ?? DEFAULT_HOUSE_MODEL_REF;
}

function buildUserProjectAgents(
  snapshot: FleetBrokerUserSnapshot,
  projectAgents: NonNullable<UserSnapshot["projectAgents"]>,
  identity: ReturnType<typeof resolveDefaultAgentIdentity>,
  options: { ownerMmUserId?: string | null; isolatedGateway: boolean; currentConfig?: unknown },
): Array<Record<string, unknown>> {
  const { ownerMmUserId, isolatedGateway, currentConfig } = options;
  const githubWorkspaces = new Map(projectAgents.filter(agent => agent.githubBacked).map(agent => {
    const sandbox = currentProjectEntry(currentConfig, projectAgentId(snapshot.slug, agent.projectId))?.sandbox;
    return [agent.projectId, {
      checkoutReady: isolatedGateway && githubCheckoutReady(snapshot, agent.projectId),
      sandboxMode: sandbox?.mode ?? projectRosterConfig(currentConfig)?.defaults?.sandbox?.mode ?? "off",
      sandbox,
      defaultCwd: projectRosterConfig(currentConfig)?.defaults?.cwd,
    }] as const;
  }));
  return buildProjectAgents({
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentsDir: AGENTS_DIR,
    defaultAgent: {
      name: identity.name,
      emoji: identity.emoji,
      model: platformProjectAgentModelForUser(snapshot.slug, snapshot) ?? DEFAULT_AGENT.model,
    },
    projectAgents,
    githubWorkspaces,
    ownerMmUserId,
    hostCode: isolatedGateway ? "builder-full" : "customer-restricted",
  });
}

function pendingProjectActivationAccountIds(slug: string, projectAgents: NonNullable<UserSnapshot["projectAgents"]>): string[] {
  return projectAgents.filter((agent) => agent.enabled && agent.status === "provisioning" && agent.activationId && agent.token)
    .map((agent) => `${slug}-proj-${agent.projectId}`);
}

function markPendingProjectActivations(reason: string, accountIds: string[], baseline: Record<string, number>): boolean {
  if (accountIds.length === 0) return false;
  markMattermostRoutingActivationPending(OPENCLAW_DIR, reason, accountIds, baseline);
  return true;
}

function mountMattermostAccountsPatch(
  current: unknown,
  slug: string,
  evictionSlugs: string[],
  userAccounts: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...userAccounts,
    ...staleProjectAgentAccountNulls(current, slug, Object.keys(userAccounts)),
    ...(evictionSlugs.length > 0
      ? buildRemoveUserAccountsPatch(current, evictionSlugs).channels.mattermost.accounts
      : {}),
  };
}

function buildDefaultAgentEntry(
  snapshot: UserSnapshot,
  defaultAgent: {
    agentId: string;
    identity: ReturnType<typeof resolveDefaultAgentIdentity>;
    customerMmUserId: string | null | undefined;
    isolatedGateway: boolean;
    modelSelection: UserAgentModelDefault | null;
  },
): ReturnType<typeof buildUserAgent> {
  const agentEntry = buildUserAgent({
    uid: snapshot.uid,
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentDir: path.join(AGENTS_DIR, defaultAgent.agentId, "agent"),
    defaultAgent: { name: defaultAgent.identity.name, emoji: defaultAgent.identity.emoji, model: DEFAULT_AGENT.model },
    customerMmUserId: defaultAgent.customerMmUserId,
    default: defaultAgent.isolatedGateway,
    hostCode: defaultAgent.isolatedGateway ? "builder-full" : "customer-restricted",
    ...(platformOpenAiEmbeddingsEnabled()
      ? { memorySearch: platformOpenAiEmbeddingMemorySearch(defaultAgent.agentId) }
      : {}),
  });
  if (defaultAgent.modelSelection) agentEntry.model = defaultAgent.modelSelection;
  agentEntry.tools = initialDefaultAgentTools(snapshot, agentEntry.tools);
  return agentEntry;
}

const ASSIGNED_ROSTER_IDENTITY_CHANGED = "Assigned Shared Native roster identity changed";

function isManagedAssignedWorkspaceRelocation(slug: string | undefined, agent: Record<string, unknown>, workspace: unknown): boolean {
  if (slug === undefined) return false;
  const parsed = parseAgentId(String(agent.id));
  if (parsed.kind !== "project" || parsed.username !== slug) return false;
  const customerDir = path.join(CUSTOMERS_DIR, slug);
  const checkout = path.join(customerDir, "projects", parsed.project);
  const privateWorkspace = projectAgentWorkspace(customerDir, parsed.project);
  return (workspace === checkout && agent.workspace === privateWorkspace) ||
    (workspace === privateWorkspace && agent.workspace === checkout);
}

function inspectAssignedIdentityAgents(current: unknown, expected: readonly Record<string, unknown>[], relocationSlug?: string) {
  const agents = (current as { agents?: { entries?: Record<string, Record<string, unknown>>; list?: Array<Record<string, unknown>> } })?.agents;
  const roster = agents?.entries ? Object.entries(agents.entries).map(([id, agent]): Record<string, unknown> => ({ ...agent, id })) : agents?.list ?? [];
  const missing: string[] = [];
  const relocating: Record<string, unknown>[] = [];
  for (const agent of expected) {
    const matches = roster.filter(value => value.id === agent.id);
    if (matches.length === 0) {
      missing.push(String(agent.id));
      continue;
    }
    if (matches.length !== 1 || agent.agentDir !== undefined && matches[0].agentDir !== agent.agentDir) throw new Error(ASSIGNED_ROSTER_IDENTITY_CHANGED);
    if (matches[0].workspace === agent.workspace) continue;
    if (!isManagedAssignedWorkspaceRelocation(relocationSlug, agent, matches[0].workspace)) throw new Error(ASSIGNED_ROSTER_IDENTITY_CHANGED);
    relocating.push(agent);
  }
  return { missing, relocating };
}

function verifyAssignedIdentityRelocations(current: unknown, relocating: readonly Record<string, unknown>[], slug: string): void {
  if (relocating.length === 0) return;
  if (inspectAssignedIdentityAgents(current, relocating, slug).missing.length > 0) throw new Error(ASSIGNED_ROSTER_IDENTITY_CHANGED);
}

interface AssignedWorkspaceIdentityInput {
  snapshot: UserSnapshot;
  brokerSnapshot: FleetBrokerUserSnapshot;
  agentEntry: Record<string, unknown>;
  projectAgentEntries: Record<string, unknown>[];
  accountEntry: object;
  projectAccounts: Record<string, unknown>;
  accountTokens: Record<string, unknown>;
  bindings: Array<{ agentId?: unknown }>;
  callOpts: AddUserConfigPatchOptions;
}

function currentAssignedIdentityOwner(input: { current: FleetBrokerUserSnapshot | null; snapshot: UserSnapshot; assigned: FleetBrokerAssignmentRosterEntry[]; gatewayId?: string; podUid?: string }): boolean {
  const { current, snapshot, assigned, gatewayId, podUid } = input;
  return !!gatewayId && !!podUid && current?.uid === snapshot.uid && current.slug === snapshot.slug && current.gatewayId === gatewayId && current.status === "complete" && assigned.length === 1 &&
    Number.isSafeInteger(assigned[0].epoch) && assigned[0].epoch >= 0;
}

function assertAssignedIdentityMode(input: AssignedWorkspaceIdentityInput, current: FleetBrokerUserSnapshot, assigned: FleetBrokerAssignmentRosterEntry): void {
  if (input.callOpts?.migrationId) {
    const restore = current.restoreAuthority;
    if (!restore || restore.migrationId !== input.callOpts.migrationId || restore.uid !== input.snapshot.uid || restore.slug !== input.snapshot.slug || restore.gatewayId !== current.gatewayId || restore.assignmentEpoch !== assigned.epoch) throw new Error("Shared restore identity authority is missing or changed");
  } else if (assigned.state !== "serving" || current.restoreAuthority !== undefined || current.runtimeMutationFenced !== false) throw new Error("Ordinary Shared identity capture requires unfenced serving custody");
}

async function readAssignedWorkspaceIdentityAuthority(ctx: BrokerCtx, input: AssignedWorkspaceIdentityInput) {
  input.callOpts?.signal?.throwIfAborted();
  const { snapshot } = input;
  const [current, assignments] = await Promise.all([ctx.client.userSnapshot(snapshot.uid), ctx.client.assignmentRoster()]);
  const assigned = assignments.filter(value => value.uid === snapshot.uid);
  const gatewayId = process.env.GATEWAY_ID?.trim(), podUid = process.env.POD_UID?.trim();
  if (!currentAssignedIdentityOwner({ current, snapshot, assigned, gatewayId, podUid })) throw new Error("Assigned Shared workspace identity authority changed");
  assertAssignedIdentityMode(input, current!, assigned[0]);
  const custody: MigrationTargetIdentityCustody = { ...(input.callOpts?.migrationId ? { migrationId: input.callOpts.migrationId } : {}), uid: snapshot.uid, gatewayId: gatewayId!, podUid: podUid!, assignmentEpoch: assigned[0].epoch };
  return { custody, restoreAuthority: current!.restoreAuthority };
}

function assignedWorkspaceIdentityManifest(input: AssignedWorkspaceIdentityInput): MigrationActivationManifest {
  const { snapshot } = input;
  const agentId = String(input.agentEntry.id);
  return { version: 2, slug: snapshot.slug, appliedFingerprint: snapshotConfigFingerprint(input.brokerSnapshot), agentId, accountId: `${snapshot.slug}-coach`, agent: input.agentEntry,
    mattermostAccount: { ...input.accountEntry, botToken: input.accountTokens[`${snapshot.slug}-coach`] }, bindings: input.bindings.filter(binding => binding.agentId === agentId), projectAgents: input.projectAgentEntries.map(agent => {
      const parsed = parseAgentId(String(agent.id));
      if (parsed.kind !== "project" || parsed.username !== snapshot.slug) throw new Error("Assigned Shared identity project is foreign");
      const accountId = `${snapshot.slug}-proj-${parsed.project}`;
      return { agentId: String(agent.id), accountId, agent, mattermostAccount: { ...(input.projectAccounts[accountId] as object), botToken: input.accountTokens[accountId] }, bindings: input.bindings.filter(binding => binding.agentId === agent.id) };
    }) };
}

async function optionalAssignedIdentityManifest(slug: string): Promise<MigrationActivationManifest | null> {
  try { return await readActivationManifest(OPENCLAW_DIR, slug); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return null; } throw error; }
}

type AssignedIdentityAuthority = Awaited<ReturnType<typeof readAssignedWorkspaceIdentityAuthority>>;

function assignedIdentityCurrent(ctx: BrokerCtx, input: AssignedWorkspaceIdentityInput, authority: AssignedIdentityAuthority, retained: MigrationActivationManifest | null) {
  return async () => {
    if (!isDeepStrictEqual(await readAssignedWorkspaceIdentityAuthority(ctx, input), authority)) throw new Error("Assigned Shared workspace identity authority changed");
    if (!isDeepStrictEqual(await optionalAssignedIdentityManifest(input.snapshot.slug), retained)) throw new Error("Assigned Shared workspace identity capture changed");
    input.callOpts?.signal?.throwIfAborted();
  };
}

function assertAssignedCaptureBinding(capture: TargetWorkspaceIdentities, authority: AssignedIdentityAuthority): void {
  assertTargetIdentityCustody(capture, { ...(capture.migrationId ? { migrationId: capture.migrationId } : {}),
    ...(capture.assignmentEpoch === undefined ? {} : { assignmentEpoch: authority.custody.assignmentEpoch }), uid: authority.custody.uid, gatewayId: authority.custody.gatewayId, podUid: authority.custody.podUid });
}

function assignedCaptureIsCurrentMount(capture: TargetWorkspaceIdentities | undefined, custody: MigrationTargetIdentityCustody): boolean {
  return capture !== undefined && capture.migrationId === custody.migrationId && capture.assignmentEpoch === custody.assignmentEpoch;
}

async function retainAssignedIdentityCapture(ctx: BrokerCtx, input: AssignedWorkspaceIdentityInput, state: { authority: AssignedIdentityAuthority; previous: MigrationActivationManifest | null; missing: string[] }): Promise<MigrationActivationManifest> {
  const { authority, previous, missing } = state;
  const capture = previous?.targetWorkspaceIdentities;
  if (capture) {
    const custody = { ...authority.custody };
    if (input.callOpts?.migrationId && capture.assignmentEpoch === undefined) delete custody.assignmentEpoch;
    assertTargetIdentityCustody(capture, custody);
    const ids = [String(input.agentEntry.id), ...input.projectAgentEntries.map(agent => String(agent.id))];
    if (!isDeepStrictEqual([previous.agentId, ...previous.projectAgents.map(agent => agent.agentId)].sort(), ids.sort())) throw new Error("Assigned Shared identity roster changed");
    return previous;
  }
  if (previous) throw new Error("Assigned Shared identity capture cannot replace an unfinished migration manifest");
  const manifest = assignedWorkspaceIdentityManifest(input);
  const retained = { ...manifest, targetWorkspaceIdentities: await captureTargetWorkspaceIdentities(input.snapshot.slug, missing, resolveOpenClawStateDir(), authority.custody, privateProjectWorkspaceAgentIds(manifest)) };
  await assignedIdentityCurrent(ctx, input, authority, null)();
  await writeActivationManifest(OPENCLAW_DIR, retained);
  return retained;
}

async function assignedWorkspaceIdentityRestore(ctx: BrokerCtx, input: Omit<AssignedWorkspaceIdentityInput, "brokerSnapshot"> & { brokerSnapshot: FleetBrokerUserSnapshot | null }): Promise<{ restore: () => Promise<void>; complete: () => Promise<void>; verifyRoster: (current: unknown) => void } | undefined> {
  if (ctx.isIsolatedGateway() || input.callOpts?.beforeRuntimePublish || input.brokerSnapshot?.status !== "complete") return undefined;
  const scoped = { ...input, brokerSnapshot: input.brokerSnapshot };
  const authority = await readAssignedWorkspaceIdentityAuthority(ctx, scoped);
  const ids = [String(input.agentEntry.id), ...input.projectAgentEntries.map(agent => String(agent.id))];
  const previous = await optionalAssignedIdentityManifest(input.snapshot.slug), capture = previous?.targetWorkspaceIdentities;
  const relocationSlug = previous === null ? input.snapshot.slug : undefined;
  const { missing, relocating } = input.callOpts?.migrationId ? { missing: ids, relocating: [] }
    : inspectAssignedIdentityAgents(await freshRosterConfig(ctx), [input.agentEntry, ...input.projectAgentEntries], relocationSlug);
  const verifyRoster = (current: unknown) => verifyAssignedIdentityRelocations(current, relocating, input.snapshot.slug);
  if (capture) assertAssignedCaptureBinding(capture, authority);
  const sameMount = assignedCaptureIsCurrentMount(capture, authority.custody);
  if (!input.callOpts?.migrationId && missing.length === 0 && !sameMount) {
    const assertCurrent = assignedIdentityCurrent(ctx, scoped, authority, previous);
    return { restore: assertCurrent, verifyRoster, complete: async () => { await assertCurrent(); if (previous) await removeActivationManifest(OPENCLAW_DIR, input.snapshot.slug); } };
  }
  const retained = await retainAssignedIdentityCapture(ctx, scoped, { authority, previous, missing });
  const assertCurrent = assignedIdentityCurrent(ctx, scoped, authority, retained);
  await assertCurrent();
  return { verifyRoster, restore: () => restoreTargetWorkspaceIdentities(retained.targetWorkspaceIdentities!, input.snapshot.slug, ids, resolveOpenClawStateDir(), { custody: retained.targetWorkspaceIdentities!, assertCurrent, privateWorkspaces: privateProjectWorkspaceAgentIds(retained) }),
    complete: async () => { await assertCurrent(); await removeActivationManifest(OPENCLAW_DIR, input.snapshot.slug); } };
}

async function prepareAssignedUserRuntimePublication(callOpts: AddUserConfigPatchOptions, assigned: Awaited<ReturnType<typeof assignedWorkspaceIdentityRestore>>): Promise<void> {
  await prepareUserRuntimePublication({ ...callOpts, beforeRuntimePublish: assigned?.restore ?? callOpts?.beforeRuntimePublish });
}

async function completeAssignedWorkspaceIdentity(assigned: Awaited<ReturnType<typeof assignedWorkspaceIdentityRestore>>): Promise<void> {
  await assigned?.complete();
}

async function applyAddUserConfigPatch(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  callOpts: AddUserConfigPatchOptions,
): Promise<{ elapsedMs: number; appliedFingerprint?: string }> {
  let evictionSlugs = evictionSlugsExcept(snapshot.slug, callOpts?.evictionBatch);
  const isolatedGateway = isConfiguredGatewayUser(snapshot.slug);
  const brokerSnapshot = await snapshotForUidWithProjectMembershipIsolation(ctx, snapshot.uid);
  if (!brokerSnapshot) throw new Error(`User snapshot unavailable for ${snapshot.slug}`);
  const defaultAgentPat = coachToken(mmUpdate, brokerSnapshot);
  if (!defaultAgentPat) {
    throw new Error(`[add:${snapshot.slug}] agent PAT unavailable from fleet broker`);
  }
  const projectAgents = brokerProjectAgents(brokerSnapshot, callOpts?.withoutProjectIds);
  await prepareBrokerProjectWorkspaces(ctx, brokerSnapshot, projectAgents, callOpts ?? {});
  const channels = brokerSnapshot.channels;
  const identity = resolveDefaultAgentIdentity(brokerSnapshot.coachIdentity, DEFAULT_AGENT);
  const accountsMap = buildMattermostAccounts(
    [
      {
        uid: snapshot.uid,
        slug: snapshot.slug,
        customerMmUserId: brokerUserMattermostUserId(brokerSnapshot, snapshot),
        channels,
        agentProjects: activeAgentProjectIds(projectAgents),
      },
    ],
    new Map([[snapshot.uid, defaultAgentPat]]),
    (m) => ctx.log(m),
  );
  const accountId = `${snapshot.slug}-coach`;
  const accountEntry = await requiredDefaultAgentMattermostAccount(ctx, snapshot.slug, accountsMap[accountId]);
  const agentId = `octogee-${snapshot.slug}-coach`;
  const defaultAgentModelSelection = initialDefaultAgentModelSelection(snapshot);
  const defaultAgentModelDefaults = platformModelDefaults(defaultAgentModelSelection);
  const agentEntry = buildDefaultAgentEntry(snapshot, {
    agentId,
    identity,
    customerMmUserId: brokerUserMattermostUserId(brokerSnapshot, snapshot),
    isolatedGateway,
    modelSelection: defaultAgentModelSelection,
  });
  const projectAgentEntries = buildUserProjectAgents(brokerSnapshot, projectAgents, identity,
    { ownerMmUserId: brokerUserMattermostUserId(brokerSnapshot, snapshot), isolatedGateway });
  if (projectAgents.some(agent => agent.githubBacked)) {
    await initializeRelocatedGithubProjectAgents(snapshot.slug, projectAgentEntries, await freshRosterConfig(ctx));
  }
  const brokerAgentIds = [agentId, ...agentIdsFromEntries(projectAgentEntries)];
  await Promise.all(
    brokerAgentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })),
  );
  evictionSlugs = await stillEvictedSlugs(
    snapshot.slug,
    evictionSlugs,
    callOpts?.currentEvictionBatch,
  );
  const secretMaterial = ctx.pendingRuntimeSecrets.get(snapshot.slug) ?? createSecretMaterialLedger();
  ctx.pendingRuntimeSecrets.set(snapshot.slug, secretMaterial);
  secretMaterial.noteIf(
    (await writeMountAccountSecrets(snapshot.slug, accountId, defaultAgentPat, projectAgents, evictionSlugs)).changed,
    "Mattermost account secrets file changed",
  );
  const projectAccounts = buildProjectAgentAccounts(
    snapshot.slug,
    projectAgents,
    brokerUserMattermostUserId(brokerSnapshot, snapshot),
  );
  const bindings = buildUserBindings([
    {
      slug: snapshot.slug,
      channels,
      agentProjects: activeAgentProjectIds(projectAgents),
    },
  ]);
  let routingActivationRequired = mattermostRoutingActivationPending(OPENCLAW_DIR);
  const routingActivationReason = `[add:${snapshot.slug}] account-level Mattermost binding changed`;
  const userAgentEntries = [agentEntry, ...projectAgentEntries];
  const accountTokens = Object.fromEntries([[accountId, defaultAgentPat], ...projectAgents.map(agent => [`${snapshot.slug}-proj-${agent.projectId}`, agent.token])]);
  const assignedIdentity = await assignedWorkspaceIdentityRestore(ctx, { snapshot, brokerSnapshot, agentEntry, projectAgentEntries, accountEntry, projectAccounts, accountTokens, bindings, callOpts });
  await callOpts?.brokerProfilesReady;
  const reportSharedAnchors = await prepareUserSharedAnchors(ctx, {
    uid: snapshot.uid, slug: snapshot.slug, agentIds: brokerAgentIds,
  });
  await reconcileUserRosterAgents(
    ctx,
    snapshot.slug,
    evictionSlugs,
    brokerAgentIds,
    userAgentEntries,
  );
  await reportSharedAnchors?.();
  await materializeUserBrokerProfiles(brokerAgentIds, snapshot.slug, ctx.log, secretMaterial);
  const { accountIds: affectedAccountIds, baseline: routingActivationBaseline } = await captureRoutingActivationBaseline(ctx, accountId, projectAccounts);
  const pendingProjectAccountIds = pendingProjectActivationAccountIds(snapshot.slug, projectAgents);
  routingActivationRequired = markPendingProjectActivations(routingActivationReason, pendingProjectAccountIds, routingActivationBaseline)
    || routingActivationRequired;
  await prepareAssignedUserRuntimePublication(callOpts, assignedIdentity);
  const startedAt = Date.now();
  let configBefore: unknown;
  const configPatch = await applyConfigPatch(
    {
      buildPatch: (current) => {
        assignedIdentity?.verifyRoster(current);
        configBefore = current;
        const currentCfg = current as { bindings?: Array<{ agentId?: unknown }> };
        const currentBindings = Array.isArray(currentCfg.bindings) ? currentCfg.bindings : [];
        const missingAccountIds = mattermostAccountBindingsNeedingActivation(
          currentBindings,
          bindings,
        );
        if (missingAccountIds.length > 0) {
          markMattermostRoutingActivationPending(
            OPENCLAW_DIR,
            routingActivationReason,
            missingAccountIds,
            routingActivationBaseline,
          );
          routingActivationRequired = true;
        }
        const agentDefaults = userAgentDefaults(current, defaultAgentModelDefaults, isolatedGateway);
        const roster = userGatewayAgentRoster(
          current,
          snapshot.slug,
          isolatedGateway ? [agentEntry, ...buildUserProjectAgents(brokerSnapshot, projectAgents, identity, { ownerMmUserId: brokerUserMattermostUserId(brokerSnapshot, snapshot), isolatedGateway: true, currentConfig: current })] : userAgentEntries,
          isolatedGateway,
        );
        const ownerCommands = isolatedGateway
          ? userOwnerCommandsPatch(current, snapshot.slug, brokerUserMattermostUserId(brokerSnapshot, snapshot))
          : undefined;
        const mountPatch = {
          ...(ownerCommands ? { commands: ownerCommands } : {}),
          agents: {
            ownership: "explicit",
            defaults: agentDefaults,
            ...userAgentRosterPatch(
              current,
              snapshot.slug,
              rebindPlatformEmbeddingRefs(roster),
            ),
          },
          bindings: mergeUserBindings(
            currentBindings,
            [snapshot.slug, ...evictionSlugs],
            bindings,
          ),
          channels: {
            mattermost: {
              accounts: mountMattermostAccountsPatch(current, snapshot.slug, evictionSlugs,
                mattermostAccountEndpointsForTarget(current, {
                  [accountId]: accountEntry,
                  ...projectAccounts,
                }, !ctx.isIsolatedGateway()),
              ),
            },
          },
        };
        return projectMountPolicy(current, mountPatch, snapshot, isolatedGateway);
      },
      buildReplacePaths: (current) => [...new Set([
        ...[snapshot.slug, ...evictionSlugs].flatMap((slug) =>
          userConfigAgentRosterReplacePaths(current, slug)
        ),
        ...(isolatedGateway ? [] : [PLATFORM_MODEL_POLICY_ALLOW_PATH]),
        ...(!isolatedGateway && !userModelCredentialsActive(snapshot)
          ? userSecurityProjectionReplacePaths(current) : []),
      ])],
      logPrefix: `[add:${snapshot.slug}]`,
    },
    {
      rpc: convergedConfigRpc(ctx),
      cache: ctx.configCache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      signal: callOpts?.signal,
    },
  );
  secretMaterial.note(
    await mountPatchSecretMaterialReasons(ctx, configBefore, configPatch.noop === true),
  );
  await settleProjectAgentActivations(ctx, {
    snapshot, projectAgents, channels, baseline: routingActivationBaseline,
    secretMaterial, signal: callOpts?.signal,
    activate: () => activateMattermostRoutingAfterConfigPatch(ctx.rpc, OPENCLAW_DIR, ctx.log, {
      accountIds: affectedAccountIds,
      baseline: routingActivationBaseline,
      configNoop: configPatch.noop === true,
      required: routingActivationRequired,
      reason: routingActivationReason,
      currentSlug: snapshot.slug,
      evictionSlugs,
      restartAccountIds: pendingProjectAccountIds,
    }),
  });
  for (const slug of evictionSlugs) ctx.configRemovedForEviction.add(slug);
  await completeAssignedWorkspaceIdentity(assignedIdentity);
  return {
    elapsedMs: Date.now() - startedAt,
    appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot),
  };
}

async function settleProjectAgentActivations(
  ctx: BrokerCtx,
  input: {
    snapshot: UserSnapshot;
    projectAgents: NonNullable<UserSnapshot["projectAgents"]>;
    channels: UserSnapshot["channels"];
    baseline: Readonly<Record<string, number>>;
    secretMaterial: SecretMaterialLedger;
    signal?: AbortSignal;
    activate(): Promise<void>;
  },
): Promise<void> {
  const errors: unknown[] = [];
  await reloadRuntimeSecretsIfChanged(ctx, `[add:${input.snapshot.slug}]`, input.secretMaterial, input.signal);
  if (ctx.pendingRuntimeSecrets.get(input.snapshot.slug) === input.secretMaterial) {
    ctx.pendingRuntimeSecrets.delete(input.snapshot.slug);
  }
  try {
    await input.activate();
  } catch (error) {
    errors.push(error);
  }
  try {
    await reportProjectAgentReadiness({
      rpc: ctx.rpc, report: (uid, projects) => ctx.client.reportProjectAgentReadiness(uid, projects),
      uid: input.snapshot.uid, slug: input.snapshot.slug, projectAgents: input.projectAgents,
      channels: input.channels, baseline: input.baseline,
    });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    throw new AggregateError(errors, `Project Agent runtime activation did not complete: ${details}`);
  }
}

async function reconcileConfiguredUserProjectAgents(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  options: { withoutProjectIds?: readonly string[]; signal?: AbortSignal } = {},
): Promise<{ elapsedMs: number; appliedFingerprint?: string }> {
  const startedAt = Date.now();
  const brokerSnapshot = await snapshotForUidWithProjectMembershipIsolation(ctx, snapshot.uid);
  if (!brokerSnapshot) throw new Error(`Project Agent snapshot unavailable for ${snapshot.slug}`);
  const preparedProjectAgents = brokerProjectAgents(brokerSnapshot, options.withoutProjectIds);
  await prepareBrokerProjectWorkspaces(ctx, brokerSnapshot, preparedProjectAgents, options);
  const current = await freshRosterConfig(ctx);
  const pendingProjectIds = new Set(options.withoutProjectIds);
  const pendingAgentIds = new Set([...pendingProjectIds].map(id => projectAgentId(snapshot.slug, id)));
  const existingAgentIds = new Set(userAgentIdsInRoster(current, snapshot.slug));
  const projectAgents = brokerProjectAgents(brokerSnapshot).filter(agent =>
    !pendingProjectIds.has(agent.projectId) || existingAgentIds.has(projectAgentId(snapshot.slug, agent.projectId)));
  const appliedFingerprint = pendingProjectIds.size === 0 ? snapshotConfigFingerprint(brokerSnapshot) : undefined;
  const managedProjectIds = configuredUserManagedProjectIds(readOpenClawConfig(), snapshot.slug,
    (brokerSnapshot.projectAgents ?? []).map((agent) => agent.projectId));
  if (managedProjectIds.length === 0) {
    if (Object.keys(configuredUserWorkspacePatch(current, snapshot.slug, brokerSnapshot.customerMmUserId, brokerSnapshot.channels)).length > 0) {
      await applyConfigPatch({
        buildPatch: (latest) => configuredUserWorkspacePatch(latest, snapshot.slug, brokerSnapshot.customerMmUserId, brokerSnapshot.channels),
        buildReplacePaths: (latest) => configuredUserWorkspacePatch(latest, snapshot.slug, brokerSnapshot.customerMmUserId, brokerSnapshot.channels).bindings ? ["bindings"] : [],
        logPrefix: `[project-agents:${snapshot.slug}]`,
      }, { rpc: convergedConfigRpc(ctx), cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS, signal: options.signal });
    }
    return { elapsedMs: Date.now() - startedAt, appliedFingerprint };
  }
  const identity = resolveDefaultAgentIdentity(brokerSnapshot.coachIdentity, DEFAULT_AGENT);
  const projectAgentEntries = buildUserProjectAgents(brokerSnapshot, projectAgents, identity, { ownerMmUserId: brokerSnapshot.customerMmUserId, isolatedGateway: true, currentConfig: current });
  const projectAccounts = buildProjectAgentAccounts(snapshot.slug, projectAgents, brokerSnapshot.customerMmUserId);
  const patchInput = {
    slug: snapshot.slug, managedProjectIds, projectAgentEntries, projectAccounts, channels: brokerSnapshot.channels,
    ownerMmUserId: brokerSnapshot.customerMmUserId,
    activationProjectIds: preparedProjectAgents.filter((agent) => agent.status === "provisioning" && agent.activationId).map((agent) => agent.projectId),
  };
  const logPrefix = `[project-agents:${snapshot.slug}]`;
  await initializeRelocatedGithubProjectAgents(snapshot.slug, projectAgentEntries, current);
  const { retiredAgentIds } = configuredUserProjectAgentPatch(current, patchInput);
  await ensureUserRosterAgents(ctx, projectAgentEntries.filter(entry => !pendingAgentIds.has(String(entry.id))), logPrefix);
  const agentIds = agentIdsFromEntries(projectAgentEntries);
  await Promise.all(agentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })));
  const secretMaterial = ctx.pendingRuntimeSecrets.get(snapshot.slug) ?? createSecretMaterialLedger();
  ctx.pendingRuntimeSecrets.set(snapshot.slug, secretMaterial);
  await materializeUserBrokerProfiles(agentIds, snapshot.slug, ctx.log, secretMaterial);
  const projectSecrets = mattermostProjectAccountSecretChange(snapshot.slug, projectAgents);
  const setSecrets = await updateMattermostAccountSecrets(OPENCLAW_DIR, { set: projectSecrets.set });
  secretMaterial.noteIf(setSecrets.changed, "Mattermost account secrets file changed");
  const pendingAccountIds = pendingProjectActivationAccountIds(snapshot.slug, preparedProjectAgents);
  const baseline = pendingAccountIds.length > 0
    ? await captureMattermostRoutingActivationBaseline(ctx.rpc, pendingAccountIds)
    : {};
  let configBefore: unknown;
  const configPatch = await applyConfigPatch({
    buildPatch: (current) => {
      configBefore = current;
      return configuredUserProjectAgentPatch(current, { ...patchInput, projectAgentEntries: buildUserProjectAgents(brokerSnapshot, projectAgents, identity, { ownerMmUserId: brokerSnapshot.customerMmUserId, isolatedGateway: true, currentConfig: current }) }).patch;
    },
    buildReplacePaths: (current) => configuredUserProjectAgentPatch(current, patchInput).replacePaths,
    logPrefix,
  }, { rpc: convergedConfigRpc(ctx), cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS, signal: options.signal });
  secretMaterial.note(
    await mountPatchSecretMaterialReasons(ctx, configBefore, configPatch.noop === true),
  );
  const retiredAccountIds = managedProjectIds.map((projectId) => `${snapshot.slug}-proj-${projectId}`)
    .filter((accountId) => !projectAccounts[accountId]);
  for (const accountId of retiredAccountIds) await ctx.rpc.channelsStop({ channel: "mattermost", accountId });
  const removedSecrets = await updateMattermostAccountSecrets(OPENCLAW_DIR, { remove: [...new Set([...projectSecrets.remove, ...retiredAccountIds])] });
  secretMaterial.noteIf(removedSecrets.changed, "Mattermost account secrets file changed");
  await releaseAgentsAndInvalidateCache(ctx, retiredAgentIds, logPrefix, { purgeStore: true });
  await settleProjectAgentActivations(ctx, {
    snapshot, projectAgents: preparedProjectAgents, channels: brokerSnapshot.channels, baseline, secretMaterial, signal: options.signal,
    activate: async () => {
      if (pendingAccountIds.length === 0) return;
      markMattermostRoutingActivationPending(OPENCLAW_DIR, logPrefix, pendingAccountIds, baseline);
      await activatePendingMattermostRouting(ctx.rpc, OPENCLAW_DIR, ctx.log, { restartAccountIds: pendingAccountIds });
    },
  });
  return { elapsedMs: Date.now() - startedAt, appliedFingerprint };
}

async function removeUserAccountsWhileStillEvicted(
  ctx: BrokerCtx,
  slug: string,
  slugs: readonly string[],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): Promise<void> {
  const logPrefix = `[remove:${slug}]`;
  let batch = slugs;
  try {
    await applyConfigPatch(
      {
        buildPatch: (current) => buildRemoveUserAccountsPatch(current, batch),
        buildReplacePaths: (current) => [...new Set(
          batch.flatMap((batchSlug) => userConfigReplacePaths(current, batchSlug)),
        )],
        logPrefix,
        beforeRetry: currentEvictionBatch && (async () => {
          const stillEvicted = new Set(await currentEvictionBatch());
          const desiredAgain = batch.filter((batchSlug) => !stillEvicted.has(batchSlug));
          if (desiredAgain.length > 0) {
            ctx.log(`${logPrefix} ${desiredAgain.join(",")} desired on this gateway again — not removing on retry`);
          }
          batch = batch.filter((batchSlug) => stillEvicted.has(batchSlug));
          return batch.length > 0;
        }),
      },
      {
        rpc: convergedConfigRpc(ctx),
        cache: ctx.configCache,
        totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      },
    );
  } catch (err) {
    if (batch.length > 0) throw err;
  }
}

async function applyRemoveUserConfigPatch(
  ctx: BrokerCtx,
  slug: string,
  _agentId: string,
  evictionBatch?: readonly string[],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const slugs = [...new Set([slug, ...(evictionBatch ?? [])])];
  if (!ctx.configRemovedForEviction.has(slug)) {
    await deleteDepartingUserAgents(ctx, slugs, `[remove:${slug}]`);
    await removeUserAccountsWhileStillEvicted(ctx, slug, slugs, currentEvictionBatch);
    for (const batchSlug of slugs) ctx.configRemovedForEviction.add(batchSlug);
  }
  const remaining = currentEvictionBatch
    ? [...new Set(await currentEvictionBatch())].filter((batchSlug) => slugs.includes(batchSlug))
    : slugs;
  if (remaining.length > 0) {
    await stopStaleMattermostRoutingAccounts(ctx.rpc, {
      currentSlug: remaining[0]!,
      desiredAccountIds: [],
      evictionSlugs: remaining.slice(1),
    }, dlog);
    discardMattermostRoutingActivationForUsers(OPENCLAW_DIR, remaining);
  }
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    remove: remaining.map((batchSlug) => `${batchSlug}-coach`),
    removePrefixes: remaining.map((batchSlug) => `${batchSlug}-proj-`),
  });
  ctx.configRemovedForEviction.delete(slug);
  return remaining;
}

async function waitForAccountHealthy(
  ctx: BrokerCtx,
  { slug, timeoutMs }: { slug: string; timeoutMs: number },
): Promise<boolean> {
  const accountId = `${slug}-coach`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const snapshot = (await ctx.rpc.channelsStatus()) as {
        channelAccounts?: Record<string, Array<{ accountId?: string; running?: boolean; connected?: boolean }>>;
      };
      const entry = (snapshot.channelAccounts?.mattermost ?? []).find(
        (a) => a.accountId === accountId,
      );
      if (entry?.running === true && entry.connected === true) return true;
    } catch (err) {
      ctx.log(
        `[verify:${slug}] attempt=${attempt} channels.status threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, Math.min(2_000 * attempt, 5_000)));
  }
  return false;
}

async function logActivatedDefaultAgentModel(ctx: BrokerCtx, slug: string): Promise<void> {
  if (logLevel() !== "debug") return;
  try {
    const agentId = userDefaultAgentId(slug);
    const { config } = await ctx.rpc.configGet();
    const agent = (config as { agents?: { entries?: Record<string, { model?: unknown }> } }).agents?.entries?.[agentId];
    ctx.log(
      `[import:${slug}] post-activation agent model=${JSON.stringify(agent?.model ?? null)} (config-patch hot-reload)`,
    );
  } catch (err) {
    ctx.log(
      `[import:${slug}] post-activation agent model diagnostic unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function quiesceUser(
  ctx: BrokerCtx,
  slug: string,
  timeoutMs: number,
  opts: { stopMattermost: boolean; schedulerMigrationId?: string; retainNonportable?: boolean } = { stopMattermost: true },
): Promise<{ drained: boolean; runningCount: number }> {
  const agentIds = agentIdsForMigration(slug);
  if (opts.stopMattermost) {
    await setUserChannelsRunning(ctx.rpc, slug, false);
  }
  const result = await quiesceUserSessionsBounded({
    rpc: ctx.rpc,
    slug,
    agentIds,
    stores: sessionPathsForMigration(slug).map(sessionStoreForPath),
    maxWaitMs: timeoutMs,
    abortAfterGrace: false,
    ...(opts.stopMattermost
      ? {
        schedulerMigrationId: opts.schedulerMigrationId,
        retainNonportable: opts.retainNonportable,
        graceMs: Math.min(MIGRATION_QUIESCE_GRACE_MS, timeoutMs),
        recheckMs: Math.min(MIGRATION_QUIESCE_STOP_RECHECK_MS, timeoutMs),
      }
      : { graceMs: Math.min(MIGRATION_QUIESCE_GRACE_MS, timeoutMs), abortAfterGrace: false }),
    log: dlog,
  });
  return { drained: result.drained, runningCount: result.runningCount };
}

function sessionPathsForMigration(slug: string): string[] {
  const stateDir = resolveOpenClawStateDir();
  if (isConfiguredGatewayUser(slug)) {
    const plan = configuredUserPortableStatePlan(OPENCLAW_CONFIG, stateDir);
    assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan);
    return plan.sessionStorePaths.map((relativePath) =>
      path.join(stateDir, ...relativePath.split("/")));
  }
  return agentIdsForMigration(slug).map((agentId) =>
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json"));
}


export function agentIdsForMigration(slug: string): string[] {
  const stateDir = resolveOpenClawStateDir();
  if (isConfiguredGatewayUser(slug)) {
    const plan = configuredUserPortableStatePlan(OPENCLAW_CONFIG, stateDir);
    assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan);
    return plan.agentIds;
  }
  return sharedMigrationAgentIds(stateDir, slug);
}

interface AgentStateRelease {
  releaseAgents: (agentIds: readonly string[]) => Promise<void>;
  procRoot: string;
}

async function releaseAgentState(
  agentIds: readonly string[],
  release: AgentStateRelease,
  heldPathOptions: HeldPathOptions = {},
): Promise<string[]> {
  const stateDir = resolveOpenClawStateDir();
  const agentDirs = agentIds.map((agentId) => path.join(stateDir, "agents", agentId));
  await release.releaseAgents(agentIds);
  for (const agentDir of agentDirs) await assertNotHeld(matchUnder(agentDir), release.procRoot, heldPathOptions);
  return agentDirs;
}

async function removeAgentDirs(agentDirs: readonly string[]): Promise<void> {
  for (const agentDir of agentDirs) await fsp.rm(agentDir, { recursive: true, force: true });
}

async function listExportPaths(slug: string): Promise<Array<{ cwd: string; path: string }>> {
  const stateDir = resolveOpenClawStateDir();
  const builderPlan = isConfiguredGatewayUser(slug)
    ? configuredUserPortableStatePlan(OPENCLAW_CONFIG, stateDir)
    : null;
  if (builderPlan) assertConfiguredUserPortableStatePlanOnDisk(stateDir, builderPlan);
  if (!builderPlan && stateDir === OPENCLAW_DIR) return sharedMigrationExportPaths(stateDir, slug);
  const candidates = [
    ...(builderPlan
      ? builderPlan.paths
        .filter((item) => !isSafeDefaultAgentPortableStatePath(item.relativePath))
        .map((item) => ({ cwd: stateDir, path: item.relativePath }))
      : [
        ...agentIdsForMigration(slug).map((agentId) => ({
          cwd: stateDir,
          path: path.join("agents", agentId),
        })),
      ]),
    ...await userFileStatePaths(OPENCLAW_DIR, slug),
  ];
  const sources: Array<{ cwd: string; path: string }> = [];
  for (const c of candidates) {
    try {
      await fsp.access(path.join(c.cwd, c.path));
      sources.push(c);
    } catch {
      // Partial local state is valid.
    }
  }
  return sources;
}

async function prepareImportDir(
  slug: string,
  mode: UserStateImportMode,
  release: AgentStateRelease,
): Promise<string> {
  const stateDir = resolveOpenClawStateDir();
  const builderPlan = isConfiguredGatewayUser(slug)
    ? configuredUserPortableStatePlan(OPENCLAW_CONFIG, stateDir)
    : null;
  if (builderPlan) assertConfiguredUserPortableStatePlanOnDisk(stateDir, builderPlan);
  const wipeState = mode !== "final" && !builderPlan;
  if (wipeState) await removeAgentDirs(await releaseAgentState(agentIdsForMigration(slug), release));
  const wipePaths = !wipeState ? [] : [
    path.join(OPENCLAW_DIR, "customers", slug),
    path.join(OPENCLAW_DIR, MIGRATION_ACTIVATION_DIR, slug),
  ];
  if (mode === "default" && !builderPlan) {
    wipePaths.push(path.join(OPENCLAW_DIR, "customer-keys", slug));
  }
  for (const p of wipePaths) {
    await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
  await fsp.mkdir(path.join(stateDir, "agents"), { recursive: true });
  if (builderPlan) {
    for (const relativeAgentDir of builderPlan.agentDirs) {
      await fsp.mkdir(path.join(stateDir, ...relativeAgentDir.split("/")), {
        recursive: true,
        mode: 0o700,
      });
    }
    assertConfiguredUserPortableStatePlanOnDisk(stateDir, builderPlan);
  } else if (mode !== "final") {
    await fsp.mkdir(path.join(stateDir, "agents", userDefaultAgentId(slug), "agent"), {
      recursive: true,
    });
  }
  await fsp.mkdir(CUSTOMERS_DIR, { recursive: true });
  await fsp.mkdir(CUSTOMER_KEYS_DIR, { recursive: true });
  return OPENCLAW_DIR;
}

async function prepareKeyImportDir(slug: string): Promise<string> {
  await fsp.rm(path.join(OPENCLAW_DIR, "customer-keys", slug), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  await fsp.mkdir(CUSTOMER_KEYS_DIR, { recursive: true });
  return OPENCLAW_DIR;
}

async function sourceMigrationIdentityCustody(ctx: BrokerCtx, slug: string, migrationId: string): Promise<MigrationSourceIdentityCustody> {
  const gatewayId = process.env.GATEWAY_ID ?? "", podUid = process.env.POD_UID ?? "";
  const uid = await ctx.client.uidForSlug(slug);
  const snapshot = uid ? await ctx.client.userSnapshot(uid) : null;
  const assignments = (await ctx.client.assignmentRoster()).filter(assignment => assignment.uid === uid);
  if (!uid || snapshot?.uid !== uid || snapshot.slug !== slug || snapshot.gatewayId !== gatewayId ||
      snapshot.status !== "complete" ||
      assignments.length !== 1 || !["serving", "quiescing"].includes(assignments[0].state)) {
    throw new Error("Source workspace identity requires its current assigned user");
  }
  const custody = { migrationId, uid, gatewayId, podUid, epoch: assignments[0].epoch };
  assertSourceIdentityCustody(custody, custody);
  return custody;
}

async function sourceIdentityForResume(ctx: BrokerCtx, manifest: Awaited<ReturnType<typeof readActivationManifest>>, opts: { resumeExistingSharedCustody?: boolean; migrationId?: string }): Promise<MigrationSourceIdentityCustody | undefined> {
  if (!opts.resumeExistingSharedCustody) return undefined;
  const custody = await sourceMigrationIdentityCustody(ctx, manifest.slug, opts.migrationId ?? "");
  if (manifest.sourceWorkspaceIdentities) {
    assertSourceIdentityCustody(manifest.sourceWorkspaceIdentities, custody);
    await captureSourceWorkspaceIdentities(manifest, resolveOpenClawStateDir(), custody);
  } else {
    const assignedCapture = assignedCaptureForSourceResume(manifest, custody);
    const current = await freshRosterConfig(ctx) as { agents?: { entries?: Record<string, Record<string, unknown>>; list?: Array<Record<string, unknown>> } };
    const roster: Array<Record<string, unknown>> = current.agents?.entries ? Object.entries(current.agents.entries).map(([id, agent]) => ({ ...agent, id })) : current.agents?.list ?? [];
    for (const entry of [manifest, ...manifest.projectAgents]) {
      const matches = roster.filter(agent => agent.id === entry.agentId);
      if (matches.length !== 1 || matches[0].workspace !== entry.agent.workspace ||
          typeof entry.agent.workspace !== "string" ||
          entry.agent.agentDir !== undefined && matches[0].agentDir !== entry.agent.agentDir) {
        throw new Error("Source rollback without an identity capture requires its intact Native roster");
      }
    }
    if (assignedCapture) await assertSourceResumeCurrent(ctx, manifest, custody);
  }
  return custody;
}

function assignedCaptureForSourceResume(manifest: MigrationActivationManifest, custody: MigrationSourceIdentityCustody): TargetWorkspaceIdentities | undefined {
  const capture = manifest.targetWorkspaceIdentities;
  if (!capture) return undefined;
  if (capture.migrationId !== undefined || capture.assignmentEpoch === undefined) throw new Error("Source rollback cannot consume a migration-bound target identity capture");
  assertTargetIdentityCustody(capture, { uid: custody.uid, gatewayId: custody.gatewayId, podUid: custody.podUid, assignmentEpoch: custody.epoch });
  return capture;
}

async function assertSourceResumeCurrent(ctx: BrokerCtx, manifest: Awaited<ReturnType<typeof readActivationManifest>>, custody: MigrationSourceIdentityCustody): Promise<void> {
  assertSourceIdentityCustody(custody, await sourceMigrationIdentityCustody(ctx, manifest.slug, custody.migrationId));
  if (!isDeepStrictEqual(manifest, await readActivationManifest(OPENCLAW_DIR, manifest.slug))) {
    throw new Error("Source rollback activation manifest changed");
  }
}

async function restoreSourceIdentityAfterRoster(ctx: BrokerCtx, manifest: Awaited<ReturnType<typeof readActivationManifest>>, safeManifest: Awaited<ReturnType<typeof readActivationManifest>>, custody: MigrationSourceIdentityCustody | undefined): Promise<void> {
  if (!custody) return;
  const assertCurrent = () => assertSourceResumeCurrent(ctx, manifest, custody);
  if (safeManifest.sourceWorkspaceIdentities) {
    await assertCurrent();
    await restoreSourceWorkspaceIdentities(safeManifest, resolveOpenClawStateDir(), custody, assertCurrent);
  } else {
    const capture = assignedCaptureForSourceResume(manifest, custody);
    if (capture) await restoreTargetWorkspaceIdentities(capture, manifest.slug, activationManifestAgentIds(manifest), resolveOpenClawStateDir(), { custody: capture, assertCurrent, privateWorkspaces: privateProjectWorkspaceAgentIds(manifest) });
  }
}

function sharedImportWithoutIdentityWitness(ctx: BrokerCtx, opts: { resumeExistingSharedCustody?: boolean; migrationId?: string; beforeRuntimePublish?: () => Promise<void> }): boolean {
  return !ctx.isIsolatedGateway() && !opts.resumeExistingSharedCustody && !!opts.migrationId && !opts.beforeRuntimePublish;
}

function importedRosterNeedsAcknowledgement(manifest: MigrationActivationManifest, sourceIdentity: MigrationSourceIdentityCustody | undefined): boolean {
  return !sourceIdentity || manifest.sourceWorkspaceIdentities !== undefined || manifest.targetWorkspaceIdentities !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function keepIsolatedRuntimeDormant(ctx: BrokerCtx): Promise<void> {
  await applyConfigPatch({ buildPatch: current => ({
    cron: { enabled: false },
    channels: Object.fromEntries(Object.keys(asRecord(asRecord(current)?.channels) ?? {})
      .map(id => [id, { enabled: false }])),
  }) }, { rpc: ctx.rpc, cache: ctx.configCache, log: ctx.log });
}

async function prepareImportControlRuntime(ctx: BrokerCtx, slug: string, signal?: AbortSignal) {
  const configuredBuilder = isConfiguredGatewayUser(slug);
  if (!configuredBuilder) return { configuredBuilder, ownerMmUserId: undefined };
  const ownerMmUserId = validOwnerMmUserId(slug, (await snapshotForSlug(ctx, slug))?.customerMmUserId);
  ctx.log(`[import:${slug}] waiting for the user control runtime before roster activation`);
  const controlRuntimeWaitStartedAt = Date.now();
  await waitForAppliedConfigRevision(ctx.rpc, slug, {
    timeoutMs: USER_IMPORT_STARTUP_TIMEOUT_MS,
    signal,
    acceptSupersedingRevision: true,
  });
  ctx.log(`[import:${slug}] User control runtime is ready for roster activation in ${Date.now() - controlRuntimeWaitStartedAt}ms`);
  return { configuredBuilder, ownerMmUserId };
}

async function prepareImportedProjectAgents(ctx: BrokerCtx, manifest: MigrationActivationManifest, signal?: AbortSignal) {
  const { slug } = manifest;
  const githubProjectAgents = manifest.projectAgents.flatMap(entry => {
    const agent = parseAgentId(entry.agentId);
    return agent.kind === "project" && entry.agent.workspace === projectAgentWorkspace(path.join(CUSTOMERS_DIR, slug), agent.project) ? [agent.project] : [];
  });
  await restoreGithubProjectAgentWorkspaces(slug, githubProjectAgents, signal);
  const control = await prepareImportControlRuntime(ctx, slug, signal);
  const projectSnapshot = control.configuredBuilder && githubProjectAgents.length > 0 ? await snapshotForSlug(ctx, slug) : null;
  return { ...control, projectSnapshot };
}

async function activateImportedUser(
  ctx: BrokerCtx,
  slug: string,
  opts: { signal?: AbortSignal; resumeExistingSharedCustody?: boolean; migrationId?: string; beforeRuntimePublish?: () => Promise<void>; deferRuntimeVerification?: true } | undefined,
): Promise<{ appliedFingerprint: string; verificationPending?: string }> {
  opts ??= {};
  if (sharedImportWithoutIdentityWitness(ctx, opts)) {
    throw new Error("Shared migration activation requires an original workspace identity witness");
  }
  const manifest = await readActivationManifest(OPENCLAW_DIR, slug);
  const sourceIdentity = await sourceIdentityForResume(ctx, manifest, opts);
  const { configuredBuilder, ownerMmUserId, projectSnapshot } = await prepareImportedProjectAgents(ctx, manifest, opts.signal);
  const secretMaterial = ctx.pendingRuntimeSecrets.get(slug) ?? createSecretMaterialLedger();
  ctx.pendingRuntimeSecrets.set(slug, secretMaterial);
  const { manifest: safeManifest, secretsChanged } = await materializeActivationManifestSecret(
    OPENCLAW_DIR,
    manifest,
  );
  secretMaterial.noteIf(secretsChanged, "Mattermost account secrets file changed");
  const routingActivationReason = `[import:${slug}] account-level Mattermost binding changed`;
  setRepoSshCommand(path.join(CUSTOMERS_DIR, slug), slug);
  ctx.log(`[import:${slug}] canonical workspace Git metadata ready`);
  const reportSharedAnchors = await prepareUserSharedAnchors(ctx, {
    slug, agentIds: activationManifestAgentIds(safeManifest), allowQuiescingExisting: opts.resumeExistingSharedCustody, migrationId: opts.migrationId,
  });
  await deleteSupersededUserAgents(ctx, {
    slug,
    evictionSlugs: [],
    keepAgentIds: activationManifestAgentIds(safeManifest),
    logPrefix: `[import:${slug}]`,
    purpose: "import",
  });
  if (importedRosterNeedsAcknowledgement(safeManifest, sourceIdentity)) {
    await ensureUserRosterAgents(ctx, [
      safeManifest.agent,
      ...safeManifest.projectAgents.map((entry) => entry.agent),
    ], `[import:${slug}]`, {
      signal: opts.signal,
      waitForAppliedRevision: ctx.isIsolatedGateway(),
    });
  }
  if (configuredBuilder && opts.deferRuntimeVerification) await keepIsolatedRuntimeDormant(ctx);
  await restoreSourceIdentityAfterRoster(ctx, manifest, safeManifest, sourceIdentity);
  await reportSharedAnchors?.();
  await materializeUserBrokerProfiles(
    activationManifestAgentIds(safeManifest),
    slug,
    ctx.log,
    secretMaterial,
    `[import:${slug}]`,
  );
  if (ctx.isIsolatedGateway()) {
    const restore = await restoreModelCredentialOauthStoreForSlug(slug, {
      logFn: (message) => ctx.log(`[import:${slug}] ${message}`),
    });
    secretMaterial.noteIf(restore.restored, "model credential OAuth store restored");
  }
  const accountIds = [
    safeManifest.accountId,
    ...safeManifest.projectAgents.map((agent) => agent.accountId),
  ];
  const routingActivationBaseline = await captureMattermostRoutingActivationBaseline(
    ctx.rpc,
    accountIds,
  );
  if (sourceIdentity) await assertSourceResumeCurrent(ctx, manifest, sourceIdentity);
  await prepareUserRuntimePublication(opts);
  const patch = await applyOpenClawActivationManifest(safeManifest, {
    rpc: ctx.rpc,
    cache: ctx.configCache,
    signal: opts.signal,
    log: ctx.log,
    gatewayClass: ctx.isIsolatedGateway() ? "isolated" : "shared",
    ...(configuredBuilder
      ? {
        authInheritanceAnchor: {
          agentId: SAFE_DEFAULT_AGENT_ID,
          agent: buildSafeDefaultAgent(),
        },
        ownerCommandsPatch: (current: unknown) => userOwnerCommandsPatch(current, slug, ownerMmUserId),
        projectCheckoutCwd: (agent: Record<string, unknown>, current: unknown) => {
          const parsed = parseAgentId(String(agent.id));
          if (parsed.kind !== "project" || !projectSnapshot || !githubCheckoutReady(projectSnapshot, parsed.project)) return undefined;
          const sandbox = (agent.sandbox as ProjectRosterEntry["sandbox"])?.mode ?? projectRosterConfig(current)?.defaults?.sandbox?.mode ?? "off";
          return sandbox === "off" ? path.join(CUSTOMERS_DIR, slug, "projects", parsed.project) : undefined;
        },
      }
      : {}),
    onRoutingActivationRequired: (accountIds) => {
      markMattermostRoutingActivationPending(
        OPENCLAW_DIR,
        routingActivationReason,
        accountIds,
        routingActivationBaseline,
      );
    },
  });
  ctx.log(`[import:${slug}] activation config patch in ${patch.elapsedMs}ms`);
  secretMaterial.noteIf(patch.configNoop !== true, "activation config patch changed the config");
  if (opts.deferRuntimeVerification) {
    await waitForAppliedConfigRevision(ctx.rpc, slug, { signal: opts.signal });
    return { appliedFingerprint: manifest.appliedFingerprint };
  }
  const verificationPending = await settleActivatedImport(ctx, {
    slug,
    patch,
    secretMaterial,
    signal: opts.signal,
    configuredUserRouting: configuredBuilder
      ? { accountIds, baseline: routingActivationBaseline }
      : undefined,
  });
  return { appliedFingerprint: manifest.appliedFingerprint, verificationPending };
}

// The patch above is the commit: from here the user is this gateway's, and
// every step is verification of a runtime that is reloading around it. Reporting
// a step it could not confirm keeps the import — rolling it back would unmount
// work that succeeded and send the retry into the same reload.
async function settleActivatedImport(
  ctx: BrokerCtx,
  input: {
    slug: string;
    patch: {
      routingActivationRequired: boolean;
      restartExistingAccountIds?: string[];
      configNoop?: boolean;
    };
    secretMaterial: SecretMaterialLedger;
    signal?: AbortSignal;
    configuredUserRouting?: {
      accountIds: readonly string[];
      baseline: Readonly<Record<string, number>>;
    };
  },
): Promise<string | undefined> {
  const { slug, patch, secretMaterial, signal, configuredUserRouting } = input;
  try {
    await waitForAppliedConfigRevision(ctx.rpc, slug, { signal });
    await reloadRuntimeSecretsIfChanged(ctx, `[import:${slug}]`, secretMaterial, signal);
    if (ctx.pendingRuntimeSecrets.get(slug) === secretMaterial) ctx.pendingRuntimeSecrets.delete(slug);
    if (configuredUserRouting && patch.configNoop === true) {
      await activateMattermostRoutingAfterConfigPatch(
        ctx.rpc,
        OPENCLAW_DIR,
        ctx.log,
        {
          accountIds: configuredUserRouting.accountIds,
          baseline: configuredUserRouting.baseline,
          configNoop: true,
          required: patch.routingActivationRequired,
          reason: `[import:${slug}] account-level Mattermost binding changed`,
          currentSlug: slug,
          evictionSlugs: [],
        },
      );
    } else if (
      patch.routingActivationRequired || mattermostRoutingActivationPending(OPENCLAW_DIR)
    ) {
      await activatePendingMattermostRouting(
        ctx.rpc,
        OPENCLAW_DIR,
        ctx.log,
        {
          restartAccountIds: patch.restartExistingAccountIds ?? [],
          restartConfiguredPending: true,
        },
      );
    }
    await removeActivationManifest(OPENCLAW_DIR, slug);
    await logActivatedDefaultAgentModel(ctx, slug);
    ctx.log(`[import:${slug}] activation complete`);
    return undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return reportPendingVerification(
      ctx,
      slug,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function reportPendingVerification(ctx: BrokerCtx, slug: string, reason: string): string {
  ctx.log(
    `[import:${slug}] ⚠ activation committed; verification incomplete — the reconcile ` +
    `converges the rest: ${reason}`,
  );
  return reason;
}

export function projectCheckoutScopeForRuntime(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): FleetBrokerProjectCheckoutScope {
  const gatewayClass = env.GATEWAY_CLASS?.trim();
  const includesProjects = gatewayClass === "shared" || (
    isIsolatedGatewayClassValue(gatewayClass) &&
    userClaimSlug(env) === slug
  );
  return includesProjects
    ? "workspace-and-projects"
    : WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
}

async function stopRetainedConfiguredUserAccounts(ctx: BrokerCtx, slug: string): Promise<SurgeOpenClawProcessGateState | null> {
  try {
    await stopStaleMattermostRoutingAccounts(ctx.rpc, {
      currentSlug: slug,
      desiredAccountIds: [],
      evictionSlugs: [],
    }, dlog);
    return null;
  } catch (error) {
    const status = await createSurgeOpenClawProcessSupervisorClient(OPENCLAW_DIR).status().catch((statusError) => {
      ctx.log(`[remove:${slug}] cannot verify held OpenClaw: ${String(statusError)}`);
      return null;
    });
    if (!process.env.POD_UID || status?.podUid !== process.env.POD_UID ||
      status.mode !== "held" || !["held", "cancelling"].includes(status.phase)) throw error;
    ctx.log(`[remove:${slug}] OpenClaw supervisor confirms this pod has no running chat accounts`);
    return status;
  }
}

async function uninitializedHeldUser(agentIds: readonly string[], held: SurgeOpenClawProcessGateState | null): Promise<boolean> {
  if (!held) return false;
  const config = readOpenClawConfig() as { database?: Parameters<typeof uninitializedUserState>[2] };
  if (!uninitializedUserState(resolveOpenClawStateDir(), agentIds, config.database ?? {}, held.podUid)) return false;
  const current = await createSurgeOpenClawProcessSupervisorClient(OPENCLAW_DIR).status();
  return JSON.stringify(current) === JSON.stringify(held);
}

interface HeldDetachReceipt {
  ok?: boolean;
  agentId?: string;
  detached?: boolean;
  storePreserved?: boolean;
  purgeFailed?: boolean;
  failed?: unknown[];
  error?: { type?: string; message?: string };
}

function hasPreservedAgentDetach(payload: HeldDetachReceipt | null, agentId: string): boolean {
  return payload?.ok === true && payload.agentId === agentId &&
    payload.detached === true && payload.storePreserved === true &&
    payload.purgeFailed !== true && (payload.failed?.length ?? 0) === 0;
}

function heldDetachAlreadyAbsent(result: OpenClawCommandResult, agentId: string): boolean {
  let payload: HeldDetachReceipt | null;
  try { payload = JSON.parse(result.stdout); }
  catch { throw new Error(`Native offline detach returned invalid JSON for ${agentId}`); }
  if (result.code === 1 && payload?.ok === false && payload.error?.type === "cli_error" &&
      payload.error.message === `agent "${agentId}" not found`) return true;
  if (result.code !== 0 || !hasPreservedAgentDetach(payload, agentId)) {
    const reason = typeof payload?.error?.message === "string" ? `: ${payload.error.message}` : "";
    throw new Error(`Native offline detach did not confirm preserved stores for ${agentId} (exit ${result.code})${reason}`);
  }
  return false;
}

async function detachHeldImportedAgents(
  ctx: BrokerCtx,
  slug: string,
  agentIds: readonly string[],
  target: NonNullable<Parameters<NonNullable<UserLifecycleAdapter["removeImportedUserBySlug"]>>[3]>,
): Promise<void> {
  const supervisor = createSurgeOpenClawProcessSupervisorClient(OPENCLAW_DIR);
  const assertHeld = async () => {
    await target.assertCurrent();
    const current = await supervisor.status();
    if (!process.env.POD_UID || current.podUid !== process.env.POD_UID ||
        current.role !== "target" || current.mode !== "held" ||
        !["held", "cancelling"].includes(current.phase) ||
        current.migrationId !== target.migrationId || current.slug !== slug ||
        current.targetPodUid !== target.targetPodUid || current.podUid !== target.targetPodUid) {
      throw new Error("import cleanup no longer owns its stopped isolated target");
    }
  };
  try {
    for (const agentId of agentIds) {
      await assertHeld();
      const result = await runOpenClaw(["agents", "detach", agentId, "--force", "--json"], {
        env: { ...process.env, OPENCLAW_STATE_DIR: resolveOpenClawStateDir(), OPENCLAW_CONFIG_PATH: OPENCLAW_CONFIG },
      });
      await assertHeld();
      if (heldDetachAlreadyAbsent(result, agentId)) {
        ctx.log(`[remove:${slug}] Native reports ${agentId} already absent after deletion admission`);
        continue;
      }
      ctx.log(`[remove:${slug}] Native detached ${agentId} offline and confirmed preserved stores`);
    }
    await assertHeld();
  } finally { invalidateConfigCache(ctx); }
}

async function removeImportedUserBySlug(
  ctx: BrokerCtx,
  slug: string,
  options: {
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
    targetCleanup?: Parameters<NonNullable<UserLifecycleAdapter["removeImportedUserBySlug"]>>[3];
    erasureAgentIds?: readonly string[];
  },
): Promise<RemoveUserResult> {
  const { evictionBatch, currentEvictionBatch, targetCleanup, erasureAgentIds } = options;
  assertSharedErasureAgentCoverage(slug, erasureAgentIds);
  const wasMounted =
    fs.existsSync(path.join(CUSTOMERS_DIR, slug)) ||
    listLocalDefaultAgentWiredSlugs(CUSTOMERS_DIR, (s) => s === slug).includes(slug);
  if (!wasMounted && !isConfiguredGatewayUser(slug) && !erasureAgentIds) return { wasMounted: false, steps: [] };
  if (isConfiguredGatewayUser(slug)) {
    const held = await stopRetainedConfiguredUserAccounts(ctx, slug);
    const agentIds = agentIdsForMigration(slug).filter(agentId => !isSafeDefaultAgentPortableStatePath(`agents/${agentId}`));
    if (await uninitializedHeldUser(agentIds, held)) ctx.log(`[remove:${slug}] no user Native state exists on this held pod; retained user configuration`);
    else if (held && targetCleanup) await detachHeldImportedAgents(ctx, slug, agentIds, targetCleanup);
    else await releaseAgentsAndInvalidateCache(ctx, agentIds, `[remove:${slug}]`);
    clearMountedMarker(CUSTOMERS_DIR, slug);
    clearMigratingInPin(CUSTOMERS_DIR, slug);
    ctx.configRemovedForEviction.delete(slug);
    await removeActivationManifest(OPENCLAW_DIR, slug);
    dlog(`[remove:${slug}] retained configured user overlay during imported cleanup`);
    return { wasMounted: true, steps: [], retained: true };
  }
  const remaining = await applyRemoveUserConfigPatch(
    ctx,
    slug,
    userDefaultAgentId(slug),
    evictionBatch,
    currentEvictionBatch,
  );
  if (!remaining.includes(slug)) {
    ctx.configRemovedForEviction.delete(slug);
    return { wasMounted: true, steps: ["config-patch-remove"], retained: true };
  }
  if (currentEvictionBatch && !(await currentEvictionBatch()).includes(slug)) {
    ctx.configRemovedForEviction.delete(slug);
    return { wasMounted: true, steps: ["config-patch-remove"], retained: true };
  }
  const agentDirs = await releaseAgentState(
    [...new Set([...agentIdsForMigration(slug), ...(erasureAgentIds ?? [])])],
    agentStateRelease(ctx, `[remove:${slug}]`),
    { ignoreReadOnlyConnections: true },
  );
  await removeDepartedUserFileState(slug, { log: ctx.log });
  if (!isConfiguredGatewayUser(slug)) {
    await fsp.rm(path.join(CUSTOMER_KEYS_DIR, slug), { recursive: true, force: true });
  }
  await removeAgentDirs(agentDirs);
  await removeActivationManifest(OPENCLAW_DIR, slug);
  await assertSharedErasureRosterRemoved(ctx, slug, erasureAgentIds);
  return { wasMounted, steps: ["config-patch-remove", "delete-dir"],
    ...(erasureAgentIds ? { releasedAgentIds: [...erasureAgentIds] } : {}) };
}

function assertSharedErasureAgentCoverage(slug: string, agentIds: readonly string[] | undefined): void {
  if (agentIds && (isConfiguredGatewayUser(slug) || agentIds.some(id => !agentIdBelongsToSlug(id, slug)))) {
    throw new Error("Invalid Shared user erasure agent coverage");
  }
}

async function assertSharedErasureRosterRemoved(ctx: BrokerCtx, slug: string, agentIds: readonly string[] | undefined): Promise<void> {
  if (agentIds && userAgentIdsInRoster(await freshRosterConfig(ctx), slug).length > 0) {
    throw new Error("Shared user erasure retained configured Native agents");
  }
}

async function resumeAssignedIsolatedRuntime(ctx: BrokerCtx, slug: string): Promise<void> {
  if (!ctx.isIsolatedGateway() || !isConfiguredGatewayUser(slug)) throw new Error("Target runtime activation requires its configured user");
  const uid = await ctx.client.uidForSlug(slug);
  const [snapshot, assignments] = await Promise.all([uid ? ctx.client.userSnapshot(uid) : null, ctx.client.assignmentRoster()]);
  if (!uid || !snapshot || snapshot.gatewayId !== process.env.GATEWAY_ID || snapshot.slug !== slug ||
      snapshot.runtimeMutationFenced !== false ||
      !assignments.some(assignment => assignment.uid === uid && assignment.state === "serving")) {
    throw new Error("Target runtime activation requires its current serving assignment");
  }
  const desired = readAcceptedUserConfig(OPENCLAW_DIR);
  const secrets = ctx.pendingRuntimeSecrets.get(slug);
  if (secrets) {
    await reloadRuntimeSecretsIfChanged(ctx, `[resume:${slug}]`, secrets);
    ctx.pendingRuntimeSecrets.delete(slug);
  }
  const talk = asRecord(desired.talk);
  await applyConfigPatch({ buildPatch: () => ({
    cron: { enabled: asRecord(desired.cron)?.enabled ?? true },
    ...(talk ? { talk: { agentId: talk.agentId ?? null } } : {}),
    channels: Object.fromEntries(Object.entries(asRecord(desired.channels) ?? {}).map(([id, channel]) => {
      const entry = asRecord(channel);
      const accounts = asRecord(entry?.accounts);
      return [id, { enabled: entry?.enabled ?? true, ...(accounts ? {
        accounts: Object.fromEntries(Object.entries(accounts).map(([accountId, account]) =>
          [accountId, { enabled: asRecord(account)?.enabled ?? true }])),
      } : {}) }];
    })),
  }) }, { rpc: ctx.rpc, cache: ctx.configCache, log: ctx.log });
  await setUserChannelsRunning(ctx.rpc, slug, true);
  await enableSystemConfigWatch(OPENCLAW_DIR, slug);
  await removeActivationManifest(OPENCLAW_DIR, slug);
}

function runtimeUpdateOperations(ctx: BrokerCtx): Pick<UserLifecycleAdapter,
  "applyAddUserConfigPatch" | "reconcileConfiguredUserProjectAgents" | "applyRemoveUserConfigPatch" | "resumeUser" |
  "prepareImportDir" | "activateImportedUser" | "removeImportedUserBySlug" | "releaseAgent"> {
  return {
    applyAddUserConfigPatch: (snapshot, mmUpdate, callOpts) =>
      openClawRuntimeUpdateGuard.run(async () => {
        callOpts?.runtimePublication?.invalidateFingerprint();
        return applyAddUserConfigPatch(ctx, snapshot, mmUpdate, callOpts);
      }, {
        signal: callOpts?.signal,
        slug: snapshot.slug,
        evicting: callOpts?.evictionBatch,
        holdUntil: callOpts?.runtimePublication?.settled,
      }),
    reconcileConfiguredUserProjectAgents: (snapshot, options) =>
      openClawRuntimeUpdateGuard.run(async () => {
        options?.runtimePublication?.invalidateFingerprint();
        return reconcileConfiguredUserProjectAgents(ctx, snapshot, options);
      }, {
        signal: options?.signal,
        slug: snapshot.slug,
        holdUntil: options?.runtimePublication?.settled,
      }),
    applyRemoveUserConfigPatch: (slug, agentId, evictionBatch, currentEvictionBatch) =>
      openClawRuntimeUpdateGuard.run(() =>
        applyRemoveUserConfigPatch(ctx, slug, agentId, evictionBatch, currentEvictionBatch), { slug, evicting: evictionBatch }),
    resumeUser: (slug, resumeOptions) => openClawRuntimeUpdateGuard.run(async () => {
      if (resumeOptions?.role === "target") return resumeAssignedIsolatedRuntime(ctx, slug);
      const manifest = await readActivationManifest(OPENCLAW_DIR, slug).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (manifest) await activateImportedUser(ctx, slug, { resumeExistingSharedCustody: true, migrationId: resumeOptions?.migrationId });
      await setUserChannelsRunning(ctx.rpc, slug, true);
    }, { ignorePublications: true }),
    prepareImportDir: (slug, mode) => openClawRuntimeUpdateGuard.run(() =>
      prepareImportDir(slug, mode, agentStateRelease(ctx, `[prepare-import:${slug}]`)), { slug }),
    activateImportedUser: (slug, callOpts) =>
      openClawRuntimeUpdateGuard.run(() => activateImportedUser(ctx, slug, callOpts), {
        signal: callOpts?.signal,
        slug,
      }),
    removeImportedUserBySlug: (slug, evictionBatch, currentEvictionBatch, targetCleanup, erasureAgentIds) =>
      openClawRuntimeUpdateGuard.run(() =>
        removeImportedUserBySlug(ctx, slug, { evictionBatch, currentEvictionBatch, targetCleanup, erasureAgentIds }), { slug, evicting: evictionBatch }),
    releaseAgent: (agentId) => openClawRuntimeUpdateGuard.run(() =>
      releaseAgentsAndInvalidateCache(ctx, [agentId], `[release:${agentId}]`)),
  };
}

export function buildBrokeredLifecycleAdapter(
  opts: BuildBrokeredLifecycleAdapterOptions,
): UserLifecycleAdapter {
  const ctx: BrokerCtx = {
    client: opts.client,
    rpc: opts.rpc,
    log: opts.log,
    isIsolatedGateway: opts.isIsolatedGateway ?? (() => false),
    configCache: { current: undefined, hash: "" },
    snapshotsByUid: new Map(),
    snapshotsBySlug: new Map(),
    projectCheckoutScope: opts.projectCheckoutScope,
    configRemovedForEviction: new Set(),
    pendingRuntimeSecrets: new Map(),
    procRoot: opts.procRoot ?? PROC_ROOT,
  };
  const adapter: UserLifecycleAdapter = {
    log: opts.log,
    isIsolatedGateway: ctx.isIsolatedGateway,
    isConfiguredUser: (slug) =>
      Boolean(opts.isIsolatedGateway?.()) && isConfiguredGatewayUser(slug),
    configuredUserOverlayPresent: (slug) =>
      Boolean(opts.isIsolatedGateway?.()) &&
      isConfiguredGatewayUser(slug) &&
      userClaimOverlaySlug() === slug,
    materializeBrokerProfiles: async (slug) => {
      const agentId = `octogee-${slug}-coach`;
      await fsp.mkdir(path.join(AGENTS_DIR, agentId, "agent"), { recursive: true });
      const secretMaterial = ctx.pendingRuntimeSecrets.get(slug) ?? createSecretMaterialLedger();
      ctx.pendingRuntimeSecrets.set(slug, secretMaterial);
      await materializeUserBrokerProfiles([agentId], slug, opts.log, secretMaterial);
    },
    projectCheckoutScope: (slug) =>
      ctx.snapshotsBySlug.get(slug)?.projectCheckoutScope
      ?? ctx.projectCheckoutScope?.(slug)
      ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE,
    userDefaultAgentWiredInOpenclawConfig: (slug) =>
      userDefaultAgentWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
    hasUserAgentRuntime: (slug) =>
      userAgentRuntimePresent(AGENTS_DIR, slug),
    listLocalUserSlugs: () =>
      opts.isIsolatedGateway?.()
        ? listLocalUserDirs(CUSTOMERS_DIR).filter((slug) =>
          isConfiguredGatewayUser(slug) && hasMountedMarker(CUSTOMERS_DIR, slug))
        : listLocalDefaultAgentWiredSlugs(CUSTOMERS_DIR, (slug) =>
          userDefaultAgentWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
        ),
    listLocalUserDirs: () => listLocalUserDirs(CUSTOMERS_DIR),
    userMountMarked: (slug) => hasMountedMarker(CUSTOMERS_DIR, slug),
    writeMountMarker: (slug) => writeMountedMarker(CUSTOMERS_DIR, slug),
    clearMountMarker: (slug) => clearMountedMarker(CUSTOMERS_DIR, slug),
    userMigratingIn: (slug) => isMigratingInPinned(CUSTOMERS_DIR, slug, MIGRATING_IN_PIN_TTL_MS),
    markUserMigratingIn: (slug) => writeMigratingInPin(CUSTOMERS_DIR, slug),
    clearUserMigratingIn: (slug) => clearMigratingInPin(CUSTOMERS_DIR, slug),
    listMigratingInSlugs: () => listMigratingInSlugs(CUSTOMERS_DIR, MIGRATING_IN_PIN_TTL_MS),

    loadUserSnapshot: async (uid, options) => {
      if (options?.refresh) invalidateSnapshot(ctx, uid);
      const snapshot = await snapshotForUid(ctx, uid);
      return snapshot ? toUserSnapshot(snapshot) : null;
    },
    seedUserSnapshotForMigration: (snapshot) => {
      cacheSnapshot(ctx, snapshot);
    },
    provisionDefaultAgentAutomation: async (snapshot) => {
      await provisionDefaultAgentAutomation(ctx.rpc, snapshot);
    },
    setProvisioningStatus: async (uid, status) => {
      await opts.client.setProvisioningStatus(uid, status);
      invalidateSnapshot(ctx, uid);
    },
    setRepoUrl: async (uid, repoUrl) => {
      await opts.client.setRepoUrl(uid, repoUrl);
      invalidateSnapshot(ctx, uid);
    },
    setMattermostFields: async (uid, mmUpdate) => {
      await opts.client.setMattermostFields(uid, mmUpdate);
      invalidateSnapshot(ctx, uid);
    },
    ensureAgentIds: async (uid, agentIds) => {
      await opts.client.ensureAgentIds(uid, agentIds);
      invalidateSnapshot(ctx, uid);
    },

    hasUserDir: (slug) => fs.existsSync(path.join(CUSTOMERS_DIR, slug)),
    hasWorkspaceGitDir: (slug) => fs.existsSync(path.join(CUSTOMERS_DIR, slug, ".git")),
    hasGitRemote: (slug) => userRepositoryHasCanonicalRemote(path.join(CUSTOMERS_DIR, slug)),
    ensureUserDirectories,
    writeUserTemplateFiles,
    removePartialWorkspace,
    deleteDepartedUserState: (slug) => removeDepartedUserFileState(slug, { log: opts.log }),
    cloneWorkspaceRepo,
    initWorkspaceRepoFromExistingDir: (userCtx) => initWorkspaceRepo(userCtx.customerDir, userCtx.slug),
    hasUserSshKey: (slug) => fs.existsSync(userSshKeyPath(slug)),
    generateUserSshKey,
    gitHost: brokeredGitHost,
    readLocalUserPubKey,
    deleteUserSshKey,
    blobSyncForSlug: async (slug) => {
      await blobSyncForSlug(slug, { store: createBrokeredBlobStore(opts.client) });
    },
    restoreByosubForAgent: async (slug) =>
      ctx.isIsolatedGateway()
        ? restoreModelCredentialOauthStoreForSlug(slug)
        : { restored: false, present: false },
    reassertByotForUser: (userData) =>
      syncModelCredentialsForUser(
        userData,
        {
          applyConfigPatch: (args, options) =>
            applyConfigPatch(args, { ...options, rpc: ctx.rpc, cache: ctx.configCache }),
          refreshDefaultAgentRuntimeSessions: refreshModelCredentialRuntimeSessions,
          triggerSecretsReload: () => reloadRuntimeSecrets(ctx, "[byot-sync]"),
        },
      ),
    reassertConvergedContextFilesForUser: async (userData) => {
      reassertConvergedContextFilesForSlug(userData);
    },
    listProjectsNeedingClone: (slug) => listProjectsNeedingClone(ctx, slug),
    cloneProjectRepo: (slug, project, repo, options) => cloneProjectRepoForTarget(ctx, slug, project, repo, options),
    provisionMattermostUser: (userCtx) => opts.client.provisionMattermost(userCtx.uid),
    ...runtimeUpdateOperations(ctx),
    cancelPendingEviction: (slug) => ctx.configRemovedForEviction.delete(slug),
    waitForAccountHealthy: (p) => waitForAccountHealthy(ctx, p),
    projectAgentsHealthy: (snapshot) => projectAgentsRuntimeReady({ ...snapshot, rpc: ctx.rpc }),
    reportProvisioned: (userCtx, report) => opts.client.reportProvisioned(userCtx.uid, report),
    uidForSlug: (slug) => opts.client.uidForSlug(slug),
    quiesceUser: (slug, timeoutMs, opts) => quiesceUser(ctx, slug, timeoutMs, opts),
    schedulerMigration: (slug, request) => migrateUserScheduler(ctx.rpc, slug, agentIdsForMigration(slug), request),
    schedulerReady: async () => { await ctx.rpc.configGet(); },
    sourceMigrationIdentityCustody: (slug, migrationId) => sourceMigrationIdentityCustody(ctx, slug, migrationId),
    sourceMigrationAgentAnchors: async (slug, migrationId) => {
      const custody = await sourceMigrationIdentityCustody(ctx, slug, migrationId);
      const current = await ctx.client.readAgentAnchors({ slug, uid: custody.uid, migrationId });
      assertSourceIdentityCustody(custody, await sourceMigrationIdentityCustody(ctx, slug, migrationId));
      return current.anchors.filter(anchor => anchor.agentId !== SAFE_DEFAULT_AGENT_ID);
    },
    listExportPaths,
    prepareKeyImportDir,
    targetMigrationIdentityCustody: async (slug, migrationId) => {
      if (!migrationId) throw new Error("target migration authority is required");
      const current = await ctx.client.readAgentAnchors({ slug, migrationId });
      const gatewayId = process.env.GATEWAY_ID?.trim(), podUid = process.env.POD_UID?.trim();
      if (!gatewayId || !podUid || current.migration?.migrationId !== migrationId || !current.assignment?.uid || current.assignment.state !== "quiescing" ||
          current.assignment.epoch !== current.migration.sourceEpoch || !Number.isSafeInteger(current.migration.claimStartedAt) || current.migration.claimStartedAt <= 0) {
        throw new Error("Target migration authority changed");
      }
      return { custody: { migrationId, uid: current.assignment.uid, gatewayId, podUid }, migration: current.migration, anchors: current.anchors };
    },
    exportOpenClawActivationManifest: (slug, options) =>
      exportSourceActivationManifest(ctx, slug, options),
  };
  return adapter;
}
