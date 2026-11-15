import type { PlatformUserRecord, UserAgentIdentity, WorkspaceChannel, WorkspaceRecord } from "@octogee/core/platform-state";
import type { UserAccount } from "@octogee/core/user-account";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { userAccounts } from "@octogee/core/identity/user-accounts";

export interface WorkspaceMmContext {
  ownerUid: string;
  slug: string;
  teamId: string | null;
  userId: string | null;
  username: string | null;
  coachUserId: string | null;
  coachDmChannelId: string | null;
  generalChannelId: string | null;
  adminChannelId: string | null;
}

interface MattermostContextParts {
  workspace: WorkspaceRecord | null;
  generalChan: WorkspaceChannel | null;
  defaultAgentDmChan: WorkspaceChannel | null;
  adminChan: WorkspaceChannel | null;
  agent: UserAgentIdentity | null;
}

export async function getWorkspaceMmContext(
  ownerUid: string,
  ownerSlug?: string,
): Promise<WorkspaceMmContext | null> {
  const [account, user] = await Promise.all([
    userAccounts().get(ownerUid),
    platformStateStore.users.records.get(ownerUid),
  ]);
  if (!account) return null;
  const slug = ownerSlug || user?.slug || account.username || user?.workspaceId || null;
  if (!slug) return null;

  const parts = await loadMattermostContextParts(ownerUid, slug);
  return buildWorkspaceMmContext(ownerUid, slug, account, user, parts);
}

async function loadMattermostContextParts(ownerUid: string, slug: string): Promise<MattermostContextParts> {
  const scope = { workspaceSlug: slug, projectSlug: null };
  const { records, channels, agentIdentities } = platformStateStore.workspaces;
  const [workspace, generalChan, defaultAgentDmChan, adminChan, agent] = await Promise.all([
    records.get(slug),
    channels.get(scope, "general"),
    channels.get(scope, "coach-dm"),
    channels.get(scope, "admin"),
    agentIdentities.get(ownerUid),
  ]);
  return { workspace, generalChan, defaultAgentDmChan, adminChan, agent };
}

function buildWorkspaceMmContext(
  ownerUid: string,
  slug: string,
  account: UserAccount,
  user: PlatformUserRecord | null,
  parts: MattermostContextParts,
): WorkspaceMmContext {
  return {
    ownerUid,
    slug,
    teamId: parts.workspace?.mattermostTeamId ?? null,
    userId: user?.mattermostUserId ?? null,
    username: account.mattermostUsername || null,
    coachUserId: parts.agent?.mattermostUserId ?? null,
    coachDmChannelId: parts.defaultAgentDmChan?.mattermostChannelId ?? null,
    generalChannelId: parts.generalChan?.mattermostChannelId ?? null,
    adminChannelId: parts.adminChan?.mattermostChannelId ?? null,
  };
}
