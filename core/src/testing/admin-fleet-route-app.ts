import { expect, vi } from "vitest";
import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

import { addAdminFleetRoutes, type FleetRouterDeps, type GatewayPodDiagnostics } from "../admin-fleet-router.js";
import type { PlatformStateStore } from "../platform-state/store.js";
import {
  createJournalFixtureStore,
  journalRowsIn,
  type FixtureDocuments,
} from "./journal-store.js";
import { firestoreUserAccountReader } from "../user-account.js";

export function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function docsFrom(records: Record<string, Record<string, unknown>>) {
  return Object.entries(records).map(([id, data]) => ({ id, data: () => data }));
}

export function applyDottedPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
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
    const leaf = parts.at(-1)!;
    if ((value as { constructor?: { name?: string } })?.constructor?.name === "DeleteTransform") {
      delete cursor[leaf];
    } else {
      cursor[leaf] = value;
    }
  }
}

export function mkCollection(
  records: Record<string, Record<string, unknown>>,
  createId?: () => string,
) {
  const query = (filters: Array<{ field: string; op: string; value: unknown }> = []) => ({
    where: vi.fn((field: string, op: string, value: unknown) =>
      query([...filters, { field, op, value }]),
    ),
    orderBy: vi.fn(() => query(filters)),
    limit: vi.fn(() => query(filters)),
    get: vi.fn(async () => ({
      docs: docsFrom(records).filter((doc) =>
        filters.every((filter) => {
          const actual = valueAtPath(doc.data(), filter.field);
          return filter.op === "in" && Array.isArray(filter.value)
            ? filter.value.includes(actual)
            : actual === filter.value;
        }),
      ),
      size: docsFrom(records).filter((doc) =>
        filters.every((filter) => {
          const actual = valueAtPath(doc.data(), filter.field);
          return filter.op === "in" && Array.isArray(filter.value)
            ? filter.value.includes(actual)
            : actual === filter.value;
        }),
      ).length,
    })),
    add: vi.fn(async (data: Record<string, unknown>) => {
      if (!createId) throw new Error("collection is read-only in this test harness");
      const id = createId();
      records[id] = data;
      return { id };
    }),
    doc: vi.fn((id: string) => ({
      get: vi.fn(async () => ({
        id,
        exists: records[id] !== undefined,
        data: () => records[id],
      })),
      delete: vi.fn(async () => {
        delete records[id];
      }),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        if (!records[id]) throw new Error(`missing record ${id}`);
        applyDottedPatch(records[id], patch);
      }),
      set: vi.fn(async (data: Record<string, unknown>) => {
        records[id] = data;
      }),
    })),
  });
  return query();
}

export type HarnessDocs = Record<string, Record<string, unknown>>;

