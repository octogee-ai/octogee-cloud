import { authorizeChannel } from "../../../gateway-edge/src/lib/channel-session-authorization.js";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { USERNAME_RE } from "@octogee/shared/types/identity";

export interface OpenClawChatAuthor {
  uid: string;
  username: string;
  mattermostUserId: string;
}

export type OpenClawChatAuthorResolver = (
  viewerUid: string,
  workspaceSlug: string,
  channelId: string,
  postId: string,
) => Promise<OpenClawChatAuthor | null>;

export async function resolveOpenClawChatAuthor(
  store: Pick<PlatformStateRepositories, "users">,
  viewerUid: string,
  workspaceSlug: string,
  channelId: string,
  postId: string,
): Promise<OpenClawChatAuthor | null> {
  const access = await authorizeChannel(viewerUid, channelId, workspaceSlug, {
    requireActiveLedger: true, includeDefaultAgentConversation: true, signal: AbortSignal.timeout(5_000),
  });
  if (!access || access.forbidden) throw new Error("Chat author channel access denied");
  const post = await access.client.getJson(["posts", postId]) as Record<string, unknown>;
  if (post.id !== postId || post.channel_id !== channelId || typeof post.user_id !== "string") {
    throw new Error("Chat author post does not belong to the authorized channel");
  }
  const author = await store.users.records.findByMattermostUserId(post.user_id);
  if (!author) return null;
  if (author.slug === null || !USERNAME_RE.test(author.slug)) throw new Error("Chat author user slug is invalid");
  return { uid: author.uid, username: author.slug, mattermostUserId: post.user_id };
}
