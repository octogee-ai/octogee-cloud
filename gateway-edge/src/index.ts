import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import { isGatewayVm } from "./lib/gateway-vm.js";
import { createChannelAgentReadinessRouter } from "./routes/channel-agent-readiness.js";
import express, { Express, Request, RequestHandler, Response, Router } from "express";
import http from "node:http";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/logging.js";
import { errorHandler } from "./middleware/errors.js";
import { logger } from "./middleware/logging.js";
import { helmetMiddleware, dashboardAssetRateLimit } from "./middleware/security.js";
import { requireAuthenticatedUid } from "./middleware/auth.js";
import { authenticationFailureLimit } from "./middleware/authenticated-request-limit.js";
import { installBodyParsers } from "./middleware/body-parsers.js";

import { mountApi } from "./routes/mount-api.js";
import automationsRoutes from "./routes/automations.js";
import gitRoutes from "./routes/workspace/git.js";
import byosubHealthRoutes from "./routes/byosub-health.js";
import { createByosubAuthRouter } from "./routes/byosub-auth.js";
import internalAgentMessageRoutes from "./routes/internal/agent-message.js";
import { createInternalConnectorApprovalRouter } from "./routes/internal/connector-approvals.js";

import internalWorkspaceCommitRoutes from "./routes/internal/workspace-commit.js";
import internalOwnerAutomationRoutes from "./routes/internal/owner-automations.js";
import { createProjectPersistenceRouter } from "./routes/internal/project-persistence.js";
import internalGiteaAdminRoutes from "./routes/internal/gitea-admin.js";
import internalByotSyncRoutes from "./routes/internal/byot-sync.js";
import { createInternalConnectorRoutes } from "./routes/internal/connectors.js";
import { createInternalVmRouter, resolveVmControlUrl } from "./routes/internal/vm.js";
import { createAgentImportsRouter } from "./routes/agent-imports.js";
import { createAgentExportsRouter } from "./routes/agent-exports.js";
import { createAgentImportRuntime, invokeLocalOpenClaw } from "./lib/agent-import-runtime.js";
import { startDesktopNodePairing } from "./lib/desktop-node-pairing.js";
import { mountClusterRoutes, type ClusterRouteTable } from "./routes/mount-cluster-routes.js";
import { createProjectCreateRoutes } from "./routes/projects/create.js";
import { createProjectRepoSourceRoutes } from "./routes/projects/repo-source.js";
import type { FeaturePolicy } from "@octogee/shared/types/feature-flags";
import { createGatewayRouter, type GatewayRouterSurface } from "./public-router.js";
import { createVmRoutesResolver } from "./vm-routes.js";
import { gatewayEdgeServiceName } from "@octogee/shared/types/gateway-releases";
import {
  createRollRosterGate,
  createRollRosterStore,
  createRollRosterUpgradeGate,
  type RollRosterStore,
  type RollRosterUpgradeGate,
} from "./roll-roster.js";
import { createBrokerRollRosterSubscription } from "./broker-roll-roster.js";
import { workspaceServingResolver } from "./openclaw-control/workspace-serving.js";
import {
  brokerUserIdentityReader,
  builderIdentity,
  claimedUserIdentity,
  createUserIdentityStore,
  installUserIdentityStore,
} from "./lib/user-identity.js";
import { chatProxyOwnsHttpPath } from "./chat-proxy/http-paths.js";
import { stripGatewayPrefix } from "./chat-proxy/gateway-prefix.js";
import { gatewayEdgeMode } from "./lib/gateway-edge-mode.js";
import { validateRequiredEnv } from "./lib/required-env.js";
import type { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import {
  attachOpenClawControlWsRoute,
  createOpenClawControlHttpRouter,
} from "./openclaw-control/surface.js";
import { createMobileGateway } from "./openclaw-control/mobile.js";
import { startOpenClawDashboardCapabilityHeartbeat } from "./openclaw-control/capability-heartbeat.js";
import {
  createOpenClawControlMetrics,
  type OpenClawControlMetrics,
} from "./openclaw-control/metrics.js";
import {
  createOpenClawControlAuthorizationCache,
  type OpenClawControlAuthorizationCache,
} from "./openclaw-control/broker.js";
import { installGatewayEdgeUnhandledRejectionPolicy } from "./process-rejection-policy.js";
import {
  attachTerminalWsRoute,
  createTerminalRouter,
  openTerminalUserSocket,
  terminalAvailable,
  type TerminalSession,
} from "./routes/terminal.js";
import { createToolSurface } from "./routes/tool-surface.js";
import { createVmEgressRouter } from "./routes/vm-egress.js";
import { createVmEgressService } from "./egress/service.js";
import { createBrokerEgressStore } from "./egress/broker.js";
import { controlApiModePoster, createBrowserModeSync } from "./egress/browser-mode.js";
import { createVmPasskeysRouter } from "./routes/vm-passkeys.js";
import { createPasskeyLinkHost } from "./webauthn/link-host.js";
import { createWebAuthnCdpProxy } from "./webauthn/cdp-proxy.js";
import { createVmSessionsRouter } from "./routes/vm-sessions.js";
import { applyCookiesOverCdp, type CdpCookie } from "./lib/cdp-cookies.js";
import { resolveToolChannelForUid } from "./lib/tool-conversation.js";
import { isAllowedWsOrigin } from "./chat-proxy/openclaw/ws-origin.js";
import { createWorkspaceRolesRouter } from "./routes/workspace-roles.js";
import { resolveNativeAdminAccess } from "./lib/native-admin-access.js";
import { createWsTicketStore } from "./lib/ws-ticket-store.js";
import { workspaceDefaultAgentId } from "@octogee/shared/types/identity";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const PORT = parseInt(process.env.PORT || "3001", 10);
type ChatProxyModule = typeof import("./chat-proxy/proxy.js");

if (process.env.NODE_ENV !== "test") {
  installGatewayEdgeUnhandledRejectionPolicy((error) => {
    logger.error("gateway-edge credential-dependent operation rejected; continuing without ADC", {
      error,
    });
  });
}

let chatProxyModulePromise: Promise<ChatProxyModule> | null = null;
let activeChatProxyMetricsRegistry: Registry | null = null;
let activeOpenClawControlMetrics: OpenClawControlMetrics | undefined;
const openClawControlAuthorizationCache = createOpenClawControlAuthorizationCache();
const terminalTickets = createWsTicketStore<TerminalSession>();
const vmControlUrl = resolveVmControlUrl(process.env);
const vmEgress = createVmEgressService({
  store: createBrokerEgressStore(),
  log: (message, meta) => logger.info(message, meta),
  browser: vmControlUrl
    ? createBrowserModeSync({
      post: controlApiModePoster(vmControlUrl),
      logger: { warn: (message, meta) => logger.warn(message, meta), error: (message, meta) => logger.error(message, meta) },
    })
    : { apply: (mode) => { if (isGatewayVm()) logger.error("[computer-egress] no desktop control URL; the VM's browser cannot follow the egress mode", { mode }); } },
});
const vmEgressRoutes = createVmEgressRouter({ service: vmEgress });
const toolSurface = createToolSurface({ egressReport: () => {
  const status = vmEgress.status();
  return status.listener === "off" ? null : { mode: status.mode, shell: status.shell, listener: status.listener };
} });
const vmPasskeys = createPasskeyLinkHost({ log: (message, meta) => logger.warn(message, meta) });
const vmPasskeyRoutes = createVmPasskeysRouter({ host: vmPasskeys, available: isGatewayVm });
const vmWebAuthn = createWebAuthnCdpProxy({
  cdpUrl: process.env.GATEWAY_COMPUTER_CDP_URL?.trim() || "http://127.0.0.1:9222",
  handle: (request, signal) => vmPasskeys.request(request, signal),
  platformAvailable: () => vmPasskeys.platformAuthenticator(),
  log: (message, meta) => logger.info(message, meta),
});

async function loadChatProxyModule(): Promise<ChatProxyModule> {
  chatProxyModulePromise ??= import("./chat-proxy/proxy.js").then((mod) => {
    activeChatProxyMetricsRegistry = mod.chatProxyMetricsRegistry;
    return mod;
  });
  return chatProxyModulePromise;
}

export type GatewayEdgeSurface = "sidecar" | "cluster";

// Filled once on revision-pod boot (installRollRosterGate); null everywhere
// else (legacy pods, cluster surface, tests) — the slot then passes through.
let activeRollRosterGate: RequestHandler | null = null;

export function installRollRosterGate(gate: RequestHandler): void {
  activeRollRosterGate = gate;
}

export interface CreateAppOptions {
  surface?: GatewayEdgeSurface;
  productRoutes?: ClusterRouteTable;
  projectsDeleteRoutes?: Router;
  // Route tests inject an enabling policy to exercise the workspace sharing
  // paths; unset means the flag is off, which is what the pod surface wants.
  featurePolicy?: FeaturePolicy;
}

export function createApp(opts: CreateAppOptions = {}) {
installDefaultUserEntitlements();
// Keep createApp() as the legacy cluster harness for route tests; the module
// entrypoint below explicitly boots the production sidecar surface.
const surface = opts.surface ?? "cluster";
const app = express();
// client → GCLB (appends client-ip, lb-ip) → gateway-router → this app
app.set("trust proxy", 2);

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });
const openClawControlMetrics = createOpenClawControlMetrics(metricsRegistry);
if (surface === "sidecar") activeOpenClawControlMetrics = openClawControlMetrics;

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

