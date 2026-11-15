import { createHash } from "node:crypto";
import type { WorkspaceChannelScope } from "@octogee/core/platform-state";
import { mmApi } from "./mattermost.js";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { projectPresentation } from "@octogee/core/identity/project-presentation";
import { retiredChannelName } from "./mattermost-channel-name.js";
import { logger } from "@octogee/core/http/logging";
import {
  CHANNEL_NAME_MAX_LENGTH,
  projectChannelName,
  workspaceAdminChannelName,
  workspaceDefaultAgentChannelName,
  workspaceCustomChannelName,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

export class MattermostChannelBindingError extends Error {
  override readonly name = "MattermostChannelBindingError";
}

export class MattermostIdentityMissingError extends Error {
  override readonly name = "MattermostIdentityMissingError";
}

export interface MattermostMembershipErrorResponse {
  status: number;
  body: { error: string };
}

export function mapMattermostMembershipError(err: unknown): MattermostMembershipErrorResponse | null {
  if (err instanceof MattermostIdentityMissingError) {
    return {
      status: 422,
      body: { error: "Your chat account could not be found. Please contact support to restore access." },
    };
  }
  return null;
}

export async function removeChannelMember(
  channelDocPath: string,
  mmUserId: string,
): Promise<void> {
  const stored = await readStoredChannel(channelDocPath);
  const primary = await requireMattermostChannel(stored.primaryChannelId, "primary");
  assertChannelBinding(primary, stored.binding, "primary");

  const legacy = stored.legacyActivityChannelId && stored.legacyActivityChannelId !== primary.id
    ? await readMattermostChannel(`/channels/${encodeURIComponent(stored.legacyActivityChannelId)}`)
    : null;
  if (legacy) assertLegacyActivityBinding(legacy, stored.binding, primary.type);

  const removedLegacy = legacy ? await deleteMember(legacy.id, mmUserId) : false;
  try {
    await deleteMember(primary.id, mmUserId);
  } catch (error) {
    if (legacy && removedLegacy) {
      try {
        await addMember(legacy.id, mmUserId);
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          "primary membership removal failed and legacy Activity membership compensation failed",
        );
      }
    }
    throw error;
  }
}

export async function addChannelMember(
  channelDocPath: string,
  mmUserId: string,
): Promise<void> {
  const channelId = await verifiedPrimaryChannelIdFor(channelDocPath);
  await ensureActiveMattermostUser(mmUserId);
  await addMember(channelId, mmUserId);
}

export async function addActiveChannelMember(channelDocPath: string, mmUserId: string): Promise<boolean> {
  const channelId = await verifiedPrimaryChannelIdFor(channelDocPath);
  const user = await requireMattermostUser(mmUserId);
  if (user.deleteAt > 0) return false;
  await addMember(channelId, mmUserId);
  return true;
}

export async function setStoredPrimaryChannelArchived(
  channelDocPath: string,
  archived: boolean,
): Promise<void> {
  const stored = await readStoredChannel(channelDocPath);
  const primary = await requireMattermostChannel(stored.primaryChannelId, "primary");
  assertChannelBinding(primary, stored.binding, "primary");
  await setMattermostChannelArchived(primary, archived);
}

export async function setStoredChannelArchived(
  channelDocPath: string,
  archived: boolean,
): Promise<void> {
  await setStoredPrimaryChannelArchived(channelDocPath, archived);
}

export async function retireStoredChannel(
  channelDocPath: string,
  now: () => number = Date.now,
): Promise<void> {
  const stored = await readStoredChannel(channelDocPath);
  const primary = await requireMattermostChannel(stored.primaryChannelId, "primary");
  assertChannelBinding(primary, stored.binding, "primary");
  if (primary.deleteAt <= 0) {
    await mmApi(`/channels/${primary.id}/patch`, "PUT", { name: retiredChannelName(primary.name, now()) });
  }
  await setMattermostChannelArchived(primary, true);
}

