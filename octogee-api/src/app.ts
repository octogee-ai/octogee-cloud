import http from "node:http";
import express, { Request, Response, type RequestHandler } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

import { corsMiddleware } from "../../gateway-edge/src/middleware/cors.js";
import { requestLogger, logger, setLogService } from "../../gateway-edge/src/middleware/logging.js";
import { mattermostChannelHostFromEnv } from "@octogee/core/channel-host";
import { createMattermostCommandRoutes } from "./routes/mattermost-commands.js";

import { errorHandler } from "../../gateway-edge/src/middleware/errors.js";
import { helmetMiddleware } from "../../gateway-edge/src/middleware/security.js";

import { runtimeBlobStore } from "./lib/runtime-blob-store.js";
import { mountClusterRoutes, type ClusterRouteTable } from "../../gateway-edge/src/routes/mount-cluster-routes.js";
import { createAdminRoutes, type ProductAdminRoutes } from "../../gateway-edge/src/routes/admin.js";
import type { DeletionProductContextDiscovery } from "@octogee/core/admin-fleet-router";
import type { AdminUserDirectorySource, AdminUserProductDetail } from "@octogee/core/admin-user-directory-router";
import type { UserAccountReader } from "@octogee/core/user-account";
import type { ControlSessionChecks } from "@octogee/core/platform-state";
import type { ProvisioningProjection } from "@octogee/core/provisionSteps";
import {
  installUserEntitlements,
  staticUserEntitlements,
  type UserEntitlementResolver,
} from "@octogee/shared/types/user-entitlements";
import internalGiteaAdminRoutes from "../../gateway-edge/src/routes/internal/gitea-admin.js";
import { installBodyParsers } from "../../gateway-edge/src/middleware/body-parsers.js";
import { createMattermostMintRoutes, createMmRestProxyHandler } from "./routes/mattermost-proxy.js";
import { createOpenClawRuntimeBrokerRoutes, type SessionChannelPurposeReader } from "./routes/openclaw-runtime-broker.js";
import { createConnectorTokenBrokerRoutes, type PublicCanvasFileReader } from "./routes/connector-token-broker.js";
import { createWorkspaceCommitProofBrokerRoutes } from "./routes/workspace-commit-proof-broker.js";
import { createOwnerAutomationAuthorizationBrokerRoutes } from "./routes/owner-automation-authorization-broker.js";
import { byosubFlowGatewayReader, createByokBrokerRoutes } from "./routes/byok-broker.js";
import { createGatewayVmContextRoutes } from "./routes/gateway-vm-context.js";
import { createFleetBrokerRoutes, type ProvisionedUserReport } from "./routes/fleet-broker.js";
import { createOpenClawControlBrokerRoutes } from "./routes/openclaw-control-broker.js";
import { createAutomationAuthorizationBrokerRoutes } from "./routes/automation-authorization-broker.js";
import { createWorkspaceGitAuthorizationBrokerRoutes } from "./routes/workspace-git-authorization-broker.js";
import { userIdentityBrokerHandlers } from "./routes/user-identity-broker.js";
import { USER_IDENTITY_BROKER_PATH } from "../../gateway-edge/src/lib/brokered-user-identity-provider.js";
import { createChannelReadinessAuthorizationBrokerRoutes } from "./routes/channel-agent-readiness-authorization-broker.js";
import { createVoiceConversationRoutes } from "./routes/voice-conversation.js";
import { createToolConversationRoutes, createWorkspaceNativeAccessRoutes } from "./routes/workspace-native-access.js";
import { createAgentImportBrokerRoutes } from "./routes/agent-import-broker.js";
import { createModelKeyIssuerRoutes } from "./routes/model-key-issuer.js";
import type { FundedBudgetInterruption } from "./lib/model-broker-budget.js";
import { operatorRailRegistry, type ModelBrokerRailRegistry } from "./lib/model-broker-rails.js";
import { platformStateBrokerRecords, type BrokerRecords } from "./lib/broker-records.js";
import { createFeatureRoutes } from "./routes/features.js";
import type { ProductNotifications } from "./lib/user-notifications.js";
import { FeaturePolicy, configuredFeatureFlagProvider } from "./lib/feature-policy.js";
import { createIsolatedGatewayRoutes } from "../../gateway-edge/src/routes/user/gateways.js";
import { createProjectCreateRoutes } from "../../gateway-edge/src/routes/projects/create.js";
import { createProjectRepoSourceRoutes } from "../../gateway-edge/src/routes/projects/repo-source.js";
import { startWorkspaceVoiceConversation } from "./lib/voice-posting-grant.js";
import { resolveVoiceChannel } from './lib/workspace-conversation.js';
import { createVoiceRoutes } from "../../gateway-edge/src/routes/voice.js";
import {
  createChatArtifactRoutes,
  createChatArtifactWorkerRoutes,
  requireArtifactWorkerAuth,
} from "./routes/chat-artifacts.js";
import { ArtifactRegistry, type ArtifactJobStore } from "./lib/chat-artifact-registry.js";
import {
  createGcsArtifactBlobStore,
  createMattermostArtifactAccess,
  createMattermostArtifactSourceReader,
} from "./lib/chat-artifact-adapters.js";
import { resolveActiveArtifactWorkspaceSlug } from "./lib/chat-artifact-workspace.js";
import { storage } from "../../gateway-edge/src/lib/db.js";
import { platformStateStore, readSizingKey } from "../../gateway-edge/src/lib/platform-state.js";
import {
  ConnectorTokenReadError,
  getFreshAccessTokenFromStore,
} from "../../gateway-edge/src/lib/connector-tokens.js";
import { getConnector } from "../../gateway-edge/src/lib/connectors/index.js";
import { githubListRepos, githubRepoApi } from "../../gateway-edge/src/lib/github.js";
import { authenticationFailureLimit } from "./middleware/authenticated-request-limit.js";
import { brokerRequestLimit } from "./middleware/broker-request-limit.js";
import {
  loadUserWithInstalledProvider,
  requireActiveAccount,
  requireAuth,
  requireAuthenticatedUid,
} from "../../gateway-edge/src/middleware/auth.js";
import {
  IN_CLUSTER_IDENTITY_CA_PATH,
  IN_CLUSTER_IDENTITY_TOKEN_PATH,
} from "./lib/token-review.js";
import {
  createTenantBindingHealthState,
  startTenantBindingSelfCheck,
} from "./lib/tenant-binding-health.js";
import {
  createTenantBindingMiddleware,
  createTenantBindingMetrics,
} from "./middleware/tenant-binding.js";
import {
  createTenantEnforcementMiddleware,
  NO_PRODUCT_TENANT_ROUTES,
  type ProductTenantRoutes,
} from "./middleware/tenant-enforcement.js";
import { createGatewayIdentityReviewer } from "./lib/gateway-identity-reviewer.js";
import { createOpenAiVoiceCatalog } from "./voice/openai-catalog.js";
import { createOpenAiLiveUpgradeHandler } from "./voice/openai-live.js";
import { createVoiceCatalog, type VoiceCatalog } from "./voice/catalog.js";
import { parseVoiceRelayConfig, type VoiceRelayConfig } from "./voice/config.js";
import {
  createVoiceRelayRoutes,
  createVoiceRelayUpgradeHandler,
  type VoiceRelayUpgradeAuth,
} from "./voice/relay.js";
import { createGatewayCredentialAuth } from "./middleware/gateway-credential-auth.js";
import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  SIDECAR_BROKER_TOKEN_AUDIENCE,
  SIDECAR_BROKER_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import { createModelBrokerTokenStore, type ModelBrokerTokenStore } from "./lib/model-broker-tokens.js";