app.use(helmetMiddleware);
app.use(corsMiddleware);

app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {

const route = req.route?.path || 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});

app.use(requestLogger);
app.use(dashboardAssetRateLimit);

installBodyParsers(app);

app.get('/metrics', async (_req, res) => {

const merged = Registry.merge(
  activeChatProxyMetricsRegistry ? [metricsRegistry, activeChatProxyMetricsRegistry] : [metricsRegistry],
);
  res.set('Content-Type', merged.contentType);
  res.end(await merged.metrics());
});

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "gateway-edge", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Mid-roll per-user routing gate (roll-roster.ts). The slot sits after
// health/metrics (probes never 503 on roster load) and before every
// user-state surface; production boot installs the real gate on revision
// pods only. Chat-proxy paths bypass Express by design — they proxy to the
// shared Mattermost service, which carries no per-revision user state.
app.use((req, res, next) =>
  activeRollRosterGate ? activeRollRosterGate(req, res, next) : next(),
);

app.use("/api/g/:gatewayId/internal", internalByotSyncRoutes);
if (surface === "sidecar") {
  app.use("/api/g/:gatewayId/internal/connector-approvals", createInternalConnectorApprovalRouter());
  app.use("/api/g/:gatewayId/internal/agent-message", internalAgentMessageRoutes);
  app.use("/internal/workspace", internalWorkspaceCommitRoutes);
  app.use("/internal/owner-automations", internalOwnerAutomationRoutes);
  app.use("/internal/projects", createProjectPersistenceRouter());
  app.use("/internal/connectors", createInternalConnectorRoutes());
  app.use("/internal/computer", createInternalVmRouter({ controlUrl: vmControlUrl }));
}

