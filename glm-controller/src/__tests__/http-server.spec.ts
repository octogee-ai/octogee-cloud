import request from "supertest";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admitAdminDryRunMarker, isAdminDryRun } from "@octogee/core/admin-dry-run";
import { noAdminUserDirectorySource } from "@octogee/core/admin-user-directory-router";
import { userAccountFromData, type UserAccountReader } from "@octogee/core/user-account";
import { createLogger } from "../lib/logger.js";
import type { GatewayPodDiagnostics } from "../lib/kube-ops.js";
import {
  MalformedRecordError,
  type PlatformStateError,
  type PlatformStateStore,
  type WatchAggregate,
  type WatchCursor,
  type WatchEvent,
  type WatchListener,
  type WatchRequest,
  type WatchSubscription,
} from "@octogee/core/platform-state";
import {
  createJournalFixtureStore,
  fixtureDocumentsAt,
  type FixtureDocuments,
} from "@octogee/core/testing/journal-store";
import {
  createHttpServer,
  type HttpServerDeps,
} from "../http-server";

interface FakeStore {
  users: Record<string, Record<string, unknown>>;
  configs: Record<string, Record<string, unknown>>;
  gateways: Record<string, Record<string, unknown>>;
  glmGateways: Record<string, Record<string, unknown>>;
  glmOperations: Array<{ id: string; data: Record<string, unknown> }>;
}

function emptyStore(): FakeStore {
  return {
    users: {},
    configs: {},
    gateways: {},
    glmGateways: {},
    glmOperations: [],
  };
}

function durableIsolatedGateway(
  gatewayId: string,
  desiredStatus: "running" | "paused",
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus,
    roll: null,
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "builder",
    imageProfile: "standard",
    sizingTier: "m",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-alice",
    builderSlug: "alice",
    modelBrokerLimits: null,
    preemption: null,
  };
}

function durableSharedGateway(gatewayId: string): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: "m",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function servingRuntime(
  gatewayId: string,
  opts: {
    imageTag?: string;
    heartbeat?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const imageTag = opts.imageTag ?? "abc1234";
  return {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    retiredAt: null,
    retireReason: null,
    helm: {
      releaseName: `octogee-gw-${gatewayId}-r1`,
      deploymentName: `octogee-gateway-${gatewayId}-r1`,
      gatewayServiceName: `gateway-${gatewayId}-r1`,
      gatewayEdgeServiceName: `gateway-edge-${gatewayId}-r1`,
      serviceAccountName: `octogee-gw-${gatewayId}`,
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
      imageTag,
      replicas: 1,
      availableReplicas: 1,
      lastAppliedAt: 1,
    },
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: null,
      version: null,
      openclawVersion: null,
      internalUrl: null,
      startedAt: null,
      mountedCustomers: [],
      migratingIn: [],
      ...opts.heartbeat,
    },
    lastError: { message: null, at: null },
  };
}

interface WatchRegistry {
  watch: PlatformStateStore["watch"];
  attachCount(aggregate: WatchAggregate): number;
  filterFor(aggregate: WatchAggregate): unknown;
  aggregates(): WatchAggregate[];
  activeCount(): number;
}

const FIXTURE_CURSOR = "fixture-cursor" as WatchCursor;
const SNAPSHOT: WatchEvent<WatchAggregate> = { kind: "snapshot", records: [], cursor: FIXTURE_CURSOR };
const CHANGES: WatchEvent<WatchAggregate> = { kind: "changes", changes: [], cursor: FIXTURE_CURSOR };

