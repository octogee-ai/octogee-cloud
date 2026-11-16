import type { Router } from "express";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { type RootGitKeyGate } from "./gateway-root-deletion.js";
import type { OperationPatch, OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export interface AdminPlacementCapabilities {
    retirementFailedRetryably(operation: Stored<OperationRecord>, gatewayId: string): boolean;
    schedulerHandoffAwaitingRelease(operation: Stored<OperationRecord>): boolean;
    rearmedRetirementPatch: OperationPatch;
    gatewayGitKeys: RootGitKeyGate;
}
export interface AdminPlacementRouterDeps extends AdminPlacementCapabilities {
    store: PlatformStateStore;
    journal: AdminFleetMutationRunner;
}
export interface RetiredIsolatedGateway {
    gatewayId: string;
    ownerUid: string;
    allocationGeneration: number;
    retirementOperation: {
        id: string;
        kind: string;
        status: string;
        placementRetirement: boolean;
        failedRetryably: boolean;
    } | null;
    unreleasedHandoffOperationId: string | null;
    ownerGatewayId: string | null;
    activationLeases: Array<{
        uid: string;
        status: string;
    }>;
}
export declare function readRetiredIsolatedGateways(deps: Pick<AdminPlacementRouterDeps, "store" | "retirementFailedRetryably" | "schedulerHandoffAwaitingRelease">): Promise<{
    gateways: RetiredIsolatedGateway[];
}>;
export declare function addAdminPlacementRoutes(router: Router, deps: AdminPlacementRouterDeps): void;