if (surface === "cluster") {
  mountClusterSurface(app, opts);
}

mountSidecarLocalitySurface(app, {
  dashboardEnabled: surface === "sidecar" && process.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED === "true",
  openClawControlMetrics,
  openClawControlAuthorizationCache,
});

app.use(errorHandler);

return app;
}

function mountClusterSurface(app: Express, opts: CreateAppOptions): void {
  // Legacy in-process Gitea broker surface. The durable broker lives on octogee-api;
  // the gateway-edge sidecar surface intentionally does not mount this.
  app.use("/internal/gitea", internalGiteaAdminRoutes);

  // mountClusterRoutes goes FIRST so its public /api/projects routes
  // (readme) and explicit-auth sequencing aren't shadowed by the locality
  // routers. Express tries handlers in mount order; locality routers are
  // gateway-edge-only and only match their specific paths.
  const featurePolicy = opts.featurePolicy;
  mountClusterRoutes(app, {
    ...(featurePolicy ? {
      projectsCreateRoutes: createProjectCreateRoutes({ featurePolicy }),
      projectsRepoSourceRoutes: createProjectRepoSourceRoutes({ featurePolicy }),
    } : {}),
    productRoutes: opts.productRoutes ?? [],
    projectsDeleteRoutes: opts.projectsDeleteRoutes,
  });
}

