import { createVoiceMigrationRegistry, createVoiceMigrationHandler, VOICE_MIGRATION_PATH } from '../voice/migration.js';
import http from "node:http";
import * as fs from "node:fs";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { Registry, Counter, Gauge } from "prom-client";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import { publicAppOriginsFromEnv } from "@octogee/core/public-app-origins";
import { OpenclawWireError } from "./openclaw/upstream.js";
import { attachActivitySubscription } from './openclaw/activity-subscription.js';
import {
  clearGatewayDeviceToken,
  fetchGatewayAuth,
  invalidateGatewayToken,
  GatewayTokenError,
  type GatewayOpenClawAuth,
} from "./openclaw/gateway-token.js";
import { openUpstreamWithGatewayAuth } from "./openclaw/authenticated-upstream.js";
import { shouldForwardFrame, sanitizeActivityFrame } from "./openclaw/frame-filter.js";
import {
  createGateState,
  evaluateInboundFrame,
  observeOutboundForState,
} from "./openclaw/inbound-gate.js";
import { isAllowedWsOrigin, warnIfWsOriginsMisconfigured } from "./openclaw/ws-origin.js";
import { applyGatewayPrefixStripInPlace, stripGatewayPrefix } from "./gateway-prefix.js";
import { createBridgeLog } from "./bridge-log.js";
import { isAllowedLocalhostOrigin } from "@octogee/shared/types/dev-origins";
import {
  guardUpgradeRequest,
  mmRosterVerdictFor,
  revisionUnavailableUpgradeResponse,
  type RollRosterUpgradeGate,
  type UpgradeGateVerdict,
} from "../roll-roster.js";
import { logger } from "@octogee/core/http/logging";
import {
  defaultAgentWiredInParsedConfig,
  listLocalDefaultAgentWiredSlugs,
  readOpenclawConfig,
} from "@octogee/core/local-default-agent-wired";

import { attachMmWsBridge, createMmWsRegistry } from "./mm-proxy/ws.js";
import {
  createOpenClawRuntimeBrokerFromEnv,
  OpenClawRuntimeBrokerError,
  type OpenClawRuntimeBroker,
} from "./openclaw/runtime-broker.js";
import {
  ACTIVITY_INTAKE_PATH,
  FINAL_REPLY_INTAKE_PATH,
  DIRECT_ACTIVITY_TARGET_PATH,
  VOICE_EVENT_RELAY_PATH,
} from "./http-paths.js";
import { createMattermostInteractionProxyHandler } from "./openclaw/mattermost-interaction-proxy.js";
import { startMmChatActivityListeners } from "./openclaw/mm-chat-activity-listener.js";
import { makeChatActivityDemandHandler } from "./openclaw/chat-activity-demand.js";
import { createProductionActivityIntakeHandler } from "./openclaw/activity-intake.js";
import {
  createActivityBindingRegistry,
  readMattermostChannelCreateAt,
} from "./openclaw/activity-binding-registry.js";
import { createActivityMmClientFactory } from "./openclaw/mm-client.js";
import { createDirectActivityTargetHandler } from "./openclaw/direct-activity-target.js";
import { createFinalReplyIntakeHandler } from "./final-reply-intake.js";
import { createVoiceWsUpgradeHandler } from "../voice/route.js";
import type { AgentEventSource } from "../voice/brain.js";
import { SileroVad } from "../voice/silero-vad.js";
import { createOpenClawVoiceEventRelay } from "../voice/openclaw-event-relay.js";
export { chatProxyOwnsHttpPath } from "./http-paths.js";

if (process.env.NODE_ENV !== "test") {
  if (!process.env.MM_INTERNAL_URL) {
    logger.error("FATAL: MM_INTERNAL_URL is required (in-cluster Mattermost URL, e.g. http://mattermost.<ns>.svc.cluster.local:8065)");
    process.exit(1);
  }
}
const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL || "https://mm-test.invalid";
const DEFAULT_OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const DEFAULT_AGENT_RECONCILE_USERS_DIR = process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
const DEFAULT_AGENT_RECONCILE_OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || "/home/node/.openclaw/openclaw.json";
const DEFAULT_AGENT_RECONCILE_INTERVAL_MS = 60_000;

const bridgeLog = createBridgeLog();

const AUTH_FAILED = 'auth-failed' as const;

const MM_INTERNAL_WS_URL = MM_INTERNAL_URL.replace(/^http/, "ws") + "/api/v4/websocket";

const mmWsRegistry = createMmWsRegistry();

const mmUserIdCache = new Map<string, { userId: string; cachedAt: number }>();
const MM_USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const MM_USER_ID_CACHE_MAX_ENTRIES = 1_000;

