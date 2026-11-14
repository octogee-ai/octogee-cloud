import { vi } from "vitest";
import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { GATEWAY_RELEASES_SUBCOLLECTION, releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";

import { addAdminFleetRoutes } from "../admin-fleet-router.js";
import type { CentralReleaseAuthority } from "../artifact-registry.js";
import type { PlatformStateStore } from "../platform-state/store.js";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "./journal-store.js";
import { firestoreUserAccountReader } from "./firestore-user-accounts.js";

// ── Path-based in-memory Firestore ─────────────────────────────────────────
// Supports the exact surface the release endpoints touch: doc get/set(merge)/
// update, subcollections, collection get/where("in")/orderBy/add, and auto-ids.
function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function applyDottedPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const current = cursor[part];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (value === FieldValue.delete()) delete cursor[key];
    else cursor[key] = value;
  }
}

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const PLATFORM_GATEWAY_REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
export const PLATFORM_BUILD: ReleasePayload = {
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

export interface TestRouterOptions {
  addProductRoutes?: (app: express.Express, deps: { db: Firestore; store: PlatformStateStore }) => void;
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

export function makeDb(
  seed: Record<string, Record<string, unknown>> = {},
  opts: TestRouterOptions = {},
) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
  let auto = 0;
  const nextAutoId = () => `auto-${++auto}`;
  let synchronizedReads = 0;
  let releaseSynchronizedReads: (() => void) | null = null;
  const synchronizedReadsReady = new Promise<void>((resolve) => {
    releaseSynchronizedReads = resolve;
  });

  function childrenOf(prefix: string) {
    const out: Array<{ id: string; path: string }> = [];
    for (const path of store.keys()) {
      if (!path.startsWith(`${prefix}/`)) continue;
      const rest = path.slice(prefix.length + 1);
      if (rest.includes("/")) continue;
      out.push({ id: rest, path });
    }
    return out;
  }

  function snapshotOf(child: { id: string; path: string }) {
    return { id: child.id, exists: true, data: () => store.get(child.path) };
  }

  function docRef(path: string): Record<string, unknown> {
    const id = path.split("/").pop() as string;
    return {
      __path: path,
      id,
      get: async () => {
        if (path === opts.synchronizeFirstTwoReadsOf && synchronizedReads < 2) {
          synchronizedReads += 1;
          if (synchronizedReads === 2) releaseSynchronizedReads?.();
          await synchronizedReadsReady;
        }
        return {
          id,
          exists: store.has(path),
          data: () => store.get(path),
        };
      },
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        if (opts?.merge && store.has(path)) {
          store.set(path, { ...store.get(path), ...data });
        } else {
          store.set(path, { ...data });
        }
      },
      update: async (data: Record<string, unknown>) => {
        if (!store.has(path)) throw new Error(`update of non-existent doc ${path}`);
        applyDottedPatch(store.get(path)!, data);
      },
      delete: async () => {
        store.delete(path);
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(prefix: string): Record<string, unknown> {
    function query(
      filters: Array<{ field: string; op: string; value: unknown }>,
      order: { field: string; dir: string } | null,
    ): Record<string, unknown> {
      return {
        where: (field: string, op: string, value: unknown) =>
          query([...filters, { field, op, value }], order),
        orderBy: (field: string, dir = "asc") => query(filters, { field, dir }),
        limit: () => query(filters, order),
        get: async () => {
          let docs = childrenOf(prefix).map(snapshotOf);
          for (const f of filters) {
            docs = docs.filter((d) => {
              const v = valueAtPath(d.data() ?? {}, f.field);
              if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
              return v === f.value;
            });
          }
          if (order) {
            docs.sort((a, b) => {
              const av = (a.data() ?? {})[order.field] as number;
              const bv = (b.data() ?? {})[order.field] as number;
              const cmp = compareNumbers(av, bv);
              return order.dir === "desc" ? -cmp : cmp;
            });
          }
          return { docs, size: docs.length };
        },
        add: async (data: Record<string, unknown>) => {
          const gid = nextAutoId();
          store.set(`${prefix}/${gid}`, { ...data });
          return { id: gid };
        },
        doc: (docId?: string) => docRef(`${prefix}/${docId ?? nextAutoId()}`),
      };
    }
    return query([], null);
  }

  // Serialized, buffered transactions — emulates Firestore's serializable
  // isolation for conflicting commits (the outcome an optimistic retry produces):
  // bodies run one at a time, and buffered writes apply only if the body
  // completes (a throw leaves the store untouched — all-or-nothing).
  let txnLock: Promise<unknown> = Promise.resolve();
  let firstTransactionStarted = false;
  let failedTransactionRead = false;
  async function runTransaction<T>(
    body: (txn: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      create: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown) => void;
      set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => void;
      update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => void;
      delete: (ref: { delete: () => Promise<void> }) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const run = txnLock.then(async () => {
      if (opts.failTransactions) {
        throw new Error("simulated transaction failure");
      }
      if (!firstTransactionStarted) {
        firstTransactionStarted = true;
        opts.beforeFirstTransaction?.(store);
      }
      const writes: Array<() => Promise<void>> = [];
      const txn = {
        get: (ref: { get: () => Promise<unknown>; __path?: string }) => {
          if (
            !failedTransactionRead &&
            opts.failFirstTransactionReadOf &&
            ref.__path === opts.failFirstTransactionReadOf
          ) {
            failedTransactionRead = true;
            throw new Error(`simulated transaction read failure: ${ref.__path}`);
          }
          return ref.get();
        },
        create: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown) => {
          writes.push(async () => {
            await ref.set(data);
          });
        },
        set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => {
          writes.push(() => ref.set(data, opts));
        },
        update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => {
          writes.push(() => ref.update(data));
        },
        delete: (ref: { delete: () => Promise<void> }) => {
          writes.push(() => ref.delete());
        },
      };
      const result = await body(txn as never);
      for (const w of writes) await w();
      return result;
    });
    txnLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const db = {
    collection: (name: string) => collectionRef(name),
    doc: (path: string) => docRef(path),
    runTransaction,
    batch: () => {
      const ops: Array<() => Promise<void>> = [];
      const b = {
        set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => {
          ops.push(() => ref.set(data, opts));
          return b;
        },
        update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => {
          ops.push(() => ref.update(data));
          return b;
        },
        commit: async () => {
          for (const op of ops) await op();
        },
      };
      return b;
    },
  } as unknown as Firestore;

  return { db, store };
}

export function mkApp(
  seed?: Record<string, Record<string, unknown>>,
  opts?: TestRouterOptions,
) {
  let firstTransactionStarted = false;
  const beforeFirstTransaction = (state: Map<string, Record<string, unknown>>) => {
    if (firstTransactionStarted) return;
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
      if (!label.startsWith("operation-audit.")) beforeFirstTransaction(store);
    },
  });
  opts?.addProductRoutes?.(app, { db, store: platformStore });
  addAdminFleetRoutes(app, {
    accounts: firestoreUserAccountReader(db),
    store: platformStore,
    logger: { info: vi.fn(), warn: vi.fn() },
    provisionGatewayAuthSecret: opts?.provisionGatewayAuthSecret
      ? vi.fn((input) => opts.provisionGatewayAuthSecret!(input))
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

export function opsIn(store: Map<string, Record<string, unknown>>, kind: string) {
  return [...store.entries()]
    .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
    .map(([, data]) => data)
    .filter((d) => d.kind === kind);
}

export function auditsIn(store: Map<string, Record<string, unknown>>) {
  return [...store.entries()]
    .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
    .map(([, data]) => data)
    .filter((data) => data.recordType === "audit");
}

// Seeds a gateway already on the durable root + immutable release schema.

export const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

export function seedNewSchemaGateway(
  id: string,
  payload: ReleasePayload,
  gatewayOverrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
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

export function sharedPayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: REPO,
    imageTag: "abc1234",
    ...overrides,
  };
}

export function readyHeartbeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function seedServingGateway(
  id: string,
  payload: ReleasePayload,
  heartbeat: Record<string, unknown> = readyHeartbeat(),
  gatewayOverrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
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

export function userAuthRecord(gatewayId: string | null): Record<string, unknown> {
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
