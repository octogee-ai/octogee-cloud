import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../middleware/auth.js";
import { authenticationFailureLimit, authenticatedRequestLimit } from "../../middleware/authenticated-request-limit.js";
import { platformStateStore, readSizingKey } from "../../lib/platform-state.js";
import {
  withCurrentSizingKey,
  type SizingKeyReader,
  type CurrentSizingKey,
} from "@octogee/core/user-activation-lease";
import type {
  PlatformUserRecord,
  GatewayRoot,
  PlatformStateRepositories,
  PlatformStateStore,
  Stored,
} from "@octogee/core/platform-state";
import {
  GatewayControlListEntry,
  GatewayControlListResponse,
} from "@octogee/shared/types/gateway-control";
import {
  isGatewayClassControlUiAccessEnabled,
  isValidGatewayId,
  resolveGatewayClass,
  resolveGatewayImageProfile,
} from "@octogee/shared/types/glm";
import {
  readGatewayArtifactInStore,
  readGatewayAuthorizationInStore,
  gatewayRuntimeHeartbeatOf,
  readGatewayRuntimeDoc,
  gatewayAuthorizationFromRootDocument,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";
import { projectOpenClawConfigStatus } from "../../lib/openclaw-config-status.js";
import { createOpenClawControlTicket } from "@octogee/core/openclaw-control-tickets";
import {
  isCanonicalWorkspaceMembership,
  resolveGatewayPrincipalAccess,
  type GatewayPrincipalAccess,
  type ResolvedGatewayAccess,
} from "@octogee/core/gateway-principal-access";
import { isOpenClawControlRevisionRuntimeReady, isOpenClawControlServingRevision } from "../../openclaw-control/runtime-ready.js";
import type { FeaturePolicy, FeatureSubject } from "@octogee/shared/types/feature-flags";
import { registerWorkspaceGatewayStatusRoute } from "./workspace-gateway-status.js";

const NOT_FOUND = "not-found";
const CAPABILITY_DISABLED = "capability-disabled";
const NOT_READY = "not-ready";

function accessRole(access: ResolvedGatewayAccess): GatewayControlListEntry["via"] {
  return access.kind;
}

const openClawTicketRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `${req.uid}:${req.params.gatewayId}`,
  message: { error: "ticket-rate-limited", retryable: true },
});

async function userViewOf({
  authorization,
  scope,
  access,
  imageTag,
  heartbeat,
  runtime,
  isCurrentAssignment,
}: {
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>;
  scope: GatewayWorkspaceScope;
  access: ResolvedGatewayAccess;
  imageTag: string | undefined;
  heartbeat: Record<string, unknown> | null;
  runtime: unknown;
  isCurrentAssignment: boolean;
}): Promise<GatewayControlListEntry> {
  const { gateway, config } = authorization;
  const explicitProfile = config.profile ?? undefined;
  const profile = explicitProfile ?? "standard";
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: explicitProfile,
    imageProfile: config.imageProfile,
  });
  const imageProfile = resolveGatewayImageProfile({
    gatewayClass,
    imageProfile: config.imageProfile,
    profile: explicitProfile,
  });
  const configStatus = projectOpenClawConfigStatus(heartbeat);
  const controlUiEnabled = access.dashboard && isGatewayClassControlUiAccessEnabled(
    gatewayClass,
    config.builderAccess ?? undefined,
  );
  return {
    gatewayId: gateway.gatewayId,
    workspaceSlug: scope.workspaceSlug,
    profile,
    gatewayClass,
    imageProfile,
    desiredStatus: gateway.desiredStatus,
    imageTag,
    controlUiEnabled,
    controlUiReady: await openClawControlReachable({
      authorization,
      runtime,
      controlUiEnabled,
      isCurrentAssignment,
    }),
    isCurrentAssignment,
    ...(configStatus ? { configStatus } : {}),
    via: accessRole(access),
    capabilities: {
      dashboard: access.dashboard,
      workspaceManagement: access.workspaceManagement,
    },
  };
}

export interface GatewayWorkspaceScope {
  gatewayId: string;
  workspaceSlug: string;
  ownerUid: string;
}

