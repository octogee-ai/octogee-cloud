import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
export interface HeldNativeProjectionScope {
    uid: string;
    slug: string;
    gatewayId: string;
    operationId: string;
    requestId: string;
    holdGeneration: string;
}
export declare function signHeldNativeOfflineDesiredProjection(input: {
    scope: HeldNativeProjectionScope;
    snapshot: FleetBrokerUserSnapshot;
    fleetPrivateKey: string;
}): {
    raw: string;
    signature: string;
    sha256: string;
};
type ProjectionRead = {
    raw: string;
    signature: string;
    expectedSha256: string;
    scope: HeldNativeProjectionScope;
    fleetPublicKey: string;
    readRestoredCredential(accountId: string): Promise<string | null>;
};
export declare function readHeldNativeOfflineDesiredProjection(input: ProjectionRead): Promise<FleetBrokerUserSnapshot>;
export {};
