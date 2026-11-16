import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { PlacementOwnerFence } from "./placement-automation-owner.js";
import { GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateTransaction, Stored } from "./platform-state/store.js";
export declare const PLACEMENT_MIGRATION_KIND = "migrate-user";
export declare const PLACEMENT_MIGRATION_ACTOR = "glm-controller-placement-policy";
export declare const CONTINUOUS_PLACEMENT_SOURCE = "continuous-placement-policy";
export declare const ACTIVATION_LEASE_SOURCE = "builder-activation-lease";
export declare const PLACEMENT_MIGRATION_SOURCES: readonly ["continuous-placement-policy", "builder-activation-lease"];
export type PlacementMigrationSource = (typeof PLACEMENT_MIGRATION_SOURCES)[number];
export interface PlacementMigrationClassifier {
    operationFailureIsTransient(error: string): boolean;
    gatewayStartupUnavailable(error: string | undefined): boolean;
    sourceRecoveryForwardRetryable(operation: Stored<OperationRecord>): boolean;
}
export interface PlacementMigrationEnqueueContext extends PlacementMigrationClassifier {
    requireOwner: PlacementOwnerFence;
    now: number;
    platformArtifact: ReleasePayload | null;
}
export interface EnqueuePlacementMigrationRequest {
    uid: string;
    builderSlug: string;
    fromGatewayId: string;
    toGatewayId: string;
    source: PlacementMigrationSource;
    operationId: string;
    sharedDrain?: {
        pairedTargetGatewayId: string | null;
    };
}
export interface SupersedePendingSharedDrainMoveRequest {
    operationId: string;
    uid: string;
    builderSlug: string;
    fromGatewayId: string;
    toGatewayId: string;
    leaseId: string;
    generation: number;
    targetGatewayId: string;
    activationOperationId: string;
}
export declare class PlacementMigrationAuthorityError extends Error {
    constructor(message: string);
}
export declare class TerminalPlacementMigrationConflictError extends Error {
    readonly operationId: string;
    readonly status: string;
    constructor(operationId: string, status: string);
}
export declare class HeldUserPlacementError extends GatewayRetirementConflictError {
    readonly uid: string;
    constructor(uid: string);
}
export declare class SharedDrainSupersededError extends Error {
    readonly fromGatewayId: string;
    constructor(fromGatewayId: string, reason: string);
}
export declare function isPlacementMigrationRefusal(error: unknown): boolean;
export declare function continuousPlacementMigrationOperationId(input: {
    uid: string;
    builderSlug: string;
    fromGatewayId: string;
    toGatewayId: string;
    sourceAssignmentEpoch: number;
}): string;
export declare function repairedPlacementProofMatches(data: Record<string, unknown>, repair: Record<string, unknown>, request: EnqueuePlacementMigrationRequest): boolean;
interface RepairedPostgresSourceObservation {
    source: Record<string, unknown>;
    runtime: Record<string, unknown>;
    release: Record<string, unknown>;
    repair: Record<string, unknown>;
    request: EnqueuePlacementMigrationRequest;
    now: number;
}
export declare function repairedPostgresSourceConverged(input: RepairedPostgresSourceObservation): boolean;
export type EnqueuePlacementMigrationOutcome = "created" | "rearmed" | "already-enqueued";
export declare function enqueuePlacementMigrationInTransaction(transaction: PlatformStateTransaction, context: PlacementMigrationEnqueueContext, request: EnqueuePlacementMigrationRequest, admit?: () => Promise<void>): Promise<EnqueuePlacementMigrationOutcome>;
export type SupersedePendingSharedDrainMoveOutcome = {
    kind: "superseded";
} | {
    kind: "already-superseded";
} | {
    kind: "refused";
    reason: string;
};
export declare function supersedePendingSharedDrainMoveInTransaction(transaction: PlatformStateTransaction, context: {
    requireOwner: PlacementOwnerFence;
    now: number;
    operationJournalRetentionMs: number;
}, request: SupersedePendingSharedDrainMoveRequest): Promise<SupersedePendingSharedDrainMoveOutcome>;
export {};