function createWatchRegistry(options: {
  script?: (aggregate: WatchAggregate) => readonly WatchEvent<WatchAggregate>[];
  failWith?: (aggregate: WatchAggregate) => PlatformStateError | undefined;
  repeatEveryMs?: number;
} = {}): WatchRegistry {
  const attachCounts = new Map<WatchAggregate, number>();
  const filters = new Map<WatchAggregate, unknown>();
  const script = options.script ?? (() => [SNAPSHOT, CHANGES]);
  let active = 0;
  const watch = (<A extends WatchAggregate>(request: WatchRequest<A>, listener: WatchListener<A>): WatchSubscription => {
    const aggregate: WatchAggregate = request.aggregate;
    attachCounts.set(aggregate, (attachCounts.get(aggregate) ?? 0) + 1);
    filters.set(aggregate, request.filter);
    active += 1;
    let open = true;
    const deliver = (event: WatchEvent<WatchAggregate>) => {
      if (open) void listener.onEvent(event as WatchEvent<A>);
    };
    queueMicrotask(() => {
      const failure = options.failWith?.(aggregate);
      if (failure !== undefined && open) listener.onError(failure);
      for (const event of script(aggregate)) deliver(event);
    });
    const timer = options.repeatEveryMs === undefined ? null : setInterval(() => deliver(CHANGES), options.repeatEveryMs);
    timer?.unref?.();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    return {
      closed,
      close: async () => {
        if (open) {
          open = false;
          active -= 1;
          if (timer) clearInterval(timer);
          resolveClosed();
        }
        return closed;
      },
    };
  }) as PlatformStateStore["watch"];
  return {
    watch,
    attachCount: (aggregate) => attachCounts.get(aggregate) ?? 0,
    filterFor: (aggregate) => filters.get(aggregate),
    aggregates: () => [...attachCounts.keys()],
    activeCount: () => active,
  };
}

function storeWithWatch(store: PlatformStateStore, watch: PlatformStateStore["watch"]): PlatformStateStore {
  return new Proxy(store, {
    get: (target, property) => (property === "watch" ? watch : Reflect.get(target, property)),
  });
}

function accountsOver(store: FakeStore): UserAccountReader {
  const account = (uid: string) => {
    const data = store.users[uid];
    return data === undefined ? null : userAccountFromData(uid, data);
  };
  return {
    get: async (uid) => account(uid),
    getMany: async (uids) => new Map(uids.flatMap((uid) => {
      const found = account(uid);
      return found === null ? [] : [[uid, found] as const];
    })),
    list: async () => new Map(Object.keys(store.users).map((uid) => [uid, account(uid)!] as const)),
  };
}

function setOperation(store: FakeStore, id: string, data: Record<string, unknown>): void {
  const index = store.glmOperations.findIndex((operation) => operation.id === id);
  if (index === -1) store.glmOperations.push({ id, data });
  else store.glmOperations[index] = { id, data };
}

function fakeStoreDocuments(store: FakeStore): FixtureDocuments {
  const other = fixtureDocumentsAt(new Map<string, Record<string, unknown>>());
  const topLevel = (path: string): Record<string, Record<string, unknown>> | null => {
    const [collection, id, ...rest] = path.split("/");
    if (id === undefined || rest.length > 0) return null;
    if (collection === "users") return store.users;
    if (collection === "gateways") return store.gateways;
    if (collection === "glmGateways") return store.glmGateways;
    return null;
  };
  const operationId = (path: string) => /^glmOperations\/([^/]+)$/.exec(path)?.[1];
  const roleOwner = (path: string) => /^users\/([^/]+)\/system\/config$/.exec(path)?.[1];
  return {
    get: (path) => {
      const id = operationId(path);
      if (id !== undefined) return store.glmOperations.find((operation) => operation.id === id)?.data;
      const owner = roleOwner(path);
      if (owner !== undefined) return store.configs[owner];
      return topLevel(path)?.[path.split("/")[1]] ?? other.get(path);
    },
    set: (path, row) => {
      const id = operationId(path);
      if (id !== undefined) return setOperation(store, id, row);
      const owner = roleOwner(path);
      if (owner !== undefined) {
        store.configs[owner] = row;
        return;
      }
      const rows = topLevel(path);
      if (rows) rows[path.split("/")[1]] = row;
      else other.set(path, row);
    },
    delete: (path) => {
      const id = operationId(path);
      if (id !== undefined) {
        store.glmOperations = store.glmOperations.filter((operation) => operation.id !== id);
        return;
      }
      const owner = roleOwner(path);
      if (owner !== undefined) {
        delete store.configs[owner];
        return;
      }
      const rows = topLevel(path);
      if (rows) delete rows[path.split("/")[1]];
      else other.delete(path);
    },
    children: (collectionPath) => {
      if (collectionPath === "glmOperations") {
        return store.glmOperations.map(({ id, data }) => [id, data] as const);
      }
      const rows = topLevel(`${collectionPath}/_`);
      return rows ? Object.entries(rows) : other.children(collectionPath);
    },
    group: (collectionId) => other.group(collectionId),
  };
}

