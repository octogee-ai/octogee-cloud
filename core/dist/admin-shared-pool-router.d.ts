import type { Router } from "express";
import type { OperationStatus } from "@octogee/shared/types/glm";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { type GatewayArtifact, type GatewayMutableConfig } from "./gateway-live-release.js";
import { type GatewayKubernetesReader } from "./fleet-state-sections.js";
import type { ProvisioningReadiness } from "./provisioning-sync.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export declare const SHARED_POOL_AUTOMATION_SOURCE = "shared-pool-scaler";
export interface AdminSharedPoolRouterDeps {
    store: PlatformStateStore;
    platformArtifact?: GatewayArtifact;
    controllerStartedAt?: number | undefined;
    journal: AdminFleetMutationRunner;
    now?: () => number;
    provisioningReadiness?: ((uid: string) => ProvisioningReadiness | null) | undefined;
    readGatewayKubernetes?: GatewayKubernetesReader | undefined;
}
export declare function sharedSlotMutableConfig(): GatewayMutableConfig;
export interface FleetStateUser {
    readonly uid: string;
    readonly slug: string | null;
    readonly admitted: boolean;
    readonly accountLifecycle: PlatformUserRecord["accountLifecycle"];
    readonly provisioning: {
        readonly status?: string;
    };
    readonly gateway: {
        readonly gatewayId: string;
    } | null;
    readonly openclaw: {
        readonly managedBy?: "cowboy" | "operator";
    };
    readonly fences: Pick<PlatformUserRecord["fences"], "restoreFence" | "sourceTransferFence">;
    readonly provisioningReady?: ProvisioningReadiness | null;
}
export declare function readFleetState(store: PlatformStateStore, input: {
    operationStatuses: readonly OperationStatus[];
    platformArtifact?: GatewayArtifact | undefined;
    controllerStartedAt?: number | undefined;
    now: number;
    provisioningReadiness?: ((uid: string) => ProvisioningReadiness | null) | undefined;
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
    users: FleetStateUser[];
    gateways: readonly Stored<GatewayRoot>[];
    latestReleasePayloadHashes: {
        [k: string]: string | null;
    };
    assignments: readonly Stored<import("@octogee/shared/types/gateway-releases").AssignmentDoc>[];
    runtimes: readonly Stored<FleetRegistryRecord>[];
    operations: readonly Stored<OperationRecord>[];
}>;
export declare function addAdminSharedPoolRoutes(router: Router, deps: AdminSharedPoolRouterDeps): void;
