import { CHANNEL_NAME_MAX_LENGTH } from "@octogee/shared/types/identity";
import { mmApi } from "./mattermost.js";

export class ChannelNameInUseError extends Error {
  override readonly name = "ChannelNameInUseError";
}

interface MattermostChannel {
  id: string;
  name: string;
  type: string;
  delete_at: number;
}

export function isChannelNameTakenError(error: unknown): boolean {
  const candidate = error as { status?: unknown; message?: unknown } | null;
  return candidate?.status === 400 &&
    typeof candidate.message === "string" &&
    candidate.message.includes("save_channel.exists");
}

export function retiredChannelName(name: string, nowMs: number): string {
  const suffix = `-x${Math.floor(nowMs / 1000).toString(36)}`;
  return `${name.slice(0, CHANNEL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

async function lookupChannelIncludingArchived(
  teamId: string,
  name: string,
): Promise<MattermostChannel | null> {
  try {
    return await mmApi(`/teams/${teamId}/channels/name/${name}?include_deleted=true`) as MattermostChannel;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return null;
    throw error;
  }
}

export type ChannelNameRelease = "absent" | "released" | "live";

export async function releaseArchivedChannelName(
  teamId: string,
  name: string,
  now: () => number = Date.now,
): Promise<ChannelNameRelease> {
  const existing = await lookupChannelIncludingArchived(teamId, name);
  if (!existing) return "absent";
  if (existing.delete_at <= 0) return "live";
  await mmApi(`/channels/${existing.id}/restore`, "POST");
  try {
    await mmApi(`/channels/${existing.id}/patch`, "PUT", { name: retiredChannelName(name, now()) });
  } catch (renameError) {
    await mmApi(`/channels/${existing.id}`, "DELETE").catch(() => undefined);
    throw renameError;
  }
  await mmApi(`/channels/${existing.id}`, "DELETE");
  return "released";
}

async function createPrivateChannel(teamId: string, name: string, displayName: string): Promise<string> {
  const channel = await mmApi("/channels", "POST", {
    team_id: teamId,
    name,
    display_name: displayName,
    type: "P",
  }) as { id?: string };
  if (!channel?.id) throw new Error("MM returned no channel id");
  return channel.id;
}

export async function createFreshPrivateChannel(
  teamId: string,
  name: string,
  displayName: string,
): Promise<string> {
  try {
    return await createPrivateChannel(teamId, name, displayName);
  } catch (error) {
    if (!isChannelNameTakenError(error)) throw error;
    const release = await releaseArchivedChannelName(teamId, name);
    if (release === "live") {
      throw new ChannelNameInUseError(`Mattermost channel ${name} is already in use on team ${teamId}`);
    }
    if (release === "absent") throw error;
    return createPrivateChannel(teamId, name, displayName);
  }
}