export async function ensureActiveMattermostUser(mmUserId: string): Promise<void> {
  const user = await requireMattermostUser(mmUserId);
  if (user.deleteAt > 0) {
    try {
      await mmApi(`/users/${mmUserId}/active`, "PUT", { active: true });
    } catch (error) {
      logger.error(`[mattermost] reactivation failed for soft-deleted Mattermost user ${mmUserId}:`, { err: error });
      throw error;
    }
    logger.warn(`[mattermost] reactivated soft-deleted Mattermost user ${mmUserId}`);
  }
}

export async function assertMattermostUserExists(mmUserId: string): Promise<void> {
  await requireMattermostUser(mmUserId);
}

interface StoredChannel {
  primaryChannelId: string;
  legacyActivityChannelId: string | null;
  binding: ExpectedBinding;
}

interface ExpectedBinding {
  primaryName: string;
  teamId: string;
}

interface StoredMattermostChannel {
  id: string;
  name: string;
  teamId: string;
  type: "P" | "O";
  deleteAt: number;
}

export async function verifiedPrimaryChannelIdFor(channelDocPath: string): Promise<string> {
  const stored = await readStoredChannel(channelDocPath);
  const primary = await requireMattermostChannel(stored.primaryChannelId, "primary");
  assertChannelBinding(primary, stored.binding, "primary");
  return primary.id;
}

function channelLocation(channelDocPath: string): { scope: WorkspaceChannelScope; channelId: string } {
  const parts = channelDocPath.split("/");
  if (parts[0] === "workspaces" && parts[1] && parts.length === 4 && parts[2] === "channels" && parts[3]) {
    return { scope: { workspaceSlug: parts[1], projectSlug: null }, channelId: parts[3] };
  }
  if (parts[0] === "workspaces" && parts[1] && parts.length === 6 && parts[2] === "projects" && parts[3] && parts[4] === "channels" && parts[5]) {
    return { scope: { workspaceSlug: parts[1], projectSlug: parts[3] }, channelId: parts[5] };
  }
  throw new MattermostChannelBindingError(`unsupported channel document path ${channelDocPath}`);
}

async function readStoredChannel(channelDocPath: string): Promise<StoredChannel> {
  const { scope, channelId } = channelLocation(channelDocPath);
  const [channel, product] = await Promise.all([
    platformStateStore.workspaces.channels.get(scope, channelId),
    projectPresentation().readChannel(scope, channelId),
  ]);
  if (channel === null) {
    throw new MattermostChannelBindingError(`channel document ${channelDocPath} was not found`);
  }
  const primaryChannelId = channel.mattermostChannelId ?? "";
  const mattermost = product?.mattermost;
  const legacy = mattermost !== null && typeof mattermost === "object" ? (mattermost as Record<string, unknown>).activityChannelId : undefined;
  const legacyActivityChannelId = typeof legacy === "string" && legacy ? legacy : null;
  if (!primaryChannelId) {
    throw new MattermostChannelBindingError(`channel document ${channelDocPath} has no primary channel`);
  }
  return {
    primaryChannelId,
    legacyActivityChannelId,
    binding: await expectedBinding(channelDocPath),
  };
}

async function requireMattermostChannel(
  channelId: string,
  label: string,
): Promise<StoredMattermostChannel> {
  const channel = await readMattermostChannel(`/channels/${encodeURIComponent(channelId)}`);
  if (!channel) throw new MattermostChannelBindingError(`${label} channel ${channelId} was not found`);
  return channel;
}

async function readMattermostChannel(path: string): Promise<StoredMattermostChannel | null> {
  let raw: unknown;
  try {
    raw = await mmApi(path);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  if (!raw || typeof raw !== "object") {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid channel for ${path}`);
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.name !== "string"
    || typeof record.team_id !== "string"
    || typeof record.delete_at !== "number"
    || (record.type !== "P" && record.type !== "O")
  ) {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid channel for ${path}`);
  }
  return {
    id: record.id,
    name: record.name,
    teamId: record.team_id,
    type: record.type,
    deleteAt: record.delete_at,
  };
}

