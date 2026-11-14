import { vi } from "vitest";
import express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { GATEWAY_RELEASES_SUBCOLLECTION, releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { addAdminFleetRoutes } from "../admin-fleet-router.js";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "./journal-store.js";
import { firestoreUserAccountReader } from "./firestore-user-accounts.js";
// ── Path-based in-memory Firestore ─────────────────────────────────────────
// Supports the exact surface the release endpoints touch: doc get/set(merge)/
// update, subcollections, collection get/where("in")/orderBy/add, and auto-ids.
function valueAtPath(data, path) {
    let cursor = data;
    for (const part of path.split(".")) {
        if (!cursor || typeof cursor !== "object")
            return undefined;
        cursor = cursor[part];
    }
    return cursor;
}
function applyDottedPatch(target, patch) {
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
        const key = parts.at(-1);
        if (value === FieldValue.delete())
            delete cursor[key];
        else
            cursor[key] = value;
    }
}
function compareNumbers(a, b) {
    if (a < b)
        return -1;
    return a > b ? 1 : 0;
}
const PLATFORM_GATEWAY_REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
export const PLATFORM_BUILD = {
    imageRepository: PLATFORM_GATEWAY_REPOSITORY,
    imageTag: `abc1234-oc2026.8.1@sha256:${"1".repeat(64)}`,
    profileImages: {
        builder: { imageRepository: `${PLATFORM_GATEWAY_REPOSITORY}-builder`, imageTag: `abc1234-oc2026.8.1@sha256:${"2".repeat(64)}` },
    },
    gatewayEdgeImage: {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
        imageTag: `abc1234-oc2026.8.1@sha256:${"3".repeat(64)}`,
    },
};
export function makeDb(seed = {}, opts = {}) {
    const store = new Map(Object.entries(seed));
    let auto = 0;
    const nextAutoId = () => `auto-${++auto}`;
    let synchronizedReads = 0;
    let releaseSynchronizedReads = null;
    const synchronizedReadsReady = new Promise((resolve) => {
        releaseSynchronizedReads = resolve;
    });
    function childrenOf(prefix) {
        const out = [];
        for (const path of store.keys()) {
            if (!path.startsWith(`${prefix}/`))
                continue;
            const rest = path.slice(prefix.length + 1);
            if (rest.includes("/"))
                continue;
            out.push({ id: rest, path });
        }
        return out;
    }
    function snapshotOf(child) {
        return { id: child.id, exists: true, data: () => store.get(child.path) };
    }
    function docRef(path) {
        const id = path.split("/").pop();
        return {
            __path: path,
            id,
            get: async () => {
                if (path === opts.synchronizeFirstTwoReadsOf && synchronizedReads < 2) {
                    synchronizedReads += 1;
                    if (synchronizedReads === 2)
                        releaseSynchronizedReads?.();
                    await synchronizedReadsReady;
                }
                return {
                    id,
                    exists: store.has(path),
                    data: () => store.get(path),
                };
            },
            set: async (data, opts) => {
                if (opts?.merge && store.has(path)) {
                    store.set(path, { ...store.get(path), ...data });
                }
                else {
                    store.set(path, { ...data });
                }
            },
            update: async (data) => {
                if (!store.has(path))
                    throw new Error(`update of non-existent doc ${path}`);
                applyDottedPatch(store.get(path), data);
            },
            delete: async () => {
                store.delete(path);
            },
            collection: (name) => collectionRef(`${path}/${name}`),
        };
    }
    function collectionRef(prefix) {
        function query(filters, order) {
            return {
                where: (field, op, value) => query([...filters, { field, op, value }], order),
                orderBy: (field, dir = "asc") => query(filters, { field, dir }),
                limit: () => query(filters, order),
                get: async () => {
                    let docs = childrenOf(prefix).map(snapshotOf);
                    for (const f of filters) {
                        docs = docs.filter((d) => {
                            const v = valueAtPath(d.data() ?? {}, f.field);
                            if (f.op === "in")
                                return Array.isArray(f.value) && f.value.includes(v);
                            return v === f.value;
                        });
                    }
                    if (order) {
                        docs.sort((a, b) => {
                            const av = (a.data() ?? {})[order.field];
                            const bv = (b.data() ?? {})[order.field];
                            const cmp = compareNumbers(av, bv);
                            return order.dir === "desc" ? -cmp : cmp;
                        });
                    }
                    return { docs, size: docs.length };
                },
                add: async (data) => {
                    const gid = nextAutoId();
                    store.set(`${prefix}/${gid}`, { ...data });
                    return { id: gid };
                },
                doc: (docId) => docRef(`${prefix}/${docId ?? nextAutoId()}`),
            };
        }
        return query([], null);
    }
    // Serialized, buffered transactions — emulates Firestore's serializable
    // isolation for conflicting commits (the outcome an optimistic retry produces):
    // bodies run one at a time, and buffered writes apply only if the body
    // completes (a throw leaves the store untouched — all-or-nothing).
    let txnLock = Promise.resolve();
    let firstTransactionStarted = false;
    let failedTransactionRead = false;
    async function runTransaction(body) {
        const run = txnLock.then(async () => {
            if (opts.failTransactions) {
                throw new Error("simulated transaction failure");
            }
            if (!firstTransactionStarted) {
                firstTransactionStarted = true;
                opts.beforeFirstTransaction?.(store);
            }
            const writes = [];
            const txn = {
                get: (ref) => {
                    if (!failedTransactionRead &&
                        opts.failFirstTransactionReadOf &&
                        ref.__path === opts.failFirstTransactionReadOf) {
                        failedTransactionRead = true;
                        throw new Error(`simulated transaction read failure: ${ref.__path}`);
                    }
                    return ref.get();
                },
                create: (ref, data) => {
                    writes.push(async () => {
                        await ref.set(data);
                    });
                },
                set: (ref, data, opts) => {
                    writes.push(() => ref.set(data, opts));
                },
                update: (ref, data) => {
                    writes.push(() => ref.update(data));
                },
                delete: (ref) => {
                    writes.push(() => ref.delete());
                },
            };
            const result = await body(txn);
            for (const w of writes)
                await w();
            return result;
        });
        txnLock = run.then(() => undefined, () => undefined);
        return run;
    }
    const db = {
        collection: (name) => collectionRef(name),
        doc: (path) => docRef(path),
        runTransaction,
        batch: () => {
            const ops = [];
            const b = {
                set: (ref, data, opts) => {
                    ops.push(() => ref.set(data, opts));
                    return b;
                },
                update: (ref, data) => {
                    ops.push(() => ref.update(data));
                    return b;
                },
                commit: async () => {
                    for (const op of ops)
                        await op();
                },
            };
            return b;
        },
    };
    return { db, store };
}
export function mkApp(seed, opts) {
    let firstTransactionStarted = false;
    const beforeFirstTransaction = (state) => {
        if (firstTransactionStarted)
            return;
        firstTransactionStarted = true;
        opts?.beforeFirstTransaction?.(state);
    };
    const { db, store } = makeDb(seed, { ...opts, beforeFirstTransaction });
    const app = express();
    app.use(express.json());
    const platformStore = createJournalFixtureStore(journalRowsAtPaths(store), {
        transactionFailure: opts?.failTransactions ? new Error("simulated transaction failure") : undefined,
        documents: fixtureDocumentsAt(store),
        beforeTransaction: (label) => {
            if (!label.startsWith("operation-audit."))
                beforeFirstTransaction(store);
        },
    });
    opts?.addProductRoutes?.(app, { db, store: platformStore });
    addAdminFleetRoutes(app, {
        accounts: firestoreUserAccountReader(db),
        store: platformStore,
        logger: { info: vi.fn(), warn: vi.fn() },
        provisionGatewayAuthSecret: opts?.provisionGatewayAuthSecret
            ? vi.fn((input) => opts.provisionGatewayAuthSecret(input))
            : vi.fn(async () => ({})),
        listGatewayBuilds: vi.fn(async () => []),
        releaseEnvironment: opts?.releaseEnvironment ?? "test",
        releaseAuthority: opts?.releaseAuthority,
        platformArtifact: PLATFORM_BUILD,
        suspendAuthUser: vi.fn(async () => undefined),
        revokeConnectorGrantsForUser: vi.fn(async () => undefined),
    });
    return { app, store };
}
export function opsIn(store, kind) {
    return [...store.entries()]
        .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
        .map(([, data]) => data)
        .filter((d) => d.kind === kind);
}
export function auditsIn(store) {
    return [...store.entries()]
        .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
        .map(([, data]) => data)
        .filter((data) => data.recordType === "audit");
}
// Seeds a gateway already on the durable root + immutable release schema.
export const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
export function seedNewSchemaGateway(id, payload, gatewayOverrides = {}) {
    const config = {
        configSchemaVersion: 1,
        profile: "standard",
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
        coOwnerUids: [],
        ...gatewayOverrides,
    };
    return {
        [`gateways/${id}`]: {
            gatewayId: id,
            createdAt: 1000,
            createdBy: "op",
            updatedAt: 1000,
            updatedBy: "op",
            latestRelease: 1,
            desiredRelease: 1,
            liveRelease: null,
            desiredStatus: "running",
            ...config,
        },
        [`gateways/${id}/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]: {
            gatewayId: id,
            release: 1,
            createdAt: 1000,
            createdBy: "op",
            sourceRelease: null,
            note: null,
            payloadHash: releasePayloadHash(payload),
            payload,
        },
    };
}
export function sharedPayload(overrides = {}) {
    return {
        imageRepository: REPO,
        imageTag: "abc1234",
        ...overrides,
    };
}
export function readyHeartbeat(overrides = {}) {
    const observedAt = Date.now();
    return {
        status: "ready",
        lastHeartbeatAt: observedAt,
        version: "abc1234",
        openclawVersion: "2026.7.1",
        startedAt: observedAt - 1_000,
        mountedCustomers: [],
        configStatus: {
            controlProtocol: {
                protocol: "durable-openclaw-config",
                version: 2,
            },
            observedAt,
            runtimeReady: true,
            openclawVersion: "2026.7.1",
            freezeState: "unfrozen",
            bootRole: "normal",
            controlOwner: null,
            candidateCommit: null,
            candidateHash: null,
        },
        ...overrides,
    };
}
export function seedServingGateway(id, payload, heartbeat = readyHeartbeat(), gatewayOverrides = {}) {
    const seed = seedNewSchemaGateway(id, payload, gatewayOverrides);
    seed[`gateways/${id}`] = {
        ...seed[`gateways/${id}`],
        liveRelease: 1,
    };
    seed[`${GLM_GATEWAYS_COLLECTION}/${id}`] = {
        docKind: "runtime",
        gatewayId: id,
        release: 1,
        lifecycle: "serving",
        createdAt: 1,
        createdByOperationId: null,
        helm: {},
        heartbeat,
        lastError: { message: null, at: null },
    };
    return seed;
}
export function userAuthRecord(gatewayId) {
    return {
        username: "alice",
        provisioning: {
            openclaw: {
                slug: "alice",
                ...(gatewayId ? {
                    gatewayId,
                    gatewayAssignedAt: 1,
                    gatewayProfile: "standard",
                    controlUiEnabled: true,
                } : {}),
            },
        },
    };
}
