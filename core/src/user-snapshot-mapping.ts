import type { FleetBrokerProjectAgent } from "@octogee/shared/types/fleet-broker";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const logger = createServiceLogger("provisioner");
import type { UserSnapshot } from "./user-lifecycle.js";
import type { MattermostTokenSecret, SecretsRepository } from "./platform-state/secrets.js";
import type { PlatformStateRepositories } from "./platform-state/store.js";
import type { ModelCredentialRecord, UserRepositories } from "./platform-state/users.js";
import type { WorkspaceProject } from "./platform-state/workspaces.js";
import type { AgentModelSelections } from "@octogee/shared/types/agent-models";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { projectAgentConfigured, projectRepoSourceFromDoc, type ProjectAgentStatus, type ProjectAgentIdentity } from "@octogee/shared/types/project";

type ChannelBinding = UserSnapshot["channels"][number];

export function mapWorkspaceChannelDoc(
  data: Record<string, unknown>,
): ChannelBinding | null {
  const channelId = (data.mattermost as { channelId?: string } | undefined)?.channelId;
  if (!channelId) return null;
  return {
    scope: "workspace",
    kind: (data.kind as string | undefined) ?? "general",
    channelId,
  };
}

export function mapProjectChannelDoc(
  projectId: string,
  data: Record<string, unknown>,
): ChannelBinding | null {
  const channelId = (data.mattermost as { channelId?: string } | undefined)?.channelId;
  if (!channelId) return null;
  return {
    scope: "project",
    projectId,
    kind: (data.kind as string | undefined) ?? "default",
    channelId,
  };
}

class ProjectAgentIdentityError extends Error {}

function projectIdentity(value: unknown): ProjectAgentIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new ProjectAgentIdentityError("Invalid project agent identity");
  const { name, emoji, persona } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || typeof emoji !== "string" || typeof persona !== "string") {
    throw new ProjectAgentIdentityError("Invalid project agent identity");
  }
  return { name, emoji, persona };
}

function projectAgentRuntimeState(value: unknown) {
  const agent = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    ...(agent.identity === undefined ? {} : { identity: projectIdentity(agent.identity) }),
    ...((agent.kickoff as { status?: string } | undefined)?.status === "pending" ||
      (agent.handoff as { status?: string } | undefined)?.status === "pending" ? { deliveryPending: true } : {}),
    activationId: typeof agent.activationId === "string" ? agent.activationId : null,
    status: typeof agent.status === "string" ? agent.status as ProjectAgentStatus : null,
  };
}

function projectAgentArchived(projectData: Record<string, unknown>): boolean {
  const commercialLifecycle = projectData.commercialLifecycle;
  return projectData.status === "archived" || (!!commercialLifecycle &&
    typeof commercialLifecycle === "object" &&
    (commercialLifecycle as { status?: unknown }).status === "archived");
}

export type ProjectAgentCredential = Pick<MattermostTokenSecret, "mattermostUserId" | "personalToken">;

export function mapProjectAgentState(
  projectId: string,
  projectData: Record<string, unknown>,
  credential: ProjectAgentCredential | null,
): FleetBrokerProjectAgent | null {
  const agent = projectData.agent;
  const requestedEnabled = projectAgentConfigured(agent);
  const enabled = requestedEnabled && !projectAgentArchived(projectData);
  const mmUserId = credential?.mattermostUserId || null;
  const token = credential?.personalToken || null;
  if (!enabled && mmUserId === null && token === null) return null;
  try {
    return {
      projectId, enabled, mmUserId, token, ...projectAgentRuntimeState(agent),
      ...(projectRepoSourceFromDoc(projectData.repoSource)?.provider === "github" ? { githubBacked: true } : {}),
    };
  } catch (error) {
    if (!(error instanceof ProjectAgentIdentityError)) throw error;
    logger.error("Project agent identity rejected", { projectId, error: error.message });
    return { projectId, enabled, mmUserId, token, status: "error", activationId: null };
  }
}

type ProjectAgentStates = Array<NonNullable<ReturnType<typeof mapProjectAgentState>>>;

type ProjectAgentSource = { readonly id: string; readonly data: Record<string, unknown> };

function storedProjectAgentSource(project: WorkspaceProject): ProjectAgentSource {
  return {
    id: project.projectSlug,
    data: {
      status: project.status,
      ...(project.agent === null ? {} : { agent: project.agent }),
      ...(project.commercialLifecycleStatus === null ? {} : { commercialLifecycle: { status: project.commercialLifecycleStatus } }),
      ...(project.repoSource === null ? {} : { repoSource: project.repoSource }),
    },
  };
}

export async function collectStoredProjectAgentStates(
  state: Pick<PlatformStateRepositories, "workspaces" | "secrets">,
  uid: string,
  slug: string,
): Promise<ProjectAgentStates> {
  const [projects, projectSecrets] = await Promise.all([
    state.workspaces.projects.list(slug),
    state.secrets.list(uid, "project-agent-mattermost"),
  ]);
  return projectAgentStatesFrom(projects.map(storedProjectAgentSource), projectSecrets);
}

