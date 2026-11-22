import { type GatewayDoc, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { type GatewayArtifact } from "./gateway-live-release.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
export type DurableGatewayRoot = GatewayDoc & GatewayMutableConfig;
export declare function asDurableGatewayRoot(data: unknown, gatewayId: string): DurableGatewayRoot | null;
export declare class StaleGatewayReleaseError extends Error {
    readonly gatewayId: string;
    readonly expectedRelease: number;
    readonly actualRelease: number;
    constructor(gatewayId: string, expectedRelease: number, actualRelease: number);
}
export declare class InvalidGatewayRootError extends Error {
    readonly gatewayId: string;
    constructor(gatewayId: string);
}
export declare class GatewayOwnerChangeError extends Error {
    readonly gatewayId: string;
    readonly field: "ownerUid" | "builderSlug";
    constructor(gatewayId: string, field: "ownerUid" | "builderSlug");
}
export interface AppendGatewayReleaseArgs {
    gateway: DurableGatewayRoot;
    artifact: GatewayArtifact;
    payload?: ReleasePayload;
    createdBy: string;
    now: number;
    sourceRelease: number | null;
    note: string | null;
    origin?: "automatic" | "operator";
}
export declare function rolloutOperationInput(gatewayId: string, targetRelease: number, artifact: GatewayArtifact): Record<string, unknown>;
export declare function appendGatewayRelease(store: PlatformStateStore, args: AppendGatewayReleaseArgs): Promise<{
    release: number;
    operationId: string | null;
}>;
export declare function appendRetainedSharedMaintenanceReleaseInStore(transaction: PlatformStateTransaction, input: {
    gatewayId: string;
    attemptId: string;
    phase: "dispatched" | "rollback";
    originalRelease: number;
    payload: ReleasePayload;
    now: number;
}): Promise<number>;
export interface RecoveredGatewayReleaseInput {
    gatewayId: string;
    operationId: string;
    claimedStartedAt: number | null;
    payload: ReleasePayload;
    now: number;
}
export declare function recordRecoveredGatewayReleaseInStore(transaction: PlatformStateTransaction, input: RecoveredGatewayReleaseInput): Promise<{
    release: number;
    operationId: string;
}>;