function buildDeps(
  store: FakeStore,
  overrides: Partial<HttpServerDeps> = {},
  watches: WatchRegistry = createWatchRegistry(),
): HttpServerDeps {
  const documents = fakeStoreDocuments(store);
  return {
    userDirectory: noAdminUserDirectorySource,
    store: storeWithWatch(createJournalFixtureStore({
      get: (id) => documents.get(`glmOperations/${id}`),
      set: (id, data) => documents.set(`glmOperations/${id}`, data),
    }, { documents }), watches.watch),
    accounts: accountsOver(store),
    log: vi.fn(),
    identity: {
      issuers: [],
      verifyBearer: vi.fn(async (token: string) => {
        if (token === "admin-token") return { ownerId: "admin-uid", email: null, operator: false };
        if (token === "user-token") return { ownerId: "user-uid", email: null, operator: false };
        throw new Error("invalid token");
      }),
    },
    provisionGatewayAuthSecret: vi.fn(async () => ({
      secretName: "stub",
      created: true,
    })),
    listGatewayBuilds: vi.fn(async () => []),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
    logs: { source: null, namespace: "octogee-test" },
    ...overrides,
  };
}

describe("createHttpServer — admin gateway routes", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = emptyStore();
    store.users["admin-uid"] = { email: "admin@octogee.com" };
    store.configs["admin-uid"] = { role: "admin" };
    store.users["user-uid"] = { email: "user@octogee.com" };
    store.configs["user-uid"] = { role: "user" };
  });

  afterEach(() => vi.unstubAllEnvs());

  it("/healthz responds without auth", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "glm-controller" });
  });

  it("sets CORS headers for allowed origins (admin UI fetches from app[-test].web.app)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://app-octogee-test.web.app");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app-octogee-test.web.app");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("answers OPTIONS preflight with 204 + CORS headers (no auth needed)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .options("/api/admin/users")
      .set("Origin", "https://app-octogee-test.web.app")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app-octogee-test.web.app");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("allows PATCH in the preflight — pause/resume + change-tier hit PATCH /api/admin/gateways/:id; omitting it makes the browser block them", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .options("/api/admin/gateways/gw-test")
      .set("Origin", "https://app-octogee-test.web.app")
      .set("Access-Control-Request-Method", "PATCH");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
  });

  it.each([
    "https://evil.example.com",
    "https://app-octogee-build-week.web.app",
  ])("does not set CORS headers for disallowed origin %s", async (origin) => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", origin);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("denies localhost CORS by default and admits it only for explicit local development", async () => {
    const app = createHttpServer(buildDeps(store));
    const denied = await request(app).get("/healthz").set("Origin", "http://localhost:4322");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();

    vi.stubEnv("OCTOGEE_ALLOW_LOCAL_ORIGINS", "true");
    const devApp = createHttpServer(buildDeps(store));
    const allowed = await request(devApp).get("/healthz").set("Origin", "http://localhost:4322");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:4322");
  });

  it("revokes connector grants on the live controller-owned account deletion route", async () => {
    store.users["delete-me"] = { email: "delete@example.com" };
    const order: string[] = [];
    const app = createHttpServer(buildDeps(store, {
      revokeConnectorGrantsForUser: vi.fn(async () => { order.push("revoke"); }),
      suspendAuthUser: vi.fn(async () => { order.push("suspend-auth"); }),
    }));

    const res = await request(app)
      .post("/api/admin/users/delete-me/delete")
      .set("Authorization", "Bearer admin-token");

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(order).toEqual(["suspend-auth", "revoke"]);
  });

  it("forwards the product's deletion context discovery to the account deletion route", async () => {
    store.users["delete-me"] = { email: "delete@example.com" };
    const discoverDeletionProductContext = vi.fn(async () => ({ stripeCustomerIds: ["cus_1"] }));
    const app = createHttpServer(buildDeps(store, {
      revokeConnectorGrantsForUser: vi.fn(async () => undefined),
      suspendAuthUser: vi.fn(async () => undefined),
      discoverDeletionProductContext,
    }));

    const res = await request(app)
      .post("/api/admin/users/delete-me/delete")
      .set("Authorization", "Bearer admin-token");

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(discoverDeletionProductContext).toHaveBeenCalledWith("delete-me");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin tokens with 403", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer user-token");
    expect(res.status).toBe(403);
  });

  it("serves /api/admin/gateways for admins (empty fleet)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toEqual([]);
    expect(res.body.stats.gateways).toEqual({
      total: 0,
      ready: 0,
      paused: 0,
      unreachable: 0,
    });
  });

  it("makes the immutable release authority available to gateway deployments", async () => {
    const requestedSourceSha = "a".repeat(40);
    const manifestSourceSha = "b".repeat(40);
    const resolveManifest = vi.fn(async () => ({
      sourceSha: manifestSourceSha,
      manifestDigest: `sha256:${"c".repeat(64)}`,
      openclawVersion: "1.2.3",
      repository: "us-central1-docker.pkg.dev/octogee/octogee",
      surfaces: { gateway: {}, platform: {} },
    }));
    store.gateways["gw-alice"] = {
      ...durableIsolatedGateway("gw-alice", "running"),
      profile: "builder",
      imageProfile: "builder",
    };
    const app = createHttpServer(buildDeps(store, {
      releaseEnvironment: "test",
      releaseAuthority: {
        resolveManifest,
        aliasesFor: vi.fn(() => []),
        keepTagsFor: vi.fn(() => []),
        ensureAliases: vi.fn(async () => []),
      },
    }));

    const res = await request(app)
      .post("/api/admin/gateways/gw-alice/deploy")
      .set("Authorization", "Bearer admin-token")
      .send({ sourceSha: requestedSourceSha });

    expect(resolveManifest).toHaveBeenCalledWith(requestedSourceSha);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "release manifest sourceSha does not match the requested SHA",
    });
  });

  it("streams server-driven fleet invalidation events after admin auth", async () => {
    const app = createHttpServer(buildDeps(store));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: ready");
    expect(res.text).toContain("event: changed");
    expect(res.text).toMatch(/"collection":"(users|gateways|config|glmGateways|glmOperations)"/);
  });

  it("subscribes fleet invalidation events to admin data dependencies", async () => {
    const watches = createWatchRegistry();
    const app = createHttpServer(buildDeps(store, {}, watches));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(watches.aggregates()).toEqual(["builders", "gateways", "config", "fleetRegistry", "operations"]);
  });

  it.each([
    ["builders", "users"],
    ["gateways", "gateways"],
    ["config", "config"],
    ["fleetRegistry", "glmGateways"],
    ["operations", "glmOperations"],
  ] as const)("names a %s change by the %s collection the admin app invalidates on", async (aggregate, collection) => {
    const watches = createWatchRegistry({
      script: (watched) => (watched === aggregate ? [SNAPSHOT, CHANGES] : [SNAPSHOT]),
    });
    const app = createHttpServer(buildDeps(store, {}, watches));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.text).toContain(`"collection":"${collection}"`);
  });

  it("announces a change when a resubscribed watch delivers its fresh snapshot", async () => {
    const watches = createWatchRegistry({
      script: (watched) => (watched === "fleetRegistry"
        ? [SNAPSHOT, { kind: "resync", reason: "backend-restart" }, SNAPSHOT]
        : [SNAPSHOT]),
    });
    const app = createHttpServer(buildDeps(store, {}, watches));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.text).toContain(`"collection":"glmGateways"`);
  });

  it("streams a watch failure to admins without ending the stream", async () => {
    const watches = createWatchRegistry({
      failWith: (watched) => (watched === "builders"
        ? new MalformedRecordError({ aggregate: "builder", key: "uid-1" }, "fails the builder schema")
        : undefined),
      script: (watched) => (watched === "operations" ? [SNAPSHOT, CHANGES] : [SNAPSHOT]),
    });
    const app = createHttpServer(buildDeps(store, {}, watches));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.text).toContain(`event: error\ndata: {"collection":"users","error":`);
    expect(res.text).toContain("fails the builder schema");
    expect(res.text).toContain(`"collection":"glmOperations"`);
  });

  it("serves /api/admin/gateways with populated fleet stats", async () => {
    store.gateways["gw-blue"] = durableSharedGateway("gw-blue");
    store.glmGateways["gw-blue"] = servingRuntime("gw-blue", {
      heartbeat: {
        status: "ready",
        version: "abc1234",
        mountedCustomers: ["alice", "bob"],
        lastHeartbeatAt: Date.now() - 2_000,
      },
    });
    store.gateways["gw-stale"] = durableSharedGateway("gw-stale");
    store.glmGateways["gw-stale"] = servingRuntime("gw-stale", {
      heartbeat: {
        status: "unreachable",
        version: "def5678",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now() - 5 * 60_000,
      },
    });
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(2);
    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      paused: 0,
      unreachable: 1,
    });
    expect(res.body.stats.usersMounted).toBe(2);
  });

  it("reads only operations referenced by the Fleet projection", async () => {
    store.users["uid-alice"] = {
      username: "alice",
      provisioning: {
        openclaw: {
          slug: "alice",
          gatewayId: "shared-a",
          activationLease: {
            leaseId: "lease-1",
            generation: 1,
            status: "provisioning",
            sourceGatewayId: "shared-a",
            targetGatewayId: "alice-s-12345678",
            activationOperationId: "activate-alice",
            requestedAt: Date.now() - 2_000,
          },
        },
      },
    };
    store.glmOperations.push({
      id: "activate-alice",
      data: { status: "running", steps: [{ name: "provision", status: "running" }] },
    });
    for (let index = 0; index < 100; index += 1) {
      store.glmOperations.push({
        id: `irrelevant-${index}`,
        data: { status: "succeeded" },
      });
    }
    const deps = buildDeps(store);
    const operations = deps.store.journal.operations;
    const operationReads = vi.spyOn(operations, "getMany");
    const operationScans = [
      vi.spyOn(operations, "listByStatus"),
      vi.spyOn(operations, "listByGateway"),
      vi.spyOn(operations, "listForUid"),
      vi.spyOn(deps.store.journal, "listRecent"),
    ];
    const app = createHttpServer(deps);

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status, res.text).toBe(200);
    expect(operationReads).toHaveBeenCalledOnce();
    const readIds = operationReads.mock.calls[0]![0];
    expect(readIds).toContain("activate-alice");
    expect(readIds.filter((id) => id.startsWith("irrelevant-"))).toEqual([]);
    for (const scan of operationScans) expect(scan).not.toHaveBeenCalled();
    expect(res.body.isolatedRuntimes).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        operationId: "activate-alice",
        operationStatus: "running",
        operationSteps: [{ name: "provision", status: "running" }],
      }),
    ]);
  });

  it("includes fleet controller pod diagnostics in the gateway summaries when available", async () => {
    store.gateways["walter"] = durableSharedGateway("walter");
    store.glmGateways["walter"] = servingRuntime("walter", {
      heartbeat: {
        status: "ready",
        version: "8507a63",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now(),
      },
    });
    const readGatewayPodDiagnostics = vi.fn(async (_gatewayId: string): Promise<GatewayPodDiagnostics> => ({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 2,
      spotPods: 1,
      onDemandPods: 0,
      unknownCapacityPods: 0,
      pods: [
        {
          name: "octogee-gateway-walter-abc",
          gatewayId: "walter",
          deleting: false,
          gatewayContainerStartedAt: null,
          uid: null,
          replicaSetUid: null,
          phase: "Running",
          readyContainers: 2,
          totalContainers: 2,
          restarts: 2,
          reason: null,
          nodeName: "gke-node-1",
          instanceId: null,
          nodePool: null,
          capacityType: "spot",
          ageMs: 125_000,
        },
      ],
    }));
    const app = createHttpServer(buildDeps(store, { readGatewayPodDiagnostics }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(1);
    expect(readGatewayPodDiagnostics).toHaveBeenCalledWith("walter");
    expect(res.body.gateways[0].podDiagnostics).toMatchObject({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 2,
      pods: [{ name: "octogee-gateway-walter-abc", nodeName: "gke-node-1" }],
    });
    expect(res.body.gateways[0]).toMatchObject({
      reservation: { type: "spot", source: "kubernetes" },
      sizing: { monthlyCostUsd: { pricingMode: "spot" } },
    });
  });

  it("batches pod diagnostics for every gateway into one fleet read", async () => {
    store.gateways["alpha"] = durableSharedGateway("alpha");
    store.glmGateways["alpha"] = servingRuntime("alpha");
    store.gateways["bravo"] = durableSharedGateway("bravo");
    store.glmGateways["bravo"] = servingRuntime("bravo");
    const readGatewayPodDiagnostics = vi.fn();
    const readGatewayPodDiagnosticsBatch = vi.fn(async () => ({
      alpha: {
        status: "ready" as const,
        totalPods: 1,
        readyPods: 1,
        totalRestarts: 0,
        spotPods: 0,
        onDemandPods: 1,
        unknownCapacityPods: 0,
        pods: [],
      },
      bravo: {
        status: "missing" as const,
        totalPods: 0,
        readyPods: 0,
        totalRestarts: 0,
        spotPods: 0,
        onDemandPods: 0,
        unknownCapacityPods: 0,
        pods: [],
      },
    }));
    const app = createHttpServer(buildDeps(store, {
      readGatewayPodDiagnostics,
      readGatewayPodDiagnosticsBatch,
    }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(readGatewayPodDiagnosticsBatch).toHaveBeenCalledTimes(1);
    expect(readGatewayPodDiagnosticsBatch).toHaveBeenCalledWith(
      expect.arrayContaining(["alpha", "bravo"]),
    );
    expect(readGatewayPodDiagnostics).not.toHaveBeenCalled();
    expect(res.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: "alpha",
          podDiagnostics: expect.objectContaining({ status: "ready" }),
        }),
        expect.objectContaining({
          gatewayId: "bravo",
          podDiagnostics: expect.objectContaining({ status: "missing" }),
        }),
      ]),
    );
  });

  it("serves gateways requested by the fleet controller before their heartbeat docs exist", async () => {
    store.gateways["canary"] = { ...durableSharedGateway("canary"), sizingTier: "s" };
    store.glmGateways["canary"] = {
      ...servingRuntime("canary", { imageTag: "8507a63-oc2026.6.10" }),
      heartbeat: {},
    };
    const readGatewayPodDiagnostics = vi.fn(async (_gatewayId: string): Promise<GatewayPodDiagnostics> => ({
      status: "not-ready",
      totalPods: 1,
      readyPods: 0,
      totalRestarts: 1,
      spotPods: 0,
      onDemandPods: 0,
      unknownCapacityPods: 1,
      pods: [
        {
          name: "octogee-gateway-canary-abc",
          gatewayId: "canary",
          deleting: false,
          gatewayContainerStartedAt: null,
          uid: null,
          replicaSetUid: null,
          phase: "Pending",
          readyContainers: 0,
          totalContainers: 2,
          restarts: 1,
          reason: "ContainerCreating",
          nodeName: "gke-node-1",
          instanceId: null,
          nodePool: null,
          capacityType: null,
          ageMs: 30_000,
        },
      ],
    }));
    const app = createHttpServer(buildDeps(store, { readGatewayPodDiagnostics }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(readGatewayPodDiagnostics).toHaveBeenCalledWith("canary");
    expect(res.body.gateways).toHaveLength(1);
    expect(res.body.gateways[0]).toMatchObject({
      gatewayId: "canary",
      status: "booting",
      desiredStatus: "running",
      imageTag: "8507a63-oc2026.6.10",
      openclawVersion: "2026.6.10",
      mountedUsers: [],
      heartbeatAgeMs: null,
      podDiagnostics: {
        status: "not-ready",
        readyPods: 0,
        totalRestarts: 1,
      },
    });
    expect(res.body.stats.gateways).toEqual({
      total: 1,
      ready: 0,
      paused: 0,
      unreachable: 0,
    });
  });

  it("derives OpenClaw from fleet controller image tags when heartbeat reports unknown", async () => {
    store.gateways["walter"] = durableSharedGateway("walter");
    store.glmGateways["walter"] = servingRuntime("walter", {
      imageTag: "5b287cb-oc2026.6.10",
      heartbeat: {
        status: "ready",
        version: "5b287cb",
        openclawVersion: "unknown",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now(),
      },
    });
    const app = createHttpServer(buildDeps(store));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.gateways[0]).toMatchObject({
      gatewayId: "walter",
      imageTag: "5b287cb",
      openclawVersion: "2026.6.10",
    });
  });

  it("serves /api/admin/operations as paginated list", async () => {
    store.glmOperations.push({
      id: "op-1",
      data: {
        kind: "add-gateway",
        status: "succeeded",
        createdAt: 100,
        input: { gatewayId: "gw-blue" },
      },
    });
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/operations")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.operations[0]).toMatchObject({
      id: "op-1",
      kind: "add-gateway",
      status: "succeeded",
    });
  });

  it("mounts addAdminUserDirectoryRoutes and returns 404 for unknown user (factory wired)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/users/does-not-exist")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found" });
  });

  it("adds the product's fields to the user detail only when the product supplies them", async () => {
    store.users.u1 = { email: "u1@example.com" };
    const productAdminUserDetail = vi.fn(async () => ({ onboarding: { step: "complete", complete: true, milestones: {} } }));
    const detail = (deps: HttpServerDeps) =>
      request(createHttpServer(deps)).get("/api/admin/users/u1").set("Authorization", "Bearer admin-token");

    const bare = await detail(buildDeps(store));
    const supplied = await detail(buildDeps(store, { productAdminUserDetail }));

    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    expect(bare.body).not.toHaveProperty("onboarding");
    expect(supplied.body.onboarding).toEqual({ step: "complete", complete: true, milestones: {} });
    expect(productAdminUserDetail).toHaveBeenCalledExactlyOnceWith("u1");
  });

  it("serves fleet logs only to admins", async () => {
    const app = createHttpServer(buildDeps(store));
    await request(app).get("/api/admin/logs").set("Authorization", "Bearer user-token").expect(403);
    const res = await request(app).get("/api/admin/logs").set("Authorization", "Bearer admin-token").expect(503);
    expect(res.body.error).toContain("not configured");
  });

  it("serves sizing profiles to admins and answers a dry run of a write ahead of the fleet routes' refusal", async () => {
    const app = createHttpServer(buildDeps(store));
    const profile = { isolation: "shared" };

    await request(app).get("/api/admin/sizing-profiles").set("Authorization", "Bearer user-token").expect(403);
    const planned = await request(app).put("/api/admin/sizing-profiles/default?dryRun=true")
      .set("Authorization", "Bearer admin-token").send(profile);
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ dryRun: true, plans: [{ what: "set sizing profile" }] });
    const applied = await request(app).put("/api/admin/sizing-profiles/default")
      .set("Authorization", "Bearer admin-token").send(profile);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ name: "default", profile, operationId: expect.any(String) });
    const listed = await request(app).get("/api/admin/sizing-profiles").set("Authorization", "Bearer admin-token");
    expect(listed.body).toEqual({ sizingProfiles: [{ name: "default", profile }] });
  });

  it("does not serve the plan change without the product", async () => {
    const res = await request(createHttpServer(buildDeps(store)))
      .post("/api/admin/users/u1/ops").set("Authorization", "Bearer admin-token").send({ action: "setTier", value: "pro" });
    expect(res.status).toBe(404);
  });

  it("hands a product admin route the verified admin and the platform store, and only for an admin", async () => {
    const reached = vi.fn();
    const deps = buildDeps(store, {
      addProductAdminRoutes: (router, routeDeps) => {
        router.post("/users/:uid/ops", (req, res) => {
          reached({ adminUid: req.uid, adminEmail: req.user?.email ?? null, store: routeDeps.store });
          res.json({ ok: true });
        });
      },
    });
    const app = createHttpServer(deps);

    await request(app).post("/api/admin/users/u1/ops").set("Authorization", "Bearer user-token").expect(403);
    expect(reached).not.toHaveBeenCalled();

    await request(app).post("/api/admin/users/u1/ops").set("Authorization", "Bearer admin-token").expect(200);
    expect(reached).toHaveBeenCalledExactlyOnceWith({ adminUid: "admin-uid", adminEmail: "admin@octogee.com", store: deps.store });
  });

  it("serves product admin routes only when the product supplies them", async () => {
    const path = "/api/admin/users/u1/reset";
    const bare = await request(createHttpServer(buildDeps(store)))
      .get(path).set("Authorization", "Bearer admin-token");
    expect(bare.status).toBe(404);
    const app = createHttpServer({
      ...buildDeps(store),
      addProductAdminRoutes: (router) => {
        router.get("/users/:uid/reset", (_req, res) => { res.json({ ok: true }); });
      },
    });
    const supplied = await request(app).get(path).set("Authorization", "Bearer admin-token");
    expect(supplied.status).toBe(200);
    expect(supplied.body).toEqual({ ok: true });
  });

  it("lets a product admin route answer its own dry run ahead of the fleet routes' refusal", async () => {
    const path = "/api/admin/platform-runtime-config?dryRun=true";
    const unanswered = await request(createHttpServer(buildDeps(store)))
      .patch(path).set("Authorization", "Bearer admin-token").send({});
    expect(unanswered.status).toBe(400);

    const app = createHttpServer(buildDeps(store, {
      addProductAdminRoutes: (router) => {
        router.patch("/platform-runtime-config", admitAdminDryRunMarker, (req, res) => {
          res.json({ dryRun: isAdminDryRun(req) });
        });
      },
    }));
    const answered = await request(app).patch(path).set("Authorization", "Bearer admin-token").send({});
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ dryRun: true });
  });

  it("answers a failed admin route with a JSON error and logs the stack instead of returning it", async () => {
    const failure = new Error('orchestrator-config "orchestrator/sizingProfiles/hobby" does not exist');
    const deps = buildDeps(store, {
      addProductAdminRoutes: (router) => {
        router.post("/users/:uid/explode", () => { throw failure; });
      },
    });

    const res = await request(createHttpServer(deps))
      .post("/api/admin/users/u1/explode").set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: "internal_error", message: failure.message });
    expect(res.text).not.toContain("at ");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("POST /api/admin/users/u1/explode failed"));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(failure.stack!));
  });

  it("logs an unexpected admin route failure at error severity and a refused request below it", async () => {
    const logger = createLogger();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = buildDeps(store, {
      log: (message) => logger.legacy(message),
      addProductAdminRoutes: (router) => {
        router.post("/users/:uid/explode", () => { throw new Error("store refused the write"); });
      },
    });
    const app = createHttpServer(deps);

    await request(app).post("/api/admin/users/u1/explode").set("Authorization", "Bearer admin-token").expect(500);
    const loggedAsError = errors.mock.calls.flat().join("\n");
    errors.mockClear();
    await request(app).post("/api/admin/users/u1/explode").set("Authorization", "Bearer admin-token")
      .set("Content-Type", "application/json").send("{\"uid\":").expect(400);

    expect(loggedAsError).toContain("POST /api/admin/users/u1/explode failed");
    expect(loggedAsError).toContain("store refused the write");
    expect(errors).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each([
    ["malformed", "{\"uid\":", 400],
    ["oversized", JSON.stringify({ pad: "x".repeat(200_000) }), 413],
  ])("answers a %s JSON body with its client error status", async (_kind, body, status) => {
    const deps = buildDeps(store);

    const res = await request(createHttpServer(deps))
      .post("/api/admin/users/u1/explode").set("Authorization", "Bearer admin-token")
      .set("Content-Type", "application/json").send(body);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.any(String) });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("POST /api/admin/users/u1/explode failed"));
  });
});

