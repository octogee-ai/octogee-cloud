import type { PlatformStateRepositories } from "./platform-state/index.js";
export declare const NATIVE_RETURN_TARGET_EXCLUSION = "native-return-target-exclusion";
export declare function nativeReturnTargetExclusionId(uid: string): string;
type ExclusionReader = Pick<PlatformStateRepositories, "journal" | "gateways" | "fleetRegistry" | "users">;
export type NativeOldTargetRetirement = {
    operationId: string;
    version: number;
    createdAt: number;
    completedAt: number;
};
export declare function nativeReturnTargetDenied(store: ExclusionReader, uid: string, gatewayId: string): Promise<boolean>;
export declare function nativeReturnSharedStoreHandoffDenied(store: ExclusionReader, uid: string): Promise<boolean>;
export declare function readNativeOldTargetRetirement(store: ExclusionReader, gatewayId: string): Promise<NativeOldTargetRetirement | null>;
export {};