type DurableGatewayAuthorization = Extract<GatewayAuthorization, { kind: "durable" }>;

export interface GatewayOwnerSizingKey extends CurrentSizingKey {
  readonly uid: string;
}

function perUserControlIdentity(config: DurableGatewayAuthorization["config"]): boolean {
  return config.gatewayClass === "isolated" && config.builderAccess?.controlIdentity === "per-user";
}

export function perUserOwnerUid(authorization: DurableGatewayAuthorization | null): string | null {
  return authorization && perUserControlIdentity(authorization.config) ? authorization.config.ownerUid : null;
}

export async function withGatewayOwnerSizingKey<T>(
  input: { store: PlatformStateStore; readSizingKey: SizingKeyReader; ownerUid: string | null; now: number },
  run: (ownerSizingKey: GatewayOwnerSizingKey | null) => Promise<T>,
): Promise<T> {
  const uid = input.ownerUid;
  if (!uid) return run(null);
  return withCurrentSizingKey(
    { store: input.store, readSizingKey: input.readSizingKey, uid, now: input.now },
    (current) => run({ ...current, uid }),
  );
}

export function ownerWorkspacePermissionsEnabled(
  config: DurableGatewayAuthorization["config"],
  ownerSizingKey: GatewayOwnerSizingKey | null,
  owner: Stored<PlatformUserRecord> | null,
): boolean {
  if (!perUserControlIdentity(config) || ownerSizingKey === null || ownerSizingKey.uid !== owner?.uid) return false;
  ownerSizingKey.assertCurrent(owner);
  return ownerSizingKey.sizingKey !== null;
}

export function userAssignedTo(
  userRecord: PlatformUserRecord | null,
  gatewayId: string,
  workspaceSlug: string,
): boolean {
  return userRecord !== null && userRecord.gateway?.gatewayId === gatewayId && userRecord.slug === workspaceSlug;
}

function rootDocument(root: Stored<GatewayRoot>): Record<string, unknown> {
  const { revision: _revision, ...document } = root;
  return document;
}

function isSharedGateway(authorization: DurableGatewayAuthorization): boolean {
  return resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  }) === "shared";
}

async function currentOwnerScope(
  state: PlatformStateRepositories,
  gatewayId: string,
  workspaceSlug: string,
  ownerUid: string,
): Promise<GatewayWorkspaceScope | null> {
  return userAssignedTo(await state.users.records.get(ownerUid), gatewayId, workspaceSlug)
    ? { gatewayId, workspaceSlug, ownerUid }
    : null;
}

async function privateGatewayWorkspaceScope(
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string,
  state: PlatformStateRepositories,
): Promise<GatewayWorkspaceScope | null> {
  const { gatewayId } = authorization.gateway;
  const ownerUid = authorization.config.ownerUid;
  if (!ownerUid || authorization.config.builderSlug !== workspaceSlug) return null;
  return currentOwnerScope(state, gatewayId, workspaceSlug, ownerUid);
}

async function sharedGatewayWorkspaceScope(
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string,
  state: PlatformStateRepositories,
): Promise<GatewayWorkspaceScope | null> {
  const ownerUid = (await state.workspaces.records.get(workspaceSlug))?.ownerUid;
  if (!ownerUid) return null;
  return currentOwnerScope(state, authorization.gateway.gatewayId, workspaceSlug, ownerUid);
}

export async function workspaceScopeFor(
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string | null | undefined,
  state: PlatformStateRepositories,
  requireCurrentOwnerAssignment = false,
): Promise<GatewayWorkspaceScope | null> {
  if (!workspaceSlug) return null;
  if (isSharedGateway(authorization)) {
    return sharedGatewayWorkspaceScope(authorization, workspaceSlug, state);
  }
  if (!requireCurrentOwnerAssignment) {
    const ownerUid = authorization.config.ownerUid;
    return ownerUid && authorization.config.builderSlug === workspaceSlug
      ? { gatewayId: authorization.gateway.gatewayId, workspaceSlug, ownerUid }
      : null;
  }
  return privateGatewayWorkspaceScope(authorization, workspaceSlug, state);
}

