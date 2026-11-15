import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import type { ChatOutputs, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import type { PlatformStateStore } from "./platform-state/store.js";
import {
  buildProvisioningContext,
  markProvisioningComplete,
  type ProvisioningProjection,
} from "./provisionSteps.js";
import type { MmUpdate } from "./user-lifecycle.js";

export interface UserAccountDocuments {
  account(uid: string): Promise<Record<string, unknown> | undefined>;
}

export interface ProvisioningMirrorDeps {
  readonly store: Pick<PlatformStateStore, "transaction" | "users" | "workspaces">;
  readonly documents: UserAccountDocuments;
  readonly projection: ProvisioningProjection;
  readonly proxyUrl: string | null;
}

export type ProvisioningMirrorOutcome = "written" | "unchanged" | "chat-not-ready" | "user-missing" | "slug-mismatch";

export class ProvisioningMirrorError extends Error {
  constructor(readonly uid: string, message: string) {
    super(message);
    this.name = "ProvisioningMirrorError";
  }
}

function chatReady(resource: UserProvisioning): ChatOutputs | null {
  const condition = resource.status.conditions.find((candidate) => candidate.type === "ChatReady");
  const chat = resource.status.outputs.chat;
  if (condition?.status !== "True" || chat === undefined) return null;
  return chat.userId && chat.teamId && chat.channels.general ? chat : null;
}

export function mmUpdateFromChatOutputs(input: {
  slug: string;
  chat: ChatOutputs;
  agentChannelName: string;
  proxyUrl: string | null;
}): MmUpdate {
  const { slug, chat, agentChannelName, proxyUrl } = input;
  const agentChannel = chat.channels.agent;
  return {
    "mattermost.userId": chat.userId,
    "mattermost.username": slug,
    "mattermost.teamId": chat.teamId,
    "mattermost.generalChannelId": chat.channels.general,
    ...(agentChannel
      ? {
          "mattermost.channelId": agentChannel,
          "mattermost.dmChannelId": agentChannel,
          "mattermost.channelName": agentChannelName,
        }
      : {}),
    ...(proxyUrl === null ? {} : { "mattermost.proxyUrl": proxyUrl }),
    ...(chat.agentBotUserId ? { "mattermost.coachUserId": chat.agentBotUserId } : {}),
  };
}

async function recordsMatch(
  store: ProvisioningMirrorDeps["store"],
  resource: UserProvisioning,
  chat: ChatOutputs,
  slug: string,
): Promise<boolean> {
  const scope = { workspaceSlug: slug, projectSlug: null };
  const [user, workspace, general, agentChannel, owner, identity] = await Promise.all([
    store.users.records.get(resource.uid),
    store.workspaces.records.get(slug),
    store.workspaces.channels.get(scope, "general"),
    chat.channels.agent ? store.workspaces.channels.get(scope, "coach-dm") : Promise.resolve(null),
    store.workspaces.members.get(slug, resource.uid),
    chat.agentBotUserId ? store.workspaces.agentIdentities.get(resource.uid) : Promise.resolve(null),
  ]);
  if (user === null || workspace === null || owner === null) return false;
  const agentIds = new Set(user.agents.agentIds);
  return (
    user.mattermostUserId === chat.userId &&
    user.workspaceId === slug &&
    user.openclaw.provisionedAt !== undefined &&
    resource.spec.agentIds.every((agentId) => agentIds.has(agentId)) &&
    workspace.ownerUid === resource.uid &&
    workspace.mattermostTeamId === chat.teamId &&
    general?.mattermostChannelId === chat.channels.general &&
    (!chat.channels.agent || agentChannel?.mattermostChannelId === chat.channels.agent) &&
    (!chat.agentBotUserId || identity?.mattermostUserId === chat.agentBotUserId)
  );
}

export async function mirrorUserProvisioning(
  deps: ProvisioningMirrorDeps,
  resource: UserProvisioning,
): Promise<ProvisioningMirrorOutcome> {
  const chat = chatReady(resource);
  if (chat === null) return "chat-not-ready";
  const user = await deps.store.users.records.get(resource.uid);
  if (user === null) return "user-missing";
  const slug = resource.spec.slug;
  if (user.slug !== slug) return "slug-mismatch";
  if (await recordsMatch(deps.store, resource, chat, slug)) return "unchanged";
  const userData = await deps.documents.account(resource.uid);
  if (userData === undefined) {
    throw new ProvisioningMirrorError(resource.uid, `user ${resource.uid} has no account document to mirror provisioning from`);
  }
  const ctx = buildProvisioningContext(resource.uid, userData);
  const stored = await deps.projection.storedMattermostNames(resource.uid, slug);
  const mmUpdate = mmUpdateFromChatOutputs({
    slug,
    chat,
    agentChannelName: stored.coachChannelName ?? workspaceDefaultAgentChannelName(slug),
    proxyUrl: deps.proxyUrl,
  });
  await markProvisioningComplete(ctx, mmUpdate, [...resource.spec.agentIds], deps.projection, deps.store);
  return "written";
}
