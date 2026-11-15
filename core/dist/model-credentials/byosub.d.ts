import { userDefaultAgentId } from "../byosub-onboarding.js";
export { userDefaultAgentId };
export declare function byosubSecretName(uid: string, provider: string): string;
export declare function isSafeGatewayId(id: unknown): id is string;
export declare function validateCodexCredential(raw: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
type CredentialValidation = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function validateClaudeCliToken(raw: string): CredentialValidation;
export declare function validateClaudeCliCredential(raw: string): CredentialValidation;
export type ByosubProvider = "openai" | "anthropic";
export type ByosubStatus = "connected" | "needs_reauth";
export type ByosubModelCredentialProvider = "openai-codex" | "claude-cli";
export declare function modelCredentialProviderForByosubProvider(provider: ByosubProvider): ByosubModelCredentialProvider;
export interface ByosubProviderConnectionView {
    connected: boolean;
    provider: ByosubProvider;
    status: ByosubStatus;
    modelCredentialProvider: ByosubModelCredentialProvider;
}
export interface ByosubConnectionView {
    connected: boolean;
    providers: Partial<Record<ByosubProvider, ByosubProviderConnectionView>>;
}
export declare function byosubConnectionView(ref: {
    providers?: unknown;
} | null | undefined): ByosubConnectionView;
export type ByosubHealthStatus = "healthy" | "needs_reauth" | "missing" | "not_connected" | "not_on_this_pod";
export interface ByosubHealthView {
    connected: boolean;
    status: ByosubHealthStatus;
    provider?: string;
}
export declare function deriveByosubHealth(input: {
    mountedHere: boolean;
    refProvider: string | null;
    storePresent: boolean;
    profileExpiresAt?: number | null;
    authStateText: string | null;
    profileId: string;
    now: number;
}): ByosubHealthView;
export interface DeviceAuthStart {
    flowId: string;
    verificationUrl: string;
    userCode: string;
    expiresInMinutes: number | null;
}
export interface DeviceAuthStatus {
    state: string;
    expiresInMinutes?: number;
}
export interface GatewayDeviceAuthClient {
    start(args: {
        gatewayId: string;
        agentId: string;
    }): Promise<DeviceAuthStart>;
    status(args: {
        gatewayId: string;
        flowId: string;
    }): Promise<DeviceAuthStatus>;
}
export interface ClaudeSsoStart {
    flowId: string;
    verificationUrl: string;
    expiresInMinutes: number | null;
    state: string;
}
export interface ClaudeSsoStatus {
    state: string;
    expiresInMinutes?: number;
    reason?: string;
}
export interface GatewayClaudeSsoClient {
    start(args: {
        gatewayId: string;
        agentId: string;
    }): Promise<ClaudeSsoStart>;
    status(args: {
        gatewayId: string;
        flowId: string;
    }): Promise<ClaudeSsoStatus>;
    submit(args: {
        gatewayId: string;
        flowId: string;
        code: string;
    }): Promise<ClaudeSsoStatus>;
}
export declare function brokerByosubFlow(args: {
    flowId: string;
    agentId: string;
    provider: string;
}): Promise<void>;
export declare function gatewayDeviceAuthClient(): GatewayDeviceAuthClient;
export declare function gatewayClaudeSsoClient(): GatewayClaudeSsoClient;
