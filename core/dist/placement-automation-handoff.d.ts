import { type PlacementAutomationOwner, type PlacementAutomationOwnership, type PlacementOwnerFence } from "./placement-automation-owner.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
export type PlacementAutomationPhase = "fleet-controller" | "handoff-pending" | "client";
export interface PlacementAutomationState extends PlacementAutomationOwnership {
    readonly phase: PlacementAutomationPhase;
}
export declare function placementAutomationState(ownership: PlacementAutomationOwnership): PlacementAutomationState;
export declare function readPlacementAutomationState(store: PlatformStateStore): Promise<PlacementAutomationState>;
export interface PlacementAutomationOwnerChange {
    readonly previous: PlacementAutomationOwnership;
    readonly current: PlacementAutomationOwnership;
    readonly changed: boolean;
}
export declare function setPlacementAutomationOwnerInTransaction(transaction: PlatformStateTransaction, owner: PlacementAutomationOwner): Promise<PlacementAutomationOwnerChange>;
export type PlacementYieldOutcome = {
    readonly kind: "not-requested";
    readonly ownership: PlacementAutomationOwnership;
} | {
    readonly kind: "already-yielded";
    readonly ownership: PlacementAutomationOwnership;
} | {
    readonly kind: "yielded";
    readonly ownership: PlacementAutomationOwnership;
};
export declare function yieldPlacementAutomationInTransaction(transaction: PlatformStateTransaction, now: number): Promise<PlacementYieldOutcome>;
export interface PlacementAutomationTurn {
    readonly decides: boolean;
    readonly ownership: PlacementAutomationOwnership;
}
export interface PlacementAutomationGate {
    pass<T>(run: (turn: PlacementAutomationTurn) => Promise<T>): Promise<T>;
    readonly requireOwner: PlacementOwnerFence;
    passesInFlight(): number;
    lastPassStartedAt(): number | null;
}
export interface PlacementAutomationGateDeps {
    store: PlatformStateStore;
    now(): number;
    log(message: string): void;
    warn(message: string): void;
}
export declare function createPlacementAutomationGate(deps: PlacementAutomationGateDeps): PlacementAutomationGate;
