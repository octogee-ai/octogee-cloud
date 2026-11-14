import { expect, vi } from "vitest";
import express from "express";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { addAdminFleetRoutes } from "../admin-fleet-router.js";
import { createJournalFixtureStore, journalRowsIn, } from "./journal-store.js";
import { firestoreUserAccountReader } from "../user-account.js";
export function valueAtPath(data, path) {
    let cursor = data;
    for (const part of path.split(".")) {
        if (!cursor || typeof cursor !== "object")
            return undefined;
        cursor = cursor[part];
    }
    return cursor;
}
export function docsFrom(records) {
    return Object.entries(records).map(([id, data]) => ({ id, data: () => data }));
}
export function applyDottedPatch(target, patch) {
    for (const [path, value] of Object.entries(patch)) {
        const parts = path.split(".");
        let cursor = target;
        for (const part of parts.slice(0, -1)) {
            const current = cursor[part];
            if (!current || typeof current !== "object" || Array.isArray(current)) {
                cursor[part] = {};
            }
            cursor = cursor[part];
        }
        const leaf = parts.at(-1);
        if (value?.constructor?.name === "DeleteTransform") {
            delete cursor[leaf];
        }
        else {
            cursor[leaf] = value;
        }
    }
}
export function mkCollection(records, createId) {
    const query = (filters = []) => ({
        where: vi.fn((field, op, value) => query([...filters, { field, op, value }])),
        orderBy: vi.fn(() => query(filters)),
        limit: vi.fn(() => query(filters)),
        get: vi.fn(async () => ({
            docs: docsFrom(records).filter((doc) => filters.every((filter) => {
                const actual = valueAtPath(doc.data(), filter.field);
                return filter.op === "in" && Array.isArray(filter.value)
                    ? filter.value.includes(actual)
                    : actual === filter.value;
            })),
            size: docsFrom(records).filter((doc) => filters.every((filter) => {
                const actual = valueAtPath(doc.data(), filter.field);
                return filter.op === "in" && Array.isArray(filter.value)
                    ? filter.value.includes(actual)
                    : actual === filter.value;
            })).length,
        })),
        add: vi.fn(async (data) => {
            if (!createId)
                throw new Error("collection is read-only in this test harness");
            const id = createId();
            records[id] = data;
            return { id };
        }),
        doc: vi.fn((id) => ({
            get: vi.fn(async () => ({
                id,
                exists: records[id] !== undefined,
                data: () => records[id],
            })),
            delete: vi.fn(async () => {
                delete records[id];
            }),
            update: vi.fn(async (patch) => {
                if (!records[id])
                    throw new Error(`missing record ${id}`);
                applyDottedPatch(records[id], patch);
            }),
            set: vi.fn(async (data) => {
                records[id] = data;
            }),
        })),
    });
    return query();
}
export function harnessDocuments(input) {
    const docsIn = (byName, name) => {
        if (!Object.hasOwn(byName, name)) {
            Object.defineProperty(byName, name, { value: {}, enumerable: true, writable: true, configurable: true });
        }
        return byName[name];
    };
    const locate = (path) => {
        const segments = path.split("/");
        if (segments.length === 2)
            return [docsIn(input.collections, segments[0]), segments[1]];
        if (segments.length === 4 && segments[0] === "gateways" && segments[2] === "assignments") {
            return [docsIn(input.assignments, segments[1]), segments[3]];
        }
        if (segments.length === 4 && segments[0] === "gateways" && segments[2] === "releases") {
            return [docsIn(input.collections, `gateways/${segments[1]}/releases`), segments[3]];
        }
        if (segments.length === 4 && segments[0] === "users" && segments[2] === "system") {
            return [docsIn(input.collections, `users/${segments[1]}/system`), segments[3]];
        }
        throw new Error(`the admin fleet route harness does not store ${path}`);
    };
    const entries = () => [
        ...Object.entries(input.collections).flatMap(([name, docs]) => Object.entries(docs).map(([id, row]) => [`${name}/${id}`, row])),
        ...Object.entries(input.assignments).flatMap(([gatewayId, docs]) => Object.entries(docs).map(([uid, row]) => [`gateways/${gatewayId}/assignments/${uid}`, row])),
    ];
    return {
        get: (path) => {
            if (Object.hasOwn(input.singletons, path))
                return input.singletons[path].get();
            const [docs, id] = locate(path);
            return Object.hasOwn(docs, id) ? docs[id] : undefined;
        },
        set: (path, row) => {
            if (Object.hasOwn(input.singletons, path)) {
                input.singletons[path].set(row);
                return;
            }
            const [docs, id] = locate(path);
            Object.defineProperty(docs, id, { value: row, enumerable: true, writable: true, configurable: true });
        },
        delete: (path) => {
            const [docs, id] = locate(path);
            delete docs[id];
        },
        children: (collectionPath) => entries().flatMap(([path, row]) => {
            if (!path.startsWith(`${collectionPath}/`))
                return [];
            const id = path.slice(collectionPath.length + 1);
            return id.includes("/") ? [] : [[id, row]];
        }),
        group: (collectionId) => entries().filter(([path]) => {
            const segments = path.split("/");
            return segments.length % 2 === 0 && segments[segments.length - 2] === collectionId;
        }),
    };
}
export function rosterAssignmentSeed(gatewayId, uid, row) {
    return {
        uid,
        gatewayId,
        slug: uid,
        source: "onboarding",
        state: "serving",
        epoch: 0,
        createdAt: 1,
        updatedAt: 1,
        updatedByOperationId: null,
        ...row,
    };
}
function sharedGatewayIdsOf(config) {
    return typeof config.defaultGatewayId === "string" && config.sharedGatewayIds === undefined
        ? [config.defaultGatewayId]
        : config.sharedGatewayIds;
}
function podDiagnosticsReader(podDiagnostics) {
    if (!podDiagnostics)
        return {};
    return {
        readGatewayPodDiagnostics: vi.fn(async (gatewayId) => podDiagnostics[gatewayId] ?? {
            status: "unknown",
            totalPods: 0,
            readyPods: 0,
            totalRestarts: 0,
            spotPods: 0,
            onDemandPods: 0,
            unknownCapacityPods: 0,
            pods: [],
            error: "diagnostics unavailable",
        }),
    };
}
export function mkAdminFleetRouteApp(opts) {
    const sharedGatewayIds = sharedGatewayIdsOf(opts.config);
    const state = {
        config: {
            ...opts.config,
            ...(sharedGatewayIds === undefined ? {} : { sharedGatewayIds }),
        },
        users: { ...opts.users },
        operations: { ...(opts.operations ?? {}) },
    };
    const poolRoots = { ...(opts.gateways ?? {}) };
    for (const gatewayId of sharedGatewayIds ?? []) {
        poolRoots[gatewayId] ??= durableGatewayRoot(gatewayId, { liveRelease: 1 });
    }
    const assignments = Object.fromEntries(Object.entries(opts.assignments ?? {}).map(([gatewayId, byUid]) => [
        gatewayId,
        Object.fromEntries(Object.entries(byUid).map(([uid, row]) => [uid, rosterAssignmentSeed(gatewayId, uid, row)])),
    ]));
    const documents = harnessDocuments({
        collections: {
            users: state.users,
            gateways: poolRoots,
            [GLM_GATEWAYS_COLLECTION]: opts.glmGateways ?? {},
            [GLM_OPERATIONS_COLLECTION]: state.operations,
            glmControllerState: opts.platformRelease ? { platformRelease: opts.platformRelease } : {},
            ...Object.fromEntries(Object.entries(opts.releases ?? {}).map(([gatewayId, byRelease]) => [`gateways/${gatewayId}/releases`, byRelease])),
        },
        assignments,
        singletons: {
            "config/orchestrator": {
                get: () => state.config,
                set: (row) => { state.config = row; },
            },
        },
    });
    const db = {
        doc: vi.fn((path) => {
            const uid = /^users\/([^/]+)$/.exec(path)?.[1];
            expect(uid).toBeDefined();
            return mkCollection(state.users).doc(uid);
        }),
        collection: vi.fn((name) => {
            expect(name).toBe("users");
            return mkCollection(state.users);
        }),
    };
    const app = express();
    app.use(express.json());
    const store = createJournalFixtureStore(journalRowsIn(state.operations), { documents });
    opts.addProductRoutes?.(app, { db, store, requestNativeReturnSourceRecovery: opts.requestNativeReturnSourceRecovery });
    if (!opts.productRoutesOnly)
        addAdminFleetRoutes(app, {
            accounts: firestoreUserAccountReader(db),
            store,
            logger: { info: vi.fn(), warn: vi.fn() },
            provisionGatewayAuthSecret: vi.fn(async () => ({})),
            listGatewayBuilds: vi.fn(async () => []),
            requestNativeReturnSourceRecovery: opts.requestNativeReturnSourceRecovery,
            ...podDiagnosticsReader(opts.podDiagnostics),
            suspendAuthUser: vi.fn(async () => undefined),
            revokeConnectorGrantsForUser: vi.fn(async () => undefined),
        });
    app.use((error, _req, res, _next) => {
        res.status(500).json({ error: error.message });
    });
    return { app, state };
}
export function durableGatewayRoot(gatewayId, overrides = {}) {
    return {
        gatewayId,
        createdAt: 1,
        createdBy: "test",
        updatedAt: 1,
        updatedBy: "test",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: null,
        liveRevisionId: null,
        trafficRevisionId: null,
        desiredStatus: "running",
        roll: null,
        configSchemaVersion: 1,
        profile: null,
        gatewayClass: "shared",
        imageProfile: "standard",
        sizingTier: null,
        gcpProject: null,
        gatewayContainerSecurityContext: null,
        serviceAccountName: null,
        serviceAccount: null,
        builderAccess: null,
        ownerUid: null,
        builderSlug: null,
        modelBrokerLimits: null,
        preemption: null,
        ...overrides,
    };
}
export function isolatedGatewayRoot(gatewayId, ownerUid, builderSlug, overrides = {}) {
    return durableGatewayRoot(gatewayId, {
        liveRelease: 1,
        profile: "builder",
        gatewayClass: "builder",
        imageProfile: "builder",
        sizingTier: "s",
        ownerUid,
        builderSlug,
        ...overrides,
    });
}
export function runtimeDoc(gatewayId, heartbeat = { status: "ready", mountedCustomers: [] }) {
    return {
        docKind: "runtime",
        gatewayId,
        release: 1,
        lifecycle: "serving",
        helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
        },
        heartbeat: { version: "1234567", lastHeartbeatAt: 1_000, startedAt: 500, ...heartbeat },
        lastError: { message: null, at: null },
    };
}
