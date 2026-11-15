import { authenticationFailureLimit, authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import type { IncomingMessage } from "node:http";
import { Router, type NextFunction, type Request, type Response } from "express";
import { WebSocket, type RawData } from "ws";
import {
  WsUpgradeAuthorizationError,
  type WsUpgradeRouter,
} from "@octogee/core/ws/upgrade-router";
import { isPerUserControlIdentity } from "@octogee/shared/types/openclaw-proxy-identity";
import { requireAuthenticatedUid } from "@octogee/core/http/auth";
import { logger } from "@octogee/core/http/logging";
import type { NativeAdminAccess, NativeAdminAccessOutcome } from "../lib/native-admin-access.js";
import { WS_TICKET_TTL_MS, wsTicketFromPath, type WsTicketStore } from "../lib/ws-ticket-store.js";
import {
  authorizeSession,
  DEFAULT_SESSION_AUTHORIZATION_INTERVAL_MS,
  DEFAULT_SESSION_AUTHORIZATION_TIMEOUT_MS,
  monitorSessionAuthorization,
} from "../lib/ws-session-authorization.js";

import { WorkspaceNativeAccessError } from "../lib/workspace-native-access.js";
import { TerminalConversationScope, type TerminalConversation } from "./terminal-conversation.js";
import { openNativeUserSocket } from "../openclaw-control/native-user-client.js";
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export interface TerminalSession {
  conversation?: TerminalConversation;
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  reauthorize(): Promise<boolean>;
}

export function openTerminalUserSocket(session: TerminalSession, open = openNativeUserSocket): Promise<TerminalUpstream> {
  return open(session.uid, session.gatewayId, process.env, {
    ...(session.conversation ? { channelSessionKey: session.conversation.sessionKey } : {}),
  });
}

export function terminalAvailable(env: NodeJS.ProcessEnv): boolean {
  return isPerUserControlIdentity(env) && isIsolatedGatewayClassValue(env.GATEWAY_CLASS);
}

export interface TerminalRouterDeps {
  localGatewayId(): string | null;
  available: boolean;
  resolveAccess(input: { gatewayId: string; authorization: string | undefined }): Promise<NativeAdminAccessOutcome>;
  tickets: WsTicketStore<TerminalSession>;
  resolveChannel?(input: { uid: string; gatewayId: string; channelId: string }): Promise<TerminalConversation>;
}

type TerminalRequest = Request & { terminalAccess?: NativeAdminAccess };

function requestedGatewayId(req: Request): string | null {
  const gatewayId = (req.params as { gatewayId?: unknown }).gatewayId;
  return typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : null;
}

function requireTerminalAccess(deps: TerminalRouterDeps) {
  return async (req: TerminalRequest, res: Response, next: NextFunction): Promise<void> => {
    const gatewayId = requestedGatewayId(req);
    if (!deps.available || !gatewayId || gatewayId !== deps.localGatewayId()) {
      res.status(404).json({ error: "terminal_unavailable" });
      return;
    }
    let outcome: NativeAdminAccessOutcome;
    try {
      outcome = await deps.resolveAccess({ gatewayId, authorization: req.headers.authorization });
    } catch (err) {
      logger.warn("terminal access broker unavailable", { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ error: "access_unavailable" });
      return;
    }
    if (outcome.kind === "unauthenticated") {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (outcome.kind === "forbidden") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (outcome.kind === "not_found") {
      res.status(404).json({ error: "terminal_unavailable" });
      return;
    }
    req.terminalAccess = outcome;
    next();
  };
}

export function createTerminalRouter(deps: TerminalRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(30));
  router.use(requireTerminalAccess(deps));

  router.post("/ticket", async (req: TerminalRequest, res) => {
    try {
    if (!isMattermostPostId(req.body?.channelId) || Object.keys(req.body).some(key => key !== 'channelId')) { res.status(400).json({ error: "invalid_conversation" }); return; }
    const { channelId } = req.body;
    if (!deps.resolveChannel) { res.status(503).json({ error: "conversation_unavailable" }); return; }
    const { gatewayId, workspaceSlug } = req.terminalAccess!;
    const authorization = req.headers.authorization;
    const conversation = await deps.resolveChannel({ uid: req.uid!, gatewayId, channelId });
    const { ticket, expiresAt } = deps.tickets.issue({
      uid: req.uid!,
      gatewayId,
      workspaceSlug,
      ...(conversation ? { conversation } : {}),
      reauthorize: async () => {
        const current = await deps.resolveAccess({ gatewayId, authorization });
        if (current.kind !== "allowed" || current.gatewayId !== gatewayId || current.workspaceSlug !== workspaceSlug) return false;
        if (!conversation) return true;
        try {
          const next = await deps.resolveChannel!({ uid: req.uid!, gatewayId, channelId });
          return next.agentId === conversation.agentId && next.sessionKey === conversation.sessionKey;
        } catch (error) {
          if (error instanceof WorkspaceNativeAccessError && error.status < 500) return false;
          throw error;
        }
      },
    });
    res.status(200).set("cache-control", "no-store").json({
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInMs: WS_TICKET_TTL_MS,
    });
    } catch (error) {
      logger.warn("terminal conversation unavailable", { error: error instanceof Error ? error.message : String(error) });
      res.status(error instanceof WorkspaceNativeAccessError ? error.status : 503).json({ error: "conversation_unavailable" });
    }
  });

  return router;
}

export const TERMINAL_WS_PREFIX = "/terminal/ws/";

export function terminalTicketFromPath(pathname: string): string | null {
  return wsTicketFromPath(pathname, TERMINAL_WS_PREFIX);
}

export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["terminal.data", "terminal.exit"]);