export async function principalAccess(
  scope: GatewayWorkspaceScope,
  uid: string,
  state: PlatformStateRepositories,
  ownerSizingKey: GatewayOwnerSizingKey | null,
): Promise<GatewayPrincipalAccess> {
  const { gatewayId, workspaceSlug, ownerUid } = scope;
  if (ownerUid === uid) return resolveGatewayPrincipalAccess({ gateway: scope, uid, membership: null });
  const [membership, workspace, root, owner] = await Promise.all([
    state.workspaces.members.get(workspaceSlug, uid),
    state.workspaces.records.get(workspaceSlug),
    state.gateways.roots.get(gatewayId),
    state.users.records.get(ownerUid),
  ]);
  const authorization = root ? gatewayAuthorizationFromRootDocument(rootDocument(root), gatewayId) : null;
  return resolveGatewayPrincipalAccess({
    gateway: { gatewayId, ownerUid, workspaceSlug,
      perUserIdentity: workspace?.ownerUid === ownerUid && authorization !== null &&
        ownerWorkspacePermissionsEnabled(authorization.config, ownerSizingKey, owner),
    },
    uid,
    membership,
  });
}

interface IsolatedGatewayCandidate {
  root: Stored<GatewayRoot>;
  workspaceSlug: string | null;
}

async function teamGatewayCandidate(workspaceSlug: string): Promise<IsolatedGatewayCandidate | null> {
  const workspace = await platformStateStore.workspaces.records.get(workspaceSlug);
  if (!workspace) return null;
  const owner = await platformStateStore.users.records.get(workspace.ownerUid);
  const gatewayId = owner?.gateway?.gatewayId;
  if (!gatewayId || !userAssignedTo(owner, gatewayId, workspaceSlug)) return null;
  const root = await platformStateStore.gateways.roots.get(gatewayId);
  return root ? { root, workspaceSlug } : null;
}

async function isolatedGatewayCandidates(uid: string): Promise<IsolatedGatewayCandidate[]> {
  const [user, owned, memberships] = await Promise.all([
    platformStateStore.users.records.get(uid),
    platformStateStore.gateways.roots.list({ ownerUid: uid }),
    platformStateStore.workspaces.members.listForUid(uid),
  ]);
  const teamRoots = await Promise.all(memberships.map((member) =>
    isCanonicalWorkspaceMembership(member) ? teamGatewayCandidate(member.workspaceSlug) : null));
  const selfGatewayId = user?.gateway?.gatewayId;
  const selfWorkspaceSlug = user?.slug;
  const assignedRoot = selfGatewayId && selfWorkspaceSlug
    ? await platformStateStore.gateways.roots.get(selfGatewayId)
    : null;
  return [
    ...owned.map((root) => ({ root, workspaceSlug: root.builderSlug })),
    ...(assignedRoot && selfWorkspaceSlug ? [{ root: assignedRoot, workspaceSlug: selfWorkspaceSlug }] : []),
    ...teamRoots.filter((item): item is IsolatedGatewayCandidate => item !== null),
  ];
}

async function isolatedGatewayEntry(
  uid: string,
  candidate: IsolatedGatewayCandidate,
): Promise<{ scopeKey: string; entry: GatewayControlListEntry } | null> {
  const authorization = gatewayAuthorizationFromRootDocument(rootDocument(candidate.root), candidate.root.gatewayId);
  if (!authorization) return null;
  const scope = await workspaceScopeFor(authorization, candidate.workspaceSlug, platformStateStore);
  if (!scope) return null;
  const access = await withGatewayOwnerSizingKey(
    { store: platformStateStore, readSizingKey, ownerUid: perUserOwnerUid(authorization), now: Date.now() },
    (ownerSizingKey) => principalAccess(scope, uid, platformStateStore, ownerSizingKey),
  );
  if (access.kind === "denied") return null;
  const [artifact, runtime, owner] = await Promise.all([
    readGatewayArtifactInStore(platformStateStore, authorization.gateway.gatewayId, authorization.gateway.liveRelease),
    readGatewayRuntimeDoc(platformStateStore, authorization.gateway),
    platformStateStore.users.records.get(scope.ownerUid),
  ]);
  const heartbeat = gatewayRuntimeHeartbeatOf(runtime, authorization.gateway);
  const isCurrentAssignment = userAssignedTo(owner, authorization.gateway.gatewayId, scope.workspaceSlug);
  return {
    scopeKey: `${scope.gatewayId}\0${scope.workspaceSlug}`,
    entry: await userViewOf({
      authorization,
      scope,
      access,
      imageTag: artifact?.imageTag,
      heartbeat,
      runtime,
      isCurrentAssignment,
    }),
  };
}

