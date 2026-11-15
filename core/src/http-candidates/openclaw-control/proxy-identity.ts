import { assertWorkspaceIdentityReady } from "../../openclaw-workspace-bootstrap.js";
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import { deriveDeviceIdentity, signConnectDevice, type DeviceIdentity } from "@octogee/shared/types/device-identity";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import {
  sendWsRequest,
  startConnectChallengeTracker,
  waitForWsOpen,
} from "@octogee/shared/types/openclaw-wire-core";
import {
  OPENCLAW_CONTROL_UI_CLIENT_ID,
  OPENCLAW_EDGE_SERVICE_IDENTITY,
  isPerUserControlIdentity,
  OPENCLAW_FULL_OPERATOR_SCOPES,
  openClawDeviceSubject,
  openClawProxyIdentityHeaders,
  openClawProxyOrigin,
} from "@octogee/shared/types/openclaw-proxy-identity";
import { WebSocket } from "ws";

import { attachUpstreamRpcClient, type UpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import type { OpenClawControlSession } from "./session.js";
import { synchronizeChannelMemberships, type AuthorizedNativeChannel } from "./channel-membership-sync.js";


const DEFAULT_ROLE_SYNC_TIMEOUT_MS = 10_000;

export interface OpenClawControlProxyIdentitySession {
  uid: string;
  gatewayId: string;
  revisionId: string;
  sessionId: string;
}

export interface OpenClawControlProxyIdentity {
  enabled: boolean;
  userHeaders(session: OpenClawControlProxyIdentitySession, req: Pick<http.IncomingMessage, "socket">): Record<string, string>;
  serviceHeaders(): Record<string, string>;
  deviceIdentity(session: OpenClawControlProxyIdentitySession): DeviceIdentity;
  connectScopes(session: OpenClawControlProxyIdentitySession): string[];
  resolveChatProfile(session: OpenClawControlProxyIdentitySession, source: { channelId: string; postId: string }): Promise<OpenClawChatSenderProfile | null>;
  syncChannelMemberships(session: OpenClawControlSession, options?: { force?: boolean }): Promise<void>;
  syncProfile(session: OpenClawControlProxyIdentitySession): Promise<void>;
}

export interface OpenClawProfile {
  id: string;
  role?: string | null;
  displayName?: string | null;
  hasAvatar?: boolean;
  updatedAt?: number;
}

export interface OpenClawChatSenderProfile {
  mattermostUserId: string;
  profileId: string;
  username: string;
  avatarUrl?: string;
}

export interface OpenClawProfileAppearance {
  displayName: string | null;
  avatar: { revision: string; read(): Promise<Buffer> } | null;
}

export interface CreateOpenClawControlProxyIdentityOptions {
  env?: NodeJS.ProcessEnv;
  upstreamBase: () => URL;
  timeoutMs?: number;
  podAddress?: () => string | undefined;
  openSocket?: typeof openProxyIdentitySocket;
  loadChatAppearance?: typeof import("./profile-appearance.js").loadOpenClawChatProfileAppearance;
  loadChannelMemberships?: (session: OpenClawControlSession) => Promise<readonly AuthorizedNativeChannel[]>;
  loadAppearance?: (session: OpenClawControlProxyIdentitySession) => Promise<OpenClawProfileAppearance>;
}

function loopback(address: string | undefined): boolean {
  if (!address) return true;
  const bare = address.replace(/^::ffff:/u, "");
  return bare === "::1" || bare === "localhost" || bare.startsWith("127.");
}

export function podClientAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4" && isIP(entry.address) === 4) return entry.address;
    }
  }
  return undefined;
}

export function openClawControlClientAddress(
  req: Pick<http.IncomingMessage, "socket">,
  fallback: () => string | undefined,
): string | undefined {
  const peer = req.socket?.remoteAddress?.replace(/^::ffff:/u, "");
  return peer && !loopback(peer) ? peer : fallback();
}

