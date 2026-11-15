import type { ChatOutputs, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import type { PlatformStateStore } from "./platform-state/store.js";
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
export type ProvisioningMirrorOutcome = "written" | "unchanged" | "chat-not-ready" | "credentials-not-issued" | "user-missing" | "slug-mismatch";
export declare class ProvisioningMirrorError extends Error {
    readonly uid: string;
    constructor(uid: string, message: string);
}
export declare function mmUpdateFromChatOutputs(input: {
    slug: string;
    chat: ChatOutputs;
    agentChannelName: string;
    proxyUrl: string | null;
}): MmUpdate;
export declare function mirrorUserProvisioning(deps: ProvisioningMirrorDeps, resource: UserProvisioning): Promise<ProvisioningMirrorOutcome>;
