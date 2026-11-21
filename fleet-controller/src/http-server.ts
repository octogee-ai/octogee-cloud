
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";

import express, { Router, type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { rateLimit } from "express-rate-limit";
import { publicAppOriginsFromEnv } from "@octogee/core/public-app-origins";
import { renderMetrics } from "./metrics.js";
import { adminPlacementCapabilities } from "./admin-placement-capabilities.js";
import type { GatewayGitKeyRelease } from "@octogee/core/gateway-root-deletion";
import { adminPlacementSharedCapabilities } from "./admin-placement-shared-capabilities.js";
import { adminIsolatedCapabilities, type AdminUserHome } from "./admin-isolated-capabilities.js";
import type { UserAccounts, UserSignInHosts } from "@octogee/core/admin-user-router";
import type { UserAccountReader } from "@octogee/core/user-account";
import {
  addAdminFleetRoutes,
  createAdminFleetMutationRunner,
  type FleetLogger,
  type FleetRouterDeps,
  type GatewayPodDiagnostics,
} from "@octogee/core/admin-fleet-router";
import { addAdminProvisioningRoutes, type AdminProvisioningClient, type AdminProvisioningRouterDeps } from "@octogee/core/admin-provisioning-router";
import type { CentralReleaseAuthority } from "@octogee/core/artifact-registry";
import type { StrandedSourceGatewayCalls } from "@octogee/core/stranded-source-restore";
import type {
  PlatformStateStore,
  WatchAggregate,
  WatchChange,
  WatchRecords,
  WatchRequest,
  WatchSubscription,
} from "@octogee/core/platform-state";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  addAdminUserDirectoryRoutes,
  type AdminUserDirectorySource,
  type AdminUserProductDetail,
  type AdminUserSpendDeps,
} from "@octogee/core/admin-user-directory-router";
import { addAdminLogsRoutes } from "@octogee/core/admin-logs-router";
import { readAdminGatewayKubernetes } from "./admin-kubernetes-observer.js";
import { addAdminSizingProfileRoutes } from "@octogee/core/admin-sizing-profile-router";
import type { LogEntriesSource } from "@octogee/core/fleet-logs";
import {
  createRequireAdmin,
  type RequireAdminDeps,
} from "./middleware/auth.js";

const ALLOWED_ORIGINS = new Set(publicAppOriginsFromEnv());

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) ||
    (process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS === "true" && /^http:\/\/localhost:\d+$/.test(origin));
}

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Internal-Service-Key",
    );
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export type ProductAdminRoutes = (
  router: Router,
  deps: {
    store: PlatformStateStore;
    requestNativeReturnSourceRecovery?: HttpServerDeps["requestNativeReturnSourceRecovery"];
  },
) => void;

