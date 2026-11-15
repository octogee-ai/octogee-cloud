import type { NextFunction, Request, Response } from "express";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import {
  configuredUserBootstrapAllowed,
} from "@octogee/core/gateway-live-release";
import { GATEWAY_BINDING_MISMATCH_REASON, RETIRED_VM_BINDING_DENIAL_REASON } from "@octogee/shared/types/fleet-broker";
import { hasRunningUserMigration } from "../lib/running-user-migration.js";
import { normalizeTenantPolicyPath } from "../lib/tenant-route-policy.js";
import type { UserNotifier } from "../lib/user-notifications.js";
import { logger, redactRequestPath } from "../../../gateway-edge/src/middleware/logging.js";
import {
  createTenantDenialReporter,
  type TenantDenial,
  type TenantDenialCause,
  type TenantDenialReporter,
  type TenantDenialTenant,
} from "./tenant-denial.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;
type PlatformBinding = Extract<Express.Request["boundTenant"], { kind: "platform" }>;
export type PlatformActor = PlatformBinding["actor"];

export interface ProductTenantRoutes {
  readonly platformActorRoutes: Readonly<Partial<Record<PlatformActor, readonly string[]>>>;
  readonly userTargetedRoutes: readonly string[];
  readonly platformOnlyRoutes: readonly string[];
  readonly tenantBoundApiRoutes: readonly string[];
  readonly selfScopedBrokerRoutes: readonly string[];
}

export const NO_PRODUCT_TENANT_ROUTES: ProductTenantRoutes = {
  platformActorRoutes: {},
  userTargetedRoutes: [],
  platformOnlyRoutes: [],
  tenantBoundApiRoutes: [],
  selfScopedBrokerRoutes: [],
};

export type FlowGatewayReader = (flowId: string) => Promise<string | null>;

interface EnforcementReaders {
  readFlowGateway: FlowGatewayReader;
  store: PlatformStateRepositories;
  productRoutes: ProductTenantRoutes;
}

export interface TenantAccessRecord {
  method: string;
  path: string;
  decision: "pending" | "admitted" | "denied";
  status: number;
  responseCompleted: boolean;
  reason?: string;
  tenant: TenantDenialTenant;
  podName?: string;
  agentId: string | null;
}

export type TenantAccessRecorder = (record: TenantAccessRecord) => void;

export interface TenantEnforcementOptions {
  readFlowGateway: FlowGatewayReader;
  store: PlatformStateRepositories;
  onDenied?: TenantDenialReporter;
  notifyUsers?: UserNotifier;
  onAccess?: TenantAccessRecorder;
  enforceWhen?: (req: Request) => boolean;
  productRoutes?: ProductTenantRoutes;
}

const UNRECORDED_POLL_ROUTES = new Set(["/internal/fleet/assignment-roster"]);

function logAccess(record: TenantAccessRecord): void {
  logger.info(`[data-access] ${record.method} ${record.path} ${record.decision} ${record.status}`, {
    category: "data-access",
    ...record,
  });
}

function platformBindingAuthorized(bound: PlatformBinding, path: string, productRoutes: ProductTenantRoutes): boolean {
  if (productRoutes.platformActorRoutes[bound.actor]?.includes(path)) return true;
  if (bound.actor === "artifact-worker") {
    return path === "/internal/chat-artifacts" || path.startsWith("/internal/chat-artifacts/");
  }
  if (bound.actor === "npm-cache-proxy") {
    return path === "/internal/fleet/npm-cache-authorize";
  }
  return false;
}