const MAX_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_AGENT_ID_LENGTH = 256;
const MAX_INPUT_CHARS = 64 * 1024;
const MAX_TERMINAL_DIMENSION = 2000;
const MAX_BROWSER_FRAME_BYTES = 256 * 1024;
const MAX_QUEUED_FRAMES = 64;
const MAX_BROWSER_BUFFERED_BYTES = 8 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function dimension(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TERMINAL_DIMENSION;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const PARAM_VALIDATORS: Record<string, (params: Record<string, unknown>) => boolean> = {
  "terminal.open": (p) => exactKeys(p, ["cols", "rows", "agentId"]) && dimension(p.cols) && dimension(p.rows)
    && (p.agentId === undefined || boundedString(p.agentId, MAX_AGENT_ID_LENGTH)),
  "terminal.attach": (p) => exactKeys(p, ["sessionId"]) && boundedString(p.sessionId, MAX_SESSION_ID_LENGTH),
  "terminal.close": (p) => exactKeys(p, ["sessionId"]) && boundedString(p.sessionId, MAX_SESSION_ID_LENGTH),
  "terminal.input": (p) => exactKeys(p, ["sessionId", "data"]) && boundedString(p.sessionId, MAX_SESSION_ID_LENGTH)
    && typeof p.data === "string" && p.data.length <= MAX_INPUT_CHARS,
  "terminal.resize": (p) => exactKeys(p, ["sessionId", "cols", "rows"]) && boundedString(p.sessionId, MAX_SESSION_ID_LENGTH)
    && dimension(p.cols) && dimension(p.rows),
  "terminal.list": (p) => exactKeys(p, []),
};

export type TerminalRequestDecision =
  | { allowed: true; outbound: string }
  | { allowed: false; id: string | null; reason: "invalid-frame" | "method-unavailable" | "params-invalid" };

export interface TerminalRequestPolicy {
  defaultAgentId: string | null;
}

export function decideTerminalRequest(raw: string, policy: TerminalRequestPolicy): TerminalRequestDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { allowed: false, id: null, reason: "invalid-frame" };
  }
  const frame = record(parsed);
  const id = frame && boundedString(frame.id, MAX_ID_LENGTH) ? frame.id : null;
  if (!frame || frame.type !== "req" || id === null || typeof frame.method !== "string"
    || (frame.params !== undefined && record(frame.params) === null)) {
    return { allowed: false, id, reason: "invalid-frame" };
  }
  const validate = Object.hasOwn(PARAM_VALIDATORS, frame.method) ? PARAM_VALIDATORS[frame.method] : undefined;
  if (!validate) return { allowed: false, id, reason: "method-unavailable" };
  const params = record(frame.params) ?? {};
  if (!validate(params)) return { allowed: false, id, reason: "params-invalid" };
  const outbound = withDefaultOwner(frame.method, params, policy);
  return { allowed: true, outbound: JSON.stringify({ type: "req", id, method: frame.method, params: outbound }) };
}