async function isolatedGatewaysFor(uid: string): Promise<GatewayControlListEntry[]> {
  const seen = new Set<string>();
  const entries: GatewayControlListEntry[] = [];
  for (const candidate of await isolatedGatewayCandidates(uid)) {
    const result = await isolatedGatewayEntry(uid, candidate);
    if (!result || seen.has(result.scopeKey)) continue;
    seen.add(result.scopeKey);
    entries.push(result.entry);
  }
  return entries.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId) ||
    a.workspaceSlug.localeCompare(b.workspaceSlug));
}

function registerGatewayListRoute(router: Router): void {
  router.get("/gateways/me", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: GatewayControlListResponse = { gateways: await isolatedGatewaysFor(req.uid!) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
}

function apiOrigin(): string {
  const configured = process.env.API_PUBLIC_URL?.trim();
  if (!configured) throw new Error("API_PUBLIC_URL is required for OpenClaw Dashboard launch URLs");
  return configured.replace(/\/$/u, "");
}

type TicketResult =
  | { kind: typeof NOT_FOUND }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof NOT_READY }
  | { kind: "minted"; minted: ReturnType<typeof createOpenClawControlTicket> };

function controlUiAccess(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  access: GatewayPrincipalAccess,
): "allowed" | typeof NOT_FOUND | typeof CAPABILITY_DISABLED {
  if (access.kind === "denied" || !access.dashboard) return NOT_FOUND;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(
    gatewayClass,
    authorization.config.builderAccess ?? undefined,
  ) ? "allowed" : CAPABILITY_DISABLED;
}

async function recordAccessDenial(
  state: PlatformStateRepositories,
  scope: GatewayWorkspaceScope,
  uid: string,
  principal: GatewayPrincipalAccess,
): Promise<void> {
  await state.access.accessAudit.record({
    at: Date.now(),
    gatewayId: scope.gatewayId,
    uid,
    reason: principal.kind === "denied" ? principal.reason : "permission_required",
    detail: {
      workspaceSlug: scope.workspaceSlug,
      ownerUid: scope.ownerUid,
      actorUid: uid,
      source: "system",
    },
  });
}

function requestedWorkspaceSlug(
  req: Request,
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
): string | null {
  const requested = req.query.workspaceSlug;
  if (typeof requested === "string" && requested.length > 0) return requested;
  return isSharedGateway(authorization) ? null : authorization.config.builderSlug;
}

function servingRevisionId(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
): string | null {
  const { gateway } = authorization;
  if (gateway.desiredStatus !== "running" ||
    typeof gateway.liveRelease !== "number") return null;
  return gateway.gatewayId;
}

async function openClawControlRuntimeReachable(
  authorization: DurableGatewayAuthorization,
  runtime: unknown,
  state: PlatformStateRepositories,
): Promise<boolean> {
  const revisionId = servingRevisionId(authorization);
  if (!revisionId) return false;
  const { gateway } = authorization;
  if (gateway.desiredRelease !== gateway.liveRelease) {
    const ownerUid = authorization.config.ownerUid;
    if (!ownerUid) return false;
    if ((await state.gateways.assignments.get(gateway.gatewayId, ownerUid))?.state !== "serving") return false;
  }
  if (!await isOpenClawControlServingRevision(gateway, runtime, {
    gatewayId: gateway.gatewayId, revisionId,
    readArtifact: (release) => readGatewayArtifactInStore(state, gateway.gatewayId, release),
  })) return false;
  return isOpenClawControlRevisionRuntimeReady(runtime, {
    gatewayId: authorization.gateway.gatewayId,
    revisionId,
  });
}

/** Every condition `mintOpenClawTicket` would reject on, answered from the list. */
async function openClawControlReachable(input: {
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>;
  runtime: unknown;
  controlUiEnabled: boolean;
  isCurrentAssignment: boolean;
}): Promise<boolean> {
  return input.controlUiEnabled &&
    input.isCurrentAssignment &&
    await openClawControlRuntimeReachable(input.authorization, input.runtime, platformStateStore);
}

async function mintOpenClawTicket(
  store: PlatformStateStore,
  gatewayId: string,
  workspaceSlug: string,
  uid: string,
  ownerSizingKey: GatewayOwnerSizingKey | null,
): Promise<TicketResult> {
  return store.transaction({ label: "builder-gateways.openclaw-ticket" }, async (tx) => {
    const serving = await readGatewayAuthorizationInStore(tx, gatewayId);
    if (!serving) return { kind: NOT_READY };
    const scope = await workspaceScopeFor(serving, workspaceSlug, tx, true);
    if (!scope) return { kind: NOT_FOUND };
    const principal = await principalAccess(scope, uid, tx, ownerSizingKey);
    if (principal.kind === "denied") {
      await recordAccessDenial(tx, scope, uid, principal);
      return { kind: NOT_FOUND };
    }
    const access = controlUiAccess(serving, principal);
    if (access !== "allowed") return { kind: access };
    const revisionId = servingRevisionId(serving);
    if (!revisionId) return { kind: NOT_READY };
    const runtime = await readGatewayRuntimeDoc(tx, serving.gateway);
    if (!await openClawControlRuntimeReachable(serving, runtime, tx)) return { kind: NOT_READY };
    const minted = createOpenClawControlTicket({
      uid,
      gatewayId,
      workspaceSlug: scope.workspaceSlug,
      revisionId,
    });
    await tx.access.controlTickets.create({
      ticketHash: minted.ticketHash,
      uid,
      gatewayId,
      createdAt: { serverNow: true },
      expiresAt: minted.document.expiresAt,
      redeemedAt: null,
      grant: { workspaceSlug: minted.document.workspaceSlug, revisionId: minted.document.revisionId },
    });
    return { kind: "minted" as const, minted };
  });
}

interface TicketResponse {
  status: number;
  body: Record<string, unknown>;
}

const TICKET_NOT_FOUND: TicketResponse = { status: 404, body: { error: "not-found" } };
const TICKET_CAPABILITY_DISABLED: TicketResponse = { status: 403, body: { error: CAPABILITY_DISABLED } };

async function openClawReleaseRefusal(
  req: Request,
  authorization: DurableGatewayAuthorization,
  scope: GatewayWorkspaceScope,
  featurePolicy: FeaturePolicy | undefined,
): Promise<TicketResponse | null> {
  if (!featurePolicy) return null;
  const subject: FeatureSubject = {
    uid: req.uid!,
    isAdmin: req.isAdmin === true,
    workspaceSlug: scope.workspaceSlug,
    gatewayClass: resolveGatewayClass({
      gatewayClass: authorization.config.gatewayClass,
      profile: authorization.config.profile ?? undefined,
      imageProfile: authorization.config.imageProfile,
    }),
    ...(authorization.config.profile ? { gatewayProfile: authorization.config.profile } : {}),
  };
  const decision = await featurePolicy.evaluate(
    "release-openclaw-dashboard",
    subject,
    "openclaw-dashboard",
  );
  if (decision.state === "disabled") return { status: 404, body: { error: "feature_unavailable" } };
  if (decision.state === "unavailable") return { status: 503, body: { error: "feature_evaluation_unavailable" } };
  return null;
}

async function scopedOpenClawTicket(
  req: Request,
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string,
  ownerSizingKey: GatewayOwnerSizingKey | null,
  featurePolicy: FeaturePolicy | undefined,
): Promise<TicketResponse> {
  const uid = req.uid!;
  const { gatewayId } = authorization.gateway;
  const scope = await workspaceScopeFor(authorization, workspaceSlug, platformStateStore, true);
  if (!scope) return TICKET_NOT_FOUND;
  const principal = await principalAccess(scope, uid, platformStateStore, ownerSizingKey);
  const access = controlUiAccess(authorization, principal);
  if (access === NOT_FOUND) {
    await recordAccessDenial(platformStateStore, scope, uid, principal);
    return TICKET_NOT_FOUND;
  }
  if (access === CAPABILITY_DISABLED) return TICKET_CAPABILITY_DISABLED;
  const refusal = await openClawReleaseRefusal(req, authorization, scope, featurePolicy);
  if (refusal) return refusal;
  const result = await mintOpenClawTicket(platformStateStore, gatewayId, scope.workspaceSlug, uid, ownerSizingKey);
  if (result.kind === NOT_FOUND) return TICKET_NOT_FOUND;
  if (result.kind === CAPABILITY_DISABLED) return TICKET_CAPABILITY_DISABLED;
  if (result.kind === NOT_READY) return { status: 409, body: { error: "gateway-not-ready", retryable: true } };
  return {
    status: 201,
    body: {
      launchUrl: openClawLaunchUrl(gatewayId, result.minted.ticket),
      expiresAt: result.minted.document.expiresAt,
    },
  };
}

function openClawLaunchUrl(gatewayId: string, ticket: string): string {
  return `${apiOrigin()}/g/${gatewayId}/openclaw/launch/${ticket}`;
}

export type OwnerControlUiLaunch =
  | { kind: "launch"; launchUrl: string; expiresAt: number }
  | { kind: "no-gateway" }
  | { kind: "shared-gateway" }
  | { kind: "not-owner" }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof NOT_READY };

