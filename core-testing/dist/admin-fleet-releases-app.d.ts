import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { CentralReleaseAuthority } from "@octogee/core/artifact-registry";
import type { PlatformStateStore } from "@octogee/core/platform-state";
export declare const PLATFORM_BUILD: ReleasePayload;
export interface TestRouterOptions {
    addProductRoutes?: (app: express.Express, deps: {
        db: Firestore;
        store: PlatformStateStore;
    }) => void;
    synchronizeFirstTwoReadsOf?: string;
    failTransactions?: boolean;
    beforeFirstTransaction?: (store: Map<string, Record<string, unknown>>) => void;
    failFirstTransactionReadOf?: string;
    releaseEnvironment?: "test" | "prod" | null;
    releaseAuthority?: CentralReleaseAuthority;
    provisionGatewayAuthSecret?: (input: {
        gatewayId: string;
        gatewayServiceAccount: string;
    }) => Promise<unknown>;
}
export declare function makeDb(seed?: Record<string, Record<string, unknown>>, opts?: TestRouterOptions): {
    db: Firestore;
    store: Map<string, Record<string, unknown>>;
};
export declare function mkApp(seed?: Record<string, Record<string, unknown>>, opts?: TestRouterOptions): {
    app: import("express-serve-static-core").Express;
    store: Map<string, Record<string, unknown>>;
};
export declare function opsIn(store: Map<string, Record<string, unknown>>, kind: string): Record<string, unknown>[];
export declare function auditsIn(store: Map<string, Record<string, unknown>>): Record<string, unknown>[];
export declare const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
export declare function seedNewSchemaGateway(id: string, payload: ReleasePayload, gatewayOverrides?: Record<string, unknown>): Record<string, Record<string, unknown>>;
export declare function sharedPayload(overrides?: Partial<ReleasePayload>): ReleasePayload;
export declare function readyHeartbeat(overrides?: Record<string, unknown>): Record<string, unknown>;
export declare function seedServingGateway(id: string, payload: ReleasePayload, heartbeat?: Record<string, unknown>, gatewayOverrides?: Record<string, unknown>): Record<string, Record<string, unknown>>;
export declare function userAuthRecord(gatewayId: string | null): Record<string, unknown>;