function assertChannelBinding(
  channel: StoredMattermostChannel,
  binding: ExpectedBinding,
  label: string,
): void {
  if (channel.teamId !== binding.teamId || channel.name !== binding.primaryName) {
    throw new MattermostChannelBindingError(
      `${label} channel binding mismatch: expected ${binding.teamId}/${binding.primaryName}, got ${channel.teamId}/${channel.name}`,
    );
  }
}

function assertLegacyActivityBinding(
  channel: StoredMattermostChannel,
  binding: ExpectedBinding,
  primaryType: "P" | "O",
): void {
  const expectedName = legacyActivityChannelName(binding.primaryName);
  if (
    channel.teamId !== binding.teamId
    || channel.name !== expectedName
    || channel.type !== primaryType
  ) {
    throw new MattermostChannelBindingError(
      `legacy Activity channel binding mismatch: expected ${binding.teamId}/${expectedName}/${primaryType}, got ${channel.teamId}/${channel.name}/${channel.type}`,
    );
  }
}

function legacyActivityChannelName(primaryName: string): string {
  const direct = `${primaryName}-activity`;
  if (direct.length <= CHANNEL_NAME_MAX_LENGTH) return direct;
  const hash = createHash("sha256").update(primaryName).digest("hex").slice(0, 12);
  const suffix = `-act-${hash}`;
  return `${primaryName.slice(0, CHANNEL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

async function setMattermostChannelArchived(
  channel: StoredMattermostChannel,
  archived: boolean,
): Promise<void> {
  if ((channel.deleteAt > 0) === archived) return;
  if (archived) {
    await mmApi(`/channels/${channel.id}`, "DELETE");
    return;
  }
  await mmApi(`/channels/${channel.id}/restore`, "POST");
}

async function requireMattermostUser(mmUserId: string): Promise<{ id: string; deleteAt: number }> {
  const user = await readMattermostUser(mmUserId);
  if (!user) throw new MattermostIdentityMissingError(`Mattermost user ${mmUserId} was not found`);
  return user;
}

async function readMattermostUser(mmUserId: string): Promise<{ id: string; deleteAt: number } | null> {
  let raw: unknown;
  try {
    raw = await mmApi(`/users/${mmUserId}`);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  if (!raw || typeof raw !== "object") {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid user for ${mmUserId}`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string") {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid user for ${mmUserId}`);
  }
  return { id: record.id, deleteAt: typeof record.delete_at === "number" ? record.delete_at : 0 };
}

function isNotFoundError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("404") || message.includes("not_found");
}

async function addMember(channelId: string, mmUserId: string): Promise<void> {
  try {
    await mmApi(`/channels/${channelId}/members`, "POST", { user_id: mmUserId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("409") && !message.includes("user_already_in_channel")) throw error;
  }
}

async function deleteMember(channelId: string, mmUserId: string): Promise<boolean> {
  try {
    await mmApi(`/channels/${channelId}/members/${mmUserId}`, "DELETE");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404") && !message.includes("not_found")) throw error;
    return false;
  }
}

async function expectedBinding(channelDocPath: string): Promise<ExpectedBinding> {
  const { scope, channelId } = channelLocation(channelDocPath);
  const workspaceId = scope.workspaceSlug;
  const teamId = (await platformStateStore.workspaces.records.get(workspaceId))?.mattermostTeamId;
  if (!teamId) {
    throw new MattermostChannelBindingError(`workspace ${workspaceId} has no Mattermost team binding`);
  }
  return scope.projectSlug === null
    ? { primaryName: workspacePrimaryName(workspaceId, channelId), teamId }
    : { primaryName: projectChannelName(workspaceId, scope.projectSlug, channelId), teamId };
}

function workspacePrimaryName(workspaceId: string, channelId: string): string {
  if (channelId === "general") return workspaceGeneralChannelName(workspaceId);
  if (channelId === "coach-dm") return workspaceDefaultAgentChannelName(workspaceId);
  if (channelId === "admin") return workspaceAdminChannelName(workspaceId);
  return workspaceCustomChannelName(workspaceId, channelId);
}