let nativeMobileGateway: ReturnType<typeof createMobileGateway> | undefined;
function mountSidecarLocalitySurface(app: Express, options: {
  dashboardEnabled: boolean;
  openClawControlMetrics: OpenClawControlMetrics;
  openClawControlAuthorizationCache: OpenClawControlAuthorizationCache;
}): void {
  if (options.dashboardEnabled) {
    nativeMobileGateway = createMobileGateway();
    app.use("/api/g/:gatewayId/openclaw/mobile", nativeMobileGateway.router);
    app.use("/api/g/:gatewayId/openclaw", createOpenClawControlHttpRouter({
      env: process.env,
      metrics: options.openClawControlMetrics,
      authorizationCache: options.openClawControlAuthorizationCache,
    }));
  }
  mountApi(app, "/channel-agent-readiness", createChannelAgentReadinessRouter());
  const workspaceLocality = Router({ mergeParams: true });
  workspaceLocality.use(gitRoutes);
  mountApi(app, "/workspace", workspaceLocality);

  // Deep byosub health runs on the user's own pod (reached via the
  // /api/g/<gatewayId>/byosub/* locality seam), so it can read the pod's
  // auth-profile store — the proof /api/model-credentials/subscription/connection's ref-read can't give.
  const byosubLocality = Router();
  byosubLocality.use("/health", authenticationFailureLimit, requireAuthenticatedUid);
  byosubLocality.use(byosubHealthRoutes);
  mountApi(app, "/byosub", byosubLocality);
  const automationsLocality = Router({ mergeParams: true });
  automationsLocality.use(authenticationFailureLimit, requireAuthenticatedUid);
  automationsLocality.use(automationsRoutes);
  mountApi(app, "/automations", automationsLocality);
  const agentImportsLocality = Router({ mergeParams: true });
  agentImportsLocality.use(authenticationFailureLimit, requireAuthenticatedUid);
  agentImportsLocality.use(createAgentImportsRouter({
    createRuntime: createAgentImportRuntime,
    localGatewayId: () => process.env.GATEWAY_ID ?? null,
  }));
  mountApi(app, "/agent-imports", agentImportsLocality);
  const agentExportsLocality = Router({ mergeParams: true });
  agentExportsLocality.use(authenticationFailureLimit, requireAuthenticatedUid);
  agentExportsLocality.use(createAgentExportsRouter());
  mountApi(app, "/agent-exports", agentExportsLocality);
  mountApi(app, "/workspace-roles", createWorkspaceRolesRouter());
  mountApi(app, "/terminal", createTerminalRouter({
    localGatewayId: () => process.env.GATEWAY_ID ?? null,
    available: terminalAvailable(process.env),
    resolveAccess: resolveNativeAdminAccess,
    tickets: terminalTickets,
    resolveChannel: resolveToolChannelForUid,
  }));
  mountApi(app, "/tools", toolSurface.router);
  mountApi(app, "/computer", vmEgressRoutes.router);
  mountApi(app, "/computer", vmPasskeyRoutes.router);
  const vmCdpUrl = process.env.GATEWAY_COMPUTER_CDP_URL?.trim() || "http://127.0.0.1:9222";
  const vmSessionsLocality = Router({ mergeParams: true });
  vmSessionsLocality.use("/sessions/import", authenticationFailureLimit, requireAuthenticatedUid);
  vmSessionsLocality.use(createVmSessionsRouter({
    localGatewayId: () => process.env.GATEWAY_ID ?? null,
    available: isGatewayVm(),
    resolveAccess: resolveNativeAdminAccess,
    applyCookies: (cookies: CdpCookie[]) => applyCookiesOverCdp(cookies, { cdpUrl: vmCdpUrl }),
  }));
  mountApi(app, "/computer", vmSessionsLocality);
  if (isGatewayVm()) {
    startDesktopNodePairing({
      invoke: (method, params) => invokeLocalOpenClaw(method, params),
      log: (message, fields) => logger.info(message, fields),
    });
  }
  // connect/status/sso-submit run HERE (the user's own pod) so the in-pod
  // claude-sso/device-auth managers accept the pod's OPENCLAW_GATEWAY_TOKEN —
  // octogee-api can't hold a per-gateway token. The flow write brokers back.
  // Mount only on the fleet-scoped path; bare /api/byosub/* is a retired
  // cluster alias and must not be masked by locality auth middleware.
  app.use("/api/g/:gatewayId/byosub", createByosubAuthRouter());
}