function withDefaultOwner(
  method: string,
  params: Record<string, unknown>,
  policy: TerminalRequestPolicy,
): Record<string, unknown> {
  if (method !== "terminal.open" || params.agentId !== undefined || !policy.defaultAgentId) return params;
  return { ...params, agentId: policy.defaultAgentId };
}

export function terminalPolicyError(id: string | null, reason: string): string {
  return JSON.stringify({
    type: "res",
    id: id ?? "policy",
    ok: false,
    error: { code: "POLICY_DENIED", message: `Octogee policy denied this terminal operation (${reason})` },
  });
}

export function terminalServerFrameAllowed(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const frame = record(parsed);
  if (!frame) return false;
  if (frame.type === "res") return typeof frame.id === "string";
  return frame.type === "event" && typeof frame.event === "string" && TERMINAL_EVENTS.has(frame.event);
}

export interface TerminalUpstream {
  ws: WebSocket;
  scopes: ReadonlySet<string>;
}

export interface AttachTerminalWsRouteOptions {
  router: WsUpgradeRouter;
  tickets: WsTicketStore<TerminalSession>;
  defaultAgentId: () => string | null;
  openUpstream: (session: TerminalSession) => Promise<TerminalUpstream>;
  isAllowedOrigin: (origin: string | undefined) => boolean;
  log: (message: string, meta?: Record<string, unknown>) => void;
  authorizationIntervalMs?: number;
  authorizationTimeoutMs?: number;
}

