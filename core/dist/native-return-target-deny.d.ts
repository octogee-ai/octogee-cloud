import type { PlatformStateRepositories } from "./platform-state/index.js";
export declare const NATIVE_RETURN_TARGET_EXCLUSION = "native-return-target-exclusion";
export declare function nativeReturnTargetExclusionId(uid: string): string;
export declare function nativeReturnTargetDenied(store: Pick<PlatformStateRepositories, "journal" | "gateways">, uid: string, gatewayId: string): Promise<boolean>;
export declare function nativeReturnSharedStoreHandoffDenied(store: Pick<PlatformStateRepositories, "journal">, uid: string): Promise<boolean>;
