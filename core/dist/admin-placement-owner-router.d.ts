import type { Router } from "express";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import type { PlatformStateStore } from "./platform-state/store.js";
export interface AdminPlacementOwnerRouterDeps {
    store: PlatformStateStore;
    journal: AdminFleetMutationRunner;
    log(message: string): void;
}
export declare function addAdminPlacementOwnerRoutes(router: Router, deps: AdminPlacementOwnerRouterDeps): void;