export async function openProxyIdentitySocket(args: {
  url: URL;
  headers: Record<string, string>;
  timeoutMs: number;
  identity?: DeviceIdentity;
  onScopes?: (scopes: string[]) => void;
  caps?: readonly string[];
}): Promise<WebSocket> {
  const ws = new WebSocket(args.url, { headers: args.headers });
  ws.on("error", () => {});
  const nonceTracker = startConnectChallengeTracker(ws);
  try {
    await waitForWsOpen(ws, args.timeoutMs);
    const nonce = await nonceTracker.wait(args.timeoutMs);
    const scopes = [...OPENCLAW_FULL_OPERATOR_SCOPES];
    const hello = await sendWsRequest({
      ws,
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: OPENCLAW_PROTOCOL_VERSION,
        maxProtocol: OPENCLAW_PROTOCOL_VERSION,
        client: {
          id: OPENCLAW_CONTROL_UI_CLIENT_ID,
          displayName: "octogee-identity-sync",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        ...(args.caps ? { caps: [...args.caps] } : {}),
        ...(args.identity ? { scopes, device: signConnectDevice({ identity: args.identity,
          clientId: OPENCLAW_CONTROL_UI_CLIENT_ID, clientMode: "backend", role: "operator", scopes, nonce, platform: process.platform }) } : {}),
      },
      timeoutMs: args.timeoutMs,
      mapConnectErrors: true,
    });
    if (args.onScopes) {
      const auth = (hello as { auth?: { scopes?: unknown } })?.auth;
      if (!Array.isArray(auth?.scopes) || !auth.scopes.every(scope => typeof scope === "string")) throw new Error("OpenClaw did not return effective scopes");
      args.onScopes(auth.scopes as string[]);
    }
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

export async function signedInProfile(rpc: Pick<UpstreamRpcClient, "call">): Promise<OpenClawProfile> {
  const self = await rpc.call<{ profile?: OpenClawProfile }>("users.self", {});
  if (!self.ok) throw new Error(`users.self failed: ${self.reason}`);
  const profile = self.result?.profile;
  if (typeof profile?.id !== "string" || !profile.id) throw new Error("users.self returned no profile");
  return profile;
}

function deviceSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!secret) throw new Error("OPENCLAW_GATEWAY_TOKEN is required to derive per-user OpenClaw devices");
  return secret;
}

