import { type GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { NewOperation, OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
export declare class GatewayRetirementConflictError extends Error {
    constructor(message: string);
}
export declare class GatewayRetirementTelemetryUnavailableError extends GatewayRetirementConflictError {
    constructor(message: string);
}
export declare class GatewayRetirementReleaseUnconvergedError extends GatewayRetirementConflictError {
    constructor(message: string);
}
type RetirableGateway = GatewayDoc & {
    desiredStatus: "running" | "draining" | "paused";
};
interface ClaimGatewayRetirementInStoreInput {
    store: PlatformStateStore;
    gatewayId: string;
    operationId: string;
    operation: NewOperation;
    now: number;
    updatedBy: string;
    telemetryObservedAfter?: number;
    claimGuard?: (input: {
        transaction: PlatformStateTransaction;
        root: RetirableGateway;
    }) => Promise<void> | void;
    supersededMoves?: {
        operationIds: readonly string[];
        cancelledBecause: string;
    };
}
interface VerifyGatewayRetirementClaimInput {
    store: PlatformStateStore;
    gatewayId: string;
    operationId: string;
    version: number;
    now: number;
    updatedBy: string;
}
export type GatewayRetirementVerification = {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function isolatedRuntimeMutationFenced(user: Stored<PlatformUserRecord>): boolean;
export declare function gatewayRetiredInStore(transaction: PlatformStateTransaction, gatewayId: string): Promise<boolean>;
export declare function assertGatewayRuntimeMutationUnfencedInStore(transaction: PlatformStateTransaction, gatewayId: string, allowedVmRecoveryOperationId?: string): Promise<void>;
export declare function moveHasNotBegun(operation: OperationRecord, gatewayId: string): boolean;
export declare function claimGatewayRetirementInStore(input: ClaimGatewayRetirementInStoreInput): Promise<{
    version: number;
}>;
export declare function verifyGatewayRetirementClaimAtomic(input: VerifyGatewayRetirementClaimInput): Promise<GatewayRetirementVerification>;
export {};