export const SELF_SCOPED_INTERNAL_BROKER_ROUTES = new Set([
  "/internal/fleet/blob/workspace/upload",
  "/internal/fleet/blob/materialization/read-url",
  "/internal/fleet/blob/materialization/manifest/read-url",
  "/internal/computer/agent-context",
  "/internal/connectors/access-token",
  "/internal/connectors/github-project-clone-access",
  "/internal/byok/agent-usage-status",
  "/internal/byok/broker-inspect",
  "/internal/byok/byosub-cred",
  "/internal/byok/byosub-cred-syncback",
  "/internal/byok/api-key",
  "/internal/byok/agent-model-token",
  "/internal/byok/byosub-flow",
  "/internal/byok/byosub-user",
  "/internal/byok/byosub-flow-read",
  "/internal/fleet/configured-builder-bootstrap",
  "/internal/fleet/builder-identity",
  "/internal/fleet/npm-registry-credentials",
  "/internal/fleet/user-snapshot",
  "/internal/fleet/builder-runtime-state/download-url",
  "/internal/fleet/builder-runtime-state/snapshot-urls",
  "/internal/fleet/builder-runtime-state/prune",
  "/internal/fleet/agent-anchors/report",
  "/internal/fleet/agent-anchors/read",
  "/internal/fleet/computer-home/checkpoint-url",
  "/internal/fleet/computer-home/commit",
  "/internal/fleet/computer-home/download-url",
  "/internal/fleet/computer-home/prune",
  "/internal/fleet/openclaw-boot/claim",
  "/internal/fleet/openclaw-boot/healthy",
  "/internal/fleet/uid-for-slug",
  "/internal/fleet/vm-runtime",
  "/internal/fleet/computer-egress",
  "/internal/openclaw-control/redeem",
  "/internal/openclaw-control/authorize",
  "/internal/openclaw-control/profile",
  "/internal/openclaw-control/tool-conversation",
  "/internal/voice/conversation",
  "/internal/voice/turn",
  "/internal/voice/bind",
  "/internal/voice/end",
  "/internal/voice/archive",
  "/internal/openclaw-control/mattermost/authorize",
  "/internal/openclaw-control/mattermost/channels",
  "/internal/workspace-git/authorize",
  "/internal/channel-agent-readiness/authorize",
  "/internal/openclaw/notifications/final-reply",
  "/internal/openclaw/activity/session-context",
  "/internal/openclaw/activity/dispatch-context",
]);

export const FINAL_HOME_CHECKPOINT_ROUTES = new Set([
  "/internal/fleet/vm-runtime",
  "/internal/fleet/computer-home/checkpoint-url",
  "/internal/fleet/computer-home/commit",
  "/internal/fleet/computer-home/prune",
]);

