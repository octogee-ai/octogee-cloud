import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import { type FleetRouterDeps, type GatewayPodDiagnostics } from "@octogee/core/admin-fleet-router";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { type FixtureDocuments } from "./journal-store.js";
export declare function valueAtPath(data: Record<string, unknown>, path: string): unknown;
export declare function docsFrom(records: Record<string, Record<string, unknown>>): {
    id: string;
    data: () => Record<string, unknown>;
}[];
export declare function applyDottedPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void;
export declare function mkCollection(records: Record<string, Record<string, unknown>>, createId?: () => string): {
    where: import("vitest").Mock<(field: string, op: string, value: unknown) => /*elided*/ any>;
    orderBy: import("vitest").Mock<() => /*elided*/ any>;
    limit: import("vitest").Mock<() => /*elided*/ any>;
    get: import("vitest").Mock<() => Promise<{
        docs: {
            id: string;
            data: () => Record<string, unknown>;
        }[];
        size: number;
    }>>;
    add: import("vitest").Mock<(data: Record<string, unknown>) => Promise<{
        id: string;
    }>>;
    doc: import("vitest").Mock<(id: string) => {
        get: import("vitest").Mock<() => Promise<{
            id: string;
            exists: boolean;
            data: () => Record<string, unknown>;
        }>>;
        delete: import("vitest").Mock<() => Promise<void>>;
        update: import("vitest").Mock<(patch: Record<string, unknown>) => Promise<void>>;
        set: import("vitest").Mock<(data: Record<string, unknown>) => Promise<void>>;
    }>;
};
export type HarnessDocs = Record<string, Record<string, unknown>>;
export declare function harnessDocuments(input: {
    collections: Record<string, HarnessDocs>;
    assignments: Record<string, HarnessDocs>;
    singletons: Record<string, {
        get: () => Record<string, unknown> | undefined;
        set: (row: Record<string, unknown>) => void;
    }>;
}): FixtureDocuments;
export declare function rosterAssignmentSeed(gatewayId: string, uid: string, row: Record<string, unknown>): Record<string, unknown>;
export declare function mkAdminFleetRouteApp(opts: {
    config: Record<string, unknown>;
    users: Record<string, Record<string, unknown>>;
    glmGateways?: Record<string, Record<string, unknown>>;
    gateways?: Record<string, Record<string, unknown>>;
    operations?: Record<string, Record<string, unknown>>;
    podDiagnostics?: Record<string, GatewayPodDiagnostics>;
    requestNativeReturnSourceRecovery?: (input: {
        uid: string;
        operationId: string;
        requestedAt: number;
        requestedBy: string;
    }) => Promise<boolean>;
    assignments?: Record<string, Record<string, Record<string, unknown>>>;
    releases?: Record<string, Record<string, Record<string, unknown>>>;
    platformRelease?: Record<string, unknown>;
    addProductRoutes?: (app: express.Express, deps: {
        db: Firestore;
        store: PlatformStateStore;
        requestNativeReturnSourceRecovery?: FleetRouterDeps["requestNativeReturnSourceRecovery"];
    }) => void;
    productRoutesOnly?: boolean;
}): {
    app: import("express-serve-static-core").Express;
    state: {
        config: {
            sharedGatewayIds?: {} | null | undefined;
        };
        users: {
            [x: string]: Record<string, unknown>;
        };
        operations: {
            [x: string]: Record<string, unknown>;
        };
    };
};
export declare function durableGatewayRoot(gatewayId: string, overrides?: Record<string, unknown>): Record<string, unknown>;
export declare function isolatedGatewayRoot(gatewayId: string, ownerUid: string, builderSlug: string, overrides?: Record<string, unknown>): Record<string, unknown>;
export declare function runtimeDoc(gatewayId: string, heartbeat?: Record<string, unknown>): Record<string, unknown>;
