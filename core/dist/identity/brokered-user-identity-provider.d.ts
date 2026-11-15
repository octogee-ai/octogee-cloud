import { type UserIdentityProvider } from "../user-identity-provider.js";
import { internalFetch } from "../internal-fetch.js";
export declare const USER_IDENTITY_BROKER_PATH = "/internal/user-identity/verify";
export declare const USER_IDENTITY_BROKER_TIMEOUT_MS = 5000;
export declare function userIdentityBrokerUrlFromEnv(env?: Record<string, string | undefined>): string;
export declare function brokeredUserIdentityProvider(options: {
    readonly brokerUrl: string;
    readonly gatewayId: string;
    readonly fetch?: typeof internalFetch;
    readonly credentialHeaders?: () => Promise<Record<string, string>>;
    readonly now?: () => number;
}): UserIdentityProvider;
export declare function installBrokeredUserIdentity(env?: Record<string, string | undefined>): void;
