import { type GatewayKubernetesReading, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationStatus } from "@octogee/shared/types/glm";
import type { GatewayArtifact } from "./gateway-live-release.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
export declare const FLEET_STATE_SECTIONS: readonly ["config", "sharedPoolAutomation", "users", "gateways", "releases", "assignments", "runtimes", "operations", "migrations", "placementAutomation"];
export type FleetStateSection = (typeof FLEET_STATE_SECTIONS)[number];
export declare const FLEET_STATE_SECTIONS_ERROR: string;
export type GatewayKubernetesReader = (runtime: Stored<FleetRegistryRecord> | null, now: number) => GatewayKubernetesReading;
export declare const UNKNOWN_GATEWAY_KUBERNETES: GatewayKubernetesReading;
export declare function parseFleetStateSections(raw: unknown): FleetStateSection[] | null;
export declare function platformArtifactHash(artifact: GatewayArtifact | undefined): string | null;
export declare function latestReleasePayloadHash(transaction: PlatformStateTransaction, root: Stored<GatewayRoot>): Promise<string | null>;
export type InstalledSharedReleaseReader = (gateway: GatewayRoot, current: ReleasePayload, requested: ReleasePayload) => Promise<boolean>;
export declare function readSharedReleaseRows(gateways: PlatformStateTransaction["gateways"], roots: readonly Stored<GatewayRoot>[]): Promise<{
    root: Stored<GatewayRoot>;
    payload: ReleasePayload | null;
    hash: string | null;
    verified: boolean;
}[]>;
export declare function selectSharedReleases(rows: Awaited<ReturnType<typeof readSharedReleaseRows>>, artifact: GatewayArtifact | undefined, readInstalled?: InstalledSharedReleaseReader): Promise<{
    platformArtifactHash: string | null;
    latestReleasePayloadHashes: {
        [k: string]: string | null;
    };
    platformCurrentSharedGatewayIds: string[];
}>;
export declare function readSharedGatewayAutoscalingOrNull(transaction: PlatformStateTransaction): Promise<import("@octogee/shared/types/shared-gateway-pool").SharedGatewayAutoscalingConfig | null>;
export interface FleetStateSectionsInput<User extends {
    readonly provisioning: object;
    readonly openclaw: object;
}> {
    readonly sections: readonly FleetStateSection[];
    readonly operationStatuses: readonly OperationStatus[];
    readonly platformArtifact?: GatewayArtifact | undefined;
    readonly readInstalledSharedRelease?: InstalledSharedReleaseReader | undefined;
    readonly controllerStartedAt?: number | undefined;
    readonly now: number;
    readonly projectUser: (user: PlatformUserRecord) => User;
    readonly readGatewayKubernetes?: GatewayKubernetesReader | undefined;
    readonly sourceRecoveryPending?: SourceRecoveryPendingReader | undefined;
}
export type SourceRecoveryPendingReader = (operation: Stored<OperationRecord>) => boolean;
export declare function withSourceRecoveryPending<T extends Stored<OperationRecord>>(operation: T, sourceRecoveryPending: SourceRecoveryPendingReader | undefined): T | (T & {
    sourceRecoveryPending: boolean;
});
export declare function readFleetStateSections<User extends {
    readonly provisioning: object;
    readonly openclaw: object;
}>(store: PlatformStateStore, input: FleetStateSectionsInput<User>): Promise<Record<string, unknown>>;
