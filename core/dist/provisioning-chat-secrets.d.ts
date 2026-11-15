import type { ChatOutputs, ProvisioningCredentialName, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import type { MattermostTokenSecret, UserSecretInput } from "./platform-state/secrets.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { type ProvisioningServiceClient } from "./provisioning-service-client.js";
export declare const USER_CHAT_SECRET_ID = "mattermost";
export declare const AGENT_CHAT_SECRET_ID = "coachMattermost";
export interface ChatSecretDeps {
    readonly store: Pick<PlatformStateStore, "secrets" | "transaction">;
    readonly client: Pick<ProvisioningServiceClient, "getCredential">;
}
export type ChatSecretsOutcome = "present" | "credentials-not-issued" | "agent-not-ready";
interface ChatSecretTarget {
    readonly secretId: string;
    readonly kind: MattermostTokenSecret["kind"];
    readonly credential: ProvisioningCredentialName;
    readonly mattermostUserId: string;
}
export declare class ProvisioningChatSecretError extends Error {
    readonly uid: string;
    constructor(uid: string, message: string);
}
export declare function chatSecretRow(target: ChatSecretTarget, token: string): UserSecretInput;
export declare function ensureChatSecrets(deps: ChatSecretDeps, resource: UserProvisioning, chat: ChatOutputs): Promise<ChatSecretsOutcome>;
export {};
