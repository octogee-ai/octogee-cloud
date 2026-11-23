import type { EphemeralGatewayWriter, GatewayRoot, PlatformStateStore, PlatformStateTransaction } from "../platform-state/index.js";
export declare function sameEphemeralWriter(writer: EphemeralGatewayWriter | undefined, pod: EphemeralGatewayWriter): boolean;
export declare function ephemeralSourceMatches(gateway: GatewayRoot | null, ownerUid: string): gateway is GatewayRoot;
export declare function excludedDisklessWriter(root: GatewayRoot | null, owner: {
    uid: string;
    slug: string;
    leaseId: string;
    generation: number;
}): boolean;
export declare function excludedDisklessActivation(tx: PlatformStateTransaction, input: {
    uid: string;
    slug: string;
    gatewayId: string;
    claim?: {
        operationId: string;
        startedAt: number;
    };
}): Promise<boolean>;
export declare function claimEphemeralWriter(input: {
    store: PlatformStateStore;
    gatewayId: string;
    ownerUid: string;
    pod: EphemeralGatewayWriter;
}): Promise<boolean>;