async function resolveMmUserId(mmToken: string): Promise<string | null> {
  const cached = mmUserIdCache.get(mmToken);
  const nowMs = Date.now();
  if (cached && nowMs - cached.cachedAt < MM_USER_ID_CACHE_TTL_MS) {
    mmUserIdCache.delete(mmToken);
    mmUserIdCache.set(mmToken, cached);
    return cached.userId;
  }
  if (cached) {
    mmUserIdCache.delete(mmToken);
  }
  try {
    const resp = await fetch(`${MM_INTERNAL_URL}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${mmToken}` },
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { id?: unknown };
    if (typeof body.id !== "string" || body.id.length === 0) return null;
    mmUserIdCache.set(mmToken, { userId: body.id, cachedAt: nowMs });
    evictMmUserIdCacheIfNeeded();
    return body.id;
  } catch (err) {
    logger.warn(`[mm-proxy] resolveMmUserId failed: ${(err as Error).message}`);
    return null;
  }
}

function evictMmUserIdCacheIfNeeded(): void {
  const nowMs = Date.now();
  for (const [token, entry] of mmUserIdCache) {
    if (nowMs - entry.cachedAt >= MM_USER_ID_CACHE_TTL_MS) {
      mmUserIdCache.delete(token);
    }
  }
  while (mmUserIdCache.size > MM_USER_ID_CACHE_MAX_ENTRIES) {
    const oldestKey = mmUserIdCache.keys().next().value;
    if (oldestKey === undefined) break;
    mmUserIdCache.delete(oldestKey);
  }
}

export const chatProxyMetricsRegistry = new Registry();
const metricsRegistry = chatProxyMetricsRegistry;

const ocWsConnectionsActive = new Gauge({
  name: 'chat_proxy_openclaw_ws_connections_active',
  help: 'Active OpenClaw gateway proxy connections',
  registers: [metricsRegistry],
});

const ocWsHandshakeTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_handshakes_total',
  help: 'Total OpenClaw upstream handshake outcomes',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const ocWsRotationRecoveredTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_rotation_recovered_total',
  help: 'OpenClaw upstream handshakes that succeeded after an auth-failed rotation retry',
  registers: [metricsRegistry],
});

const ocWsFrameFilterTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_frame_filter_total',
  help: 'Per-user frame-filter decisions on inbound gateway events',
  labelNames: ['decision', 'reason'] as const,
  registers: [metricsRegistry],
});

const ocWsInboundGateTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_inbound_gate_total',
  help: 'Browser-to-gateway frame allowlist decisions',
  labelNames: ['decision', 'reason'] as const,
  registers: [metricsRegistry],
});

let mattermostInteractionProxyHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

let activityIntakeHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

let directActivityTargetHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

function getActivityIntakeHandler():
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null {
  if (activityIntakeHandler) return activityIntakeHandler;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) return null;
  const broker = getOpenClawRuntimeBroker();
  const registry = createActivityBindingRegistry({
    resolveAgentIdentity: (agentId) => broker.resolveAgentIdentity(agentId),
    resolveConversationTarget: (agentId, conversationId) =>
      broker.resolveConversationTarget(agentId, conversationId),
    resolveDirectConversationTarget: (agentId, conversationId, ownerUserId) =>
      broker.resolveDirectConversationTarget(agentId, conversationId, ownerUserId),
    verifyChannel: (identity, target) => readMattermostChannelCreateAt({
      baseUrl: MM_INTERNAL_URL,
      channelId: target.primaryChannelId,
      token: identity.coachToken,
      ...(target.expectedChannelTeamId !== null ? { expectedTeamId: target.expectedChannelTeamId } : {}),
      ...(target.expectedChannelName !== null ? { expectedName: target.expectedChannelName } : {}),
      expectedType: target.expectedChannelType,
      ...(target.expectedMemberIds ? { expectedMemberIds: target.expectedMemberIds } : {}),
    }),
  });
  const mmClientFor = createActivityMmClientFactory({ baseUrl: MM_INTERNAL_URL });
  activityIntakeHandler = createProductionActivityIntakeHandler({
    gatewayToken,
    registry,
    receiptsFor: (binding) => broker.activityWriteReceiptsFor(binding.channelDocPath),
    mmClientFor,
    leaseOwner: `${process.env.GATEWAY_ID?.trim() || "gateway-edge"}:${process.pid}`,
    log: (event, meta) => logger.warn(`[activity-intake] ${event}`, meta),
  });
  return activityIntakeHandler;
}

let finalReplyIntakeHandler: ReturnType<typeof createFinalReplyIntakeHandler> | null = null;

