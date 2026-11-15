import { type ProductFields } from "@octogee/shared/types/user-entitlements";
import type { MmUpdate } from "./user-lifecycle.js";
import type { UserPatch } from "./platform-state/users.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import type { ProvisionMattermostUserInput, ReadStoredMattermostNames } from "./mattermost/provision.js";
import type { ManagedChannelHost } from "./channel-host/types.js";
export { listTierTemplateFiles, writeTierTemplateFiles, } from "./tier-template-files.js";
export interface AgentBinding {
    agentId: string;
    match?: {
        channel?: string;
        accountId?: string;
        peer?: {
            kind?: string;
            id?: string;
        };
    };
}
export interface AgentEntry {
    id: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
    identity?: {
        name?: string;
        emoji?: string;
    };
    heartbeat?: {
        every?: string;
        target?: string;
        lightContext?: boolean;
    };
    tools?: {
        fs?: {
            workspaceOnly?: boolean;
        };
    };
    [k: string]: unknown;
}
export interface MattermostAccount {
    botToken?: string;
    [k: string]: unknown;
}
export interface OpenclawConfigShape {
    agents?: {
        list?: AgentEntry[];
    };
    bindings?: AgentBinding[];
    channels?: {
        mattermost?: {
            accounts?: Record<string, MattermostAccount>;
            defaultAccount?: string;
        };
    };
}
export interface ProvisioningContext {
    uid: string;
    slug: string;
    contextTemplateKey: string;
    provisionedProductFields: ProductFields;
    ownerName: string;
    customerDir: string;
    today: string;
    username: string;
    templateVars: Record<string, string>;
    userData: Record<string, unknown>;
}
export declare function buildProvisioningContext(uid: string, userData: Record<string, unknown>): ProvisioningContext;
export declare function createUserDirectories(ctx: ProvisioningContext): void;
export declare function writeUserTemplateFiles(ctx: ProvisioningContext): Promise<void>;
export declare function registerDefaultAgent(ctx: ProvisioningContext, config: OpenclawConfigShape): string;
export declare function buildDefaultAgentEntry(ctx: ProvisioningContext): AgentEntry;
export declare function buildDefaultAgentBindings(current: unknown, userDefaultAgentId: string, slug: string, mmUpdate: MmUpdate): AgentBinding[];
export declare function buildRemoveUserConfig(current: OpenclawConfigShape & Record<string, unknown>, slug: string, agentId: string): OpenclawConfigShape & Record<string, unknown>;
export declare function provisionMattermostUserInput(ctx: ProvisioningContext): ProvisionMattermostUserInput;
export declare function provisionMattermost(ctx: ProvisioningContext, channelHost: ManagedChannelHost, projection: ProvisioningProjection): Promise<MmUpdate>;
export declare function upsertMattermostBindingByAgentAndPeer(bindings: AgentBinding[], binding: AgentBinding & {
    match: {
        peer: {
            id: string;
        };
    };
}): void;
export declare function wireDefaultAgentMattermostBindings(config: OpenclawConfigShape, userDefaultAgentId: string, slug: string, mmUpdate: MmUpdate): void;
export interface ProvisioningProjection {
    storedMattermostNames: ReadStoredMattermostNames;
    systemConfig(ctx: ProvisioningContext): Promise<void>;
    user(ctx: ProvisioningContext, mmUpdate: MmUpdate): Promise<void>;
    workspace(ctx: ProvisioningContext): Promise<void>;
    channel(ctx: ProvisioningContext, channelId: "general" | "coach-dm", name: string): Promise<void>;
    agent(ctx: ProvisioningContext): Promise<void>;
    workspaceEntry(ctx: ProvisioningContext, allAgentIds: string[]): Promise<void>;
}
export declare const noProvisioningProjection: ProvisioningProjection;
type ProvisioningStore = Pick<PlatformStateStore, "transaction">;
export declare function markProvisioningComplete(ctx: ProvisioningContext, mmUpdate: MmUpdate, allAgentIds: string[], projection: ProvisioningProjection, store?: ProvisioningStore): Promise<void>;
export declare function buildProvisionedUserPatch(ctx: ProvisioningContext, mmUpdate: MmUpdate): UserPatch;
export declare function buildUserProductFields(ctx: ProvisioningContext, mmUpdate: MmUpdate): Record<string, unknown>;
