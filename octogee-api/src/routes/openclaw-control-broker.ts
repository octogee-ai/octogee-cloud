import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";

import {
  withCurrentSizingKey,
  type SizingKeyReader,
  type CurrentSizingKey,
} from "@octogee/core/user-activation-lease";
import { gatewayAuthorizationFromRootDocument, readGatewayArtifactInStore } from "@octogee/core/gateway-live-release";
import {
  inspectOpenClawControlTicket,
  openClawControlTicketHash,
  type OpenClawControlTicketInspection,
} from "@octogee/core/openclaw-control-tickets";
import { isOpenClawControlRevisionRuntimeReady, isOpenClawControlServingRevision } from "@octogee/core/openclaw-control-runtime-ready";
import {
  resolveGatewayPrincipalAccess,
  type GatewayPrincipalAccess,
  type ResolvedGatewayAccess,
} from "@octogee/core/gateway-principal-access";
import type {
  PlatformUserRecord,
  ControlSession as StoredControlSession,
  ControlSessionChecks,
  ControlTicket,
  FleetRegistryRecord,
  GatewayRoot,
  PlatformStateStore,
  PlatformStateTransaction,
  Revision,
  Stored,
} from "@octogee/core/platform-state";
import type { AssignmentState } from "@octogee/shared/types/gateway-releases";
import { isGatewayClassControlUiAccessEnabled, resolveGatewayClass } from "@octogee/shared/types/glm";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

export const OPENCLAW_CONTROL_SESSION_TTL_MS = 60 * 60_000;
export const OPENCLAW_CONTROL_REQUEST_MAX_BYTES = 16 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITY_DISABLED = "capability-disabled";
const INVALID_REQUEST = "invalid-request";
const SESSION_INVALID = "session-invalid";
const ASSIGNMENT_MISSING = "assignment-missing";
const WORKSPACE_NOT_SERVING = "workspace-not-serving";
const MOVING_ASSIGNMENT_STATES = new Set<unknown>(["quiescing", "migrating"]);

interface ControlSession {
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  revisionId: string;
  expiresAt: number;
}

