import type { FleetRegistryRecord, OperationRecord, PlatformStateRepositories } from "./platform-state/index.js";
export declare const NATIVE_RETURN_TARGET_EXCLUSION = "native-return-target-exclusion";
export declare function nativeReturnTargetExclusionId(uid: string): string;
type ExclusionReader = Pick<PlatformStateRepositories, "journal" | "gateways" | "fleetRegistry" | "users">;
export type NativeOldTargetRetirement = {
    operationId: string;
    version: number;
    createdAt: number;
    completedAt: number;
};
export interface NativeReturnTargetDrain {
    operationId: string;
    replacementGatewayId: string;
    oldPodUid: string;
    replacementPodUid: string;
    owners: Array<{
        uid: string;
        slug: string;
        epoch: number;
    }>;
    dormantInboundOperationIds: string[];
}
export declare function readNativeReturnTargetDrain(store: ExclusionReader, operation: Pick<OperationRecord, "id" | "input">): Promise<NativeReturnTargetDrain | null>;
export declare function sharedDrainPodMatches(runtime: FleetRegistryRecord | null, podUid: string, now: number): runtime is FleetRegistryRecord;
export declare function nativeReturnTargetDenied(store: ExclusionReader, uid: string, gatewayId: string): Promise<boolean>;
export declare function nativeReturnSharedStoreHandoffDenied(store: ExclusionReader, uid: string): Promise<boolean>;
export declare function readNativeOldTargetRetirement(store: ExclusionReader, gatewayId: string): Promise<NativeOldTargetRetirement | null>;
export {};