export async function mintOwnerControlUiLaunch(
  store: PlatformStateStore,
  uid: string,
): Promise<OwnerControlUiLaunch> {
  const user = await store.users.records.get(uid);
  const gatewayId = user?.gateway?.gatewayId;
  if (!user?.slug || !gatewayId) return { kind: "no-gateway" };
  const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
  if (!authorization) return { kind: NOT_READY };
  if (isSharedGateway(authorization)) return { kind: "shared-gateway" };
  if (authorization.config.ownerUid !== uid) return { kind: "not-owner" };
  const result = await mintOpenClawTicket(store, gatewayId, user.slug, uid, null);
  if (result.kind === NOT_FOUND) return { kind: "not-owner" };
  if (result.kind !== "minted") return { kind: result.kind };
  return {
    kind: "launch",
    launchUrl: openClawLaunchUrl(gatewayId, result.minted.ticket),
    expiresAt: result.minted.document.expiresAt,
  };
}

async function openClawTicketResponse(
  req: Request,
  gatewayId: unknown,
  featurePolicy: FeaturePolicy | undefined,
): Promise<TicketResponse> {
  if (!isValidGatewayId(gatewayId)) return TICKET_NOT_FOUND;
  const authorization = await readGatewayAuthorizationInStore(platformStateStore, gatewayId);
  if (!authorization) return TICKET_NOT_FOUND;
  const workspaceSlug = requestedWorkspaceSlug(req, authorization);
  if (!workspaceSlug) return TICKET_NOT_FOUND;
  return withGatewayOwnerSizingKey(
    { store: platformStateStore, readSizingKey, ownerUid: perUserOwnerUid(authorization), now: Date.now() },
    (ownerSizingKey) => scopedOpenClawTicket(req, authorization, workspaceSlug, ownerSizingKey, featurePolicy),
  );
}

function registerOpenClawTicketRoute(router: Router, featurePolicy: FeaturePolicy | undefined): void {
  router.post(
    "/gateways/:gatewayId/openclaw-ticket",
    openClawTicketRateLimit,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { status, body } = await openClawTicketResponse(req, req.params.gatewayId, featurePolicy);
        res.status(status).json(body);
      } catch (err) {
        next(err);
      }
    },
  );
}

export function createIsolatedGatewayRoutes({ featurePolicy }: { featurePolicy?: FeaturePolicy } = {}): Router {
  const router = Router();
  router.use(authenticationFailureLimit, requireAuth);
  router.use(["/gateways/me", "/workspaces/gateway-status"], authenticatedRequestLimit(120));
  registerGatewayListRoute(router);
  registerWorkspaceGatewayStatusRoute(router);
  registerOpenClawTicketRoute(router, featurePolicy);
  return router;
}

export default createIsolatedGatewayRoutes();