import { normalizeTenantPolicyPath } from "./lib/tenant-route-policy.js";


setLogService("api");

const TENANT_BOUND_API_ROUTES: readonly string[] = [
  "/api/model-credentials/subscription/auth-state",
  "/api/model-credentials/subscription/capture",
  "/api/model-credentials/subscription/sync-back",
];
export const GATEWAY_CREDENTIAL_ROUTES = new Set([
  "/internal/fleet/blob/materialization/read-url",
  "/internal/fleet/blob/materialization/manifest/read-url",
  "/internal/connectors/access-token",
  "/internal/fleet/vm-runtime",
  "/internal/fleet/computer-home/checkpoint-url",
  "/internal/fleet/computer-home/commit",
  "/internal/fleet/computer-home/download-url",
  "/internal/fleet/computer-home/prune",
  "/internal/fleet/assigned-users",
  "/internal/fleet/assignment-watch",
  "/internal/fleet/configured-builder-bootstrap",
  "/internal/fleet/builder-identity",
  "/internal/fleet/npm-registry-credentials",
  "/internal/fleet/user-snapshot",
  "/internal/fleet/runtime-reset-ack",
  "/internal/fleet/provision-mattermost",
]);

export const SIDECAR_BROKER_ROUTES = new Set([
  "/internal/fleet/blob/project/upload-url",
  "/internal/fleet/blob/workspace/upload",
  "/internal/connectors/github-project-clone-access",
  "/internal/openclaw/activity/agent-identity",
  "/internal/workspace-commit/verify-proof",
  "/internal/owner-automations/authorize",
  USER_IDENTITY_BROKER_PATH,
]);