type SessionAccess =
  | { kind: "allowed"; session: ControlSession }
  | { kind: typeof SESSION_INVALID }
  | { kind: "capability-disabled" }
  | { kind: typeof ASSIGNMENT_MISSING }
  | { kind: typeof WORKSPACE_NOT_SERVING }
  | { kind: "not-ready" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function requestFits(req: Request): boolean {
  const encoded = JSON.stringify(req.body ?? null);
  return Buffer.byteLength(encoded, "utf8") <= OPENCLAW_CONTROL_REQUEST_MAX_BYTES;
}

function authenticatedGateway(req: Request): { bound: GatewayBinding; revisionId: string } | null {
  const bound = req.boundTenant;
  const revisionId = bound?.kind === "gateway"
    ? revisionIdFromGatewayPodName(bound.gatewayId, bound.podName)
    : null;
  return bound?.kind === "gateway" && revisionId ? { bound, revisionId } : null;
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const body = record(req.body);
  const authenticated = authenticatedGateway(req);
  const claimedGateway = boundedString(body?.gatewayId, 32);
  const claimedRevision = boundedString(body?.revisionId, 64);
  if (
    !authenticated ||
    claimedGateway !== authenticated.bound.gatewayId ||
    !claimedRevision ||
    claimedRevision !== authenticated.revisionId
  ) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return authenticated.bound;
}

function controlUiAuthorization(
  root: unknown,
  gatewayId: string,
  access: ResolvedGatewayAccess,
) {
  const authorization = gatewayAuthorizationFromRootDocument(root, gatewayId);
  if (!authorization) return null;
  const config = authorization.config;
  if (!access.dashboard) return null;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: config.profile ?? undefined,
    imageProfile: config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(gatewayClass, config.builderAccess ?? undefined)
    ? authorization
    : null;
}
interface ScopedPrincipalAccess {
  scope: { gatewayId: string; workspaceSlug: string; ownerUid: string; perUserIdentity: boolean };
  principal: GatewayPrincipalAccess | null;
  assignmentMissing: boolean;
  assignmentState: AssignmentState | undefined;
}

type GatewayRootAuthorization = NonNullable<ReturnType<typeof gatewayAuthorizationFromRootDocument>>;

interface OwnerSizingKey extends CurrentSizingKey {
  readonly uid: string;
}

interface PrincipalReadArgs {
  tx: PlatformStateTransaction;
  gatewayId: string;
  workspaceSlug: string;
  uid: string;
  ownerSizingKey: OwnerSizingKey | null;
}

function perUserControlIdentity(config: GatewayRootAuthorization["config"]): boolean {
  return config.gatewayClass === "isolated" && config.builderAccess?.controlIdentity === "per-user";
}

function perUserIdentityEnabled(
  config: GatewayRootAuthorization["config"],
  ownerSizingKey: OwnerSizingKey | null,
  owner: Stored<PlatformUserRecord> | null,
): boolean {
  if (!perUserControlIdentity(config) || ownerSizingKey === null || ownerSizingKey.uid !== owner?.uid) return false;
  ownerSizingKey.assertCurrent(owner);
  return ownerSizingKey.sizingKey !== null;
}

function rootDocument(root: Stored<GatewayRoot> | null): Record<string, unknown> | undefined {
  if (root === null) return undefined;
  const { revision: _revision, ...document } = root;
  return document;
}

function registryRuntimeDocument(runtime: Stored<FleetRegistryRecord> | null): Record<string, unknown> | undefined {
  if (runtime === null) return undefined;
  const { revision: _revision, ...record } = runtime;
  return { docKind: "runtime", ...record };
}

async function revisionRuntime(
  tx: PlatformStateTransaction,
  gatewayId: string,
  revisionId: string,
): Promise<Record<string, unknown> | undefined> {
  return revisionId === gatewayId ? registryRuntimeDocument(await tx.fleetRegistry.get(gatewayId)) : undefined;
}

async function storedOwnerScope(
  args: PrincipalReadArgs,
  authorization: GatewayRootAuthorization,
): Promise<Omit<ScopedPrincipalAccess, "principal"> | null> {
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  if (gatewayClass !== "shared" && authorization.config.builderSlug !== args.workspaceSlug) {
    return null;
  }
  const workspace = await args.tx.workspaces.records.get(args.workspaceSlug);
  const ownerUid = gatewayClass === "shared"
    ? workspace?.ownerUid
    : authorization.config.ownerUid;
  if (typeof ownerUid !== "string" || !ownerUid) return null;
  const [owner, assignment] = await Promise.all([
    args.tx.users.records.get(ownerUid),
    args.tx.gateways.assignments.get(args.gatewayId, ownerUid),
  ]);
  const scope = { gatewayId: args.gatewayId, workspaceSlug: args.workspaceSlug, ownerUid,
    perUserIdentity: workspace?.ownerUid === ownerUid &&
      perUserIdentityEnabled(authorization.config, args.ownerSizingKey, owner),
  };
  return {
    scope,
    assignmentState: assignment?.state,
    assignmentMissing: owner === null ||
      owner.gateway?.gatewayId !== args.gatewayId ||
      owner.slug !== args.workspaceSlug,
  };
}

async function storedMemberPrincipal(
  args: PrincipalReadArgs,
  scope: ScopedPrincipalAccess["scope"],
): Promise<GatewayPrincipalAccess> {
  const membership = await args.tx.workspaces.members.get(scope.workspaceSlug, args.uid);
  return resolveGatewayPrincipalAccess({ gateway: scope, uid: args.uid, membership });
}

async function storedPrincipalAccess(
  args: PrincipalReadArgs & { root: Record<string, unknown> | undefined },
): Promise<ScopedPrincipalAccess | null> {
  const authorization = gatewayAuthorizationFromRootDocument(args.root, args.gatewayId);
  if (!authorization) return null;
  const storedScope = await storedOwnerScope(args, authorization);
  if (!storedScope) return null;
  if (storedScope.assignmentMissing) {
    return { ...storedScope, principal: null };
  }
  if (storedScope.scope.ownerUid === args.uid) {
    const principal = resolveGatewayPrincipalAccess({
      gateway: storedScope.scope,
      uid: args.uid,
      membership: null,
    });
    return principal.kind === "denied"
      ? null
      : { ...storedScope, principal };
  }
  const principal = await storedMemberPrincipal(args, storedScope.scope);
  return { ...storedScope, principal };
}

async function auditPrincipalDenial(args: {
  tx: PlatformStateTransaction;
  scope: ScopedPrincipalAccess["scope"];
  uid: string;
  principal: GatewayPrincipalAccess;
  now: number;
}): Promise<void> {
  if (args.uid === args.scope.ownerUid) return;
  await args.tx.access.accessAudit.record({
    at: args.now,
    gatewayId: args.scope.gatewayId,
    uid: args.uid,
    reason: args.principal.kind === "denied" ? args.principal.reason : "binding_changed",
    detail: {
      workspaceSlug: args.scope.workspaceSlug,
      ownerUid: args.scope.ownerUid,
      actorUid: args.uid,
      source: "system",
    },
  });
}

export function openClawControlSessionHash(sessionId: string): string {
  return createHash("sha256").update("openclaw-control-session\0").update(sessionId).digest("hex");
}

function sessionDocument(session: StoredControlSession): Record<string, unknown> {
  return { ...session.grant, uid: session.uid, gatewayId: session.gatewayId, expiresAt: session.expiresAt };
}

function parseSession(
  value: unknown,
  gatewayId: string,
  revisionId: string,
  now: number,
): ControlSession | null {
  const item = record(value);
  if (!item) return null;
  const uid = boundedString(item.uid, 128);
  const workspaceSlug = boundedString(item.workspaceSlug, 128);
  if (
    !uid ||
    !workspaceSlug ||
    item.gatewayId !== gatewayId ||
    item.revisionId !== revisionId ||
    typeof item.expiresAt !== "number" ||
    !Number.isFinite(item.expiresAt) ||
    item.expiresAt <= now
  ) {
    return null;
  }
  return {
    uid,
    gatewayId,
    workspaceSlug,
    revisionId,
    expiresAt: item.expiresAt,
  };
}

async function auditStoredPrincipalDenial(
  tx: PlatformStateTransaction,
  stored: ScopedPrincipalAccess | null,
  uid: string,
  now: number,
): Promise<void> {
  if (stored?.principal) await auditPrincipalDenial({ tx, scope: stored.scope, uid, principal: stored.principal, now });
}

interface ControlSessionAccessArgs {
  gatewayId: string;
  revisionId: string;
  sessionHash: string;
  sessionRevision: Revision;
  ownerSizingKey: OwnerSizingKey | null;
  now: number;
}

async function sessionAccessInTransaction(
  tx: PlatformStateTransaction,
  args: ControlSessionAccessArgs,
): Promise<SessionAccess> {
  const [storedRoot, revision, storedSession] = await Promise.all([
    tx.gateways.roots.get(args.gatewayId),
    revisionRuntime(tx, args.gatewayId, args.revisionId),
    tx.access.controlSessions.get(args.sessionHash),
  ]);
  const session = storedSession?.revision === args.sessionRevision
    ? parseSession(sessionDocument(storedSession), args.gatewayId, args.revisionId, args.now)
    : null;
  if (!session) return { kind: SESSION_INVALID };
  const root = rootDocument(storedRoot);
  const stored = await storedPrincipalAccess({
    tx,
    root,
    gatewayId: args.gatewayId,
    workspaceSlug: session.workspaceSlug,
    uid: session.uid,
    ownerSizingKey: args.ownerSizingKey,
  });
  if (stored?.assignmentMissing) return { kind: ASSIGNMENT_MISSING };
  const principal = stored?.principal;
  if (!stored || !principal || principal.kind === "denied") {
    await auditStoredPrincipalDenial(tx, stored, session.uid, args.now);
    return { kind: CAPABILITY_DISABLED };
  }
  const authorization = controlUiAuthorization(root, args.gatewayId, principal);
  if (!authorization) return { kind: CAPABILITY_DISABLED };
  if (MOVING_ASSIGNMENT_STATES.has(stored.assignmentState)) {
    return { kind: WORKSPACE_NOT_SERVING };
  }
  if (stored.assignmentState !== "serving" || !await isOpenClawControlServingRevision(root, revision, {
    gatewayId: args.gatewayId, revisionId: args.revisionId, now: args.now,
    readArtifact: (release) => readGatewayArtifactInStore(tx, args.gatewayId, release),
  })) {
    return { kind: "not-ready" };
  }
  return { kind: "allowed", session };
}

function sendSessionAccessFailure(result: Exclude<SessionAccess, { kind: "allowed" }>, res: Response): void {
  if (result.kind === SESSION_INVALID) {
    res.status(404).json({ error: SESSION_INVALID });
  } else if (result.kind === CAPABILITY_DISABLED || result.kind === WORKSPACE_NOT_SERVING) {
    res.status(403).json({ error: result.kind });
  } else if (result.kind === ASSIGNMENT_MISSING) {
    res.status(403).json({ error: ASSIGNMENT_MISSING });
  } else {
    res.status(409).json({ error: "gateway-not-ready", retryable: true });
  }
}

interface BrokerContext {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  sessionChecks: ControlSessionChecks;
  now: () => number;
}

async function withOwnerSizingKey<T>(
  context: BrokerContext,
  gatewayId: string,
  now: number,
  run: (ownerSizingKey: OwnerSizingKey | null) => Promise<T>,
): Promise<T> {
  const authorization = gatewayAuthorizationFromRootDocument(rootDocument(await context.store.gateways.roots.get(gatewayId)), gatewayId);
  const uid = authorization && perUserControlIdentity(authorization.config) ? authorization.config.ownerUid : null;
  if (!uid) return run(null);
  return withCurrentSizingKey(
    { store: context.store, readSizingKey: context.readSizingKey, uid, now },
    (current) => run({ ...current, uid }),
  );
}

async function resolveSessionAccess(
  context: BrokerContext,
  input: { gatewayId: string; revisionId: string; sessionHash: string },
): Promise<SessionAccess> {
  const now = context.now();
  const stored = await context.store.access.controlSessions.get(input.sessionHash);
  const session = stored ? parseSession(sessionDocument(stored), input.gatewayId, input.revisionId, now) : null;
  if (!stored || !session) return { kind: SESSION_INVALID };
  if (stored.attachmentId !== null && !await context.sessionChecks.current({
    uid: session.uid,
    gatewayId: input.gatewayId,
    workspaceSlug: session.workspaceSlug,
    attachmentId: stored.attachmentId,
  }, now)) return { kind: SESSION_INVALID };
  return withOwnerSizingKey(context, input.gatewayId, now, (ownerSizingKey) =>
    context.store.transaction({ label: "openclaw-control-broker.session-access" }, (tx) =>
      sessionAccessInTransaction(tx, { ...input, sessionRevision: stored.revision, ownerSizingKey, now })));
}

type AuthenticatedGateway = NonNullable<ReturnType<typeof authenticatedGateway>>;
type RedeemableTicket = Extract<OpenClawControlTicketInspection, { kind: "redeemable" }>;

interface RedeemAttempt {
  authenticated: AuthenticatedGateway;
  ticketHash: string;
  sessionHash: string;
  attemptAt: number;
}

type RedeemResult =
  | { kind: "ticket-invalid" }
  | { kind: "session-conflict" }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof ASSIGNMENT_MISSING }
  | { kind: typeof WORKSPACE_NOT_SERVING }
  | { kind: "not-ready" }
  | { kind: "redeemed"; redeemed: RedeemableTicket; expiresAt: number };