export function createOpenClawControlProxyIdentity(
  options: CreateOpenClawControlProxyIdentityOptions,
): OpenClawControlProxyIdentity {
  const env = options.env ?? process.env;
  const enabled = isPerUserControlIdentity(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_SYNC_TIMEOUT_MS;
  const fallbackAddress = options.podAddress ?? podClientAddress;
  const openSocket = options.openSocket ?? openProxyIdentitySocket;
  const loadAppearance = options.loadAppearance ?? (async (session: OpenClawControlProxyIdentitySession) => {
    const { loadOpenClawProfileAppearance } = await import("./profile-appearance.js");
    return loadOpenClawProfileAppearance(session, env);
  });
  const avatarSyncs = new Map<string, { revision: string; updatedAt: number | undefined }>();
  const pendingSyncs = new Map<string, Promise<void>>();
  const channelSyncs = new Map<string, { pending?: Promise<void>; expiresAt: number }>();
  const loadChannels = options.loadChannelMemberships ?? (async (session: OpenClawControlSession) => {
    const { createBrokeredMattermostAccess } = await import("./mattermost-broker.js");
    const { authorizedMattermostSessions } = await import("./mattermost-chat.js");
    const broker = createBrokeredMattermostAccess(session, { env });
    return authorizedMattermostSessions(session, broker.authorize, broker.listWorkspaceChannels);
  });

  const avatarAlreadySynced = (profile: OpenClawProfile, appearance: OpenClawProfileAppearance): boolean => {
    const previous = avatarSyncs.get(profile.id);
    return Boolean(profile.hasAvatar && previous?.revision === appearance.avatar?.revision
      && previous?.updatedAt === profile.updatedAt);
  };

  const identityHeaders = (user: string, clientAddress: string | undefined): Record<string, string> => {
    assertWorkspaceIdentityReady(env);
    return { ...openClawProxyIdentityHeaders({ user, clientAddress }), origin: openClawProxyOrigin(env) };
  };
  const serviceHeaders = (): Record<string, string> =>
    identityHeaders(OPENCLAW_EDGE_SERVICE_IDENTITY, fallbackAddress());

  const identityUrl = (): URL => {
    const url = new URL("/", options.upstreamBase());
    url.protocol = "ws:";
    return url;
  };

  const userProfile = async (uid: string): Promise<OpenClawProfile> => {
    const ws = await openSocket({
      url: identityUrl(),
      headers: identityHeaders(uid, fallbackAddress()),
      timeoutMs,
    });
    const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
    try {
      return await signedInProfile(rpc);
    } finally {
      rpc.dispose();
      ws.close();
    }
  };

  const synchronizeProfile = async (
    session: OpenClawControlProxyIdentitySession, suppliedAppearance?: OpenClawProfileAppearance,
  ): Promise<OpenClawProfile> => {
    const ws = await openSocket({ url: identityUrl(), headers: serviceHeaders(), timeoutMs });
    const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
    try {
      let profile = await userProfile(session.uid);
      const appearance = suppliedAppearance ?? await loadAppearance(session);
      const avatarUnchanged = avatarAlreadySynced(profile, appearance);
      const update = async (method: string, params: Record<string, unknown>): Promise<void> => {
        const result = await rpc.call<{ profile: OpenClawProfile }>(method, { profileId: profile.id, ...params });
        if (!result.ok) throw new Error(`${method} failed: ${result.reason}`);
        profile = result.result.profile;
      };
      if ((profile.displayName ?? null) !== appearance.displayName) {
        await update("users.setDisplayName", { displayName: appearance.displayName });
      }
      if (appearance.avatar) {
        if (!avatarUnchanged) {
          const bytes = await appearance.avatar.read();
          await update("users.setAvatar", { mime: "image/jpeg", avatarBase64: bytes.toString("base64") });
        }
        avatarSyncs.delete(profile.id);
        avatarSyncs.set(profile.id, { revision: appearance.avatar.revision, updatedAt: profile.updatedAt });
        if (avatarSyncs.size > 256) avatarSyncs.delete(avatarSyncs.keys().next().value!);
      }
      return profile;
    } finally {
      rpc.dispose();
      ws.close();
    }
  };

  const syncProfile = (session: OpenClawControlProxyIdentitySession): Promise<void> => {
    const key = JSON.stringify([session.gatewayId, session.uid]);
    const pending = pendingSyncs.get(key);
    if (pending) return pending;
    const sync = synchronizeProfile(session).then(() => {}).finally(() => { pendingSyncs.delete(key); });
    pendingSyncs.set(key, sync);
    return sync;
  };

  const syncChannelMemberships = async (session: OpenClawControlSession, settings: { force?: boolean } = {}): Promise<void> => {
    if (!enabled) return;
    const key = JSON.stringify([session.gatewayId, session.uid, session.workspaceSlug]);
    const existing = channelSyncs.get(key);
    if (existing?.pending) {
      await existing.pending;
      return;
    } else if (!settings.force && existing && existing.expiresAt > Date.now()) return;
    const state: { pending?: Promise<void>; expiresAt: number } = { expiresAt: 0 };
    const work = async () => {
      const authorized = await loadChannels(session);
      const ws = await openSocket({ url: identityUrl(), headers: serviceHeaders(), timeoutMs });
      const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
      try {
        const service = await signedInProfile(rpc);
        const member = await userProfile(session.uid);
        await synchronizeChannelMemberships({ rpc, profileId: member.id, serviceProfileId: service.id, authorized });
        state.expiresAt = Date.now() + 10_000;
      } finally {
        rpc.dispose();
        ws.close();
      }
    };
    state.pending = work().finally(() => {
      state.pending = undefined;
      if (state.expiresAt === 0) channelSyncs.delete(key);
    });
    channelSyncs.set(key, state);
    if (channelSyncs.size > 256) {
      for (const [oldKey, old] of channelSyncs) {
        if (!old.pending && oldKey !== key) { channelSyncs.delete(oldKey); break; }
      }
    }
    await state.pending;
  };

  return {
    enabled,
    syncChannelMemberships,
    userHeaders: (session, req) =>
      ({ ...identityHeaders(session.uid, openClawControlClientAddress(req, fallbackAddress)),
      }),
    serviceHeaders,
    deviceIdentity: (session) =>
      deriveDeviceIdentity({
        secret: deviceSecret(env),
        subject: openClawDeviceSubject(session.gatewayId, session.uid),
      }),
    connectScopes: () => [...OPENCLAW_FULL_OPERATOR_SCOPES],
    async resolveChatProfile(session, source) {
      if (!enabled) return null;
      const load = options.loadChatAppearance ?? (await import("./profile-appearance.js")).loadOpenClawChatProfileAppearance;
      const author = await load(session, source, env);
      if (!author) return null;
      const profile = await synchronizeProfile({ ...session, uid: author.uid }, author.appearance);
      return {
        mattermostUserId: author.mattermostUserId, profileId: profile.id, username: author.username,
        ...(profile.hasAvatar ? { avatarUrl: `/api/users/${encodeURIComponent(profile.id)}/avatar?v=${profile.updatedAt ?? 0}` } : {}),
      };
    },
    syncProfile,
  };
}
