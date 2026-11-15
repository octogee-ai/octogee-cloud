import type http from "node:http";
import { type DeviceIdentity } from "@octogee/shared/types/device-identity";
import { WebSocket } from "ws";
import { type UpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import type { OpenClawControlSession } from "./session.js";
import { type AuthorizedNativeChannel } from "./channel-membership-sync.js";
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
    resolveChatProfile(session: OpenClawControlProxyIdentitySession, source: {
        channelId: string;
        postId: string;
    }): Promise<OpenClawChatSenderProfile | null>;
    syncChannelMemberships(session: OpenClawControlSession, options?: {
        force?: boolean;
    }): Promise<void>;
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
    avatar: {
        revision: string;
        read(): Promise<Buffer>;
    } | null;
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
export declare function podClientAddress(): string | undefined;
export declare function openClawControlClientAddress(req: Pick<http.IncomingMessage, "socket">, fallback: () => string | undefined): string | undefined;
export declare function openProxyIdentitySocket(args: {
    url: URL;
    headers: Record<string, string>;
    timeoutMs: number;
    identity?: DeviceIdentity;
    onScopes?: (scopes: string[]) => void;
    caps?: readonly string[];
}): Promise<WebSocket>;
export declare function signedInProfile(rpc: Pick<UpstreamRpcClient, "call">): Promise<OpenClawProfile>;
export declare function createOpenClawControlProxyIdentity(options: CreateOpenClawControlProxyIdentityOptions): OpenClawControlProxyIdentity;