function rejectRedeemAttempt(
  res: Response,
  rejection: { status: number; error: string },
): null {
  res.status(rejection.status).json({ error: rejection.error });
  return null;
}

function parseRedeemPayload(
  body: Record<string, unknown> | null,
  ticket: string | null,
  ticketHash: string | undefined,
): { sessionId: string; ticketHash: string } | null {
  if (
    body === null ||
    !exactKeys(body, ["gatewayId", "revisionId", "sessionId", "ticket"]) ||
    !validSessionId(body.sessionId) ||
    ticket === null ||
    ticketHash === undefined
  ) {
    return null;
  }
  return { sessionId: body.sessionId, ticketHash };
}

function validateRedeemAttempt(
  context: BrokerContext,
  req: Request,
  res: Response,
): RedeemAttempt | null {
  const authenticated = authenticatedGateway(req);
  if (!authenticated) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  const body = record(req.body);
  const claimedGateway = boundedString(body?.gatewayId, 32);
  const claimedRevision = boundedString(body?.revisionId, 64);
  const ticket = boundedString(body?.ticket, 256);
  const ticketHash = ticket ? openClawControlTicketHash(ticket) : undefined;
  const attemptAt = context.now();
  if (!requestFits(req)) {
    return rejectRedeemAttempt(res, { status: 413, error: "request-too-large" });
  }
  if (!claimedGateway || !claimedRevision) {
    return rejectRedeemAttempt(res, { status: 403, error: "forbidden" });
  }
  if (claimedGateway !== authenticated.bound.gatewayId) {
    return rejectRedeemAttempt(res, { status: 403, error: "forbidden" });
  }
  if (claimedRevision !== authenticated.revisionId) {
    return rejectRedeemAttempt(res, { status: 403, error: "forbidden" });
  }
  const payload = parseRedeemPayload(body, ticket, ticketHash);
  if (!payload) {
    return rejectRedeemAttempt(res, { status: 400, error: INVALID_REQUEST });
  }
  return {
    authenticated,
    ticketHash: payload.ticketHash,
    sessionHash: openClawControlSessionHash(payload.sessionId),
    attemptAt,
  };
}