export interface HttpServerDeps {
  addProductAdminRoutes?: ProductAdminRoutes;
  userAccounts?: UserAccounts | undefined;
  discoverDeletionProductContext?: ((uid: string) => Promise<Readonly<Record<string, unknown>>>) | undefined;
  productAdminUserDetail?: AdminUserProductDetail | undefined;
  userSignIn?: UserSignInHosts | undefined;
  store: PlatformStateStore;
  accounts: UserAccountReader;
  userDirectory: AdminUserDirectorySource;
  userSpend: AdminUserSpendDeps | null;
  identity: RequireAdminDeps["identity"];
  log: (msg: string) => void;
  provisionGatewayAuthSecret: (opts: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
  listGatewayBuilds: (opts: {
    service: string;
    limit: number;
  }) => Promise<unknown[]>;
  releaseEnvironment?: "test" | "prod" | null;
  releaseAuthority?: CentralReleaseAuthority;
  platformArtifact?: GatewayArtifact;
  controllerStartedAt?: number;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  readGatewayPodDiagnosticsBatch?: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;
  requestNativeReturnSourceRecovery?: (input: { uid: string; operationId: string; requestedAt: number; requestedBy: string }) => Promise<boolean>;
  strandedSource?: StrandedSourceGatewayCalls;
  userHome?: AdminUserHome;
  suspendAuthUser: (uid: string) => Promise<void>;
  revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
  fleetEventListenerLingerMs?: number;
  logs: { source: LogEntriesSource | null; namespace: string };
  provisioning?: AdminProvisioningClient | null;
  gatewayGitKeys: GatewayGitKeyRelease | null;
  provisioningReadiness?: FleetRouterDeps["provisioningReadiness"];
  provisioningSync?: AdminProvisioningRouterDeps["sync"];
}

function adaptLogger(log: (msg: string) => void): FleetLogger {
  const fmt = (msg: string, meta?: Record<string, unknown>): string =>
    meta && Object.keys(meta).length > 0
      ? `${msg} ${JSON.stringify(meta)}`
      : msg;
  return {
    info: (msg, meta) => log(fmt(msg, meta)),
    warn: (msg, meta) => log(`⚠ ${fmt(msg, meta)}`),
  };
}

function writeSseEvent(res: Response, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// A dropped SSE stream (LB idle timeout, tab reconnect) must not re-buy the
// initial snapshot of every watched collection: watchers are shared across all
// connections and outlive the last one by lingerMs.
const FLEET_EVENT_LINGER_MS_DEFAULT = 10 * 60_000;

const ACTIVE_OPERATION_STATUSES = ["pending", "running"] as const;

type FleetEvent =
  | { kind: "changed"; collection: string; at: number; placement: boolean }
  | { kind: "placement-reset"; collection: string; at: number }
  | { kind: "error"; collection: string; error: string };

interface FleetEventHub {
  subscribe(handler: (event: FleetEvent) => void): () => void;
}

type PlacementFingerprint<A extends WatchAggregate> = (record: WatchRecords[A]) => [key: string, fingerprint: string] | undefined;

const builderPlacementFingerprint: PlacementFingerprint<"builders"> = ({ uid, activationLease: lease }) =>
  lease ? [uid, JSON.stringify([lease.leaseId, lease.generation, lease.status, lease.targetGatewayId,
    lease.sourceGatewayId, lease.sourceAssignmentEpoch, lease.returnRequestedAt, lease.operatorTerminateRequestedAt])] : undefined;

const gatewayPlacementFingerprint: PlacementFingerprint<"gateways"> = (root) =>
  [root.gatewayId, JSON.stringify([root.desiredStatus, root.desiredRelease, root.liveRelease,
    root.allocation?.leaseId, root.allocation?.generation])];

const runtimePlacementFingerprint: PlacementFingerprint<"fleetRegistry"> = (runtime) =>
  [runtime.gatewayId, JSON.stringify([runtime.lifecycle, runtime.vm?.status, runtime.vm?.instanceId,
    runtime.heartbeat.status, runtime.heartbeat.version, [...runtime.heartbeat.mountedCustomers].sort()])];

const migrationPlacementFingerprint: PlacementFingerprint<"operations"> = (operation) =>
  operation.kind === "migrate-user" && operation.input.source === "builder-activation-lease"
    ? [operation.id, operation.status] : undefined;

function updatePlacementFingerprint<A extends WatchAggregate>(
  fingerprints: Map<string, string>,
  { key, record }: WatchChange<A>,
  fingerprint: PlacementFingerprint<A>,
): boolean {
  const next = record ? fingerprint(record)?.[1] : undefined;
  if (next === fingerprints.get(key)) return false;
  if (next === undefined) fingerprints.delete(key);
  else fingerprints.set(key, next);
  return true;
}

function createFleetEventHub(deps: {
  store: Pick<PlatformStateStore, "watch">;
  log: (msg: string) => void;
  lingerMs: number;
}): FleetEventHub {
  const subscribers = new Set<(event: FleetEvent) => void>();
  let subscriptions: WatchSubscription[] | null = null;
  let lingerTimer: NodeJS.Timeout | null = null;

  const emit = (event: FleetEvent) => {
    for (const subscriber of [...subscribers]) subscriber(event);
  };

  const reportFailure = (collection: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`[glm-controller] fleet event watch failed collection=${collection}: ${message}`);
    emit({ kind: "error", collection, error: message });
  };

  function watch<A extends WatchAggregate>(
    collection: string,
    request: WatchRequest<A>,
    fingerprint?: PlacementFingerprint<A>,
  ): WatchSubscription {
    let primed = false;
    const placements = new Map<string, string>();
    const subscription = deps.store.watch(request, {
      onEvent: (event) => {
        if (event.kind === "resync") return;
        let placement = false;
        if (fingerprint && event.kind === "snapshot") {
          placements.clear();
          for (const record of event.records) {
            const entry = fingerprint(record);
            if (entry) placements.set(...entry);
          }
          emit({ kind: "placement-reset", collection, at: Date.now() });
        } else if (fingerprint && event.kind === "changes") {
          for (const change of event.changes) {
            if (updatePlacementFingerprint(placements, change, fingerprint)) placement = true;
          }
        }
        if (!primed) {
          primed = true;
          return;
        }
        emit({ kind: "changed", collection, at: Date.now(), placement });
      },
      onError: (error) => reportFailure(collection, error),
    });
    subscription.closed.catch((error: unknown) => reportFailure(collection, error));
    return subscription;
  }

  const ensureWatchers = () => {
    if (subscriptions) return;
    subscriptions = [
      watch("users", { aggregate: "builders", filter: {} }, builderPlacementFingerprint),
      watch("gateways", { aggregate: "gateways", filter: {} }, gatewayPlacementFingerprint),
      watch("config", { aggregate: "config", filter: {} }),
      watch(GLM_GATEWAYS_COLLECTION, { aggregate: "fleetRegistry", filter: {} }, runtimePlacementFingerprint),
      watch(GLM_OPERATIONS_COLLECTION, { aggregate: "operations", filter: { statuses: ACTIVE_OPERATION_STATUSES } }, migrationPlacementFingerprint),
    ];
  };

  const teardown = () => {
    for (const subscription of subscriptions ?? []) void subscription.close();
    subscriptions = null;
  };

  return {
    subscribe(handler) {
      if (lingerTimer) {
        clearTimeout(lingerTimer);
        lingerTimer = null;
      }
      subscribers.add(handler);
      ensureWatchers();
      return () => {
        subscribers.delete(handler);
        if (subscribers.size > 0 || lingerTimer) return;
        if (deps.lingerMs <= 0) {
          teardown();
          return;
        }
        lingerTimer = setTimeout(() => {
          lingerTimer = null;
          if (subscribers.size === 0) teardown();
        }, deps.lingerMs);
        lingerTimer.unref?.();
      };
    },
  };
}

function addAdminFleetEventRoute(
  router: Router,
  hub: FleetEventHub,
): void {
  router.get("/fleet-events", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const closeAfterFirstChange = req.query.once === "1";
    const placementOnly = req.query.placement === "1";
    const keepalive = setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, 30_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    };

    writeSseEvent(res, "ready", { at: Date.now(), ...(placementOnly ? { placementChanges: true } : {}) });
    unsubscribe = hub.subscribe((event) => {
      if (closed) return;
      if (event.kind === "placement-reset") {
        if (placementOnly) writeSseEvent(res, "placement-reset", { collection: event.collection, at: event.at });
        return;
      }
      if (event.kind === "changed") {
        if (placementOnly && !event.placement) return;
        writeSseEvent(res, placementOnly ? "placement-changed" : "changed", { collection: event.collection, at: event.at });
        if (closeAfterFirstChange) close();
        return;
      }
      writeSseEvent(res, "error", { collection: event.collection, error: event.error });
    });
    req.on("close", close);
  });
}

