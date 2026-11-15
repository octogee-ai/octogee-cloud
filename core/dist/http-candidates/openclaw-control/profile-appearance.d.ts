import type { OpenClawControlProxyIdentitySession, OpenClawProfileAppearance } from "./proxy-identity.js";
export declare function loadOpenClawProfileAppearance(session: OpenClawControlProxyIdentitySession, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<OpenClawProfileAppearance>;
export declare function loadOpenClawChatProfileAppearance(session: OpenClawControlProxyIdentitySession, source: {
    channelId: string;
    postId: string;
}, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<{
    uid: string;
    username: string;
    mattermostUserId: string;
    appearance: OpenClawProfileAppearance;
} | null>;