function rawDataText(data: RawData, isBinary: boolean): string | null {
  if (isBinary) return null;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function closeCodeForPeer(code: number): number {
  return code >= 1000 && code <= 1013 && code !== 1004 && code !== 1005 && code !== 1006 ? code : 1011;
}

function bridgeTerminal(
  browser: WebSocket,
  upstreamPending: Promise<TerminalUpstream>,
  session: TerminalSession,
  options: AttachTerminalWsRouteOptions,
): void {
  const { log } = options;
  const queued: string[] = [];
  const scope = session.conversation ? new TerminalConversationScope(session.conversation) : null;
  let upstream: WebSocket | null = null;
  let closed = false;

  const closeSocket = (socket: WebSocket, code: number, reason: string) => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, reason);
  };
  const closeBoth = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    stopAuthorization();
    queued.length = 0;
    closeSocket(browser, code, reason);
    if (upstream) closeSocket(upstream, 1000, reason);
  };
  const stopAuthorization = monitorSessionAuthorization(session, {
    intervalMs: options.authorizationIntervalMs ?? DEFAULT_SESSION_AUTHORIZATION_INTERVAL_MS,
    timeoutMs: options.authorizationTimeoutMs ?? DEFAULT_SESSION_AUTHORIZATION_TIMEOUT_MS,
    onEnded: (result) => {
      log("terminal authorization ended", { uid: session.uid, result });
      closeBoth(result === "revoked" ? 1008 : 1011, result === "revoked" ? "terminal access changed" : "authorization unavailable");
    },
  });
  const relayFailure = (side: "browser" | "gateway", err: unknown) => {
    log(`terminal ${side} socket failed`, { error: err instanceof Error ? err.message : String(err) });
    closeBoth(1011, `${side} socket failed`);
  };
  const toBrowser = (raw: string) => {
    if (closed) return;
    if (browser.bufferedAmount > MAX_BROWSER_BUFFERED_BYTES) {
      log("terminal browser backpressure", { uid: session.uid, bufferedAmount: browser.bufferedAmount });
      closeBoth(1013, "backpressure");
      return;
    }
    try {
      browser.send(raw);
    } catch (err) {
      relayFailure("browser", err);
    }
  };
  const toGateway = (raw: string) => {
    if (closed) return;
    if (!upstream) {
      if (queued.length >= MAX_QUEUED_FRAMES) {
        closeBoth(1013, "backpressure");
        return;
      }
      queued.push(raw);
      return;
    }
    try {
      upstream.send(raw);
    } catch (err) {
      relayFailure("gateway", err);
    }
  };

  browser.on("message", (data, isBinary) => {
    if (closed) return;
    const raw = rawDataText(data, isBinary);
    if (raw === null) {
      closeBoth(1008, "text frames only");
      return;
    }
    const decision = decideTerminalRequest(raw, { defaultAgentId: session.conversation?.agentId ?? options.defaultAgentId() });
    if (!decision.allowed) {
      if (decision.reason === "invalid-frame" && decision.id === null) {
        closeBoth(1008, "invalid frame");
        return;
      }
      toBrowser(terminalPolicyError(decision.id, decision.reason));
      return;
    }
    const outbound = scope ? scope.request(decision.outbound) : decision.outbound;
    if (!outbound) { toBrowser(terminalPolicyError(JSON.parse(decision.outbound).id, "conversation-owner")); return; }
    toGateway(outbound);
  });
  browser.on("close", (code, reason) => closeBoth(closeCodeForPeer(code), reason.toString()));
  browser.on("error", (err) => relayFailure("browser", err));

  upstreamPending.then(({ ws, scopes }) => {
    if (closed) {
      closeSocket(ws, 1000, "browser gone");
      return;
    }
    if (!scopes.has("operator.admin")) {
      log("terminal upstream lacks admin scope", { uid: session.uid });
      closeSocket(ws, 1000, "terminal not permitted");
      closeBoth(1008, "terminal not permitted");
      return;
    }
    upstream = ws;
    ws.on("message", (data, isBinary) => {
      if (closed) return;
      const raw = rawDataText(data, isBinary);
      if (raw === null || !terminalServerFrameAllowed(raw)) return;
      const scoped = scope ? scope.response(raw) : raw;
      if (scoped) toBrowser(scoped);
    });
    ws.on("close", (code, reason) => closeBoth(closeCodeForPeer(code), reason.toString()));
    ws.on("error", (err) => relayFailure("gateway", err));
    for (const raw of queued) ws.send(raw);
    queued.length = 0;
  }).catch((err: unknown) => {
    log("terminal upstream dial failed", { uid: session.uid, error: err instanceof Error ? err.message : String(err) });
    closeBoth(1011, "terminal unreachable");
  });
}

export function attachTerminalWsRoute(options: AttachTerminalWsRouteOptions): void {
  const redeemed = new WeakMap<IncomingMessage, TerminalSession>();
  const authorizationTimeoutMs = options.authorizationTimeoutMs ?? DEFAULT_SESSION_AUTHORIZATION_TIMEOUT_MS;
  options.router.add({
    match: (pathname) => pathname.startsWith(TERMINAL_WS_PREFIX),
    extractTicket: terminalTicketFromPath,
    allowedOrigins: options.isAllowedOrigin,
    maxPayloadBytes: MAX_BROWSER_FRAME_BYTES,
    authorize: async (req) => {
      const ticket = terminalTicketFromPath((req.url ?? "").split("?")[0]);
      const session = ticket ? options.tickets.redeem(ticket) : null;
      if (!session) throw new WsUpgradeAuthorizationError(401, "TERMINAL_TICKET_INVALID");
      const result = await authorizeSession(session, authorizationTimeoutMs);
      if (result !== "allowed") {
        options.log("terminal ticket authorization denied", { uid: session.uid, result });
        throw new WsUpgradeAuthorizationError(
          result === "revoked" ? 401 : 503,
          result === "revoked" ? "TERMINAL_ACCESS_REVOKED" : "TERMINAL_ACCESS_UNAVAILABLE",
        );
      }
      redeemed.set(req, session);
      return true;
    },
    onUpgrade: ({ ws, req }) => {
      const session = redeemed.get(req);
      redeemed.delete(req);
      if (!session) {
        ws.close(1011, "session missing");
        return;
      }
      bridgeTerminal(ws, options.openUpstream(session), session, options);
    },
  });
}
