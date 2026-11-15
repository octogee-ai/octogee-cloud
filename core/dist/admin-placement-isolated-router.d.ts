import type { Router } from "express";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { type HomeCapabilitiesFactory } from "./isolated-gateway-lifecycle/index.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import type { UserAccountReader } from "./user-account.js";
import type { PodObservation } from "./isolated-gateway-lifecycle/index.js";
export interface AdminIsolatedCapabilities {
    namespace: string;
    home?: HomeCapabilitiesFactory;
    ensureAuthSecret(input: {
        namespace: string;
        gatewayId: string;
    }): Promise<unknown>;
    readGatewayPodDiagnostics(gatewayId: string): Promise<PodObservation>;
}
export interface AdminPlacementIsolatedRouterDeps {
    store: PlatformStateStore;
    journal: AdminFleetMutationRunner;
    accounts: Pick<UserAccountReader, "get">;
    capabilities: AdminIsolatedCapabilities;
    log(message: string): void;
    warn(message: string): void;
    now?: () => number;
}
export declare function isolatedVerbRefusalBody(error: unknown): Record<string, unknown> | null;
export declare function addAdminPlacementIsolatedRoutes(router: Router, deps: AdminPlacementIsolatedRouterDeps): void;
