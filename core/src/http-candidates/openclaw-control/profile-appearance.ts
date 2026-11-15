import { USERNAME_RE } from "@octogee/shared/types/identity";
import { postOpenClawControlBroker } from "./broker.js";
import type { OpenClawControlProxyIdentitySession, OpenClawProfileAppearance } from "./proxy-identity.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function loadOpenClawProfileAppearance(
  session: OpenClawControlProxyIdentitySession,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<OpenClawProfileAppearance> {
  const { gatewayId, revisionId, sessionId } = session;
  const response = await postOpenClawControlBroker("/internal/openclaw-control/profile", {
    gatewayId, revisionId, sessionId,
  }, env, fetchImpl);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Profile broker request failed: ${response.status}`);
  }
  return parseAppearance(await response.json());
}

function parseAppearance(value: unknown): OpenClawProfileAppearance {
  const body = record(value);
  if (!body || (body.displayName !== null && (typeof body.displayName !== "string" || body.displayName.length > 256))) {
    throw new Error("Invalid profile broker response");
  }
  if (body.avatar === null) return { displayName: body.displayName as string | null, avatar: null };
  return { displayName: body.displayName as string | null, avatar: parseAvatar(body.avatar) };
}

function parseAvatar(value: unknown): NonNullable<OpenClawProfileAppearance["avatar"]> {
  const avatar = record(value);
  if (!avatar || typeof avatar.revision !== "string" || !avatar.revision || avatar.revision.length > 256 ||
    typeof avatar.avatarBase64 !== "string" || !avatar.avatarBase64 || avatar.avatarBase64.length > 699_052 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(avatar.avatarBase64)) {
    throw new Error("Invalid profile broker response");
  }
  const bytes = Buffer.from(avatar.avatarBase64, "base64");
  return { revision: avatar.revision, read: async () => bytes };
}

export async function loadOpenClawChatProfileAppearance(
  session: OpenClawControlProxyIdentitySession,
  source: { channelId: string; postId: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<{ uid: string; username: string; mattermostUserId: string; appearance: OpenClawProfileAppearance } | null> {
  const { gatewayId, revisionId, sessionId } = session;
  const response = await postOpenClawControlBroker("/internal/openclaw-control/profile", {
    gatewayId, revisionId, sessionId, ...source,
  }, env, fetchImpl);
  if (response.status === 204) return null;
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Profile broker request failed: ${response.status}`);
  }
  const body = record(await response.json());
  const author = record(body?.author);
  if (!author || typeof author.uid !== "string" || !author.uid || author.uid.length > 128 ||
    typeof author.username !== "string" || !USERNAME_RE.test(author.username) ||
    typeof author.mattermostUserId !== "string" || !/^[a-z0-9]{26}$/u.test(author.mattermostUserId)) {
    throw new Error("Invalid chat profile broker response");
  }
  return { uid: author.uid, username: author.username, mattermostUserId: author.mattermostUserId, appearance: parseAppearance(body) };
}
