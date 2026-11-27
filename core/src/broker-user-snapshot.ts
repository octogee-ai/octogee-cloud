import type { FleetBrokerChannelBinding, FleetBrokerProjectCheckoutScope, FleetBrokerProjectRestore, FleetBrokerProvisioningStatus, FleetBrokerUserRuntimeReset, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { isValidUsername } from "@octogee/shared/types/identity";
import { githubCheckpointRepo, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { readUserRestoreAuthoritySnapshot } from "./fleet-state.js";
import { isolatedRuntimeMutationFenced } from "./gateway-retirement-claim.js";
import type { GatewayRoot, MattermostTokenSecret, PlatformStateRepositories, PlatformStateStore, PlatformUserRecord, Stored } from "./platform-state/index.js";
import { collectArchivedAgentProjectIds, collectStoredProjectAgentStates, readByotSnapshotProjection } from "./user-snapshot-mapping.js";

export interface BrokerSnapshotDocuments {
  agent(uid: string): Promise<Record<string, unknown> | undefined>;
  projectRecipes(workspaceSlug: string): Promise<ReadonlyMap<string, string>>;
}

interface BrokerSnapshotDeps {
  store: PlatformStateStore;
  records: { userDocuments: BrokerSnapshotDocuments };
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

export class CorruptStoredFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptStoredFieldError";
  }
}

export function storedTimeZone(user: Record<string, unknown> | undefined): string | null {
  const raw = readPath(user, "preferences.timeZone");
  if (raw === undefined || raw === null) return null;
  const zone = parseTimeZone(raw);
  if (!zone) throw new CorruptStoredFieldError(`users/{uid}.preferences.timeZone is not an IANA zone: ${JSON.stringify(raw)}`);
  return zone;
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
  deps: BrokerSnapshotDeps,
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
      if (repoSource.workingCopy?.ready) out.giteaRepoName = githubCheckpointRepo(repoSource.workingCopy.id);
      else if (repoSource.workingCopy) out.checkoutEnabled = false;
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

export function storedRuntimeReset(
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
  "uid" | "slug" | "channels" | "projectCheckoutScope" | "projects" | "coachToken" | "coachMmUserId" | "coachIdentity" | "byotActive"
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
  };
}

export async function defaultAgentMattermostSecret(store: PlatformStateRepositories, uid: string): Promise<MattermostTokenSecret | null> {
  const secret = await store.secrets.get(uid, "coachMattermost");
  return secret?.kind === "coach-mattermost" ? secret : null;
}

export function snapshotDefaultAgentFields(
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

export async function loadSnapshot(
  deps: BrokerSnapshotDeps,
  userRecord: Stored<PlatformUserRecord>,
  account: Record<string, unknown>,
  options: LoadSnapshotOptions,
): Promise<(FleetBrokerUserSnapshot & { greetingPosted: boolean }) | null> {
  const { records, store } = deps;
  const { modelDials } = options;
  const { uid, slug } = userRecord;
  if (!slug || !isValidUsername(slug)) return null;
  const projectCheckoutScope = projectCheckoutScopeForGatewayRoot(options.gatewayData, options.gatewayId, uid, slug);
  const [collectedChannels, projects, projectAgents, archivedProjectIds, defaultAgent, agentData, credentialProjection, runtimeReset, restoreAuthority] = await Promise.all([
    collectChannelBindings(store, slug),
    projectCheckoutScope === "workspace-and-projects"
      ? collectProjects(deps, slug)
      : Promise.resolve([]),
    collectStoredProjectAgentStates(store, uid, slug),
    collectArchivedAgentProjectIds(store, uid, slug),
    defaultAgentMattermostSecret(store, uid),
    records.userDocuments.agent(uid),
    readByotSnapshotProjection(store.users, uid),
    admittedRuntimeReset(store, userRecord),
    readUserRestoreAuthoritySnapshot({ store }, { uid, slug, gatewayId: options.gatewayId }),
  ]);
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
    byotActive: credentialProjection.byotActive,
    freeTierModelRef: modelDials.freeTierModelRef,
    builderAgentDefault: modelDials.userAgentDefault,
    channels,
    projectCheckoutScope,
    projects,
    ...(projectAgents.length > 0 ? { projectAgents } : {}),
    ...(archivedProjectIds.length > 0 ? { archivedProjectIds } : {}),
    ...snapshotDefaultAgentFields(defaultAgent),
    ...snapshotDefaultAgentIdentity(agentData),
    ...(credentialProjection.systemConfig ? { systemConfig: credentialProjection.systemConfig } : {}),
  };
}

