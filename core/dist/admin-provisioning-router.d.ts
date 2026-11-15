import type { Router } from "express";
import { type AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { type ProvisioningServiceClient } from "./provisioning-service-client.js";
export type AdminProvisioningClient = Pick<ProvisioningServiceClient, "getProvisioning" | "getProvisioningEvents" | "listProvisionings" | "retryProvisioning">;
export interface AdminProvisioningRouterDeps {
    readonly provisioning: AdminProvisioningClient | null;
    readonly journal: AdminFleetMutationRunner;
}
export declare function addAdminProvisioningRoutes(router: Router, deps: AdminProvisioningRouterDeps): void;