interface RedeemDocuments {
  root: Record<string, unknown> | undefined;
  revision: Record<string, unknown> | undefined;
  ticket: Record<string, unknown> | undefined;
  sessionExists: boolean;
}

function ticketDocument(ticket: ControlTicket | null): Record<string, unknown> | undefined {
  if (ticket === null) return undefined;
  return {
    ...ticket.grant,
    uid: ticket.uid,
    gatewayId: ticket.gatewayId,
    expiresAt: ticket.expiresAt,
    ...(ticket.redeemedAt === null ? {} : { redeemedAt: ticket.redeemedAt }),
  };
}

async function loadRedeemDocuments(
  tx: PlatformStateTransaction,
  attempt: RedeemAttempt,
): Promise<RedeemDocuments> {
  const gatewayId = attempt.authenticated.bound.gatewayId;
  const [root, revision, ticket, session] = await Promise.all([
    tx.gateways.roots.get(gatewayId),
    revisionRuntime(tx, gatewayId, attempt.authenticated.revisionId),
    tx.access.controlTickets.get(attempt.ticketHash),
    tx.access.controlSessions.get(attempt.sessionHash),
  ]);
  return {
    root: rootDocument(root),
    revision,
    ticket: ticketDocument(ticket),
    sessionExists: session !== null,
  };
}