function getFinalReplyIntakeHandler(): ReturnType<typeof createFinalReplyIntakeHandler> | null {
  if (finalReplyIntakeHandler) return finalReplyIntakeHandler;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) return null;
  const gatewayId = process.env.GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("GATEWAY_ID is required for final reply intake");
  const broker = getOpenClawRuntimeBroker();
  finalReplyIntakeHandler = createFinalReplyIntakeHandler({
    gatewayToken,
    notify: (input) => broker.notifyFinalReply(input),
    log: (message, fields) => logger.warn(`[final-reply] ${message}`, fields),
  });
  return finalReplyIntakeHandler;
}

function getDirectActivityTargetHandler():
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null {
  if (directActivityTargetHandler) return directActivityTargetHandler;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) return null;
  const broker = getOpenClawRuntimeBroker();
  const mmClientFor = createActivityMmClientFactory({ baseUrl: MM_INTERNAL_URL });
  directActivityTargetHandler = createDirectActivityTargetHandler({
    gatewayToken,
    deps: {
      resolveAgentIdentity: (agentId) => broker.resolveAgentIdentity(agentId),
      resolveDirectConversationTarget: (agentId, conversationId, ownerUserId) =>
        broker.resolveDirectConversationTarget(agentId, conversationId, ownerUserId),
      mmClientFor,
      verifyChannel: (identity, target) => readMattermostChannelCreateAt({
        baseUrl: MM_INTERNAL_URL,
        channelId: target.primaryChannelId,
        token: identity.coachToken,
        ...(target.expectedChannelTeamId !== null ? { expectedTeamId: target.expectedChannelTeamId } : {}),
        ...(target.expectedChannelName !== null ? { expectedName: target.expectedChannelName } : {}),
        expectedType: target.expectedChannelType,
        ...(target.expectedMemberIds ? { expectedMemberIds: target.expectedMemberIds } : {}),
      }),
    },
    log: (message, fields) => logger.warn(`[activity-direct-target] ${message}`, fields),
  });
  return directActivityTargetHandler;
}

const voiceMigrationRegistry = createVoiceMigrationRegistry();
const voiceEventRelayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
const voiceEventRelay = voiceEventRelayToken
  ? createOpenClawVoiceEventRelay({
      gatewayToken: voiceEventRelayToken,
      log: (message, fields) => logger.warn(`[voice] ${message}`, fields),
    })
  : null;
const voiceMigrationHandler = voiceEventRelayToken ? createVoiceMigrationHandler({ gatewayToken: voiceEventRelayToken, registry: voiceMigrationRegistry }) : null;
const unavailableVoiceEventSource: AgentEventSource = {
  subscribe: () => () => undefined,
};

const FRAME_DROP_LOG_WINDOW_MS = 60_000;
// Retry-After hint for a WS upgrade refused because the serving revision is not
// resolvable yet (mirrors the roll-roster gate's default). The client reconnects
// after the roll settles rather than seeing an opaque failure.
const WS_REVISION_UNAVAILABLE_RETRY_SECONDS = 2;
const lastFrameDropLogByUid = new Map<string, number>();
const filteredFrameCountByUid = new Map<string, Map<string, number>>();

function bumpFilteredFrameCount(uid: string, reason: string): void {
  let perReason = filteredFrameCountByUid.get(uid);
  if (!perReason) {
    perReason = new Map<string, number>();
    filteredFrameCountByUid.set(uid, perReason);
  }
  perReason.set(reason, (perReason.get(reason) ?? 0) + 1);
}

function drainFilteredFrameCounts(uid: string): string {
  const perReason = filteredFrameCountByUid.get(uid);
  if (!perReason || perReason.size === 0) return "";
  const parts: string[] = [];
  for (const [reason, count] of perReason) {
    parts.push(`${reason}=${count}`);
  }
  filteredFrameCountByUid.delete(uid);
  return parts.join(",");
}
const lastInboundDropLogByUid = new Map<string, number>();

function normalizeWsData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

let openclawRuntimeBroker: OpenClawRuntimeBroker | undefined;
function getOpenClawRuntimeBroker(): OpenClawRuntimeBroker {
  if (openclawRuntimeBroker === undefined) {
    openclawRuntimeBroker = createOpenClawRuntimeBrokerFromEnv();
  }
  return openclawRuntimeBroker;
}

