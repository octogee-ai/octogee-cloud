import { type OrchestratorConfig, type PlacementAutomationOwner } from "./platform-state/config.js";
import type { PlatformStateTransaction } from "./platform-state/store.js";
export { DEFAULT_PLACEMENT_AUTOMATION_OWNER, PLACEMENT_AUTOMATION_OWNERS, isPlacementAutomationOwner, type PlacementAutomationOwner, } from "./platform-state/config.js";
export declare const PLACEMENT_OWNER_REFUSAL_CODE = "placement-owner";
export interface PlacementAutomationOwnership {
    readonly owner: PlacementAutomationOwner;
    readonly yieldedAt: number | null;
}
export type PlacementAutomationActor = "client" | "fleet-controller";
export declare class PlacementOwnerRefusedError extends Error {
    readonly ownership: PlacementAutomationOwnership;
    readonly refused: PlacementAutomationActor;
    readonly code = "placement-owner";
    constructor(ownership: PlacementAutomationOwnership, refused: PlacementAutomationActor);
}
export declare function placementAutomationOwnership(config: Pick<OrchestratorConfig, "placementAutomationOwner" | "placementAutomationYieldedAt"> | null): PlacementAutomationOwnership;
export declare function clientOwnsPlacementAutomation(ownership: PlacementAutomationOwnership): boolean;
export declare function fleetControllerOwnsPlacementAutomation(ownership: PlacementAutomationOwnership): boolean;
export declare function readPlacementAutomationOwnership(transaction: Pick<PlatformStateTransaction, "config">): Promise<PlacementAutomationOwnership>;
export declare function assertClientOwnsPlacementAutomation(transaction: Pick<PlatformStateTransaction, "config">): Promise<PlacementAutomationOwnership>;
export declare function assertFleetControllerOwnsPlacementAutomation(transaction: Pick<PlatformStateTransaction, "config">): Promise<PlacementAutomationOwnership>;
export type PlacementOwnerFence = (transaction: PlatformStateTransaction) => Promise<void>;
export declare const requireClientPlacementOwner: PlacementOwnerFence;
export declare const requireFleetControllerPlacementOwner: PlacementOwnerFence;
export declare function placementOwnerRefusalBody(error: unknown): {
    code: typeof PLACEMENT_OWNER_REFUSAL_CODE;
    error: string;
} | null;
