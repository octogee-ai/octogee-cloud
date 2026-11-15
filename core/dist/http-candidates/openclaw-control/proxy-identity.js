import { assertWorkspaceIdentityReady } from "../../openclaw-workspace-bootstrap.js";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import { deriveDeviceIdentity, signConnectDevice } from "@octogee/shared/types/device-identity";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { sendWsRequest, startConnectChallengeTracker, waitForWsOpen, } from "@octogee/shared/types/openclaw-wire-core";
import { OPENCLAW_CONTROL_UI_CLIENT_ID, OPENCLAW_EDGE_SERVICE_IDENTITY, isPerUserControlIdentity, OPENCLAW_FULL_OPERATOR_SCOPES, openClawDeviceSubject, openClawProxyIdentityHeaders, openClawProxyOrigin, } from "@octogee/shared/types/openclaw-proxy-identity";
import { WebSocket } from "ws";
import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { synchronizeChannelMemberships } from "./channel-membership-sync.js";
const DEFAULT_ROLE_SYNC_TIMEOUT_MS = 10_000;
function loopback(address) {
    if (!address)
        return true;
    const bare = address.replace(/^::ffff:/u, "");
    return bare === "::1" || bare === "localhost" || bare.startsWith("127.");
}
export function podClientAddress() {
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (!entry.internal && entry.family === "IPv4" && isIP(entry.address) === 4)
                return entry.address;
        }
    }
    return undefined;
}
export function openClawControlClientAddress(req, fallback) {
    const peer = req.socket?.remoteAddress?.replace(/^::ffff:/u, "");
    return peer && !loopback(peer) ? peer : fallback();
}
export async function openProxyIdentitySocket(args) {
    const ws = new WebSocket(args.url, { headers: args.headers });
    ws.on("error", () => { });
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
            const auth = hello?.auth;
            if (!Array.isArray(auth?.scopes) || !auth.scopes.every(scope => typeof scope === "string"))
                throw new Error("OpenClaw did not return effective scopes");
            args.onScopes(auth.scopes);
        }
        return ws;
    }
    catch (error) {
        ws.terminate();
        throw error;
    }
}
export async function signedInProfile(rpc) {
    const self = await rpc.call("users.self", {});
    if (!self.ok)
        throw new Error(`users.self failed: ${self.reason}`);
    const profile = self.result?.profile;
    if (typeof profile?.id !== "string" || !profile.id)
        throw new Error("users.self returned no profile");
    return profile;
}
function deviceSecret(env) {
    const secret = env.OPENCLAW_GATEWAY_TOKEN?.trim();
    if (!secret)
        throw new Error("OPENCLAW_GATEWAY_TOKEN is required to derive per-user OpenClaw devices");
    return secret;
}
export function createOpenClawControlProxyIdentity(options) {
    const env = options.env ?? process.env;
    const enabled = isPerUserControlIdentity(env);
    const timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_SYNC_TIMEOUT_MS;
    const fallbackAddress = options.podAddress ?? podClientAddress;
    const openSocket = options.openSocket ?? openProxyIdentitySocket;
    const loadAppearance = options.loadAppearance ?? (async (session) => {
        const { loadOpenClawProfileAppearance } = await import("./profile-appearance.js");
        return loadOpenClawProfileAppearance(session, env);
    });
    const avatarSyncs = new Map();
    const pendingSyncs = new Map();
    const channelSyncs = new Map();
    const loadChannels = options.loadChannelMemberships ?? (async (session) => {
        const { createBrokeredMattermostAccess } = await import("./mattermost-broker.js");
        const { authorizedMattermostSessions } = await import("./mattermost-chat.js");
        const broker = createBrokeredMattermostAccess(session, { env });
        return authorizedMattermostSessions(session, broker.authorize, broker.listWorkspaceChannels);
    });
    const avatarAlreadySynced = (profile, appearance) => {
        const previous = avatarSyncs.get(profile.id);
        return Boolean(profile.hasAvatar && previous?.revision === appearance.avatar?.revision
            && previous?.updatedAt === profile.updatedAt);
    };
    const identityHeaders = (user, clientAddress) => {
        assertWorkspaceIdentityReady(env);
        return { ...openClawProxyIdentityHeaders({ user, clientAddress }), origin: openClawProxyOrigin(env) };
    };
    const serviceHeaders = () => identityHeaders(OPENCLAW_EDGE_SERVICE_IDENTITY, fallbackAddress());
    const identityUrl = () => {
        const url = new URL("/", options.upstreamBase());
        url.protocol = "ws:";
        return url;
    };
    const userProfile = async (uid) => {
        const ws = await openSocket({
            url: identityUrl(),
            headers: identityHeaders(uid, fallbackAddress()),
            timeoutMs,
        });
        const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
        try {
            return await signedInProfile(rpc);
        }
        finally {
            rpc.dispose();
            ws.close();
        }
    };
    const synchronizeProfile = async (session, suppliedAppearance) => {
        const ws = await openSocket({ url: identityUrl(), headers: serviceHeaders(), timeoutMs });
        const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
        try {
            let profile = await userProfile(session.uid);
            const appearance = suppliedAppearance ?? await loadAppearance(session);
            const avatarUnchanged = avatarAlreadySynced(profile, appearance);
            const update = async (method, params) => {
                const result = await rpc.call(method, { profileId: profile.id, ...params });
                if (!result.ok)
                    throw new Error(`${method} failed: ${result.reason}`);
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
                if (avatarSyncs.size > 256)
                    avatarSyncs.delete(avatarSyncs.keys().next().value);
            }
            return profile;
        }
        finally {
            rpc.dispose();
            ws.close();
        }
    };
    const syncProfile = (session) => {
        const key = JSON.stringify([session.gatewayId, session.uid]);
        const pending = pendingSyncs.get(key);
        if (pending)
            return pending;
        const sync = synchronizeProfile(session).then(() => { }).finally(() => { pendingSyncs.delete(key); });
        pendingSyncs.set(key, sync);
        return sync;
    };
    const syncChannelMemberships = async (session, settings = {}) => {
        if (!enabled)
            return;
        const key = JSON.stringify([session.gatewayId, session.uid, session.workspaceSlug]);
        const existing = channelSyncs.get(key);
        if (existing?.pending) {
            await existing.pending;
            return;
        }
        else if (!settings.force && existing && existing.expiresAt > Date.now())
            return;
        const state = { expiresAt: 0 };
        const work = async () => {
            const authorized = await loadChannels(session);
            const ws = await openSocket({ url: identityUrl(), headers: serviceHeaders(), timeoutMs });
            const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
            try {
                const service = await signedInProfile(rpc);
                const member = await userProfile(session.uid);
                await synchronizeChannelMemberships({ rpc, profileId: member.id, serviceProfileId: service.id, authorized });
                state.expiresAt = Date.now() + 10_000;
            }
            finally {
                rpc.dispose();
                ws.close();
            }
        };
        state.pending = work().finally(() => {
            state.pending = undefined;
            if (state.expiresAt === 0)
                channelSyncs.delete(key);
        });
        channelSyncs.set(key, state);
        if (channelSyncs.size > 256) {
            for (const [oldKey, old] of channelSyncs) {
                if (!old.pending && oldKey !== key) {
                    channelSyncs.delete(oldKey);
                    break;
                }
            }
        }
        await state.pending;
    };
    return {
        enabled,
        syncChannelMemberships,
        userHeaders: (session, req) => ({ ...identityHeaders(session.uid, openClawControlClientAddress(req, fallbackAddress)),
        }),
        serviceHeaders,
        deviceIdentity: (session) => deriveDeviceIdentity({
            secret: deviceSecret(env),
            subject: openClawDeviceSubject(session.gatewayId, session.uid),
        }),
        connectScopes: () => [...OPENCLAW_FULL_OPERATOR_SCOPES],
        async resolveChatProfile(session, source) {
            if (!enabled)
                return null;
            const load = options.loadChatAppearance ?? (await import("./profile-appearance.js")).loadOpenClawChatProfileAppearance;
            const author = await load(session, source, env);
            if (!author)
                return null;
            const profile = await synchronizeProfile({ ...session, uid: author.uid }, author.appearance);
            return {
                mattermostUserId: author.mattermostUserId, profileId: profile.id, username: author.username,
                ...(profile.hasAvatar ? { avatarUrl: `/api/users/${encodeURIComponent(profile.id)}/avatar?v=${profile.updatedAt ?? 0}` } : {}),
            };
        },
        syncProfile,
    };
}
