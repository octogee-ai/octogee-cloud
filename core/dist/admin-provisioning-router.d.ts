import type { Router } from "express";
import { type AdminFleetMutationRunner, type FleetLogger } from "./admin-fleet-router.js";
import { type ProvisioningServiceClient } from "./provisioning-service-client.js";
import type { ProvisioningSync } from "./provisioning-sync.js";
export type AdminProvisioningClient = Pick<ProvisioningServiceClient, "getProvisioning" | "getProvisioningEvents" | "listProvisionings" | "retryProvisioning">;
export interface AdminProvisioningRouterDeps {
    readonly provisioning: AdminProvisioningClient | null;
    readonly journal: AdminFleetMutationRunner;
    readonly logger: Pick<FleetLogger, "warn">;
    readonly sync?: Pick<ProvisioningSync, "specFailures" | "mirrorRefusals">;
    readonly readDeadlineMs?: number;
}
export declare const ADMIN_PROVISIONING_READ_DEADLINE_MS = 5000;
export declare function addAdminProvisioningRoutes(router: Router, deps: AdminProvisioningRouterDeps): void;
