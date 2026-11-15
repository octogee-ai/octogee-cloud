import type { ChatOutputs, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import type { SecretsRepository } from "./platform-state/secrets.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { UserAgentIdentitiesRepository } from "./platform-state/workspaces.js";
import { type ChatSecretDeps } from "./provisioning-chat-secrets.js";
import { type ProvisioningProjection } from "./provisionSteps.js";
import type { MmUpdate } from "./user-lifecycle.js";
export interface UserAccountDocuments {
    account(uid: string): Promise<Record<string, unknown> | undefined>;
}
export interface ProvisioningMirrorDeps {
    readonly store: Pick<PlatformStateStore, "transaction" | "users" | "workspaces" | "secrets">;
    readonly client: ChatSecretDeps["client"];
    readonly documents: UserAccountDocuments;
    readonly projection: ProvisioningProjection;
    readonly proxyUrl: string | null;
}
export type ProvisioningMirrorOutcome = "written" | "unchanged" | "chat-not-ready" | "credentials-not-issued" | "agent-not-ready" | "chat-id-mismatch" | "being-erased" | "user-missing" | "slug-mismatch";
export declare class ProvisioningMirrorError extends Error {
    readonly uid: string;
    constructor(uid: string, message: string);
}
export declare function userBeingErased(user: Pick<PlatformUserRecord, "accountLifecycle">): boolean;
export interface HeldChatAccountReader {
    readonly secrets: Pick<SecretsRepository, "get">;
    readonly workspaces: {
        readonly agentIdentities: Pick<UserAgentIdentitiesRepository, "get">;
    };
}
export declare function chatAccountMismatch(reader: HeldChatAccountReader, user: Pick<PlatformUserRecord, "uid" | "mattermostUserId">, chat: ChatOutputs): Promise<string | null>;
export declare function mmUpdateFromChatOutputs(input: {
    slug: string;
    chat: ChatOutputs;
    agentChannelName: string;
    proxyUrl: string | null;
}): MmUpdate;
export declare function mirrorUserProvisioning(deps: ProvisioningMirrorDeps, resource: UserProvisioning): Promise<ProvisioningMirrorOutcome>;
