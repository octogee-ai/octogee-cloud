import type { SizingTier } from "@octogee/shared/types/sizing";
import type { SizingKeyReader } from "../sizing-key.js";
import type { PlatformStateStore, PlatformStateTransaction } from "../platform-state/store.js";
export declare const ISOLATED_GATEWAY_LIFECYCLE_ACTOR = "glm-controller-disposable-gateway";
export declare const PLACEMENT_AUTOMATION_ACTOR = "glm-controller-placement-policy";
export declare const ISOLATED_GATEWAY_ALLOCATION_KIND = "disposable-builder";
export declare const ROLLED_BACK_STATUS = "rolled-back";
export declare class IsolatedGatewayFenceError extends Error {
    constructor(message: string);
}
export type PlacementOwnerFence = (transaction: PlatformStateTransaction) => Promise<void>;
export interface IsolatedLifecycleDeps {
    store: PlatformStateStore;
    readSizingKey: SizingKeyReader;
    requireOwner: PlacementOwnerFence;
    now(): number;
    log(message: string): void;
}
export interface AllocateIsolatedGatewayInput {
    uid: string;
    builderSlug: string;
    leaseId: string;
    generation: number;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
    sizingKey: string;
    sizingTier: SizingTier;
    parkedGateway?: {
        gatewayId: string;
        generation: number;
    };
}
export interface SizingKeyTransitionInput {
    uid: string;
    leaseId: string;
    generation: number;
    targetGatewayId: string;
    sizingKey: string;
}
export interface AdvanceActivationLeaseInput {
    uid: string;
    leaseId: string;
    generation: number;
    fromStatus: "provisioning" | "activating" | "active";
    toStatus: "activating" | "active" | "returning";
    operationId?: string;
}
export interface CompleteActivationLeaseInput {
    uid: string;
    leaseId: string;
    generation: number;
    targetGatewayId: string;
    parked?: true;
}
export interface FailActivationLeaseInput {
    uid: string;
    leaseId: string;
    generation: number;
    targetGatewayId: string;
    operationId: string;
    message: string;
}
export interface RecoverUnreachableIsolatedGatewayInput {
    uid: string;
    builderSlug: string;
    gatewayId: string;
    leaseId: string;
    generation: number;
    authoritativeGatewayId: string;
    sourceUnavailable?: boolean;
}
export type AuthoritativeLeaseStatus = "provisioning" | "activating" | "returning";
export declare const PLACEMENT_RETIREMENT_REASONS: readonly ["provisioning-timeout", "provisioning-target-paused", "builder-authorization-ended", "activation-failed", "builder-returned", "operator-terminated", "parked-computer-replaced", "owned-gateway-not-kept"];
export type PlacementRetirementReason = typeof PLACEMENT_RETIREMENT_REASONS[number];
export interface RetireOwnedIsolatedGatewayInput {
    uid: string;
    builderSlug: string;
    gatewayId: string;
    reason: PlacementRetirementReason;
    leaseId?: string;
    generation: number;
    telemetryFenceOperationId?: string;
    telemetryFenceStatus?: "succeeded" | "terminal-failure";
    authoritativeGatewayId?: string;
    authoritativeLeaseStatus?: AuthoritativeLeaseStatus;
    zeroWorkloadRecoveryOperationId?: string;
}
export declare function fieldMap(value: unknown): Record<string, unknown> | null;
export declare function readMillis(value: unknown): number | null;