const app = createApp({ surface: "sidecar" });

export function dispatchGatewayEdgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): void {
  const rawPath = (req.url || "").split("?")[0];
  if (chatProxyOwnsHttpPath(stripGatewayPrefix(rawPath), rawPath)) {
    loadChatProxyModule().then((chatProxy) => chatProxy.chatProxyHandleRequest(req, res)).catch((err) => {
      logger.error("[chat-proxy] request handler failed", {
        path: rawPath,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  } else {
    app(req, res);
  }
}

if (process.env.NODE_ENV !== "test") {
  const vmRoutesFile = process.env.GATEWAY_VM_ROUTES_FILE;
  const resolveVmOrigin = vmRoutesFile
    ? createVmRoutesResolver({
        filePath: vmRoutesFile,
        edgePort: 3001,
        log: (message, meta) => logger.warn(message, meta),
        logInfo: (message, meta) => logger.info(message, meta),
      })
    : undefined;
  if (gatewayEdgeMode() === "agent-control-router") {
    const { createAgentControlCallbackRouter } = await import("./agent-control-callback-router.js");
    const namespace = process.env.K8S_NAMESPACE || "default";
    const router = createAgentControlCallbackRouter({
      namespace,
      signingKey: process.env.AGENT_CONTROL_ROUTER_KEY ?? "",
      resolveVmOrigin,
      log: (message, meta) => logger.error(message, meta),
    });
    router.listen(PORT, () => {
      logger.info(`mattermost-callback-router boot — listening on port ${PORT}`, {
        port: PORT,
        namespace,
        sha: process.env.BUILD_SHA || "unknown",
      });
    });
  } else if (gatewayEdgeMode() === "router") {
    const namespace = process.env.K8S_NAMESPACE || "default";
    const routerLog = (message: string, meta?: Record<string, unknown>) => logger.error(message, meta);
    const server = createGatewayRouter({
      namespace,
      log: routerLog,
      ...(resolveVmOrigin
        ? {
            targetOriginForGateway: (_surface: GatewayRouterSurface, serviceId: string) =>
              resolveVmOrigin(serviceId)
              ?? `http://${gatewayEdgeServiceName(serviceId)}.${namespace}.svc.cluster.local:3001`,
          }
        : {}),
    });
    server.listen(PORT, () => {
      logger.info(`gateway-router boot — listening on port ${PORT}`, {
        port: PORT,
        namespace: process.env.K8S_NAMESPACE || "default",
        sha: process.env.BUILD_SHA || "unknown",
      });
    });
  } else {
  const env = process.env.K8S_NAMESPACE || process.env.NODE_ENV || "development";
  const isProd = env !== "development" && env !== "local" && env !== "test";
  const { missing } = validateRequiredEnv(process.env, {
    isProd,
    profile: process.env.GATEWAY_PROFILE,
  });
  if (missing.length > 0) {
    logger.error(
      `FATAL: required gateway-edge env unset: ${missing.join(", ")}. ` +
        "Supplied per-gateway via the chart's gatewayEdge.env/.secrets ranges " +
        "(threaded by the fleet controller); a missing one means a skewed render or a " +
        "dropped-on-apply duplicate. Refusing to boot rather than limp — the " +
        "OpenClaw projection, Activity intake, and git locality routes all " +
        "depend on these.",
    );
    process.exit(1);
  }

  const edgeGatewayClass = isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS) ? "isolated" : "shared";
  if (edgeGatewayClass === "isolated") {
    const identityStore = createUserIdentityStore({
      read: brokerUserIdentityReader(process.env),
      log: (msg) => logger.error(msg),
    });
    installUserIdentityStore(identityStore);
    process.once("exit", identityStore.start());
  }

  // Gateway pods gate user-state traffic on the durable assignment roster
  // (the migration quiesce gate). The gate installs SYNCHRONOUSLY with a
  // not-yet-loaded store facade, so an edge booting mid-migration answers 503 +
  // Retry-After until the roster snapshot lands — it never defaults to
  // serve-local for a quiescing user (council-resolved). The roster read is
  // scoped to this pod's own gateway and is read-only.
  const selfRevisionId = process.env.GATEWAY_REVISION_ID ?? "";
  const rosterGatewayId = process.env.GATEWAY_ID ?? "";
  let rollRosterUpgradeGate: RollRosterUpgradeGate | null = null;
  let rosterFacade: Pick<RollRosterStore, "loaded" | "get"> | null = null;
  if (selfRevisionId && rosterGatewayId) {
    let rosterStore: RollRosterStore | null = null;
    const storeFacade = {
      loaded: () => rosterStore?.loaded() ?? false,
      get: (uid: string) => rosterStore?.get(uid),
    };
    rosterFacade = storeFacade;
    installRollRosterGate(
      createRollRosterGate({
        store: storeFacade,
        gatewayId: rosterGatewayId,
        selfRevisionId,
        log: (msg) => logger.warn(msg),
      }),
    );
    // WS upgrades bypass Express — the same roster/boot checks run at the
    // chat-proxy upgrade path.
    rollRosterUpgradeGate = createRollRosterUpgradeGate({
      store: storeFacade,
      gatewayId: rosterGatewayId,
      selfRevisionId,
      log: (msg) => logger.warn(msg),
    });
    rosterStore = createRollRosterStore({
      subscribe: createBrokerRollRosterSubscription({
        brokerUrl:
          process.env.FLEET_BROKER_URL ??
          process.env.OCTOGEE_API_URL ??
          `http://octogee-api.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3001`,
        gatewayId: rosterGatewayId,
        revisionId: selfRevisionId,
      }),
      log: (msg) => logger.warn(msg),
    });
  }

  const server = http.createServer((req, res) =>
    dispatchGatewayEdgeRequest(req, res, app),
  );
  loadChatProxyModule().then((chatProxy) => {
    chatProxy.attachChatProxyWsUpgrade(server, { upgradeGate: rollRosterUpgradeGate });
    mountApi(app, "/workspace-roles", createWorkspaceRolesRouter());
    toolSurface.attachWs((server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter, isAllowedWsOrigin);
    vmEgressRoutes.attachWs((server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter, isAllowedWsOrigin);
    vmPasskeyRoutes.attachWs((server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter, isAllowedWsOrigin);
    if (isGatewayVm()) {
      vmWebAuthn.start();
      vmEgress.boot().catch((err) => {
        logger.error("[computer-egress] SOCKS5 listener failed to start; the VM's Chromium has no egress", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (terminalAvailable(process.env)) {
      attachTerminalWsRoute({
        router: (server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter,
        tickets: terminalTickets,
        defaultAgentId: () => {
          const identity = claimedUserIdentity();
          return identity ? workspaceDefaultAgentId(identity.builderSlug) : null;
        },
        openUpstream: openTerminalUserSocket,
        isAllowedOrigin: isAllowedWsOrigin,
        log: (message, meta) => logger.warn(message, meta),
      });
    }
    if (process.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED === "true") {
      nativeMobileGateway?.attach((server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter);
      attachOpenClawControlWsRoute({
        router: (server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter,
        env: process.env,
        metrics: activeOpenClawControlMetrics,
        authorizationCache: openClawControlAuthorizationCache,
        workspaceServing: workspaceServingResolver({
          gatewayClass: edgeGatewayClass,
          identity: builderIdentity,
          store: rosterFacade,
        }),
      });
      const dashboardHeartbeat = startOpenClawDashboardCapabilityHeartbeat({
        env: process.env,
        logError: (error) => logger.error("OpenClaw Dashboard capability heartbeat failed", {
          errorType: error instanceof Error ? error.name : "unknown",
        }),
      });
      process.once("exit", () => dashboardHeartbeat?.stop());
    }
    server.listen(PORT, () => {
      logger.info(`gateway-edge boot — listening on port ${PORT}`, {
        port: PORT,
        env: process.env.K8S_NAMESPACE || "local",
        sha: process.env.BUILD_SHA || "unknown",
        oc: process.env.OPENCLAW_VERSION || "n/a",
        fork: process.env.OPENCLAW_FORK_SHA || "n/a",
        node: process.version,
      });
    });

    chatProxy.startChatProxyBackground().catch((err) => {
      logger.error("[chat-proxy] background boot failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }).catch((err) => {
    logger.error("[chat-proxy] module load failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
  }
}

export default app;