function projectAgentStatesFrom(
  projects: readonly ProjectAgentSource[],
  projectSecrets: Awaited<ReturnType<SecretsRepository["list"]>>,
): ProjectAgentStates {
  const credentials = new Map(projectSecrets.flatMap((secret) =>
    secret.kind === "connector" || !secret.projectId ? [] : [[secret.projectId, secret] as const]));
  const out: ProjectAgentStates = [];
  const seenProjects = new Set<string>();
  for (const { id, data } of projects) {
    if (data.agent === undefined) continue;
    seenProjects.add(id);
    const state = mapProjectAgentState(id, data, credentials.get(id) ?? null);
    if (state) out.push(state);
  }

  for (const [projectId, credential] of credentials) {
    if (seenProjects.has(projectId)) continue;
    const state = mapProjectAgentState(projectId, {}, credential);
    if (state) out.push(state);
  }
  return out;
}

export function deriveSlug(uid: string, data: Record<string, unknown>): string {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const slug = (oc?.slug as string | undefined) ?? (data.username as string | undefined);
  if (!slug) {
    throw new Error(
      `[load:${uid}] cannot derive slug — neither provisioning.openclaw.slug nor users/{uid}.username is set`,
    );
  }
  return slug;
}


function snapshotProvisioning(data: Record<string, unknown>): Pick<
  UserSnapshot,
  "gatewayId" | "status" | "agentIds" | "repoUrl"
> {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const git = (data.provisioning as { git?: Record<string, unknown> } | undefined)?.git;
  return {
    gatewayId: (oc?.gatewayId as string | undefined) ?? "",
    status: ((oc?.status as string | undefined) ?? "") as UserSnapshot["status"],
    agentIds: (oc?.agentIds as string[] | undefined) ?? [],
    repoUrl: (git?.repoUrl as string | undefined) ?? "",
  };
}

function snapshotIdentity(
  data: Record<string, unknown>,
  slug: string,
): Pick<UserSnapshot, "mattermostUserId" | "ownerName"> {
  return {
    mattermostUserId:
      (data.mattermost as { userId?: string } | undefined)?.userId ?? null,
    ownerName:
      (data.displayName as string | undefined) ??
      (data.username as string | undefined) ??
      slug,
  };
}

type SnapshotSystemConfig = NonNullable<UserSnapshot["systemConfig"]>;

export interface ByotSnapshotProjection {
  byotActive: boolean;
  systemConfig?: SnapshotSystemConfig;
}

function byotSystemConfig(credential: ModelCredentialRecord): SnapshotSystemConfig {
  return {
    byot: {
      provider: credential.provider,
      ...(credential.baseUrl === null ? {} : { baseUrl: credential.baseUrl }),
      ...(credential.model === null ? {} : { model: credential.model }),
    },
  };
}

export async function readAgentModelSelections(
  users: Pick<UserRepositories, "agentModels">,
  uid: string,
): Promise<AgentModelSelections> {
  const selections = await users.agentModels.list(uid);
  return Object.fromEntries(selections.map(({ agentId, primary, fallbacks }) => [agentId, { primary, fallbacks: [...fallbacks] }]));
}

export function byotSnapshotProjection(
  credential: ModelCredentialRecord | null,
  agentModels: AgentModelSelections,
): ByotSnapshotProjection {
  const byotConfig = credential?.active === true ? byotSystemConfig(credential) : undefined;
  const systemConfig = Object.keys(agentModels).length === 0
    ? byotConfig
    : { ...(byotConfig ?? {}), agentModels };
  return {
    byotActive: byotConfig !== undefined,
    ...(systemConfig ? { systemConfig } : {}),
  };
}

export async function readByotSnapshotProjection(
  users: Pick<UserRepositories, "agentModels" | "modelCredentials">,
  uid: string,
): Promise<ByotSnapshotProjection> {
  const [credential, agentModels] = await Promise.all([
    users.modelCredentials.get(uid),
    readAgentModelSelections(users, uid),
  ]);
  return byotSnapshotProjection(credential, agentModels);
}

export function mapUserDocToSnapshot(
  uid: string,
  data: Record<string, unknown>,
  channels: UserSnapshot["channels"],
): UserSnapshot {
  const slug = deriveSlug(uid, data);
  const planInputs = userEntitlements().pickInputs(data);
  return {
    uid,
    slug,
    channels,
    byotActive: false,
    ...snapshotIdentity(data, slug),
    ...snapshotProvisioning(data),
    planInputs,
    contextTemplateKey: userEntitlements().seedContextTemplateKey(planInputs),
    persona: null,
  };
}

export { snapshotConfigFingerprint } from "./broker-snapshot-fingerprint.js";