function isSelfScopedInternalBrokerRoute(path: string, productRoutes: ProductTenantRoutes): boolean {
  return SELF_SCOPED_INTERNAL_BROKER_ROUTES.has(path) ||
    productRoutes.selfScopedBrokerRoutes.includes(path) ||
    path === "/internal/agent-imports" || path.startsWith("/internal/agent-imports/");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((v): v is string => !!v) : [];
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

function requestedGatewayIds(req: Request): string[] {
  const b = body(req);
  return [
    stringValue(b.gatewayId),
    stringValue(req.params?.gatewayId),
    stringValue(req.query?.gatewayId),
  ].filter((v): v is string => !!v);
}

function requestedFlowId(req: Request): string | null {
  return stringValue(body(req).flowId);
}

function requestedUids(req: Request): string[] {
  const b = body(req);
  return [
    stringValue(b.uid),
    stringValue(b.ownerUid),
    stringValue(b.actorUid),
    stringValue(req.params?.uid),
    ...stringArray(b.targetUserIds),
  ].filter((v): v is string => !!v);
}

function requestedSlugs(req: Request): string[] {
  const b = body(req);
  return [
    stringValue(b.slug),
    stringValue(b.workspaceSlug),
    stringValue(b.org),
    stringValue(req.params?.slug),
    stringValue(req.query?.slug),
    stringValue(req.query?.org),
  ].filter((v): v is string => !!v);
}

async function uidBelongsToGateway(
  store: PlatformStateRepositories,
  uid: string,
  gatewayId: string,
): Promise<boolean> {
  const user = await store.users.records.get(uid);
  if (user?.gateway?.gatewayId === gatewayId) return true;
  return uidHoldsDisposableClaim(store, uid, gatewayId);
}

// The user mirror only names a disposable isolated once activation finishes, and
// activation cannot finish without the bootstrap calls this check guards. The
// gateway's own allocation is the platform-written record of that pending
// binding, so an active claim binds the uid for exactly as long as it stands.
// Both the claim and the owner must name the uid, and a retired gateway's
// leftover claim binds nothing.
async function uidHoldsDisposableClaim(
  store: PlatformStateRepositories,
  uid: string,
  gatewayId: string,
): Promise<boolean> {
  const gateway = await store.gateways.roots.get(gatewayId);
  if (!gateway || gateway.desiredStatus === "retired") return false;
  const allocation = gateway.allocation;
  return (
    allocation?.kind === "disposable-builder" &&
    allocation.claimedByUid === uid &&
    gateway.ownerUid === uid
  );
}

async function slugBelongsToGateway(
  store: PlatformStateRepositories,
  slug: string,
  gatewayId: string,
): Promise<boolean> {
  const assigned = await store.users.records.listByGateway(gatewayId);
  return assigned.some((user) => user.slug === slug);
}

async function slugHasRunningInboundMigration(
  store: PlatformStateRepositories,
  gatewayId: string,
  slug: string,
): Promise<boolean> {
  const user = await store.users.records.findBySlug(slug);
  return user !== null && hasRunningUserMigration(store, user.uid, gatewayId, "inbound");
}

function routeAllowsInboundMigrationSlug(req: Request): boolean {
  return req.path === "/internal/gitea" || req.path.startsWith("/internal/gitea/");
}

function routeRequiresTargetUser(req: Request, productRoutes: ProductTenantRoutes): boolean {
  return productRoutes.userTargetedRoutes.includes(normalizeTenantPolicyPath(req.path));
}

function routeIsPlatformOnly(req: Request, productRoutes: ProductTenantRoutes): boolean {
  return productRoutes.platformOnlyRoutes.includes(normalizeTenantPolicyPath(req.path));
}

async function slugAllowedForRequest(
  store: PlatformStateRepositories,
  slug: string,
  bound: GatewayBinding,
  req: Request,
): Promise<boolean> {
  if (await slugBelongsToGateway(store, slug, bound.gatewayId)) return true;
  if (!routeAllowsInboundMigrationSlug(req)) return false;
  if (await slugHasRunningInboundMigration(store, bound.gatewayId, slug)) return true;
  const gateway = await store.gateways.roots.get(bound.gatewayId);
  return configuredUserBootstrapAllowed(gateway ?? undefined, {
    gatewayId: bound.gatewayId,
    podName: bound.podName,
    slug,
  });
}

async function allUidsBelongToGateway(
  store: PlatformStateRepositories,
  uids: string[],
  gatewayId: string,
): Promise<boolean> {
  for (const uid of uids) {
    if (!(await uidBelongsToGateway(store, uid, gatewayId))) return false;
  }
  return true;
}

async function allSlugsAllowedForRequest(
  store: PlatformStateRepositories,
  slugs: string[],
  bound: GatewayBinding,
  req: Request,
): Promise<boolean> {
  for (const slug of slugs) {
    if (!(await slugAllowedForRequest(store, slug, bound, req))) return false;
  }
  return true;
}

async function uidsAllowedForRequest(
  { store, productRoutes }: EnforcementReaders,
  uids: string[],
  gatewayId: string,
  req: Request,
): Promise<boolean> {
  if (routeRequiresTargetUser(req, productRoutes) && uids.length === 0) return false;
  return uids.length === 0 || allUidsBelongToGateway(store, uids, gatewayId);
}

async function gatewayDenialReason(
  readers: EnforcementReaders,
  bound: GatewayBinding,
  req: Request,
): Promise<string | null> {
  const gatewayIds = requestedGatewayIds(req);
  const requestTargetsDifferentGateway = gatewayIds.some((gatewayId) => gatewayId !== bound.gatewayId);
  if (gatewayIds.length > 0 && requestTargetsDifferentGateway) {
    return GATEWAY_BINDING_MISMATCH_REASON;
  }
  if (routeIsPlatformOnly(req, readers.productRoutes)) {
    return "route is platform-only";
  }
  if (bound.finalHomeCheckpoint) {
    return FINAL_HOME_CHECKPOINT_ROUTES.has(req.path)
      ? null
      : RETIRED_VM_BINDING_DENIAL_REASON;
  }

  // These brokers perform route-specific authorization from their own body
  // shape. Keeping this as an explicit route allowlist avoids turning
  // gatewayId into a generic skeleton key for future internal routes.
  if (isSelfScopedInternalBrokerRoute(req.path, readers.productRoutes)) {
    return null;
  }
  return targetedDenialReason(readers, bound, req, gatewayIds.length > 0);
}

async function targetedDenialReason(
  readers: EnforcementReaders,
  bound: GatewayBinding,
  req: Request,
  namesBoundGateway: boolean,
): Promise<string | null> {
  const { readFlowGateway, store } = readers;
  const uids = requestedUids(req);
  if (!(await uidsAllowedForRequest(readers, uids, bound.gatewayId, req))) {
    return "request names a user not assigned to the bound gateway";
  }

  const slugs = requestedSlugs(req);
  if (slugs.length > 0 && !(await allSlugsAllowedForRequest(store, slugs, bound, req))) {
    return "request names a workspace slug not assigned to the bound gateway";
  }

  const flowId = requestedFlowId(req);
  if (flowId && (await readFlowGateway(flowId)) !== bound.gatewayId) {
    return "request names a flow owned by another gateway";
  }

  return uids.length > 0 || slugs.length > 0 || namesBoundGateway || flowId !== null
    ? null
    : "route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow";
}

const PLACEMENT_DENIAL_REASONS: ReadonlySet<string> = new Set([
  GATEWAY_BINDING_MISMATCH_REASON,
  "request names a user not assigned to the bound gateway",
  "request names a workspace slug not assigned to the bound gateway",
  RETIRED_VM_BINDING_DENIAL_REASON,
]);

export function tenantDenialCause(reason: string): TenantDenialCause {
  return PLACEMENT_DENIAL_REASONS.has(reason) ? "placement" : "policy";
}

function denialTenant(bound: Express.Request["boundTenant"]): TenantDenialTenant {
  if (bound?.kind === "gateway") {
    return { kind: "gateway", gatewayId: bound.gatewayId, ...(bound.ownerUid ? { ownerUid: bound.ownerUid } : {}) };
  }
  if (bound?.kind === "platform") return { kind: "platform", actor: bound.actor };
  return { kind: "unbound" };
}

function requestedAgentId(req: Request): string | null {
  return stringValue(body(req).agentId);
}

interface AccessOutcome {
  decision: TenantAccessRecord["decision"];
  deniedReason?: string;
}

function recordAccessOnResponse(
  req: Request,
  res: Response,
  outcome: AccessOutcome,
  onAccess: TenantAccessRecorder,
): void {
  if (UNRECORDED_POLL_ROUTES.has(normalizeTenantPolicyPath(req.path))) return;
  const path = redactRequestPath(req.path);
  const method = req.method;
  const agentId = requestedAgentId(req);
  let recorded = false;
  const recordAccess = () => {
    if (recorded) return;
    recorded = true;
    res.off("finish", recordAccess);
    res.off("close", recordAccess);
    const bound = req.boundTenant;
    const record: TenantAccessRecord = {
      method,
      path,
      decision: outcome.decision,
      status: res.statusCode,
      responseCompleted: res.writableFinished,
      ...(outcome.deniedReason === undefined ? {} : { reason: outcome.deniedReason }),
      tenant: denialTenant(bound),
      ...(bound?.kind === "gateway" && bound.podName ? { podName: bound.podName } : {}),
      agentId,
    };
    try {
      onAccess(record);
    } catch (error: unknown) {
      logger.error("[tenant-enforcement] access recorder threw", { ...record, error });
    }
  };
  res.once("finish", recordAccess);
  res.once("close", recordAccess);
}

export function createTenantEnforcementMiddleware(
  opts: TenantEnforcementOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const readers: EnforcementReaders = {
    readFlowGateway: opts.readFlowGateway,
    store: opts.store,
    productRoutes: opts.productRoutes ?? NO_PRODUCT_TENANT_ROUTES,
  };
  const onDenied = opts.onDenied ?? createTenantDenialReporter({ store: opts.store, notifyUsers: opts.notifyUsers });
  const onAccess = opts.onAccess ?? logAccess;
  const deny = (req: Request, res: Response, outcome: AccessOutcome, reason: string): void => {
    outcome.decision = "denied";
    outcome.deniedReason = reason;
    const denial: TenantDenial = {
      method: req.method,
      path: req.path,
      reason,
      cause: tenantDenialCause(reason),
      tenant: denialTenant(req.boundTenant),
      agentId: requestedAgentId(req),
    };
    onDenied(denial).catch((error: unknown) => {
      logger.error("[tenant-enforcement] denial reporter threw", { ...denial, error });
    });
    res.status(403).json({ error: `forbidden: ${reason}`, code: "tenant-enforcement" });
  };
  return (req, res, next) => {
    const outcome: AccessOutcome = { decision: "pending" };
    const admit = () => {
      outcome.decision = "admitted";
      next();
    };
    recordAccessOnResponse(req, res, outcome, onAccess);
    if (opts.enforceWhen && !opts.enforceWhen(req)) {
      admit();
      return;
    }
    const bound = req.boundTenant;
    if (bound?.kind === "platform") {
      if (platformBindingAuthorized(bound, req.path, readers.productRoutes)) {
        admit();
      } else {
        deny(req, res, outcome, `platform actor ${bound.actor} is not admitted on this route`);
      }
      return;
    }
    if (!bound || bound.kind !== "gateway") {
      deny(req, res, outcome, "request carries no gateway tenant binding");
      return;
    }

    gatewayDenialReason(readers, bound, req)
      .then((reason) => {
        if (reason !== null) {
          deny(req, res, outcome, reason);
          return;
        }
        admit();
      })
      .catch((error: unknown) => {
        deny(req, res, outcome, `authorization check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}
