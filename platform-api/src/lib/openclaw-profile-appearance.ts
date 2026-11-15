import sharp from "sharp";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { MM_URL } from "../../../gateway-edge/src/lib/mattermost.js";
import type { OpenClawProfileAppearance } from "@octogee/core/http-candidates/openclaw-control/proxy-identity";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const PROFILE_TIMEOUT_MS = 5_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fullName(first: unknown, last: unknown): string {
  return [text(first), text(last)].filter(Boolean).join(" ");
}

function mattermostName(user: Record<string, unknown>): string {
  return fullName(user.first_name, user.last_name) || text(user.nickname) || text(user.username);
}

export async function avatarJpeg(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_AVATAR_BYTES) throw new Error("Avatar exceeds 5 MB");
    chunks.push(Buffer.from(chunk));
  }
  return sharp(Buffer.concat(chunks), { limitInputPixels: 16_777_216 })
    .resize(256, 256, { fit: "cover", position: "centre" })
    .jpeg({ quality: 85 }).toBuffer();
}

async function mattermostProfileRequest(path: string, token: string): Promise<Response> {
  const response = await fetch(`${MM_URL}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Mattermost profile request failed: ${response.status}`);
  }
  return response;
}

export interface UserProfileAppearance {
  displayName: string | null;
  avatar: OpenClawProfileAppearance["avatar"];
}

export type UserProfileAppearanceSource = (uid: string) => Promise<UserProfileAppearance>;

export const NO_USER_PROFILE_APPEARANCE: UserProfileAppearanceSource = async () => ({ displayName: null, avatar: null });

type ProfileAppearanceStore = Pick<PlatformStateRepositories, "users" | "secrets">;

export type OpenClawProfileAppearanceLoader = (uid: string) => Promise<OpenClawProfileAppearance>;

async function mattermostAppearance(
  store: ProfileAppearanceStore,
  uid: string,
  mmUserId: string,
): Promise<OpenClawProfileAppearance> {
  const secret = await store.secrets.get(uid, "mattermost");
  const token = text(secret?.kind === "builder-mattermost" ? secret.personalToken : null);
  if (!token) throw new Error("Mattermost personal token missing for profile sync");
  const mmUser = await (await mattermostProfileRequest("/users/me", token)).json() as Record<string, unknown>;
  if (mmUser.id !== mmUserId) throw new Error("Mattermost profile identity mismatch");
  return {
    displayName: mattermostName(mmUser) || null,
    avatar: {
      revision: `mattermost:${mmUserId}:${mmUser.last_picture_update ?? 0}`,
      read: async () => {
        const response = await mattermostProfileRequest(`/users/${encodeURIComponent(mmUserId)}/image`, token);
        if (!response.body) throw new Error("Mattermost avatar response has no body");
        return avatarJpeg(response.body);
      },
    },
  };
}

export async function loadOpenClawProfileAppearance(
  store: ProfileAppearanceStore,
  uid: string,
  userProfile: UserProfileAppearanceSource = NO_USER_PROFILE_APPEARANCE,
): Promise<OpenClawProfileAppearance> {
  const userRecord = await store.users.records.get(uid);
  if (!userRecord) throw new Error("Octogee user not found for profile sync");
  const own = await userProfile(uid);
  const mmUserId = text(userRecord.mattermostUserId);
  const displayName = text(own.displayName);
  const mattermost = mmUserId && (!displayName || !own.avatar)
    ? await mattermostAppearance(store, uid, mmUserId) : null;
  return {
    displayName: displayName || mattermost?.displayName || null,
    avatar: own.avatar ?? mattermost?.avatar ?? null,
  };
}
