import { ReplyBindingDeniedError, type FinalReplyIdentity, type FinalReplyPost, type FinalReplyTarget } from "@octogee/core/native-final-reply";
import { createMattermostInternalHttpClient, MattermostInternalHttpError } from "../../../gateway-edge/src/chat-proxy/openclaw/mattermost-http.js";

async function read(identity: FinalReplyIdentity, path: string[], query?: Record<string, string>): Promise<unknown> {
  const client = createMattermostInternalHttpClient({ baseUrl: process.env.MM_INTERNAL_URL ?? "", token: identity.coachToken, requireToken: true });
  try {
    return await client.requestJson("GET", path, query);
  } catch (error) {
    if (error instanceof MattermostInternalHttpError && (error.status === 403 || error.status === 404)) throw new ReplyBindingDeniedError();
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReplyBindingDeniedError();
  return value as Record<string, unknown>;
}

export async function readFinalReplyPost(identity: FinalReplyIdentity, postId: string): Promise<FinalReplyPost> {
  const post = record(await read(identity, ["posts", postId]));
  const fileIds = post.file_ids === null ? [] : post.file_ids;
  if (typeof post.id !== "string" || typeof post.channel_id !== "string" || !/^[a-z0-9]{26}$/u.test(post.channel_id)
    || typeof post.root_id !== "string" || typeof post.user_id !== "string" || typeof post.message !== "string"
    || !Number.isSafeInteger(post.delete_at) || (post.delete_at as number) < 0
    || !Array.isArray(fileIds) || !fileIds.every(id => typeof id === "string")) throw new ReplyBindingDeniedError();
  return { id: post.id, channelId: post.channel_id, rootId: post.root_id, userId: post.user_id,
    message: post.message, deleteAt: post.delete_at as number, fileIds };
}

async function verifyDirectMembers(identity: FinalReplyIdentity, target: FinalReplyTarget): Promise<void> {
  const channelId = target.primaryChannelId;
  const members = await read(identity, ["channels", channelId, "members"], { per_page: "200" });
  if (!Array.isArray(members) || members.length !== 2 || target.expectedMemberIds?.length !== 2) throw new ReplyBindingDeniedError();
  const memberIds = members.map(value => {
    const member = record(value);
    if (member.channel_id !== channelId || typeof member.user_id !== "string") throw new ReplyBindingDeniedError();
    return member.user_id;
  });
  if (new Set(memberIds).size !== 2 || !target.expectedMemberIds.every(id => memberIds.includes(id))) throw new ReplyBindingDeniedError();
}

export async function verifyFinalReplyChannel(identity: FinalReplyIdentity, target: FinalReplyTarget): Promise<void> {
  const channelId = target.primaryChannelId;
  const channel = record(await read(identity, ["channels", channelId]));
  if (channel.id !== channelId || channel.type !== target.expectedChannelType || channel.delete_at !== 0
    || (target.expectedChannelTeamId !== null && channel.team_id !== target.expectedChannelTeamId)
    || (target.expectedChannelName !== null && channel.name !== target.expectedChannelName)) throw new ReplyBindingDeniedError();
  if (target.expectedChannelType === "D") {
    await verifyDirectMembers(identity, target);
  } else {
    const member = record(await read(identity, ["channels", channelId, "members", target.recipientMmUserId]));
    if (member.channel_id !== channelId || member.user_id !== target.recipientMmUserId) throw new ReplyBindingDeniedError();
  }
}