function inspectRedeemDocuments(args: {
  attempt: RedeemAttempt;
  documents: RedeemDocuments;
}): RedeemableTicket | RedeemResult {
  const { attempt, documents } = args;
  const inspected = inspectOpenClawControlTicket({
    document: documents.ticket,
    gatewayId: attempt.authenticated.bound.gatewayId,
    revisionId: attempt.authenticated.revisionId,
    now: attempt.attemptAt,
  });
  if (inspected.kind === "rejected") return { kind: "ticket-invalid" };
  if (!documents.sessionExists) return inspected;
  return { kind: "session-conflict" };
}

async function rejectRedeemPrincipal(args: {
  attempt: RedeemAttempt;
  inspected: RedeemableTicket;
  principal: GatewayPrincipalAccess | null;
  scope: ScopedPrincipalAccess["scope"] | null;
  tx: PlatformStateTransaction;
}): Promise<RedeemResult> {
  if (args.principal && args.scope) {
    await auditPrincipalDenial({
      tx: args.tx,
      scope: args.scope,
      uid: args.inspected.uid,
      principal: args.principal,
      now: args.attempt.attemptAt,
    });
  }
  return { kind: CAPABILITY_DISABLED };
}

async function redeemPrincipalFailure(args: {
  attempt: RedeemAttempt;
  inspected: RedeemableTicket;
  root: Record<string, unknown> | undefined;
  ownerSizingKey: OwnerSizingKey | null;
  tx: PlatformStateTransaction;
}): Promise<RedeemResult | null> {
  const gatewayId = args.attempt.authenticated.bound.gatewayId;
  const stored = await storedPrincipalAccess({
    tx: args.tx,
    root: args.root,
    gatewayId,
    workspaceSlug: args.inspected.workspaceSlug,
    uid: args.inspected.uid,
    ownerSizingKey: args.ownerSizingKey,
  });
  if (stored?.assignmentMissing) {
    return { kind: ASSIGNMENT_MISSING };
  }
  const principal = stored?.principal ?? null;
  const assignmentState = stored?.assignmentState;
  const authorization = principal && principal.kind !== "denied"
    ? controlUiAuthorization(args.root, gatewayId, principal)
    : null;
  if (!authorization || !principal || principal.kind === "denied") {
    return rejectRedeemPrincipal({ ...args, principal, scope: stored?.scope ?? null });
  }
  if (MOVING_ASSIGNMENT_STATES.has(assignmentState)) {
    return { kind: WORKSPACE_NOT_SERVING };
  }
  if (assignmentState !== "serving") return { kind: "not-ready" };
  return null;
}