describe("createHttpServer — fleet-events watcher sharing", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = emptyStore();
    store.users["admin-uid"] = { email: "admin@octogee.com" };
    store.configs["admin-uid"] = { role: "admin" };
  });

  const streamOnce = (app: Express) =>
    request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

  it("shares one watcher set across concurrent stream connections", async () => {
    const registry = createWatchRegistry({ repeatEveryMs: 5 });
    const app = createHttpServer(buildDeps(store, {}, registry));

    const [first, second] = await Promise.all([streamOnce(app), streamOnce(app)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    for (const aggregate of ["builders", "gateways", "config", "fleetRegistry", "operations"] as const) {
      expect(registry.attachCount(aggregate), aggregate).toBe(1);
    }
  });

  it("keeps watchers warm across sequential reconnects", async () => {
    const registry = createWatchRegistry({ repeatEveryMs: 5 });
    const app = createHttpServer(buildDeps(store, {}, registry));

    expect((await streamOnce(app)).status).toBe(200);
    expect((await streamOnce(app)).status).toBe(200);

    expect(registry.attachCount("operations")).toBe(1);
    expect(registry.activeCount()).toBe(5);
  });

  it("filters the glmOperations watch to active operations", async () => {
    const registry = createWatchRegistry({ repeatEveryMs: 5 });
    const app = createHttpServer(buildDeps(store, {}, registry));

    expect((await streamOnce(app)).status).toBe(200);

    expect(registry.filterFor("operations")).toEqual({ statuses: ["pending", "running"] });
  });

  it("tears down watchers after the last connection closes when linger is disabled", async () => {
    const registry = createWatchRegistry({ repeatEveryMs: 5 });
    const app = createHttpServer(buildDeps(store, { fleetEventListenerLingerMs: 0 }, registry));

    expect((await streamOnce(app)).status).toBe(200);
    expect(registry.activeCount()).toBe(0);

    expect((await streamOnce(app)).status).toBe(200);
    expect(registry.attachCount("builders")).toBe(2);
  });
});
