import type { Router } from "express";
import type { OperationStatus } from "@octogee/shared/types/glm";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { type GatewayArtifact, type GatewayMutableConfig } from "./gateway-live-release.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export declare const SHARED_POOL_AUTOMATION_SOURCE = "shared-pool-scaler";
export interface AdminSharedPoolRouterDeps {
    store: PlatformStateStore;
    platformArtifact?: GatewayArtifact;
    controllerStartedAt?: number | undefined;
    journal: AdminFleetMutationRunner;
    now?: () => number;
}
export declare function sharedSlotMutableConfig(): GatewayMutableConfig;
export declare function readFleetState(store: PlatformStateStore, input: {
    operationStatuses: readonly OperationStatus[];
    platformArtifact?: GatewayArtifact | undefined;
    controllerStartedAt?: number | undefined;
    now: number;
}): Promise<{
    generatedAt: number;
    fleetControllerStartedAt: number | null;
    platformArtifactHash: string | null;
    config: {
        sharedGatewayAutoscaling: import("@octogee/shared/types/shared-gateway-pool").SharedGatewayAutoscalingConfig | null;
        sizingProfiles: Readonly<Record<string, import("./platform-state/config.js").GatewaySizingProfile>>;
        disposableGatewayIdleMs: number | null;
    };
    sharedPoolAutomation: Stored<import("./platform-state/controller-state.js").SharedPoolScalerState> | null;
    users: readonly Stored<import("./platform-state/users.js").PlatformUserRecord>[];
    gateways: readonly Stored<GatewayRoot>[];
    latestReleasePayloadHashes: {
        [k: string]: string | null;
    };
    assignments: readonly Stored<import("@octogee/shared/types/gateway-releases").AssignmentDoc>[];
    runtimes: readonly Stored<FleetRegistryRecord>[];
    operations: readonly Stored<OperationRecord>[];
}>;
export declare function addAdminSharedPoolRoutes(router: Router, deps: AdminSharedPoolRouterDeps): void;