async function persistRedeemedSession(args: {
  attempt: RedeemAttempt;
  inspected: RedeemableTicket;
  tx: PlatformStateTransaction;
}): Promise<RedeemResult> {
  const { attempt, inspected, tx } = args;
  const expiresAt = attempt.attemptAt + OPENCLAW_CONTROL_SESSION_TTL_MS;
  await tx.access.controlTickets.markRedeemed(attempt.ticketHash, attempt.attemptAt, { redeemedAt: null });
  await tx.access.controlSessions.put({
    sessionHash: attempt.sessionHash,
    uid: inspected.uid,
    gatewayId: attempt.authenticated.bound.gatewayId,
    createdAt: attempt.attemptAt,
    expiresAt,
    attachmentId: null,
    grant: {
      workspaceSlug: inspected.workspaceSlug,
      revisionId: attempt.authenticated.revisionId,
    },
  });
  return { kind: "redeemed", redeemed: inspected, expiresAt };
}

async function applyRedeemAttempt(
  tx: PlatformStateTransaction,
  attempt: RedeemAttempt,
  ownerSizingKey: OwnerSizingKey | null,
): Promise<RedeemResult> {
  const documents = await loadRedeemDocuments(tx, attempt);
  const inspected = inspectRedeemDocuments({ attempt, documents });
  if (inspected.kind !== "redeemable") return inspected;
  const principalFailure = await redeemPrincipalFailure({
    attempt,
    inspected,
    root: documents.root,
    ownerSizingKey,
    tx,
  });
  if (principalFailure) return principalFailure;
  const identity = {
    gatewayId: attempt.authenticated.bound.gatewayId,
    revisionId: attempt.authenticated.revisionId,
    now: attempt.attemptAt,
  };
  if (!isOpenClawControlRevisionRuntimeReady(documents.revision, identity) ||
    !await isOpenClawControlServingRevision(documents.root, documents.revision, {
      ...identity,
      readArtifact: (release) => readGatewayArtifactInStore(tx, identity.gatewayId, release),
    })) return { kind: "not-ready" };
  return persistRedeemedSession({ attempt, inspected, tx });
}

async function redeemAttemptInTransaction(
  context: BrokerContext,
  attempt: RedeemAttempt,
): Promise<RedeemResult> {
  return withOwnerSizingKey(context, attempt.authenticated.bound.gatewayId, attempt.attemptAt, (ownerSizingKey) =>
    context.store.transaction({ label: "openclaw-control-broker.redeem" }, (tx) => applyRedeemAttempt(tx, attempt, ownerSizingKey)));
}

function sendRedeemResult(result: RedeemResult, res: Response): void {
  if (result.kind === "not-ready") {
    res.status(409).json({ error: "gateway-not-ready", retryable: true });
    return;
  }
  if (result.kind !== "redeemed") {
    res.status(404).json({ error: "ticket-invalid" });
    return;
  }
  res.json({ ...result.redeemed, expiresAt: result.expiresAt });
}