export function harnessDocuments(input: {
  collections: Record<string, HarnessDocs>;
  assignments: Record<string, HarnessDocs>;
  singletons: Record<string, { get: () => Record<string, unknown> | undefined; set: (row: Record<string, unknown>) => void }>;
}): FixtureDocuments {
  const docsIn = (byName: Record<string, HarnessDocs>, name: string): HarnessDocs => {
    if (!Object.hasOwn(byName, name)) {
      Object.defineProperty(byName, name, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    return byName[name];
  };
  const locate = (path: string): readonly [HarnessDocs, string] => {
    const segments = path.split("/");
    if (segments.length === 2) return [docsIn(input.collections, segments[0]), segments[1]];
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
  const entries = (): Array<readonly [string, Record<string, unknown>]> => [
    ...Object.entries(input.collections).flatMap(([name, docs]) =>
      Object.entries(docs).map(([id, row]) => [`${name}/${id}`, row] as const)),
    ...Object.entries(input.assignments).flatMap(([gatewayId, docs]) =>
      Object.entries(docs).map(([uid, row]) => [`gateways/${gatewayId}/assignments/${uid}`, row] as const)),
  ];
  return {
    get: (path) => {
      if (Object.hasOwn(input.singletons, path)) return input.singletons[path].get();
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
      if (!path.startsWith(`${collectionPath}/`)) return [];
      const id = path.slice(collectionPath.length + 1);
      return id.includes("/") ? [] : [[id, row] as const];
    }),
    group: (collectionId) => entries().filter(([path]) => {
      const segments = path.split("/");
      return segments.length % 2 === 0 && segments[segments.length - 2] === collectionId;
    }),
  };
}

export function rosterAssignmentSeed(gatewayId: string, uid: string, row: Record<string, unknown>): Record<string, unknown> {
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

function sharedGatewayIdsOf(config: Record<string, unknown>): unknown {
  return typeof config.defaultGatewayId === "string" && config.sharedGatewayIds === undefined
    ? [config.defaultGatewayId]
    : config.sharedGatewayIds;
}

function podDiagnosticsReader(podDiagnostics: Record<string, GatewayPodDiagnostics> | undefined) {
  if (!podDiagnostics) return {};
  return {
    readGatewayPodDiagnostics: vi.fn(async (gatewayId: string): Promise<GatewayPodDiagnostics> =>
      podDiagnostics[gatewayId] ?? {
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

export function mkAdminFleetRouteApp(opts: {
  config: Record<string, unknown>;
  users: Record<string, Record<string, unknown>>;
  glmGateways?: Record<string, Record<string, unknown>>;
  gateways?: Record<string, Record<string, unknown>>;
  operations?: Record<string, Record<string, unknown>>;
  podDiagnostics?: Record<string, GatewayPodDiagnostics>;
  requestNativeReturnSourceRecovery?: (input: { uid: string; operationId: string; requestedAt: number; requestedBy: string }) => Promise<boolean>;
  // gateways/{gatewayId}/assignments/{uid} durable roster docs (PR7).
  assignments?: Record<string, Record<string, Record<string, unknown>>>;
  releases?: Record<string, Record<string, Record<string, unknown>>>;
  platformRelease?: Record<string, unknown>;
  addProductRoutes?: (app: express.Express, deps: {
    db: Firestore;
    store: PlatformStateStore;
    requestNativeReturnSourceRecovery?: FleetRouterDeps["requestNativeReturnSourceRecovery"];
  }) => void;
  productRoutesOnly?: boolean;
}) {
  const sharedGatewayIds = sharedGatewayIdsOf(opts.config);
  const state = {
    config: {
      ...opts.config,
      ...(sharedGatewayIds === undefined ? {} : { sharedGatewayIds }),
    },
    users: { ...opts.users },
    operations: { ...(opts.operations ?? {}) },
  };
  const poolRoots: Record<string, Record<string, unknown>> = { ...(opts.gateways ?? {}) };
  for (const gatewayId of (sharedGatewayIds as string[] | undefined) ?? []) {
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
    doc: vi.fn((path: string) => {
      const uid = /^users\/([^/]+)$/.exec(path)?.[1];
      expect(uid).toBeDefined();
      return mkCollection(state.users).doc(uid!);
    }),
    collection: vi.fn((name: string) => {
      expect(name).toBe("users");
      return mkCollection(state.users);
    }),
  } as unknown as Firestore;

  const app = express();
  app.use(express.json());
  const store = createJournalFixtureStore(journalRowsIn(state.operations), { documents });
  opts.addProductRoutes?.(app, { db, store, requestNativeReturnSourceRecovery: opts.requestNativeReturnSourceRecovery });
  if (!opts.productRoutesOnly) addAdminFleetRoutes(app, {
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
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, state };
}

export function durableGatewayRoot(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

export function isolatedGatewayRoot(
  gatewayId: string,
  ownerUid: string,
  builderSlug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

export function runtimeDoc(
  gatewayId: string,
  heartbeat: Record<string, unknown> = { status: "ready", mountedCustomers: [] },
): Record<string, unknown> {
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

