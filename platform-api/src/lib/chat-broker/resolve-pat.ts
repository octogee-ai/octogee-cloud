/**
 * Lane-aware PAT resolution for the chat broker.
 *
 * The broker is the WORKSPACE capability boundary: it uses the user PAT but
 * returns data only from canonical channels the user owns or has joined.
 *   - A PROJECT agent reads with its own bot PAT, whose MM channel membership
 *     is that project's channels ONLY. Under injection it cannot reach what the
 *     PAT cannot see.
 *
 * No fallback lanes: a missing secret is a refusal, never a broader token.
 */

import type { MattermostTokenSecret, PlatformStateRepositories } from "@octogee/core/platform-state";
import { parseAgentId } from "@octogee/shared/types/identity";
import { parseProjectRetention } from "@octogee/shared/types/project-retention";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";

export type ChatPatErrorCode =
  | "invalid-agent"
  | "foreign-agent"
  | "no-builder-pat"
  | "no-coach-identity"
  | "no-project-pat"
  | "project-archived";

export class ChatPatError extends Error {
  constructor(
    public readonly code: ChatPatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatPatError";
  }
}

export interface ChatIdentityDeps {
  readAccount(uid: string): Promise<Record<string, unknown> | undefined>;
  store: Pick<PlatformStateRepositories, "secrets" | "workspaces">;
}

export interface ChatIdentityInput {
  uid: string;
  /** The workspace slug the caller was validated as assigned to. */
  slug: string;
  agentId: string;
}

export interface ResolvedChatIdentity {
  lane: "workspace" | "project";
  pat: string;
  /** The agent's own MM user id — its authored posts are labeled `self: true` in results. */
  defaultAgentMmUserId: string;
  /** Credential for the `unread` direction: the AGENT's own catch-up cursor. MM only
   *  serves a user's unread state to that user, so this must be the bot's own PAT —
   *  running unread under the user PAT would either 403 (agent id) or advance the
   *  HUMAN's read marker (`me`), silently clearing their unread badges. */
  unread: { pat: string; mmUserId: string };
  canReadChannel?: (channelId: string) => Promise<boolean>;
  includeArchivedProjectHistory?: true;
}

async function mattermostSecret(
  deps: ChatIdentityDeps,
  uid: string,
  secretId: string,
): Promise<MattermostTokenSecret | null> {
  const secret = await deps.store.secrets.get(uid, secretId);
  return secret === null || secret.kind === "connector" ? null : secret;
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function workspaceChannelReadable(
  deps: ChatIdentityDeps,
  uid: string,
  assignedSlug: string,
  workspaceSlug: string,
  channelDocId: string,
): Promise<boolean> {
  if (channelDocId === "admin") return false;
  if (workspaceSlug === assignedSlug) return true;
  const [workspace, membership] = await Promise.all([
    deps.store.workspaces.records.get(workspaceSlug),
    deps.store.workspaces.members.get(workspaceSlug, uid),
  ]);
  return workspace?.ownerUid === uid ||
    (membership !== null && isCanonicalWorkspaceMembership(membership));
}

async function projectChannelReadable(
  deps: ChatIdentityDeps,
  uid: string,
  workspaceSlug: string,
  projectSlug: string,
): Promise<boolean> {
  const [project, membership] = await Promise.all([
    deps.store.workspaces.projects.get(workspaceSlug, projectSlug),
    deps.store.workspaces.projectMembers.get(workspaceSlug, projectSlug, uid),
  ]);
  return project?.ownerUid === uid || membership !== null;
}

async function canonicalChannelReadable(
  deps: ChatIdentityDeps,
  uid: string,
  assignedSlug: string,
  channelId: string,
): Promise<boolean> {
  const channel = await deps.store.workspaces.channels.findByMattermostChannelId(channelId);
  if (channel === null) return false;
  const { workspaceSlug, projectSlug } = channel.scope;
  if (projectSlug === null) {
    return workspaceChannelReadable(deps, uid, assignedSlug, workspaceSlug, channel.channelId);
  }
  return projectChannelReadable(deps, uid, workspaceSlug, projectSlug);
}

async function projectArchiveAccess(
  deps: ChatIdentityDeps,
  uid: string,
): Promise<{ blocksProjectAgent: boolean; historyReadable: boolean }> {
  const retention = parseProjectRetention((await deps.readAccount(uid))?.projectRetention);
  if (!retention || retention.status === "active") {
    return { blocksProjectAgent: false, historyReadable: false };
  }
  return {
    blocksProjectAgent: true,
    historyReadable:
      retention.status === "archived" &&
      retention.deleteAfter !== null &&
      retention.deleteAfter.getTime() > Date.now(),
  };
}

async function projectAgentIdentity(
  deps: ChatIdentityDeps,
  input: ChatIdentityInput,
  project: string,
): Promise<ResolvedChatIdentity> {
  const secret = await mattermostSecret(deps, input.uid, projectAgentSecretDocId(project));
  const pat = nonEmptyString(secret?.personalToken);
  const mmUserId = nonEmptyString(secret?.mattermostUserId);
  if (!pat || !mmUserId) {
    throw new ChatPatError(
      "no-project-pat",
      `project agent ${input.agentId} has no minted PAT — agent disabled or not yet provisioned`,
    );
  }
  return {
    lane: "project",
    pat,
    defaultAgentMmUserId: mmUserId,
    unread: { pat, mmUserId },
  };
}

export async function resolveChatIdentity(
  deps: ChatIdentityDeps,
  input: ChatIdentityInput,
): Promise<ResolvedChatIdentity> {
  const parsed = parseAgentId(input.agentId);
  if (parsed.kind === "unknown") {
    throw new ChatPatError("invalid-agent", `unparseable agent id ${input.agentId}`);
  }
  if (parsed.username !== input.slug) {
    throw new ChatPatError(
      "foreign-agent",
      `agent ${input.agentId} does not belong to workspace ${input.slug}`,
    );
  }

  const archiveAccess = await projectArchiveAccess(deps, input.uid);

  if (parsed.kind === "project") {
    if (archiveAccess.blocksProjectAgent) {
      throw new ChatPatError(
        "project-archived",
        `project agent ${input.agentId} is disabled while its owner is on Free`,
      );
    }
    return projectAgentIdentity(deps, input, parsed.project);
  }

  const userSecret = await mattermostSecret(deps, input.uid, "mattermost");
  const userPat = nonEmptyString(userSecret?.personalToken);
  if (!userPat) {
    throw new ChatPatError(
      "no-builder-pat",
      `no user MM PAT at users/{uid}/secrets/mattermost for ${input.slug} — re-run provisioning`,
    );
  }
  const defaultAgentSecret = await mattermostSecret(deps, input.uid, "coachMattermost");
  const defaultAgentMmUserId = nonEmptyString(defaultAgentSecret?.mattermostUserId);
  const defaultAgentPat = nonEmptyString(defaultAgentSecret?.personalToken);
  if (!defaultAgentMmUserId || !defaultAgentPat) {
    throw new ChatPatError(
      "no-coach-identity",
      `incomplete users/{uid}/secrets/coachMattermost for ${input.slug} — cannot self-label the agent's own posts or read its unread cursor`,
    );
  }
  return {
    lane: "workspace",
    pat: userPat,
    defaultAgentMmUserId,
    unread: { pat: defaultAgentPat, mmUserId: defaultAgentMmUserId },
    canReadChannel: (channelId) =>
      canonicalChannelReadable(deps, input.uid, input.slug, channelId),
    ...(archiveAccess.historyReadable ? { includeArchivedProjectHistory: true as const } : {}),
  };
}
