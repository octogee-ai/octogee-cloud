import express, { Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type FleetRouterDeps } from "../admin-fleet-router.js";
import type { ReleaseDigestManifest } from "../artifact-registry.js";
import type { PlatformStateStore } from "../platform-state/store.js";
export type Seed = Record<string, Record<string, unknown>>;
export declare const SOURCE_SHA: string;
export declare const MANIFEST: ReleaseDigestManifest;
export declare const PAYLOAD: ReleasePayload;
export declare function gatewayRoot(gatewayId: string, overrides?: Record<string, unknown>): Record<string, unknown>;
export declare function release(gatewayId: string, number: number, payload?: ReleasePayload): Seed;
export declare function servingSharedGateway(gatewayId: string): Seed;
export declare function isolatedGateway(gatewayId: string, ownerUid: string, slug: string): Seed;
export declare function placedUser(uid: string, slug: string, gatewayId: string): Seed;
export declare function operation(id: string, row: Record<string, unknown>): Seed;
export declare const FLEET: Seed;
export declare const VM_RUNTIME: Seed;
export declare function sourceRecoveryFleet(): Seed;
export declare function restoreRecoveryFleet(): Seed;
export interface DryRunInstall {
    addProductRoutes?: (router: Router, deps: {
        db: Firestore;
        store: PlatformStateStore;
        requestNativeReturnSourceRecovery?: FleetRouterDeps["requestNativeReturnSourceRecovery"];
    }) => void;
}
export declare function harness(seed?: Seed, install?: DryRunInstall): {
    app: import("express-serve-static-core").Express;
    router: import("express-serve-static-core").Router;
    records: Map<string, Record<string, unknown>>;
    effects: {
        provisionGatewayAuthSecret: import("vitest").Mock<() => Promise<{}>>;
        suspendAuthUser: import("vitest").Mock<() => Promise<undefined>>;
        revokeConnectorGrantsForUser: import("vitest").Mock<() => Promise<undefined>>;
        requestNativeReturnSourceRecovery: import("vitest").Mock<() => Promise<boolean>>;
        createAccount: import("vitest").Mock<(account: {
            userId: string;
        }) => Promise<{
            kind: "created";
            userId: string;
        }>>;
        setChatPassword: import("vitest").Mock<() => Promise<undefined>>;
        setGitPassword: import("vitest").Mock<() => Promise<string>>;
    };
    snapshot: () => string;
};
export type Method = "post" | "patch" | "delete";
export interface ChangingRequest {
    method: Method;
    path: string;
    body?: Record<string, unknown>;
}
export declare function send(app: express.Express, call: ChangingRequest, dryRun: boolean): request.Test;
