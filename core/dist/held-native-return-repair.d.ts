import { type HeldNativeOfflineStageReceipt, type SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { OperationRecord, PlatformStateRepositories, PlatformStateStore } from "./platform-state/index.js";
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
export declare const HELD_NATIVE_OFFLINE_SOURCE_FENCE_KIND = "held-native-offline-source";
export declare function requestHeldNativeReturnRepair(store: PlatformStateStore, selection: HeldNativeReturnSelection, actor: string, now: number, dryRun?: boolean): Promise<HeldNativeReturnAuthority>;
type HeldClaim = {
    authority: HeldNativeReturnAuthority;
    claimStartedAt: number;
};
export declare function assertHeldNativeReturnRepairClaim(store: PlatformStateStore, claim: HeldClaim): Promise<void>;
export declare function completeHeldNativeReturnRepair(store: PlatformStateStore, claim: HeldClaim, proof: HeldNativeReturnSourceProof, now: number): Promise<SchedulerHandoffState>;
export declare function reserveHeldNativeOfflineSource(store: PlatformStateStore, selection: HeldNativeReturnSelection, actor: string, now: number, dryRun?: boolean): Promise<HeldNativeReturnAuthority>;
export interface HeldNativeStoppedOriginalWitness {
    originalInstanceId: string;
    stoppedAt: number;
}
export declare function bindHeldNativeStoppedOriginal(store: PlatformStateStore, selection: HeldNativeReturnSelection, witness: HeldNativeStoppedOriginalWitness, actor: string, now: number): Promise<HeldNativeReturnAuthority>;
export declare function assertHeldNativeOfflineSourceClaim(store: PlatformStateStore, claim: HeldClaim): Promise<void>;
export declare function recordHeldNativeOfflineStage(store: PlatformStateStore, claim: HeldClaim, stage: HeldNativeOfflineStageReceipt, now: number): Promise<SchedulerHandoffState>;
export declare function heldNativeReturnBlocksDestination(op: Pick<OperationRecord, "input" | "schedulerHandoff">, gatewayId: string): boolean;
export declare function heldNativeReturnBlocksOwnerDestination(store: PlatformStateRepositories, gatewayId: string, owner: {
    fences: {
        migration?: {
            operationId?: string;
        };
    };
}): Promise<boolean>;
export {};
