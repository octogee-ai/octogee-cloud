import { type SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { GatewayRuntimeRestartFenceValue, OperationRecord, PlatformStateRepositories, PlatformStateStore } from "./platform-state/index.js";
export declare class HeldNativeReturnConflict extends Error {
}
export interface HeldNativeReturnSelection {
    operationId: string;
    sourceGatewayId: string;
    targetGatewayId: string;
    sourceEpoch: number;
    schedulerMigrationId: string;
}
export interface HeldNativeReturnAuthority extends HeldNativeReturnSelection {
    uid: string;
    slug: string;
    requestId: string;
}
export interface HeldNativeReturnSourceProof {
    verifiedAt: number;
    appliedFingerprint: string;
    activationManifestSha256: string;
}
export declare function readHeldNativeReturnForTargetMaintenance(state: PlatformStateRepositories, selection: HeldNativeReturnSelection, targetFence?: GatewayRuntimeRestartFenceValue, maintenanceRelease?: {
    original: number;
    desired: number;
}): Promise<{
    sourceRelease: number;
    targetRelease: number;
    uid: string;
    slug: string;
}>;
export declare function requestHeldNativeReturnRepair(store: PlatformStateStore, selection: HeldNativeReturnSelection, actor: string, now: number, dryRun?: boolean): Promise<HeldNativeReturnAuthority>;
type HeldClaim = {
    authority: HeldNativeReturnAuthority;
    claimStartedAt: number;
};
export declare function assertHeldNativeReturnRepairClaim(store: PlatformStateStore, claim: HeldClaim): Promise<void>;
export declare function completeHeldNativeReturnRepair(store: PlatformStateStore, claim: HeldClaim, proof: HeldNativeReturnSourceProof, now: number): Promise<SchedulerHandoffState>;
export declare function heldNativeReturnBlocksDestination(op: Pick<OperationRecord, "input" | "schedulerHandoff">, gatewayId: string): boolean;
export declare function heldNativeReturnBlocksOwnerDestination(store: PlatformStateRepositories, gatewayId: string, owner: {
    fences: {
        migration?: {
            operationId?: string;
        };
    };
}): Promise<boolean>;
export {};
