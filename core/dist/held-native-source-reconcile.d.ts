import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { FlushGatewayResponse, QuiesceResponse, RestoreMigrationResponse } from "@octogee/shared/types/fleet-controller";
export interface HeldSourceIdentity {
    uid: string;
    slug: string;
    gatewayId: string;
    migrationId: string;
}
export interface HeldSourceClient {
    restore(snapshot: FleetBrokerUserSnapshot): Promise<RestoreMigrationResponse>;
    quiesce(): Promise<QuiesceResponse>;
    flush(): Promise<FlushGatewayResponse>;
    exportManifest(): Promise<{
        migrationId: string;
        slug: string;
        manifest: unknown;
    }>;
}
interface HeldSourceReconcileDeps {
    assertCurrent(): Promise<void>;
    readSnapshot(): Promise<FleetBrokerUserSnapshot>;
    client: HeldSourceClient;
    now(): number;
}
export declare function reconcileHeldNativeSource(identity: HeldSourceIdentity, deps: HeldSourceReconcileDeps): Promise<{
    verifiedAt: number;
    appliedFingerprint: string;
    activationManifestSha256: string;
}>;
export {};