async function redeemControlTicket(
  context: BrokerContext,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const attempt = validateRedeemAttempt(context, req, res);
    if (!attempt) return;
    sendRedeemResult(await redeemAttemptInTransaction(context, attempt), res);
  } catch (err) {
    next(err);
  }
}

async function authorizeControlSession(
  context: BrokerContext,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!requestFits(req)) {
    res.status(413).json({ error: "request-too-large" });
    return;
  }
  const bound = boundGateway(req, res);
  if (!bound) return;
  const body = record(req.body);
  if (
    !body ||
    !exactKeys(body, ["gatewayId", "revisionId", "sessionId"]) ||
    !validSessionId(body.sessionId)
  ) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  const revisionId = body.revisionId as string;
  const sessionHash = openClawControlSessionHash(body.sessionId as string);
  try {
    const result = await resolveSessionAccess(context, { gatewayId: bound.gatewayId, revisionId, sessionHash });
    if (result.kind !== "allowed") {
      sendSessionAccessFailure(result, res);
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

function validProfileRequest(body: Record<string, unknown> | null): body is Record<string, unknown> {
  if (!body || !exactKeys(body, ["gatewayId", "revisionId", "sessionId", "channelId", "postId"]) || !validSessionId(body.sessionId)) return false;
  if (body.channelId === undefined && body.postId === undefined) return true;
  return typeof body.channelId === "string" && /^[a-z0-9]{26}$/u.test(body.channelId) &&
    typeof body.postId === "string" && /^[a-z0-9]{26}$/u.test(body.postId);
}

async function loadControlProfile(
  context: BrokerContext & {
    profile: import("../lib/openclaw-profile-appearance.js").OpenClawProfileAppearanceLoader;
    chatAuthor: import("../lib/openclaw-chat-author.js").OpenClawChatAuthorResolver;
  },
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("cache-control", "no-store");
  if (!requestFits(req)) {
    res.status(413).json({ error: "request-too-large" });
    return;
  }
  const bound = boundGateway(req, res);
  if (!bound) return;
  const body = record(req.body);
  if (!validProfileRequest(body)) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  const revisionId = body.revisionId as string;
  const sessionHash = openClawControlSessionHash(body.sessionId as string);
  try {
    const result = await resolveSessionAccess(context, { gatewayId: bound.gatewayId, revisionId, sessionHash });
    if (result.kind !== "allowed") {
      sendSessionAccessFailure(result, res);
      return;
    }
    let author: Awaited<ReturnType<typeof context.chatAuthor>> = null;
    if (typeof body.postId === "string") {
      author = await context.chatAuthor(result.session.uid, result.session.workspaceSlug, body.channelId as string, body.postId);
      if (!author) {
        res.status(204).end();
        return;
      }
    }
    const appearance = await context.profile(author?.uid ?? result.session.uid);
    res.json({ ...(author ? { author } : {}), displayName: appearance.displayName, avatar: appearance.avatar ? {
      revision: appearance.avatar.revision,
      avatarBase64: (await appearance.avatar.read()).toString("base64"),
    } : null });
  } catch (err) {
    next(err);
  }
}

interface MattermostBrokerDependencies {
  authorize: typeof import("../../../gateway-edge/src/lib/channel-session-authorization.js").authorizeChannelCredentials;
  listChannels: typeof import("../../../gateway-edge/src/lib/channel-session-authorization.js").listWorkspaceChannelCandidates;
}

const mattermostDefaults: MattermostBrokerDependencies = {
  authorize: async (...args) => (await import("../../../gateway-edge/src/lib/channel-session-authorization.js")).authorizeChannelCredentials(...args),
  listChannels: async (...args) => (await import("../../../gateway-edge/src/lib/channel-session-authorization.js")).listWorkspaceChannelCandidates(...args),
};

function validMattermostRequest(body: Record<string, unknown> | null, operation: "authorize" | "channels"): body is Record<string, unknown> {
  const keys = ["gatewayId", "revisionId", "sessionId"];
  if (operation === "authorize") keys.push("channelId", "requireActiveLedger");
  if (!body || !exactKeys(body, keys) || !validSessionId(body.sessionId)) return false;
  return operation === "channels" || (typeof body.channelId === "string" &&
    /^[a-z0-9]{26}$/u.test(body.channelId) &&
    (body.requireActiveLedger === undefined || typeof body.requireActiveLedger === "boolean"));
}

async function controlMattermostRequest(
  context: BrokerContext & { mattermost: MattermostBrokerDependencies; operation: "authorize" | "channels" },
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { mattermost, operation } = context;
  res.setHeader("cache-control", "no-store");
  if (!requestFits(req)) {
    res.status(413).json({ error: "request-too-large" });
    return;
  }
  const bound = boundGateway(req, res);
  if (!bound) return;
  const body = record(req.body);
  if (!validMattermostRequest(body, operation)) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  try {
    const access = await resolveSessionAccess(context, {
      gatewayId: bound.gatewayId,
      revisionId: body.revisionId as string,
      sessionHash: openClawControlSessionHash(body.sessionId as string),
    });
    if (access.kind !== "allowed") {
      sendSessionAccessFailure(access, res);
      return;
    }
    const signal = AbortSignal.timeout(5_000);
    const { uid, workspaceSlug } = access.session;
    if (operation === "channels") {
      res.json(await mattermost.listChannels(workspaceSlug, signal));
      return;
    }
    const channel = await mattermost.authorize(uid, body.channelId as string, workspaceSlug, {
      requireActiveLedger: body.requireActiveLedger === true, includeDefaultAgentConversation: true, signal,
    });
    if (!channel || channel.forbidden) {
      res.status(channel?.forbidden ? 403 : 404).json({ error: "channel-unavailable" });
      return;
    }
    res.json(channel);
  } catch (error) {
    next(error);
  }
}

function cacheProfileAvatars(
  load: import("../lib/openclaw-profile-appearance.js").OpenClawProfileAppearanceLoader,
): typeof load {
  const avatars = new Map<string, { revision: string; bytes: Buffer }>();
  return async (uid) => {
    const appearance = await load(uid);
    const avatar = appearance.avatar;
    if (!avatar) {
      avatars.delete(uid);
      return appearance;
    }
    return { ...appearance, avatar: { revision: avatar.revision, read: async () => {
      const cached = avatars.get(uid);
      const bytes = cached?.revision === avatar.revision ? cached.bytes : await avatar.read();
      avatars.delete(uid);
      avatars.set(uid, { revision: avatar.revision, bytes });
      if (avatars.size > 128) avatars.delete(avatars.keys().next().value!);
      return bytes;
    } } };
  };
}
export const NO_CONTROL_SESSION_ATTACHMENTS: ControlSessionChecks = {
  current: async () => false,
};

export function createOpenClawControlBrokerRoutes(args: {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  sessionChecks?: ControlSessionChecks;
  now?: () => number;
  mattermost?: MattermostBrokerDependencies;
  profile?: import("../lib/openclaw-profile-appearance.js").OpenClawProfileAppearanceLoader;
  chatAuthor?: import("../lib/openclaw-chat-author.js").OpenClawChatAuthorResolver;
}): Router {
  const router = Router();
  const context: BrokerContext = {
    store: args.store,
    readSizingKey: args.readSizingKey,
    sessionChecks: args.sessionChecks ?? NO_CONTROL_SESSION_ATTACHMENTS,
    now: args.now ?? Date.now,
  };
  router.post("/redeem", (req, res, next) => redeemControlTicket(context, req, res, next));
  router.post("/authorize", brokerRequestLimit(1800), (req, res, next) => authorizeControlSession(context, req, res, next));
  const profile = cacheProfileAvatars(args.profile ?? (async (uid) =>
    (await import("../lib/openclaw-profile-appearance.js")).loadOpenClawProfileAppearance(args.store, uid)));
  const chatAuthor = args.chatAuthor ?? (async (...params) =>
    (await import("../lib/openclaw-chat-author.js")).resolveOpenClawChatAuthor(args.store, ...params));
  router.post("/profile", (req, res, next) => loadControlProfile({ ...context, profile, chatAuthor }, req, res, next));
  for (const operation of ["authorize", "channels"] as const) {
    router.post(`/mattermost/${operation}`, (req, res, next) =>
      controlMattermostRequest({ ...context, mattermost: args.mattermost ?? mattermostDefaults, operation }, req, res, next));
  }
  return router;
}