function addHealthAndMetricsRoutes(app: Express): void {
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "glm-controller" });
  });

  app.get("/metrics", (_req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.end(renderMetrics());
  });
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  return expose === true && typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

function jsonErrorHandler(log: (msg: string) => void) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const clientStatus = clientErrorStatus(error);
    log(`[glm-controller] ${clientStatus === undefined ? "❌ " : ""}${req.method} ${req.originalUrl} failed: ${detail}`);
    if (res.headersSent) {
      next(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (clientStatus !== undefined) {
      res.status(clientStatus).json({ error: "invalid_request", message });
      return;
    }
    res.status(500).json({ error: "internal_error", message });
  };
}

export function createHttpServer(deps: HttpServerDeps): Express {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  addHealthAndMetricsRoutes(app);

  const adminRouter = Router();
  adminRouter.use(rateLimit({
    windowMs: 60_000, limit: 1200, standardHeaders: false, legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: req => req.isAdmin === true,
  }));
  adminRouter.use(
    createRequireAdmin({
      identity: deps.identity,
      store: deps.store,
      accounts: deps.accounts,
      log: deps.log,
    }),
  );

  adminRouter.use(rateLimit({
    windowMs: 60_000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: req => req.uid!,
  }));

  addAdminFleetEventRoute(
    adminRouter,
    createFleetEventHub({
      store: deps.store,
      log: deps.log,
      lingerMs: deps.fleetEventListenerLingerMs ?? FLEET_EVENT_LINGER_MS_DEFAULT,
    }),
  );

  addAdminUserDirectoryRoutes(adminRouter, {
    store: deps.store,
    accounts: deps.accounts,
    source: deps.userDirectory,
    spend: deps.userSpend,
    logger: adaptLogger(deps.log),
    productUserDetail: deps.productAdminUserDetail,
  });
  deps.addProductAdminRoutes?.(adminRouter, {
    store: deps.store,
    requestNativeReturnSourceRecovery: deps.requestNativeReturnSourceRecovery,
  });
  addAdminSizingProfileRoutes(adminRouter, { store: deps.store });
  addAdminFleetRoutes(adminRouter, {
    computerReplacementEnabled: true,
    accounts: deps.accounts,
    store: deps.store,
    logger: adaptLogger(deps.log),
    provisionGatewayAuthSecret: deps.provisionGatewayAuthSecret,
    listGatewayBuilds: deps.listGatewayBuilds,
    releaseEnvironment: deps.releaseEnvironment,
    releaseAuthority: deps.releaseAuthority,
    platformArtifact: deps.platformArtifact,
    controllerStartedAt: deps.controllerStartedAt,
    readGatewayKubernetes: readAdminGatewayKubernetes,
    readGatewayPodDiagnostics: deps.readGatewayPodDiagnostics,
    readGatewayPodDiagnosticsBatch: deps.readGatewayPodDiagnosticsBatch,
    requestNativeReturnSourceRecovery: deps.requestNativeReturnSourceRecovery,
    suspendAuthUser: deps.suspendAuthUser,
    revokeConnectorGrantsForUser: deps.revokeConnectorGrantsForUser,
    userAccounts: deps.userAccounts,
    userSignIn: deps.userSignIn,
    discoverDeletionProductContext: deps.discoverDeletionProductContext,
    placement: { ...adminPlacementCapabilities, gatewayGitKeys: { client: deps.gatewayGitKeys, log: deps.log } },
    placementShared: adminPlacementSharedCapabilities(deps),
    isolated: adminIsolatedCapabilities({
      namespace: deps.logs.namespace,
      log: deps.log,
      readGatewayPodDiagnostics: deps.readGatewayPodDiagnostics,
      ...(deps.userHome ? { userHome: deps.userHome } : {}),
    }),
    provisioningReadiness: deps.provisioningReadiness,
    ...(deps.strandedSource ? { strandedSource: deps.strandedSource } : {}),
  });
  addAdminProvisioningRoutes(adminRouter, {
    provisioning: deps.provisioning ?? null,
    journal: createAdminFleetMutationRunner(deps.store),
    logger: adaptLogger(deps.log),
    sync: deps.provisioningSync,
  });
  addAdminLogsRoutes(adminRouter, {
    source: deps.logs.source,
    namespace: deps.logs.namespace,
    logger: adaptLogger(deps.log),
  });
  app.use("/api/admin", adminRouter);
  app.use(jsonErrorHandler(deps.log));

  return app;
}

export function startHttpServer(
  deps: HttpServerDeps & { port: number },
): () => void {
  const app = createHttpServer(deps);
  const server: Server = app.listen(deps.port, () => {
    deps.log(`[glm-controller] http server listening on :${deps.port}`);
  });
  return () => {
    server.close();
  };
}