export interface ProductRouteDeps {
  featurePolicy: FeaturePolicy;
}

export interface ProductRuntime {
  featurePolicy: FeaturePolicy;
  routesBeforeMiddleware?: ClusterRouteTable;
  routesBeforeTenantBinding?(deps: ProductRouteDeps): ClusterRouteTable;
  prewarmProjectCapacity?: () => Promise<void>;
  projectsDeleteRoutes?: express.Router;
  discoverDeletionProductContext?: DeletionProductContextDiscovery;
  tenantRoutes?: ProductTenantRoutes;
  controlSessionChecks?: ControlSessionChecks;
  publicCanvasFile?: PublicCanvasFileReader;
  sessionChannelPurpose?: SessionChannelPurposeReader;
  brokerRecords?: BrokerRecords;
  provisioningProjection?: ProvisioningProjection;
  chatArtifactJobs?: ArtifactJobStore;
  adminUserDetail?: AdminUserProductDetail;
  adminUserDirectory?: AdminUserDirectorySource;
  addAdminRoutes?: ProductAdminRoutes;
  platformConfigFields?: () => Record<string, unknown>;
  clusterRoutes(deps: ProductRouteDeps): ClusterRouteTable;
  apiRoutes(deps: ProductRouteDeps): ClusterRouteTable;
  internalRoutes(deps: ProductRouteDeps): ClusterRouteTable;
  onBudgetInterruption(input: { uid: string; reason: FundedBudgetInterruption }): void;
  onUserProvisioned(report: ProvisionedUserReport): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProductExtension {
  entitlements: UserEntitlementResolver;
  validateBoot(): void;
  createRuntime(input: {
    metricsRegistry: Registry;
    namespace: string;
    appOrigin: string;
    readGithubToken(uid: string): Promise<string | null>;
  }): ProductRuntime;
  modelBrokerRails?: ModelBrokerRailRegistry;
  notifications?: ProductNotifications;
}

export interface PlatformAppOptions {
  product?: ProductExtension;
  tenantBindingReviewer?: Parameters<typeof createTenantBindingMiddleware>[0]["reviewer"];
  gatewayCredentialReviewer?: Parameters<typeof createGatewayCredentialAuth>[0]["reviewer"];
  sidecarBrokerReviewer?: Parameters<typeof createGatewayCredentialAuth>[0]["reviewer"];
  tenantBindingSelfCheck?: {
    inCluster?: boolean;
    tokenPath?: string;
  };
  modelKeyTokenStore?: ModelBrokerTokenStore;
  modelKeyIssuerBearerToken?: string;
  modelKeyIssuerTtlSeconds?: number | null;
  featurePolicy?: FeaturePolicy;
  voiceRelayConfig?: VoiceRelayConfig | null;
  voiceOpenAiApiKey?: string | null;
  appOrigin?: string;
}

function chatArtifactRoutes(jobs: ArtifactJobStore) {
  const registry = new ArtifactRegistry(jobs);
  let blobs: ReturnType<typeof createGcsArtifactBlobStore> | undefined;
  const blobStore = {
    put(input: Parameters<ReturnType<typeof createGcsArtifactBlobStore>["put"]>[0]) {
      blobs ??= createGcsArtifactBlobStore(storage.bucket());
      return blobs.put(input);
    },
    open(output: Parameters<ReturnType<typeof createGcsArtifactBlobStore>["open"]>[0]) {
      blobs ??= createGcsArtifactBlobStore(storage.bucket());
      return blobs.open(output);
    },
    delete(output: Parameters<ReturnType<typeof createGcsArtifactBlobStore>["delete"]>[0]) {
      blobs ??= createGcsArtifactBlobStore(storage.bucket());
      return blobs.delete(output);
    },
  };
  let access: ReturnType<typeof createMattermostArtifactAccess> | undefined;
  let source: ReturnType<typeof createMattermostArtifactSourceReader> | undefined;
  const mattermostOptions = () => ({
    mattermostBaseUrl: process.env.MM_INTERNAL_URL ?? "",
    adminToken: process.env.MM_ADMIN_TOKEN ?? "",
    resolveWorkspaceSlugForTeamId: (teamId: string) =>
      resolveActiveArtifactWorkspaceSlug(platformStateStore, teamId),
  });
  return {
    public: createChatArtifactRoutes({
      registry,
      blobs: blobStore,
      auth: requireAuth,
      access: {
        authorizeRequest(userId, request) {
          access ??= createMattermostArtifactAccess(mattermostOptions());
          return access.authorizeRequest(userId, request);
        },
        assertChannelMember(userId, channelId) {
          access ??= createMattermostArtifactAccess(mattermostOptions());
          return access.assertChannelMember(userId, channelId);
        },
      },
    }),
    worker: createChatArtifactWorkerRoutes({
      registry,
      blobs: blobStore,
      auth: requireArtifactWorkerAuth,
      source: {
        open(fileId) {
          source ??= createMattermostArtifactSourceReader(mattermostOptions());
          return source.open(fileId);
        },
      },
    }),
  };
}

export interface TenantBindingScope {
  shouldAttempt(path: string): boolean;
  shouldEnforce(req: Request): boolean;
}

export function createTenantBindingScope(productRoutes: ProductTenantRoutes): TenantBindingScope {
  const tenantBoundApiRoutes = new Set([...TENANT_BOUND_API_ROUTES, ...productRoutes.tenantBoundApiRoutes]);
  const shouldAttempt = (path: string): boolean => {
    const normalized = normalizeTenantPolicyPath(path);
    if (normalized === "/internal" || normalized.startsWith("/internal/")) return true;
    return tenantBoundApiRoutes.has(normalized);
  };
  return {
    shouldAttempt,
    shouldEnforce: (req) => shouldAttempt(req.path) && Boolean(req.boundTenant || req.get("x-k8s-sa-token")),
  };
}

async function readFreshGithubToken(uid: string): Promise<string | null> {
  const connector = getConnector("github");
  if (!connector) throw new Error("GitHub connector is unavailable");
  const token = await getFreshAccessTokenFromStore(platformStateStore, uid, connector);
  if (token.ok) return token.accessToken;
  if (token.reason === "not_connected") return null;
  throw new ConnectorTokenReadError(409, token.reason);
}

function mountRouteTable(app: ReturnType<typeof express>, routes: ClusterRouteTable): void {
  for (const [path, route] of routes) app.use(path, route);
}

function clusterRouteOverrides(
  featurePolicy: FeaturePolicy,
  voiceCatalog: VoiceCatalog,
  product: ProductRuntime | undefined,
  accounts: UserAccountReader,
  notifications?: ProductNotifications,
) {
  return {
    mmRestProxyHandler: createMmRestProxyHandler(platformStateStore, notifications),
    mattermostMintRoutes: createMattermostMintRoutes(platformStateStore),
    productRoutes: product?.clusterRoutes({ featurePolicy }) ?? [],
    projectsDeleteRoutes: product?.projectsDeleteRoutes,
    adminRoutes: createAdminRoutes({
      accounts,
      discoverDeletionProductContext: product?.discoverDeletionProductContext,
      userDetail: product?.adminUserDetail,
      userDirectory: product?.adminUserDirectory,
      addAdminRoutes: product?.addAdminRoutes,
      platformConfigFields: product?.platformConfigFields,
    }),
    isolatedGatewaysRoutes: createIsolatedGatewayRoutes({ featurePolicy }),
    projectsCreateRoutes: createProjectCreateRoutes({ featurePolicy, prewarmProjectRunCapacity: product?.prewarmProjectCapacity }),
    projectsRepoSourceRoutes: createProjectRepoSourceRoutes({ featurePolicy }),
    voiceRoutes: createVoiceRoutes({ featurePolicy, catalog: voiceCatalog, resolveChannel: async (uid, channelId) => {
      const result = await resolveVoiceChannel({ store: platformStateStore, readSizingKey }, { uid, channelId });
      return result ? { gatewayId: result.scope.gatewayId, channelId } : null;
    }, resolveConversation: async (uid, channelId, threadRootPostId) => {
      const result = await startWorkspaceVoiceConversation({ store: platformStateStore, readSizingKey }, { uid, channelId, threadRootPostId });
      return result ? { gatewayId: result.scope.gatewayId, workspaceSlug: result.scope.workspaceSlug, ownerUid: result.scope.ownerUid, channelId, threadRootPostId: result.context.threadRootPostId, sessionKey: result.context.sessionKey } : null;
    } }),
  };
}

function createHttpRequestMetrics(metricsRegistry: Registry): RequestHandler {
  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metricsRegistry],
  });
  const httpRequestTotal = new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status"] as const,
    registers: [metricsRegistry],
  });
  return (req, res, next) => {
    if (req.path === "/metrics") return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path || "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      end(labels);
      httpRequestTotal.inc(labels);
    });
    next();
  };
}

