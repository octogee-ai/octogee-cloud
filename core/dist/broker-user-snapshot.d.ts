import type { FleetBrokerChannelBinding, FleetBrokerProjectCheckoutScope, FleetBrokerUserRuntimeReset, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { GatewayRoot, MattermostTokenSecret, PlatformStateRepositories, PlatformStateStore, PlatformUserRecord, Stored } from "./platform-state/index.js";
export interface BrokerSnapshotDocuments {
    agent(uid: string): Promise<Record<string, unknown> | undefined>;
    projectRecipes(workspaceSlug: string): Promise<ReadonlyMap<string, string>>;
}
interface BrokerSnapshotDeps {
    store: PlatformStateStore;
    records: {
        userDocuments: BrokerSnapshotDocuments;
    };
}
export declare class CorruptStoredFieldError extends Error {
    constructor(message: string);
}
export declare function storedTimeZone(user: Record<string, unknown> | undefined): string | null;
export declare function collectChannelBindings(store: PlatformStateRepositories, slug: string): Promise<{
    bindings: FleetBrokerChannelBinding[];
    projectMemberships: Array<{
        projectId: string;
        channelIds: string[];
    }>;
}>;
export declare function projectCheckoutScopeForGatewayRoot(gatewayData: unknown, gatewayId: string, uid: string, slug: string): FleetBrokerProjectCheckoutScope;
type StoredRuntimeReset = FleetBrokerUserRuntimeReset | (Omit<FleetBrokerUserRuntimeReset, "status"> & {
    status: "acknowledged";
    acknowledgedAt: unknown;
});
export declare function storedRuntimeReset(userRecord: PlatformUserRecord): StoredRuntimeReset | undefined;
export declare function snapshotGreetingPosted(greeting: unknown): boolean;
export declare function snapshotBaseFields(userRecord: PlatformUserRecord, account: Record<string, unknown>, slug: string): Omit<FleetBrokerUserSnapshot, "uid" | "slug" | "channels" | "projectCheckoutScope" | "projects" | "coachToken" | "coachMmUserId" | "coachIdentity" | "byotActive">;
export declare function defaultAgentMattermostSecret(store: PlatformStateRepositories, uid: string): Promise<MattermostTokenSecret | null>;
export declare function snapshotDefaultAgentFields(defaultAgent: MattermostTokenSecret | null): Pick<FleetBrokerUserSnapshot, "coachToken" | "coachMmUserId">;
interface SnapshotModelDials {
    freeTierModelRef: string;
    userAgentDefault: FleetBrokerUserSnapshot["builderAgentDefault"];
}
interface LoadSnapshotOptions {
    modelDials: SnapshotModelDials;
    gatewayId: string;
    gatewayData: GatewayRoot | undefined;
}
export declare function loadSnapshot(deps: BrokerSnapshotDeps, userRecord: Stored<PlatformUserRecord>, account: Record<string, unknown>, options: LoadSnapshotOptions): Promise<(FleetBrokerUserSnapshot & {
    greetingPosted: boolean;
}) | null>;
export {};