function watchBrokerGatewayIdChange(
  broker: OpenClawRuntimeBroker,
  uid: string,
  initialGatewayId: string,
  onChange: (newGatewayId: string | null) => void,
  intervalMs: number = 30_000,
): () => void {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    broker.getUserGatewayId(uid)
      .then((newGatewayId) => {
        if (!newGatewayId || newGatewayId === initialGatewayId || fired) return;
        fired = true;
        onChange(newGatewayId);
      })
      .catch((err) => {
        if (err instanceof OpenClawRuntimeBrokerError && err.status === 403 && !fired) {
          fired = true;
          onChange(null);
          return;
        }
        logger.warn(
          `[proxy] OC WS: broker gatewayId watch failed for uid=${uid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const ALLOWED_ORIGINS = new Set(publicAppOriginsFromEnv());

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || isAllowedLocalhostOrigin(origin);
}

export function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin as string | undefined;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function handleDirectActivityTargetRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const handler = getDirectActivityTargetHandler();
    if (!handler) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "direct_activity_target_unconfigured", retryable: true }));
      return;
    }
    await handler(req, res);
  } catch (error) {
    logger.error("[activity-direct-target] initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "direct_activity_target_unavailable", retryable: true }));
  }
}

async function handleFinalReplyRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const handler = getFinalReplyIntakeHandler();
    if (!handler) throw new Error("final reply intake is not configured");
    await handler(req, res);
  } catch (error) {
    logger.error("[final-reply] initialization failed", { error: error instanceof Error ? error.message : String(error) });
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "reply_notification_unavailable", retryable: true }));
  }
}

async function handleLocalInternalRoute(
  path: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (path === FINAL_REPLY_INTAKE_PATH) {
    await handleFinalReplyRoute(req, res);
    return true;
  }
  if (path === DIRECT_ACTIVITY_TARGET_PATH) {
    await handleDirectActivityTargetRoute(req, res);
    return true;
  }
  if (path === ACTIVITY_INTAKE_PATH) {
    try {
      const handler = getActivityIntakeHandler();
      if (!handler) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "activity_intake_unconfigured", retryable: true }));
      } else {
        await handler(req, res);
      }
    } catch (error) {
      logger.error("[activity-intake] initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "activity_intake_unavailable", retryable: true }));
    }
    return true;
  }
  if (path === VOICE_MIGRATION_PATH) {
    if (voiceMigrationHandler) await voiceMigrationHandler(req, res);
    else { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'voice_migration_unconfigured' })); }
    return true;
  }
  if (path !== VOICE_EVENT_RELAY_PATH) return false;
  if (!voiceEventRelay) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "voice_relay_unconfigured" }));
  } else {
    await voiceEventRelay.handle(req, res);
  }
  return true;
}

function handleHealthRoute(path: string, res: http.ServerResponse): boolean {
  if (path === "/healthz" || path === "/health" || path === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return true;
  }
  return false;
}

async function handleControlRoute(
  path: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (/^\/internal\/openclaw\/mattermost\/interactions\/[A-Za-z0-9_-]{1,128}$/.test(path)) {
    if (!mattermostInteractionProxyHandler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable", reason: "interaction proxy not initialized" }));
    } else {
      await mattermostInteractionProxyHandler(req, res);
    }
    return true;
  }
  return false;
}

export async function chatProxyHandleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const originalPath = (req.url || "").split("?")[0];
  if (await handleLocalInternalRoute(originalPath, req, res)) return;

  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = applyGatewayPrefixStripInPlace(req);
  if (handleHealthRoute(urlPath, res)) return;
  if (await handleControlRoute(urlPath, req, res)) return;

  req.resume();
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

type UpstreamOutcome =
  | { ok: true; upstream: WebSocket }
  | { ok: false; httpStatus: string };

type GatewayAuthOutcome =
  | { ok: true; auth: GatewayOpenClawAuth }
  | { ok: false; httpStatus: string };

type OpenAttempt =
  | { ok: true; upstream: WebSocket }
  | { ok: false; code: string };

export async function establishUpstreamWithRotation(
  gatewayId: string,
): Promise<UpstreamOutcome> {
  if (!process.env.GATEWAY_ID || process.env.GATEWAY_ID !== gatewayId) {
    logger.error("[proxy] OC WS: redeemed gateway does not match the local gateway");
    return { ok: false, httpStatus: "403 Forbidden" };
  }
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_OPENCLAW_GATEWAY_URL;
  const auth = await fetchInitialGatewayAuth(gatewayId);
  if (!auth.ok) return auth;

  const first = await tryOpenGatewayUpstream(gatewayId, gatewayUrl, auth.auth);
  if (first.ok) return acceptUpstreamHandshake(first.upstream);
  if (first.code !== AUTH_FAILED) return rejectUpstreamHandshake(first.code);

  await clearStaleGatewayAuth(gatewayId, auth.auth);
  const fresh = await fetchGatewayAuthAfterRotation(gatewayId);
  if (!fresh.ok) return fresh;

  const retry = await tryOpenGatewayUpstream(gatewayId, gatewayUrl, fresh.auth);
  if (retry.ok) return acceptRotationRecovery(retry.upstream);
  return rejectRotationHandshake(retry.code);
}

async function fetchInitialGatewayAuth(gatewayId: string): Promise<GatewayAuthOutcome> {
  try {
    const auth = await fetchGatewayAuth({ gatewayId, allowLegacyFallback: true });
    return { ok: true, auth };
  } catch (e) {
    if (!(e instanceof GatewayTokenError)) throw e;
    logger.error(`[proxy] OC WS: gateway auth fetch failed — ${e.code}: ${e.message}`);
    return { ok: false, httpStatus: "503 Service Unavailable" };
  }
}

async function fetchGatewayAuthAfterRotation(gatewayId: string): Promise<GatewayAuthOutcome> {
  try {
    const auth = await fetchGatewayAuth({ gatewayId, skipCache: true, allowLegacyFallback: true });
    return { ok: true, auth };
  } catch (fetchErr) {
    const fetchCode = fetchErr instanceof GatewayTokenError ? fetchErr.code : "unknown";
    logger.error(`[proxy] OC WS: gateway auth re-fetch during rotation failed — ${fetchCode}`);
    ocWsHandshakeTotal.inc({ outcome: `fail:refetch:${fetchCode}` });
    return { ok: false, httpStatus: "503 Service Unavailable" };
  }
}

async function tryOpenGatewayUpstream(
  gatewayId: string,
  gatewayUrl: string,
  auth: GatewayOpenClawAuth,
): Promise<OpenAttempt> {
  try {
    const upstream = await openUpstreamWithGatewayAuth({
      gatewayId,
      url: gatewayUrl,
      pairingUrl: process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_OPENCLAW_GATEWAY_URL,
    }, auth);
    return { ok: true, upstream };
  } catch (e) {
    const code = e instanceof OpenclawWireError ? e.code : "unknown";
    return { ok: false, code };
  }
}

async function clearStaleGatewayAuth(gatewayId: string, auth: GatewayOpenClawAuth): Promise<void> {
  if (auth.source === "legacy-token") {
    invalidateGatewayToken(gatewayId);
    return;
  }
  await clearGatewayDeviceToken();
}

function acceptUpstreamHandshake(upstream: WebSocket): UpstreamOutcome {
  ocWsHandshakeTotal.inc({ outcome: "ok" });
  return { ok: true, upstream };
}

function acceptRotationRecovery(upstream: WebSocket): UpstreamOutcome {
  ocWsHandshakeTotal.inc({ outcome: "ok" });
  ocWsRotationRecoveredTotal.inc();
  return { ok: true, upstream };
}

function rejectUpstreamHandshake(code: string): UpstreamOutcome {
  logger.warn(`[proxy] OC WS: upstream handshake failed — ${code}`);
  ocWsHandshakeTotal.inc({ outcome: `fail:${code}` });
  return { ok: false, httpStatus: "502 Bad Gateway" };
}

function rejectRotationHandshake(code: string): UpstreamOutcome {
  logger.warn(`[proxy] OC WS: upstream handshake failed after rotation retry — ${code}`);
  ocWsHandshakeTotal.inc({ outcome: `fail:${code}` });
  return { ok: false, httpStatus: "502 Bad Gateway" };
}

function handleOpenClawWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: {
    upgradeGate: RollRosterUpgradeGate | null;
    runtimeBroker?: OpenClawRuntimeBroker;
    gatewayWatchIntervalMs?: number;
  },
): void {
  const { upgradeGate, runtimeBroker: runtimeBrokerOverride, gatewayWatchIntervalMs } = options;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedWsOrigin(origin)) {
    ocWsHandshakeTotal.inc({ outcome: "fail:origin-rejected" });
    logger.warn(`[proxy] OC WS: rejected origin=${origin ?? "(none)"}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const urlPath = stripGatewayPrefix((req.url || "").split("?")[0]);
  const pathMatch = urlPath.match(/\/api\/openclaw\/ws\/([a-f0-9-]{36})$/);
  const ticket = pathMatch?.[1] || null;

  if (!ticket) {
    logger.warn(`[proxy] OC WS: no ticket`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  (async () => {
    try {
      const runtimeBroker = runtimeBrokerOverride ?? getOpenClawRuntimeBroker();
      const redeemOutcome = await runtimeBroker.redeemOpenClawWs(ticket);
      if (redeemOutcome.kind === "unauthorized") {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (redeemOutcome.kind === "revision-unavailable") {
        // The broker could not resolve a LIVE serving revision (mid-roll or a
        // just-retired revision). Surface the SAME retryable roll-in-progress
        // signal as a roster refusal — never a generic 500 — so the client
        // reconnects once the roll settles instead of hard-failing.
        logger.warn(
          `[proxy] OC WS: revision unavailable (${redeemOutcome.reason}) — refusing with retryable 503`,
        );
        socket.write(
          revisionUnavailableUpgradeResponse(
            WS_REVISION_UNAVAILABLE_RETRY_SECONDS,
            redeemOutcome.reason,
          ),
        );
        socket.destroy();
        return;
      }
      const redeemed = redeemOutcome.redeemed;
      const uid = redeemed.uid;
      const gatewayId = redeemed.gatewayId;
      const expectedAgentId = redeemed.expectedAgentId;
      const activityScope = redeemed.activityConversation;

      // Post-auth roster verdict (the ticket just resolved the user): a
      // quiescing user or one serving on another revision must never
      // attach here — refuse so the client reconnects via the serving
      // revision.
      if (upgradeGate) {
        const verdict = upgradeGate.checkUid(activityScope?.ownerUid ?? uid);
        if (!verdict.allow) {
          upgradeGate.refuse(socket, verdict);
          return;
        }
      }

      const outcome = await establishUpstreamWithRotation(gatewayId);
      if (!outcome.ok) {
        socket.write(`HTTP/1.1 ${outcome.httpStatus}\r\n\r\n`);
        socket.destroy();
        return;
      }
      const upstream = outcome.upstream;

      const gateState = createGateState(expectedAgentId);
      gateState.readOnly = Boolean(activityScope);

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        ocWsConnectionsActive.inc();

        const stopGatewayWatch = watchBrokerGatewayIdChange(
          runtimeBroker,
          activityScope?.ownerUid ?? uid,
          gatewayId,
          (newGatewayId) => {
            const destination = newGatewayId ?? "not-assigned-here";
            logger.info(
              `[proxy] OC WS: gatewayId changed for uid=${uid}: ${gatewayId} → ${destination}; forcing reconnect`,
            );
            try {
              clientWs.close(1001, "gatewayId-changed");
            } catch {
              // best-effort
            }
          },
          gatewayWatchIntervalMs,
        );

        clientWs.on("message", (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN) return;
          const buf = normalizeWsData(data);
          const decision = evaluateInboundFrame(buf, isBinary, gateState);
          ocWsInboundGateTotal.inc({
            decision: decision.accept ? "accept" : "drop",
            reason: decision.reason,
          });
          if (!decision.accept) {
            const now = Date.now();
            const last = lastInboundDropLogByUid.get(uid) ?? 0;
            if (now - last >= FRAME_DROP_LOG_WINDOW_MS) {
              lastInboundDropLogByUid.set(uid, now);
              logger.warn(
                `[proxy] OC WS: dropped inbound frame uid=${uid} reason=${decision.reason}`,
              );
            }
            return;
          }
          upstream.send(isBinary ? buf : buf.toString("utf8"), { binary: isBinary });
        });
        upstream.on("message", (data, isBinary) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;
          if (isBinary) {
            if (activityScope) return;
            clientWs.send(data, { binary: true });
            return;
          }
          const text = data.toString();
          const decision = shouldForwardFrame(text, { expectedAgentId, ...(activityScope ? { sessionKey: activityScope.sessionKey } : {}) });
          ocWsFrameFilterTotal.inc({
            decision: decision.forward ? "forward" : "drop",
            reason: decision.reason,
          });
          if (decision.forward) {
            observeOutboundForState(text, gateState);
            clientWs.send(activityScope ? sanitizeActivityFrame(text) : text);
          } else {
            bumpFilteredFrameCount(uid, decision.reason);
            const now = Date.now();
            const last = lastFrameDropLogByUid.get(uid);
            if (last === undefined) {
              lastFrameDropLogByUid.set(uid, now);
            } else if (now - last >= FRAME_DROP_LOG_WINDOW_MS) {
              lastFrameDropLogByUid.set(uid, now);
              const counts = drainFilteredFrameCounts(uid);
              logger.info(
                `[proxy] OC WS fan-out filtered frames uid=${uid} window=${FRAME_DROP_LOG_WINDOW_MS}ms counts=${counts} (correct per-user routing, not lost messages)`,
              );
            }
          }
        });
        clientWs.on("close", () => {
          ocWsConnectionsActive.dec();
          stopGatewayWatch();
          stopActivity?.();
          try {
            upstream.close();
          } catch {}
        });
        upstream.on("close", () => clientWs.close());
        const stopActivity = activityScope ? attachActivitySubscription({ upstream, client: clientWs, scope: activityScope, uid, broker: runtimeBroker, warn: (message, metadata) => logger.warn(message, metadata) }) : undefined;
        clientWs.on("error", () => {
          try {
            upstream.close();
          } catch {}
        });
        upstream.on("error", () => clientWs.close());
      });
    } catch (e) {
      logger.error(`[proxy] OC WS error: ${e instanceof Error ? e.message : String(e)}`);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  })();
}

export function _clearCaches(): void {
  mmUserIdCache.clear();
  firebaseUidByMmUserId.clear();
  openclawRuntimeBroker = undefined;
}

export function gatewayHealthUrl(
  base: string = process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_OPENCLAW_GATEWAY_URL,
): string {
  return `${base}/healthz`;
}

export interface AttachChatProxyWsUpgradeOptions {
  // Roll-roster gate for revision pods (Codex P0): upgrades bypass Express, so
  // the SAME roster/boot checks the HTTP middleware runs must run here, at the
  // one shared upgrade handler — BEFORE any dispatch, so every current and
  // future upgrade route is covered by construction.
  upgradeGate?: RollRosterUpgradeGate | null;
  runtimeBroker?: OpenClawRuntimeBroker;
  gatewayWatchIntervalMs?: number;
}

// mmUserId → Firebase uid for the roll-roster verdict. The mapping is written
// once at provisioning (users/{uid}.mattermost.userId), so positive lookups
// cache forever; misses are re-queried per auth. A lookup that resolves to
// nothing (missing/stale mapping) is REFUSED — never served locally during a
// roll; a lookup that throws fails CLOSED (the client reconnects, retry
// semantics), it never attaches ungated.
const firebaseUidByMmUserId = new Map<string, string>();

export function buildMmRosterVerdict(
  gate: RollRosterUpgradeGate,
  lookupUid: (mmUserId: string) => Promise<string | null>,
): (mmUserId: string | null) => Promise<UpgradeGateVerdict> {
  return (mmUserId) =>
    mmRosterVerdictFor(gate, mmUserId, async (id) => {
      const cached = firebaseUidByMmUserId.get(id);
      if (cached !== undefined) return cached;
      const uid = await lookupUid(id);
      if (uid !== null) firebaseUidByMmUserId.set(id, uid);
      return uid;
    });
}

export function attachChatProxyWsUpgrade(
  server: http.Server,
  opts: AttachChatProxyWsUpgradeOptions = {},
) {
  const wss = new WebSocketServer({ noServer: true });
  const mmWss = new WebSocketServer({ noServer: true });

  const wsRouter = new WsUpgradeRouter();
  const upgradeGate = opts.upgradeGate ?? null;
  const voiceWsUpgrade = createVoiceWsUpgradeHandler({
    migrationRegistry: voiceMigrationRegistry,
    runtimeBroker: {
      redeemOpenClawWs: (ticket, purpose) =>
        (opts.runtimeBroker ?? getOpenClawRuntimeBroker()).redeemOpenClawWs(ticket, purpose),
    },
    eventSourceForAgent: (agentId) => voiceEventRelay?.source(agentId) ?? unavailableVoiceEventSource,
    isAgentReady: (agentId) => voiceEventRelay?.readiness(agentId).ready ?? false,
    upgradeGate,
    isAllowedWsOrigin,
    stripGatewayPrefix,
    relayBaseUrl: process.env.OPENCLAW_RUNTIME_BROKER_URL ?? "",
    createVad: () => SileroVad.create(),
    registry: chatProxyMetricsRegistry,
    log: (message, fields) => logger.info(`[voice] ${message}`, fields ?? {}),
  });

  server.on("upgrade", (req, socket, head) => {
    if (guardUpgradeRequest(upgradeGate, req, socket)) return;
    const originalUrl = req.url ?? "(none)";

    const urlPath = applyGatewayPrefixStripInPlace(req);
    if (urlPath.startsWith("/api/voice/ws/")) {
      void voiceWsUpgrade(req, socket, head);
      return;
    }
    if (urlPath.startsWith("/api/openclaw/ws/")) {
      handleOpenClawWsUpgrade(
        wss,
        req,
        socket,
        head,
        {
          upgradeGate,
          runtimeBroker: opts.runtimeBroker,
          gatewayWatchIntervalMs: opts.gatewayWatchIntervalMs,
        },
      );
      return;
    }
    if (urlPath === "/api/v4/websocket") {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (!isAllowedWsOrigin(origin)) {
        logger.warn(`[mm-proxy/ws] rejected origin=${origin ?? "(none)"}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      logger.info(`[mm-proxy/ws] upgrade accepted origin=${origin ?? "(none)"}`);
      mmWss.handleUpgrade(req, socket, head, (browserWs) => {
        attachMmWsBridge(
          {
            mmInternalWsUrl: MM_INTERNAL_WS_URL,
            log: bridgeLog,
            resolveMmUserId,
            openUpstream: (url) => new WebSocket(url),
            registry: mmWsRegistry,
            // Auth-late roster enforcement (Codex P0): MM identity resolves
            // from the first auth frame, so the bridge holds the upstream dial
            // until this verdict — the shared upgrade-gate policy — admits. The
            // mmUser→uid step routes through the tenant-bound runtime broker,
            // like every other resolution on this creds-less pod — a direct
            // Firestore read has no credentials here and would hang admission
            // forever (the client-reconnect-loop regression from #2161).
            ...(upgradeGate
              ? {
                  rosterVerdict: buildMmRosterVerdict(upgradeGate, (mmUserId) =>
                    getOpenClawRuntimeBroker().resolveOctogeeUidByMmUser(mmUserId),
                  ),
                }
              : {}),
          },
          browserWs,
        );
      });
      return;
    }
    if (wsRouter.dispatch(req, socket, head)) return;

    const redactWsPath = (p: string) => p.replace(/[A-Za-z0-9_-]{16,}/g, "<redacted>");
    logger.warn(
      `[ws-upgrade] no route matched — 404 strippedPath=${redactWsPath(urlPath)} originalUrl=${redactWsPath(originalUrl)}`,
    );
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  (server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter = wsRouter;
}

async function readMountedDefaultAgentUsers(): Promise<readonly string[] | null> {
  if (!fs.existsSync(DEFAULT_AGENT_RECONCILE_USERS_DIR)) return null;
  const config = readOpenclawConfig(DEFAULT_AGENT_RECONCILE_OPENCLAW_CONFIG);
  if (!config) return null;
  return listLocalDefaultAgentWiredSlugs(
    DEFAULT_AGENT_RECONCILE_USERS_DIR,
    (slug) => defaultAgentWiredInParsedConfig(config, slug),
  );
}

function startDefaultAgentChatActivity(
  runtimeBroker: OpenClawRuntimeBroker,
): void {
  const chatActivityDemand = makeChatActivityDemandHandler({
    broker: runtimeBroker,
    log: bridgeLog,
  });
  const manager = startMmChatActivityListeners({
    log: bridgeLog,
    openWebSocket: () => new WebSocket(MM_INTERNAL_WS_URL),
    onChatActivity: (activity) => {
      void chatActivityDemand(activity);
    },
  });
  const trackedDefaultAgentIds = new Set<string>();
  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      const slugs = await readMountedDefaultAgentUsers();
      if (slugs === null) return;
      const nextDefaultAgentIds = new Set<string>();
      for (const slug of slugs) {
        try {
          const identity = await runtimeBroker.resolveAgentIdentity(`octogee-${slug}-coach`);
          if (!identity?.coachMmUserId || !identity.coachToken) continue;
          nextDefaultAgentIds.add(identity.coachMmUserId);
          manager.addDefaultAgent({
            defaultAgentMmUserId: identity.coachMmUserId,
            coachToken: identity.coachToken,
          });
        } catch (error) {
          logger.warn("[default-agent-notifications] defaultAgent discovery failed", {
            slug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const defaultAgentMmUserId of trackedDefaultAgentIds) {
        if (!nextDefaultAgentIds.has(defaultAgentMmUserId)) manager.removeDefaultAgent(defaultAgentMmUserId);
      }
      trackedDefaultAgentIds.clear();
      for (const defaultAgentMmUserId of nextDefaultAgentIds) trackedDefaultAgentIds.add(defaultAgentMmUserId);
    } finally {
      reconciling = false;
    }
  };
  void reconcile();
  const timer = setInterval(() => void reconcile(), DEFAULT_AGENT_RECONCILE_INTERVAL_MS);
  timer.unref();
  logger.info("[chat-proxy] Mattermost chat activity listeners started");
}

export async function startChatProxyBackground(): Promise<void> {
  warnIfWsOriginsMisconfigured(logger.warn);
  logger.info(`[chat-proxy] MM internal URL (data path): ${MM_INTERNAL_URL}`);
  const gatewayId = process.env.GATEWAY_ID?.trim();
  if (!gatewayId) {
    logger.error("[chat-proxy] background services disabled: GATEWAY_ID is missing");
    return;
  }
  const runtimeBroker = getOpenClawRuntimeBroker();
  mattermostInteractionProxyHandler = createMattermostInteractionProxyHandler({
    gatewayId,
    routerPublicKey: process.env.AGENT_CONTROL_ROUTER_PUBLIC_KEY ?? "",
    log: (message, meta) => logger.error(message, meta),
  });
  startDefaultAgentChatActivity(runtimeBroker);
}