function mountDiagnosticRoutes(
  app: ReturnType<typeof express>,
  metricsRegistry: Registry,
  tenantBindingHealth: ReturnType<typeof createTenantBindingHealthState>,
): void {
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });
  const healthHandler = (_req: Request, res: Response) => {
    const tenantBinding = tenantBindingHealth.get();
    res.status(tenantBinding.status === "unhealthy" ? 503 : 200).json({
      status: tenantBinding.status === "unhealthy" ? "degraded" : "ok",
      service: "octogee-api",
      tenantBinding,
      timestamp: new Date().toISOString(),
    });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);
}

async function authorizeVoiceRelayUpgrade(
  app: ReturnType<typeof express>,
  bindTenant: RequestHandler,
  upgradeReq: http.IncomingMessage,
): Promise<VoiceRelayUpgradeAuth> {
  const req = Object.setPrototypeOf(upgradeReq, app.request) as Request;
  const res = Object.setPrototypeOf(new http.ServerResponse(upgradeReq), app.response) as Response;
  req.res = res;
  res.req = req;
  await new Promise<void>((resolve, reject) => {
    bindTenant(req, res, (err?: unknown) => {
      if (!err) {
        resolve();
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") return { ok: false, status: 403 };
  const claimed = new URL(upgradeReq.url ?? "/", "https://relay.local").searchParams.get("gatewayId");
  if (claimed && claimed !== bound.gatewayId) return { ok: false, status: 403 };
  return { ok: true, gatewayId: bound.gatewayId };
}

// eslint-disable-next-line max-lines-per-function, complexity -- application assembly keeps route ownership and dependency wiring explicit
export function createPlatformApp(opts: PlatformAppOptions = {}) {
  installUserEntitlements(opts.product?.entitlements ?? staticUserEntitlements);
  opts.product?.validateBoot();

  const app = express();
  if (process.env.BLOB_STORE_BACKEND !== "gcs") app.locals.workspaceBlobStore = runtimeBlobStore;
  // client → GCLB (appends client-ip, lb-ip) → this app
  app.set("trust proxy", 2);
  const metricsRegistry = new Registry();
  collectDefaultMetrics({ register: metricsRegistry });
  const httpRequestMetrics = createHttpRequestMetrics(metricsRegistry);
  const namespace = process.env.K8S_NAMESPACE ?? "octogee";
  const appOrigin = opts.appOrigin ?? process.env.APP_URL ?? "";
  const product = opts.product?.createRuntime({
    metricsRegistry,
    namespace,
    appOrigin,
    readGithubToken: readFreshGithubToken,
  });
  mountRouteTable(app, product?.routesBeforeMiddleware ?? []);
  const featurePolicy = opts.featurePolicy ?? product?.featurePolicy ?? new FeaturePolicy(configuredFeatureFlagProvider(process.env), { logger });
  const productRouteDeps: ProductRouteDeps = { featurePolicy };
  const modelBrokerRails = opts.product?.modelBrokerRails ?? operatorRailRegistry();
  const brokerRecords = product?.brokerRecords ?? platformStateBrokerRecords(platformStateStore);
  app.locals.productShutdown = product?.shutdown;
  const tenantBindingMetrics = createTenantBindingMetrics(metricsRegistry);
  const tenantBindingReviewer = opts.tenantBindingReviewer ?? createGatewayIdentityReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
  }, { namespace });
  const tenantBindingHealth = createTenantBindingHealthState();
  const tenantBindingMiddleware = createTenantBindingMiddleware({
    reviewer: tenantBindingReviewer,
    store: platformStateStore,
    metrics: tenantBindingMetrics,
  });
  const tenantRoutes = product?.tenantRoutes ?? NO_PRODUCT_TENANT_ROUTES;
  const tenantBindingScope = createTenantBindingScope(tenantRoutes);
  const tenantEnforcementMiddleware = createTenantEnforcementMiddleware({
    readFlowGateway: byosubFlowGatewayReader(brokerRecords.byosub),
    store: platformStateStore,
    enforceWhen: tenantBindingScope.shouldEnforce,
    productRoutes: tenantRoutes,
    notifyUsers: opts.product?.notifications?.notifyUsers,
  });
  const gatewayCredentialReviewer = opts.gatewayCredentialReviewer ?? createGatewayIdentityReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
    audience: GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  }, { namespace });
  const gatewayCredentialAuth = createGatewayCredentialAuth({
    reviewer: gatewayCredentialReviewer,
    store: platformStateStore,
    namespace,
  });
  const sidecarBrokerReviewer = opts.sidecarBrokerReviewer ?? createGatewayIdentityReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
    audience: SIDECAR_BROKER_TOKEN_AUDIENCE,
  }, { namespace });
  const sidecarBrokerAuth = createGatewayCredentialAuth({
    reviewer: sidecarBrokerReviewer,
    store: platformStateStore,
    namespace,
    tokenHeader: SIDECAR_BROKER_TOKEN_HEADER,
    audience: SIDECAR_BROKER_TOKEN_AUDIENCE,
  });
  startTenantBindingSelfCheck(tenantBindingHealth, {
    reviewer: tenantBindingReviewer,
    ...opts.tenantBindingSelfCheck,
    log: (msg) => logger.error(msg),
  });

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(httpRequestMetrics);

  app.use(requestLogger);
  app.use("/internal/mattermost/commands", createMattermostCommandRoutes({
    store: platformStateStore,
    routerPublicKey: process.env.AGENT_CONTROL_ROUTER_PUBLIC_KEY ?? "",
    commandTokenMatches: (input) => mattermostChannelHostFromEnv().commandTokenMatches(input),
    log: (message, meta) => logger.warn(message, meta ?? {}),
  }));

  installBodyParsers(app);
  mountDiagnosticRoutes(app, metricsRegistry, tenantBindingHealth);
  app.use("/api/features", createFeatureRoutes({ featurePolicy }));
  mountRouteTable(app, product?.routesBeforeTenantBinding?.(productRouteDeps) ?? []);
  app.use((req, res, next) => {
    if (!tenantBindingScope.shouldAttempt(req.path)) {
      next();
      return;
    }
    tenantBindingMiddleware(req, res, next);
  });
  app.use((req, res, next) => {
    if (!tenantBindingScope.shouldAttempt(req.path)) {
      next();
      return;
    }
    tenantEnforcementMiddleware(req, res, next);
  });
  app.use((req, res, next) => {
    if (!GATEWAY_CREDENTIAL_ROUTES.has(normalizeTenantPolicyPath(req.path))) {
      next();
      return;
    }
    gatewayCredentialAuth(req, res, next);
  });
  app.use((req, res, next) => {
    if (!SIDECAR_BROKER_ROUTES.has(normalizeTenantPolicyPath(req.path))) {
      next();
      return;
    }
    sidecarBrokerAuth(req, res, next);
  });
  const voiceRelayConfig = opts.voiceRelayConfig === undefined ? parseVoiceRelayConfig() : opts.voiceRelayConfig;
  const voiceOpenAiApiKey = opts.voiceOpenAiApiKey === undefined ? process.env.VOICE_OPENAI_API_KEY?.trim() || null : opts.voiceOpenAiApiKey;
  const voiceRelayLog = (message: string, fields?: Record<string, unknown>) => logger.warn(message, fields ?? {});
  mountClusterRoutes(app, clusterRouteOverrides(
    featurePolicy,
    voiceOpenAiApiKey ? createOpenAiVoiceCatalog(voiceOpenAiApiKey) : createVoiceCatalog(voiceRelayConfig, { log: voiceRelayLog }),
    product,
    brokerRecords.accounts,
    opts.product?.notifications,
  ));
  mountRouteTable(app, product?.apiRoutes(productRouteDeps) ?? []);
  mountRouteTable(app, product?.internalRoutes(productRouteDeps) ?? []);
  const chatArtifacts = product?.chatArtifactJobs ? chatArtifactRoutes(product.chatArtifactJobs) : null;
  if (chatArtifacts) app.use("/api/chat/artifacts", chatArtifacts.public);
  // octogee-api-only: Gitea admin broker. Gateway provisioners call this with
  // their projected gateway KSA token; octogee-api holds the Gitea admin token.
  app.use("/internal/gitea", internalGiteaAdminRoutes);
  if (chatArtifacts) app.use("/internal/chat-artifacts", chatArtifacts.worker);
  // octogee-api-only: broker the gateway-edge OpenClaw runtime Firestore
  // dependencies so cattle pods do not need ADC/datastore reach.
  app.use("/internal/openclaw", createOpenClawRuntimeBrokerRoutes({
    store: platformStateStore,
    readSizingKey,
    readSessionChannelPurpose: product?.sessionChannelPurpose,
    notifyFinalReply: opts.product?.notifications?.notifyFinalReply,
  }));
  // octogee-api-only: voice relay. gateway-edge Talk engines stream microphone
  // audio and fetch speech here so provider keys never reach a gateway pod.
  app.use("/internal/voice", createVoiceRelayRoutes({ config: voiceRelayConfig, nativeOpenAi: Boolean(voiceOpenAiApiKey), log: voiceRelayLog }));
  const voiceRelayUpgrade = createVoiceRelayUpgradeHandler({
    config: voiceRelayConfig,
    log: voiceRelayLog,
    authorize: (upgradeReq) => authorizeVoiceRelayUpgrade(app, tenantBindingMiddleware, upgradeReq),
  });
  const openAiLiveUpgrade = createOpenAiLiveUpgradeHandler({
    apiKey: voiceOpenAiApiKey,
    log: voiceRelayLog,
    authorize: (upgradeReq) => authorizeVoiceRelayUpgrade(app, tenantBindingMiddleware, upgradeReq),
  });
  app.locals.attachUpgradeHandlers = (server: http.Server) => {
    server.on("upgrade", (upgradeReq, socket, head) => {
      if (openAiLiveUpgrade(upgradeReq, socket, head)) return;
      if (voiceRelayUpgrade(upgradeReq, socket, head)) return;
      socket.destroy();
    });
  };
  // octogee-api-only: broker standard gateway fleet-mount Firestore/MM
  // operations. The OpenClaw gateway sees only assigned roster snapshots
  // and assigned-scoped mutation endpoints for its own KSA-bound identity.
  app.use("/internal/fleet", createFleetBrokerRoutes({
    store: platformStateStore,
    records: brokerRecords,
    modelBrokerRails,
    onBudgetInterruption: product?.onBudgetInterruption,
    onUserProvisioned: product?.onUserProvisioned,
    provisioningProjection: product?.provisioningProjection,
  }));
  // octogee-api-only: broker sidecar GitHub file-browser token reads
  // so cattle pods do not need Firestore or KMS access to user secrets.
  app.use("/internal/connectors", createConnectorTokenBrokerRoutes({ store: platformStateStore, readPublicCanvasFile: product?.publicCanvasFile }));
  app.use("/internal/workspace-commit", createWorkspaceCommitProofBrokerRoutes({ store: platformStateStore }));
  app.use("/internal/owner-automations", createOwnerAutomationAuthorizationBrokerRoutes({ store: platformStateStore }));
  // octogee-api-only: materialize BYOK creds for cattle gateways that can't reach
  // Secret Manager — BYOSUB OAuth (scoped to the caller's user integration) and
  // byok-* API keys (roster-scoped to the gateway's assigned slugs).
  app.use("/internal/byok", createByokBrokerRoutes({ store: platformStateStore, records: brokerRecords, rails: modelBrokerRails }));
  app.use("/internal/computer", createGatewayVmContextRoutes({ store: platformStateStore }));
  app.use("/internal/openclaw-control", createOpenClawControlBrokerRoutes({
    store: platformStateStore,
    readSizingKey,
    sessionChecks: product?.controlSessionChecks,
  }));
  app.use(
    "/internal/automations",
    authenticationFailureLimit, requireAuthenticatedUid, brokerRequestLimit(240, "user"),
    createAutomationAuthorizationBrokerRoutes({ store: platformStateStore }),
  );
  app.use("/internal/voice", createVoiceConversationRoutes({ store: platformStateStore, readSizingKey }));
  app.use("/internal/openclaw-control", createToolConversationRoutes({ store: platformStateStore, readSizingKey }));
  app.use("/internal/openclaw-control/workspace-access", authenticationFailureLimit, requireAuthenticatedUid, brokerRequestLimit(360, "user"));
  app.use("/internal/openclaw-control", createWorkspaceNativeAccessRoutes({ store: platformStateStore, readSizingKey }));
  app.use("/internal/user-identity", ...userIdentityBrokerHandlers({ loadUser: loadUserWithInstalledProvider }));
  app.use("/internal/workspace-git", authenticationFailureLimit, requireAuthenticatedUid, brokerRequestLimit(360, "user"), requireActiveAccount, createWorkspaceGitAuthorizationBrokerRoutes({ store: platformStateStore }));
  app.use("/internal/channel-agent-readiness", authenticationFailureLimit, requireAuthenticatedUid, brokerRequestLimit(360, "user"), requireActiveAccount, createChannelReadinessAuthorizationBrokerRoutes({ store: platformStateStore }));
  app.use(
    "/internal/agent-imports",
    authenticationFailureLimit, requireAuthenticatedUid, brokerRequestLimit(360, "user"),
    createAgentImportBrokerRoutes({
      store: platformStateStore,
      accounts: brokerRecords.accounts,
      blobs: runtimeBlobStore,
      readGithubToken: readFreshGithubToken,
      listGithubRepos: githubListRepos,
      readGithubRepoSize: async (owner, repo, token) => {
        const value = await githubRepoApi(owner, repo, token);
        const size = value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).size
          : undefined;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
          throw new Error("GitHub repository size is unavailable");
        }
        return size;
      },
      readIdentity: (uid) => brokerRecords.agentIdentity.read(uid),
      syncIdentity: async (uid, identity) => {
        await brokerRecords.agentIdentity.sync(uid, {
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.persona !== undefined ? { persona: identity.persona } : {}),
          ...(identity.emoji ? { emoji: identity.emoji } : {}),
        });
      },
      replaceIdentity: (uid, identity) => brokerRecords.agentIdentity.replaceText(uid, identity),
      now: () => new Date(),
      featurePolicy,
    }),
  );
  // octogee-api-only: mint/revoke opaque model broker tokens. GLM mirrors
  // these into per-gateway K8s secrets, but the values are no longer provider
  // keys and cannot fetch provider keys from the gateway pod.
  app.use(
    "/internal/model-keys",
    createModelKeyIssuerRoutes({
      rails: modelBrokerRails,
      tokens: opts.modelKeyTokenStore ?? createModelBrokerTokenStore(platformStateStore),
      state: platformStateStore,
      accounts: brokerRecords.accounts,
      bearerToken:
        opts.modelKeyIssuerBearerToken ?? process.env.GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN,
      ttlSeconds: opts.modelKeyIssuerTtlSeconds,
    }),
  );

  app.use(errorHandler);

  return app;
}

