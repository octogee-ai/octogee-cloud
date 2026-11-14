import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import {
  WsUpgradeAuthorizationError,
  WsUpgradeRouter,
} from "@octogee/core/ws/upgrade-router";
import {
  acquireSystemConfigMutationLease,
  type SystemConfigMutationLease,
} from "@octogee/core/system-config-mutation-lease";
import type { SystemConfigInvariantContext } from "@octogee/core/system-config-invariants";
import { isResponseFrame } from "@octogee/shared/types/openclaw-wire-core";
import { Router, type Request, type Response } from "express";
import { WebSocket, type RawData } from "ws";

import {
  isOpenClawProxyIdentityHeader,
  resolveControlIdentityFromEnv,
} from "@octogee/shared/types/openclaw-proxy-identity";

import { fetchGatewayToken } from "../chat-proxy/openclaw/gateway-token.js";
import { logger } from "../middleware/logging.js";
import { clientRequestLimit } from "../middleware/authenticated-request-limit.js";
import { isDashboardAssetRequest } from "../middleware/dashboard-asset-request.js";
import { workspaceServingDenial, type WorkspaceServingResolver } from "./workspace-serving.js";
import {
  authorizeOpenClawControlSession,
  createOpenClawControlAuthorizationCache,
  openClawControlBrokerFailureKind,
  redeemOpenClawControlTicket,
  type OpenClawControlAuthorizationCache,
} from "./broker.js";
import {
  challengeNonce,
  rewriteTrustedOpenClawConnect,
  sanitizeOpenClawControlServerFrame,
  type OpenClawConnectIdentity,
} from "./connect-rewrite.js";
import {
  createOpenClawControlProxyIdentity,
  type OpenClawControlProxyIdentity,
} from "./proxy-identity.js";
import {
  evaluateOpenClawControlRpc,
  openClawControlRpcCategory,
  installedMethodsFromHello,
  isOpenClawControlMutation,
  openClawConfigSnapshotFromGetResponse,
  openClawControlPolicyError,
  openClawControlTimeoutError,
  type OpenClawConfigSnapshot,
  type OpenClawControlRpcDecision,
  type OpenClawControlRpcCategory,
} from "./rpc-policy.js";
import {
  OpenClawControlResourceLimiter,
  type OpenClawControlLease,
  type OpenClawControlResourceIdentity,
} from "./limits.js";
import { ChannelMembershipSyncError } from "./channel-membership-sync.js";
import { OpenClawControlSessionManager, type OpenClawControlSession } from "./session.js";
import { bridgeDesktopObserver, DesktopObserverTickets } from "./desktop-stream.js";
import type { OpenClawControlMetrics, OpenClawControlMetricIdentity } from "./metrics.js";
import {
  createMattermostControlChat,
  type MattermostChatPreparation,
  type MattermostControlChat,
} from "./mattermost-chat.js";
import type { ClaimedUserIdentity } from "@octogee/shared/types/builder-identity";
import { claimedUserIdentity } from "../lib/user-identity.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const MAX_BROWSER_WS_FRAME_BYTES = 1_048_576;
const MAX_UPSTREAM_WS_FRAME_BYTES = 25 * 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_MUTATION_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_LONG_RUNNING_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_AUTHORIZATION_INTERVAL_MS = 10_000;
const CSP_BEFORE_FRAME_ANCESTORS = "default-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors";
const CSP_AFTER_FRAME_ANCESTORS = "; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:";
const DASHBOARD_ERROR_EVENT = "octogee-openclaw-dashboard-error";
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma",
]);
const ALLOWED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-security-policy",
  "content-disposition",
  "content-language",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "vary",
]);
const DASHBOARD_ROUTES = new Set([
  "/activity",
  "/agents",
  "/ai-agents",
  "/apps",
  "/appearance",
  "/automation",
  "/automations",
  "/channels",
  "/chat",
  "/communications",
  "/config",
  "/cron",
  "/custodian",
  "/dashboard",
  "/dashboards",
  "/debug",
  "/dreaming",
  "/dreams",
  "/infrastructure",
  "/instances",
  "/logs",
  "/lobsterdex",
  "/mcp",
  "/memory-import",
  "/model-providers",
  "/model-setup",
  "/new",
  "/nodes",
  "/overview",
  "/plugin",
  "/portals",
  "/profile",
  "/sessions",
  "/settings/about",
  "/settings/advanced",
  "/settings/agents",
  "/settings/approvals",
  "/settings/ai-agents",
  "/settings/appearance",
  "/settings/automation",
  "/settings/channels",
  "/settings/cloud-workers",
  "/settings/communications",
  "/settings/connection",
  "/settings/devices",
  "/settings/general",
  "/settings/infrastructure",
  "/settings/labs",
  "/settings/lobsterdex",
  "/settings/mcp",
  "/settings/memory",
  "/settings/memory-import",
  "/settings/model-providers",
  "/settings/model-setup",
  "/settings/notifications",
  "/settings/plugins",
  "/settings/profile",
  "/settings/secrets",
  "/settings/security",
  "/settings/sessions",
  "/settings/talk",
  "/settings/updates",
  "/settings/worktrees",
  "/skills",
  "/skills/workshop",
  "/tasks",
  "/usage",
  "/workboard",
  "/worktrees",
]);
const DASHBOARD_ROOT_ASSETS = new Set([
  "/apple-touch-icon.png",
  "/favicon-32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/sw.js",
]);
const DASHBOARD_STATIC_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".png",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".webp",
]);
const DASHBOARD_FONT_EXTENSIONS = new Set([".css", ".woff2"]);
const LONG_RUNNING_RPC_METHODS = new Set(["browser.request", "config.apply"]);
const defaultSessions = new OpenClawControlSessionManager();
const defaultLimiter = new OpenClawControlResourceLimiter();
const retainedMutationLeases = new Set<SystemConfigMutationLease>();

function retainMutationLeaseUntilProcessReplacement(lease: SystemConfigMutationLease): void {
  if (!retainedMutationLeases.has(lease)) retainedMutationLeases.add(lease);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for OpenClaw Dashboard`);
  return value;
}

function apiOrigin(env: NodeJS.ProcessEnv): string {
  const origin = new URL(envValue(env, "API_PUBLIC_URL"));
  if (origin.pathname !== "/" || origin.search || origin.hash ||
    (origin.protocol !== "https:" && origin.hostname !== "localhost")) {
    throw new Error("API_PUBLIC_URL must be an HTTPS origin for OpenClaw Dashboard");
  }
  return origin.origin;
}

function appOrigin(env: NodeJS.ProcessEnv): string {
  const origin = new URL(envValue(env, "APP_URL"));
  const allowedProtocol = origin.protocol === "https:" ||
    (origin.protocol === "http:" && origin.hostname === "localhost");
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password ||
    !allowedProtocol) {
    throw new Error("APP_URL must be an HTTPS origin for OpenClaw Dashboard");
  }
  return origin.origin;
}

function gatewayClass(env: NodeJS.ProcessEnv): "shared" | "isolated" {
  return isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && isIsolatedGatewayClassValue(env.GATEWAY_PROFILE)
    ? "isolated"
    : "shared";
}

function metricIdentity(env: NodeJS.ProcessEnv): OpenClawControlMetricIdentity {
  return {
    gatewayId: envValue(env, "GATEWAY_ID"),
    revisionId: envValue(env, "GATEWAY_REVISION_ID"),
    gatewayClass: gatewayClass(env),
  };
}

export function invariantContext(
  env: NodeJS.ProcessEnv,
  gatewayId: string,
  identity: ClaimedUserIdentity | null,
): SystemConfigInvariantContext | null {
  const value = gatewayClass(env);
  const brokerProviderEnv = {
    OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
    PLATFORM_OPENAI_BASE_URL: env.PLATFORM_OPENAI_BASE_URL,
    PLATFORM_VERTEX_BASE_URL: env.PLATFORM_VERTEX_BASE_URL,
  };
  if (value === "shared") return { gatewayClass: value, brokerProviderEnv };
  if (!identity) return null;
  return {
    gatewayClass: value,
    gatewayId,
    apiOrigin: apiOrigin(env),
    controlIdentity: resolveControlIdentityFromEnv(env),
    ownerUid: identity.ownerUid,
    workspaceSlug: identity.builderSlug,
    brokerProviderEnv,
  };
}

export function isOpenClawControlWsPath(pathname: string): boolean {
  return pathname === "/openclaw";
}

export function openClawControlUpstreamBase(env: NodeJS.ProcessEnv): URL {
  const url = new URL(env.OPENCLAW_GATEWAY_URL?.trim() || "http://127.0.0.1:18789");
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "[::1]" || hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (url.protocol !== "http:") throw new Error("OpenClaw Dashboard upstream must use HTTP");
  if (!loopback) throw new Error("OpenClaw Dashboard upstream must use a loopback address");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("OpenClaw Dashboard upstream must be a bare loopback origin");
  }
  return url;
}

function isNativeChatSessionSelector(parsed: URL, key: string): boolean {
  const chatSessions = parsed.searchParams.getAll(key);
  return parsed.pathname.endsWith("/openclaw/chat") &&
    key === "session" &&
    chatSessions.length === 1 &&
    /^[A-Za-z0-9:_-]{1,256}$/u.test(chatSessions[0] ?? "");
}

function controlResourceSuffix(pathname: string, gatewayId: string): string | null {
  for (const base of [`/api/g/${gatewayId}/openclaw`, "/openclaw"]) {
    if (pathname === base) return "/";
    if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  }
  return null;
}

function isEncodedResourceSegment(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return decodeURIComponent(value).length > 0;
  } catch {
    return false;
  }
}

function isDashboardControlResourcePath(pathname: string): boolean {
  const resource = /^\/(?:avatar|__openclaw__\/(?:catalog-icon|channel-avatar|link-favicon|plugin-icon|workspace-icon))\/([^/]+)$/u
    .exec(pathname);
  if (resource) return isEncodedResourceSegment(resource[1]);
  const userAvatar = /^\/api\/users\/([^/]+)\/avatar$/u.exec(pathname);
  return isEncodedResourceSegment(userAvatar?.[1]);
}

function isDashboardAssistantMediaResource(parsed: URL): boolean {
  if (parsed.pathname !== "/__openclaw__/assistant-media") return false;
  const sources = parsed.searchParams.getAll("source");
  return sources.length === 1 && sources[0]!.length > 0 && sources[0]!.length <= 8_192 &&
    [...parsed.searchParams.keys()].every((key) => key === "source");
}

function approvalIdFromEncodedDeepLink(pathname: string): string | null {
  const encodedId = pathname.slice("/approve/".length);
  if (!pathname.startsWith("/approve/") || !encodedId || encodedId.includes("/") || encodedId.length > 4_096) {
    return null;
  }
  try {
    const approvalId = decodeURIComponent(encodedId);
    return approvalId.length > 0 && approvalId !== "." && approvalId !== ".." &&
      encodeURIComponent(approvalId) === encodedId
      ? approvalId
      : null;
  } catch {
    return null;
  }
}

function isDashboardApprovalDeepLink(pathname: string): boolean {
  return approvalIdFromEncodedDeepLink(pathname) !== null;
}

function isSafeDashboardPath(rawPath: string, gatewayId: string): boolean {
  if (!rawPath.startsWith("/") || rawPath.includes("\\") || rawPath.includes("..") ||
    /%(?:2e|5c)/iu.test(rawPath)) {
    return false;
  }
  if (!/%2f/iu.test(rawPath)) return true;
  const resourceSuffix = controlResourceSuffix(rawPath, gatewayId);
  return resourceSuffix !== null && (
    isDashboardControlResourcePath(resourceSuffix) ||
    isDashboardApprovalDeepLink(resourceSuffix)
  );
}

export function openClawControlUpstreamPath(originalUrl: string, gatewayId: string): string {
  const rawPath = originalUrl.split("?", 1)[0] ?? "";
  if (!isSafeDashboardPath(rawPath, gatewayId)) {
    throw new Error("OpenClaw Dashboard request path is outside its base path");
  }
  const parsed = new URL(originalUrl, "https://octogee.invalid");
  for (const key of parsed.searchParams.keys()) {
    if (isNativeChatSessionSelector(parsed, key)) continue;
    if (/(?:token|ticket|secret|session|auth|key)/iu.test(key)) {
      throw new Error("OpenClaw Dashboard request contains a sensitive query parameter");
    }
  }
  const publicBase = `/api/g/${gatewayId}/openclaw`;
  const strippedBase = "/openclaw";
  let inboundBase: string | null = null;
  if (parsed.pathname === publicBase || parsed.pathname.startsWith(`${publicBase}/`)) {
    inboundBase = publicBase;
  } else if (parsed.pathname === strippedBase || parsed.pathname.startsWith(`${strippedBase}/`)) {
    inboundBase = strippedBase;
  }
  if (!inboundBase) throw new Error("OpenClaw Dashboard request path is outside its base path");
  const suffix = parsed.pathname.slice(inboundBase.length);
  return `/g/${gatewayId}/openclaw${suffix}${parsed.search}`;
}

function openClawControlHttpSuffix(originalUrl: string, gatewayId: string): URL {
  const parsed = new URL(originalUrl, "https://octogee.invalid");
  const publicBase = `/api/g/${gatewayId}/openclaw`;
  const strippedBase = "/openclaw";
  const inboundBase = parsed.pathname === publicBase || parsed.pathname.startsWith(`${publicBase}/`)
    ? publicBase
    : strippedBase;
  parsed.pathname = parsed.pathname.slice(inboundBase.length) || "/";
  return parsed;
}

function isDashboardStaticAsset(pathname: string): boolean {
  if (!pathname.startsWith("/assets/")) return false;
  const relativePath = pathname.slice("/assets/".length);
  if (!relativePath || relativePath.split("/").some((segment) =>
    !/^[A-Za-z0-9@+._-]+$/u.test(segment))) {
    return false;
  }
  return DASHBOARD_STATIC_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function isDashboardFontAsset(pathname: string): boolean {
  if (!pathname.startsWith("/fonts/")) return false;
  const filename = pathname.slice("/fonts/".length);
  return /^[A-Za-z0-9@+._-]+$/u.test(filename) &&
    DASHBOARD_FONT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function isDashboardProviderIcon(pathname: string): boolean {
  return /^\/provider-icons\/ProviderIcon-[A-Za-z0-9_-]+\.svg$/u.test(pathname);
}

function isDashboardArtwork(pathname: string): boolean {
  return /^\/(?:plugin-art|community-art)\/[A-Za-z0-9_-]+\.webp$/u.test(pathname);
}

function isDashboardTheme(pathname: string): boolean {
  return /^\/themes\/[A-Za-z0-9_-]+\.css$/u.test(pathname);
}

function isDashboardBundledAsset(pathname: string): boolean {
  return DASHBOARD_ROOT_ASSETS.has(pathname) ||
    isDashboardStaticAsset(pathname) ||
    isDashboardFontAsset(pathname) ||
    isDashboardProviderIcon(pathname) ||
    isDashboardArtwork(pathname) ||
    isDashboardTheme(pathname);
}

function isDashboardSessionRoute(pathname: string): boolean {
  const match = /^\/(?:chat|dashboard)\/([A-Za-z0-9][A-Za-z0-9._~-]{0,511})\/(.+)$/u.exec(pathname);
  if (!match) return false;
  const segments = match[2]!.split("/");
  if (segments[0] === "~key") segments.shift();
  return segments.length > 0 && segments.every((segment) => {
    if (!/^[A-Za-z0-9._~:%-]{1,512}$/u.test(segment)) return false;
    try {
      return !/[\p{Cc}\\/]/u.test(decodeURIComponent(segment));
    } catch {
      return false;
    }
  });
}

function isDashboardDynamicRoute(pathname: string): boolean {
  const segment = "[A-Za-z0-9][A-Za-z0-9._~:%-]{0,511}";
  return new RegExp(`^/(?:chat|dashboard)/${segment}$`, "iu").test(pathname) ||
    new RegExp(`^/settings/agents/${segment}(?:/${segment})?$`, "iu").test(pathname) ||
    new RegExp(`^/workboard/${segment}$`, "iu").test(pathname) ||
    /^\/settings\/memory\/(?:memories|dreams|settings)$/iu.test(pathname) ||
    pathname.toLowerCase() === "/settings/plugins/discover";
}

export function isOpenClawControlHttpResource(originalUrl: string, gatewayId: string): boolean {
  openClawControlUpstreamPath(originalUrl, gatewayId);
  const parsed = openClawControlHttpSuffix(originalUrl, gatewayId);
  const route = parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  return route === "/" ||
    route === "/control-ui-config.json" ||
    DASHBOARD_ROUTES.has(route.toLowerCase()) ||
    isDashboardDynamicRoute(route) ||
    isDashboardSessionRoute(route) ||
    isDashboardBundledAsset(route) ||
    isDashboardControlResourcePath(route) ||
    isDashboardAssistantMediaResource(parsed) ||
    isDashboardApprovalDeepLink(route);
}

function frameableContentSecurityPolicy(value: string, frameAncestor: string): string {
  const directives = value.split(";").map((directive) => directive.trim()).filter(Boolean);
  const frameAncestors = directives.findIndex((directive) => /^frame-ancestors(?:\s|$)/iu.test(directive));
  if (frameAncestors >= 0) directives[frameAncestors] = `frame-ancestors ${frameAncestor}`;
  else directives.push(`frame-ancestors ${frameAncestor}`);
  return directives.join("; ");
}

function securityHeaders(
  res: Response | http.ServerResponse,
  frameAncestor: string,
  upstreamContentSecurityPolicy?: number | string | string[],
): void {
  res.setHeader("cache-control", "no-store");
  const fallback = `${CSP_BEFORE_FRAME_ANCESTORS} ${frameAncestor}${CSP_AFTER_FRAME_ANCESTORS}`;
  let policies: string | string[] = fallback;
  if (Array.isArray(upstreamContentSecurityPolicy)) {
    policies = upstreamContentSecurityPolicy.map((value) => frameableContentSecurityPolicy(value, frameAncestor));
  } else if (typeof upstreamContentSecurityPolicy === "string") {
    policies = frameableContentSecurityPolicy(upstreamContentSecurityPolicy, frameAncestor);
  }
  res.setHeader("content-security-policy", policies);
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.removeHeader("x-frame-options");
}

function isDashboardNavigation(req: Request): boolean {
  const destination = req.get("sec-fetch-dest")?.toLowerCase();
  return destination === "document" || destination === "iframe" ||
    /(?:^|,)\s*text\/html(?:\s*;[^,]*)?(?:,|$)/iu.test(req.get("accept") ?? "");
}

function dashboardFailureDocument(
  res: Response,
  frameAncestor: string,
  status: number,
): void {
  securityHeaders(res, frameAncestor);
  const targetOrigin = JSON.stringify(frameAncestor);
  const eventType = JSON.stringify(DASHBOARD_ERROR_EVENT);
  res.status(status).type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenClaw Dashboard</title>
  <style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f8fafc;color:#1e293b;font:14px system-ui,sans-serif}.card{max-width:24rem;margin:1.5rem;padding:1.5rem;border:1px solid #e2e8f0;border-radius:.75rem;background:#fff;text-align:center}h1{margin:0 0 .5rem;font-size:1rem}p{margin:0;color:#64748b}</style>
</head>
<body>
  <main class="card"><h1>OpenClaw Dashboard</h1><p>The secure Dashboard could not load. Return to Octogee and try again.</p></main>
  <script>window.parent.postMessage({type:${eventType}},${targetOrigin})</script>
</body>
</html>`);
}

function dashboardFailure(
  req: Request,
  res: Response,
  frameAncestor: string,
  status: number,
  body: Record<string, unknown>,
): void {
  if (isDashboardNavigation(req)) {
    dashboardFailureDocument(res, frameAncestor, status);
    return;
  }
  securityHeaders(res, frameAncestor);
  res.status(status).json(body);
}

function unauthorized(req: Request, res: Response, frameAncestor: string): void {
  dashboardFailure(req, res, frameAncestor, 401, {
    error: "dashboard-session-invalid",
    relaunch: true,
  });
}

type OpenClawDashboardBrokerOutcome = "broker_timeout" | "broker_unavailable";
type OpenClawDashboardHttpOutcome =
  | "ok"
  | "policy_denied"
  | OpenClawDashboardBrokerOutcome
  | "upstream_timeout"
  | "upstream_unavailable"
  | "error";

function brokerOutcome(error: unknown): OpenClawDashboardBrokerOutcome {
  return openClawControlBrokerFailureKind(error) === "timeout"
    ? "broker_timeout"
    : "broker_unavailable";
}

function brokerFailureResponse(
  req: Request,
  res: Response,
  frameAncestor: string,
  error: unknown,
): OpenClawDashboardBrokerOutcome {
  const outcome = brokerOutcome(error);
  dashboardFailure(req, res, frameAncestor, outcome === "broker_timeout" ? 504 : 503, {
    error: outcome === "broker_timeout" ? "openclaw-broker-timeout" : "openclaw-broker-unavailable",
    retryable: true,
  });
  return outcome;
}

function brokerWsFailure(error: unknown): WsUpgradeAuthorizationError {
  return brokerOutcome(error) === "broker_timeout"
    ? new WsUpgradeAuthorizationError(504, "OPENCLAW_BROKER_TIMEOUT")
    : new WsUpgradeAuthorizationError(503, "OPENCLAW_BROKER_UNAVAILABLE");
}

function logBrokerFailure(args: {
  operation: "redeem" | "authorize";
  gatewayId: string | string[];
  revisionId: string;
  error: unknown;
}): OpenClawDashboardBrokerOutcome {
  const outcome = brokerOutcome(args.error);
  logger.warn("OpenClaw Dashboard broker request failed", {
    gatewayId: args.gatewayId,
    revisionId: args.revisionId,
    operation: args.operation,
    failure: outcome,
  });
  return outcome;
}

function logPolicyDenial(args: {
  operation: "redeem" | "authorize";
  gatewayId: string | string[];
  revisionId: string;
}): void {
  logger.info("OpenClaw Dashboard session denied by policy", args);
}

function rejectDashboardHttpRequest(
  req: Request,
  res: Response,
  frameAncestor: string,
  gatewayId: string,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    securityHeaders(res, frameAncestor);
    res.setHeader("allow", "GET, HEAD");
    res.status(405).json({ error: "method-not-allowed" });
    return true;
  }
  if (!isOpenClawControlHttpResource(req.originalUrl, gatewayId)) {
    securityHeaders(res, frameAncestor);
    res.status(404).json({ error: "dashboard-resource-not-found" });
    return true;
  }

  return false;
}

type UpstreamAuthority =
  | { kind: "token"; gatewayToken: string }
  | { kind: "proxy-identity"; headers: Record<string, string> };

function requestHeaders(
  req: Request,
  env: NodeJS.ProcessEnv,
  authority: UpstreamAuthority,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase()) && !isOpenClawProxyIdentityHeader(name)) {
      headers[name] = value;
    }
  }
  headers.host = openClawControlUpstreamBase(env).host;
  headers.origin = apiOrigin(env);
  if (authority.kind === "token") headers.authorization = `Bearer ${authority.gatewayToken}`;
  else Object.assign(headers, authority.headers);
  headers["accept-encoding"] = "identity";
  return headers;
}

function scrubCredentialText(value: string, credentials: readonly string[]): string {
  return credentials.filter(Boolean).reduce(
    (cleaned, credential) => cleaned.replaceAll(credential, "*".repeat(credential.length)),
    value,
  );
}

function credentialScrubber(credentials: readonly string[]): Transform {
  const needles = credentials.filter(Boolean).map((value) => Buffer.from(value)).sort((a, b) => b.length - a.length);
  const overlap = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const scrub = (input: Buffer): Buffer => {
    const output = Buffer.from(input);
    for (const needle of needles) {
      let index = output.indexOf(needle);
      while (index >= 0) {
        output.fill(0x2a, index, index + needle.length);
        index = output.indexOf(needle, index + needle.length);
      }
    }
    return output;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const combined = Buffer.concat([pending, Buffer.from(chunk)]);
      const safeLength = Math.max(0, combined.length - overlap);
      const cleaned = scrub(combined);
      pending = cleaned.subarray(safeLength);
      callback(null, cleaned.subarray(0, safeLength));
    },
    flush(callback) {
      callback(null, scrub(pending));
    },
  });
}

export interface CreateOpenClawControlHttpRouterOptions {
  env?: NodeJS.ProcessEnv;
  sessions?: OpenClawControlSessionManager;
  redeem?: typeof redeemOpenClawControlTicket;
  authorize?: typeof authorizeOpenClawControlSession;
  authorizationCache?: OpenClawControlAuthorizationCache;
  loadGatewayToken?: typeof fetchGatewayToken;
  proxyIdentity?: OpenClawControlProxyIdentity;
  httpTimeoutMs?: number;
  metrics?: OpenClawControlMetrics;
}

function defaultProxyIdentity(env: NodeJS.ProcessEnv): OpenClawControlProxyIdentity {
  return createOpenClawControlProxyIdentity({
    env,
    upstreamBase: () => openClawControlUpstreamBase(env),
  });
}



function dashboardLaunchPage(query: Request["query"]): string | null {
  if (Object.keys(query).length === 0) return "new";
  return Object.keys(query).length === 1 && query.page === "talk-settings" ? "settings/talk" : null;
}

// eslint-disable-next-line max-lines-per-function -- launch and asset proxy routes share one session, policy, and metrics closure.
export function createOpenClawControlHttpRouter(
  options: CreateOpenClawControlHttpRouterOptions,
): Router {
  const env = options.env ?? process.env;
  const sessions = options.sessions ?? defaultSessions;
  const redeem = options.redeem ?? redeemOpenClawControlTicket;
  const authorizeBroker = options.authorize ?? authorizeOpenClawControlSession;
  const authorizationCache = options.authorizationCache ?? createOpenClawControlAuthorizationCache({
    authorize: authorizeBroker,
  });
  const loadGatewayToken = options.loadGatewayToken ?? fetchGatewayToken;
  const proxyIdentity = options.proxyIdentity ?? defaultProxyIdentity(env);
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const metrics = options.metrics;
  const identity = metricIdentity(env);
  const frameAncestor = appOrigin(env);
  if (!Number.isSafeInteger(httpTimeoutMs) || httpTimeoutMs <= 0) {
    throw new Error("OpenClaw Dashboard HTTP timeout must be a positive integer");
  }
  const router = Router({ mergeParams: true });
  const limitNavigation = clientRequestLimit(240);
  router.use((req, res, next) => {
    const path = req.originalUrl.split("?", 1)[0];
    if (isDashboardAssetRequest({ method: req.method, path })) return next();
    return limitNavigation(req, res, next);
  });
  router.get("/launch/:ticket", async (req: Request, res: Response) => {
    const startedAt = performance.now();
    let outcome: OpenClawDashboardHttpOutcome = "error";
    res.once("finish", () => metrics?.http(
      identity,
      "launch",
      outcome,
      (performance.now() - startedAt) / 1_000,
    ));
    try {
      const gatewayId = req.params.gatewayId;
      const revisionId = envValue(env, "GATEWAY_REVISION_ID");
      const ticket = req.params.ticket;
      if (gatewayId !== envValue(env, "GATEWAY_ID") || typeof ticket !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
        outcome = "policy_denied";
        logPolicyDenial({ operation: "redeem", gatewayId, revisionId });
        unauthorized(req, res, frameAncestor);
        return;
      }
      const page = dashboardLaunchPage(req.query);
      if (!page) {
        outcome = "policy_denied";
        securityHeaders(res, frameAncestor);
        res.status(400).json({ error: "invalid-dashboard-page" });
        return;
      }
      const sessionId = randomUUID();
      const redeemed = await redeem({ ticket, sessionId, gatewayId, revisionId, env });
      if (!redeemed || redeemed.gatewayId !== gatewayId || redeemed.revisionId !== revisionId) {
        outcome = "policy_denied";
        metrics?.session(identity, "redeem", "denied");
        logPolicyDenial({ operation: "redeem", gatewayId, revisionId });
        unauthorized(req, res, frameAncestor);
        return;
      }
      metrics?.session(identity, "redeem", "ok");
      const issued = sessions.issue({
        sessionId,
        uid: redeemed.uid,
        gatewayId,
        workspaceSlug: redeemed.workspaceSlug,
        revisionId,
        absoluteExpiresAt: redeemed.expiresAt,
      });
      securityHeaders(res, frameAncestor);
      res.setHeader("set-cookie", issued.cookie);
      res.setHeader("location", `/g/${gatewayId}/openclaw/${page}`);
      outcome = "ok";
      res.status(303).end();
    } catch (error) {
      outcome = logBrokerFailure({
        operation: "redeem",
        gatewayId: req.params.gatewayId,
        revisionId: env.GATEWAY_REVISION_ID?.trim() ?? "unknown",
        error,
      });
      metrics?.session(identity, "redeem", outcome);
      brokerFailureResponse(req, res, frameAncestor, error);
    }
  });
  // eslint-disable-next-line complexity -- the proxy handler keeps each fail-closed HTTP outcome local to its response.
  router.use(async (req: Request, res: Response) => {
    const startedAt = performance.now();
    let outcome: OpenClawDashboardHttpOutcome = "error";
    res.once("finish", () => metrics?.http(
      identity,
      "asset",
      outcome,
      (performance.now() - startedAt) / 1_000,
    ));
    try {
      const gatewayId = req.params.gatewayId;
      const revisionId = env.GATEWAY_REVISION_ID?.trim();
      if (gatewayId !== env.GATEWAY_ID || !revisionId) {
        outcome = "policy_denied";
        logPolicyDenial({ operation: "authorize", gatewayId, revisionId: revisionId ?? "unknown" });
        unauthorized(req, res, frameAncestor);
        return;
      }
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      if (!session) {
        outcome = "policy_denied";
        metrics?.session(identity, "authorize", "denied");
        logPolicyDenial({ operation: "authorize", gatewayId, revisionId });
        unauthorized(req, res, frameAncestor);
        return;
      }
      let allowed: boolean;
      try {
        allowed = await authorizationCache.authorize({
          sessionId: session.sessionId,
          gatewayId,
          revisionId,
          env,
        });
      } catch (error) {
        outcome = logBrokerFailure({ operation: "authorize", gatewayId, revisionId, error });
        metrics?.session(identity, "authorize", outcome);
        brokerFailureResponse(req, res, frameAncestor, error);
        return;
      }
      if (!allowed) {
        outcome = "policy_denied";
        metrics?.session(identity, "authorize", "denied");
        sessions.revoke(session.sessionId);
        logPolicyDenial({ operation: "authorize", gatewayId, revisionId });
        unauthorized(req, res, frameAncestor);
        return;
      }
      metrics?.session(identity, "authorize", "ok");
      if (rejectDashboardHttpRequest(req, res, frameAncestor, gatewayId)) return;
      const touched = sessions.touchSession(session);
      if (!touched) {
        outcome = "policy_denied";
        unauthorized(req, res, frameAncestor);
        return;
      }
      if (proxyIdentity.enabled && !isDashboardBundledAsset(openClawControlHttpSuffix(req.originalUrl, gatewayId).pathname)) {
        await proxyIdentity.syncChannelMemberships(session);
      }
      const gatewayToken = proxyIdentity.enabled ? "" : await loadGatewayToken({ gatewayId });
      const authority: UpstreamAuthority = proxyIdentity.enabled
        ? { kind: "proxy-identity", headers: proxyIdentity.userHeaders(session, req) }
        : { kind: "token", gatewayToken };
      const base = openClawControlUpstreamBase(env);
      let timedOut = false;
      let settled = false;
      const proxy = http.request({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: req.method,
        path: openClawControlUpstreamPath(req.originalUrl, gatewayId),
        headers: requestHeaders(req, env, authority),
      }, (upstream) => {
        settled = true;
        if (upstream.statusCode === 206) {
          outcome = "upstream_unavailable";
          logger.warn("OpenClaw Dashboard upstream returned a partial response", {
            gatewayId,
          });
          upstream.resume();
          res.setHeader("set-cookie", touched.cookie);
          dashboardFailure(req, res, frameAncestor, 502, {
            error: "openclaw-partial-response-rejected",
          });
          return;
        }
        res.status(upstream.statusCode ?? 502);
        outcome = (upstream.statusCode ?? 502) < 500 ? "ok" : "upstream_unavailable";
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value !== undefined && ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            const scrubbed = Array.isArray(value)
              ? value.map((item) => scrubCredentialText(item, [gatewayToken]))
              : scrubCredentialText(String(value), [gatewayToken]);
            res.setHeader(name, scrubbed);
          }
        }
        securityHeaders(res, frameAncestor, res.getHeader("content-security-policy"));
        res.setHeader("set-cookie", touched.cookie);
        upstream.pipe(credentialScrubber([gatewayToken])).pipe(res);
      });
      proxy.setTimeout(httpTimeoutMs, () => {
        timedOut = true;
        proxy.destroy();
      });
      proxy.once("error", () => {
        if (settled || res.headersSent) {
          res.destroy();
          return;
        }
        if (timedOut) {
          outcome = "upstream_timeout";
          dashboardFailure(req, res, frameAncestor, 504, {
            error: "openclaw-upstream-timeout",
            retryable: true,
          });
        } else {
          outcome = "upstream_unavailable";
          dashboardFailure(req, res, frameAncestor, 502, {
            error: "openclaw-upstream-unavailable",
            retryable: true,
          });
        }
      });
      req.once("aborted", () => proxy.destroy());
      proxy.end();
    } catch (error) {
      outcome = "upstream_unavailable";
      logger.warn("OpenClaw Dashboard HTTP proxy failed", {
        gatewayId: req.params.gatewayId,
        failure: outcome,
        errorType: error instanceof Error ? error.name : typeof error,
        ...(error instanceof ChannelMembershipSyncError ? { channelSync: error.diagnostics } : {}),
      });
      if (!res.headersSent) {
        dashboardFailure(req, res, frameAncestor, 502, {
          error: "openclaw-upstream-unavailable",
          retryable: true,
        });
      } else {
        res.destroy();
      }
    }
  });
  return router;
}

function parseFrame(data: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function frameBytes(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return Buffer.byteLength(data as ArrayBuffer);
}

function configFrozen(env: NodeJS.ProcessEnv): boolean {
  const openclawDir = envValue(env, "OPENCLAW_DIR");
  return fs.existsSync(path.join(openclawDir, "system_config.freeze.json"));
}

interface PendingRpc {
  category: OpenClawControlRpcCategory;
  method: string;
  internal: boolean;
  timeoutMs: number;
  proposed?: Record<string, unknown>;
  responseProjector?: (frame: Record<string, unknown>) => Record<string, unknown>;
  lease: OpenClawControlLease;
  mutationLease?: SystemConfigMutationLease;
  mutationDispatched: boolean;
  timer: NodeJS.Timeout;
}

interface ActiveMattermostPreparation {
  controller: AbortController;
  releaseRequest(): void;
  timer: NodeJS.Timeout;
}

function mattermostPreparationExpired(controller: AbortController, deadlineAt: number): boolean {
  return controller.signal.aborted || Date.now() >= deadlineAt;
}

function browserCannotReceive(closing: boolean, browser: WebSocket): boolean {
  return closing || browser.readyState !== WebSocket.OPEN;
}

function mattermostProjectionOptions(
  preparation: MattermostChatPreparation | null,
): { responseProjector?: (frame: Record<string, unknown>) => Record<string, unknown> } {
  if (preparation?.kind !== "upstream") return {};
  return { responseProjector: preparation.project };
}

function mattermostOutboundFrame(
  outbound: Record<string, unknown>,
  preparation: MattermostChatPreparation | null,
): Record<string, unknown> {
  if (preparation?.kind !== "upstream" || !preparation.upstreamParams) return outbound;
  return { ...outbound, params: preparation.upstreamParams };
}

export function openClawControlRpcDeadlineMs(args: {
  category: OpenClawControlRpcCategory;
  method: string;
  overrideMs?: number;
}): number {
  if (args.overrideMs !== undefined) return args.overrideMs;
  if (LONG_RUNNING_RPC_METHODS.has(args.method)) return DEFAULT_LONG_RUNNING_RPC_TIMEOUT_MS;
  if (args.category === "config_mutation" || args.category === "approval_mutation" ||
    args.category === "tools_invoke") {
    return DEFAULT_MUTATION_RPC_TIMEOUT_MS;
  }
  return DEFAULT_RPC_TIMEOUT_MS;
}

export interface MobileControlTransport {
  role: 'node' | 'operator';
  prepareConnect(frame: Record<string, unknown>, nonce: string): Promise<string>;
  acceptFrame(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeRequest(frame: Record<string, unknown>): void;
  prepareRequest?(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  projectFrame?(frame: Record<string, unknown>): Record<string, unknown>;
  authorize(): Promise<boolean>;
}

export interface BridgeControlSocketArgs {
  mobile?: MobileControlTransport;
  desktopTickets: DesktopObserverTickets;
  browser: WebSocket;
  requestPath: string;
  cookieHeader?: string;
  session: OpenClawControlSession;
  sessions: OpenClawControlSessionManager;
  env: NodeJS.ProcessEnv;
  authorizationCache: OpenClawControlAuthorizationCache;
  loadGatewayToken: typeof fetchGatewayToken;
  proxyIdentity: OpenClawControlProxyIdentity;
  request: Pick<http.IncomingMessage, "socket">;
  limiter: OpenClawControlResourceLimiter;
  socketLease: OpenClawControlLease;
  rpcTimeoutOverrideMs?: number;
  authorizationIntervalMs: number;
  metrics?: OpenClawControlMetrics;
  mattermostChat: MattermostControlChat;
  workspaceServing: WorkspaceServingResolver;
  retainMutationLeaseUntilProcessReplacement: (
    lease: SystemConfigMutationLease,
    reason: string,
  ) => void;
}

interface BrowserRpcFrame extends Record<string, unknown> {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

function browserRpcFrame(data: RawData): BrowserRpcFrame | null {
  const frame = parseFrame(data);
  if (!frame || typeof frame.id !== "string" || typeof frame.method !== "string") return null;
  if (frame.params === undefined) frame.params = {};
  if (!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) return null;
  return frame as BrowserRpcFrame;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

class OpenClawControlSocketBridge {
  private readonly identity: OpenClawControlResourceIdentity;
  private readonly metricsIdentity: OpenClawControlMetricIdentity;
  private activeSession: OpenClawControlSession;
  private gatewayToken = "";
  private upstream?: WebSocket;
  private nonce: string | null = null;
  private bufferedConnect?: BrowserRpcFrame;
  private connectForwarded = false;
  private installedMethods?: Set<string>;
  private nativeScopes: ReadonlySet<string> = new Set();
  private currentConfig?: OpenClawConfigSnapshot;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly admittingIds = new Set<string>();
  private readonly mattermostPreparations = new Map<string, ActiveMattermostPreparation>();
  private readonly mattermostWatches = new Map<string, AbortController>();
  private readonly timedOut = new Map<string, SystemConfigMutationLease | undefined>();
  private quarantineTimer?: NodeJS.Timeout;
  private authorizationTimer?: NodeJS.Timeout;
  private nextProfileSyncAt = 0;
  private profileSyncPending = false;
  private upstreamMessages = Promise.resolve();
  private queuedUpstreamFrames = 0;
  private queuedUpstreamBytes = 0;
  private closing = false;
  private socketReleased = false;

  constructor(private readonly args: BridgeControlSocketArgs) {
    this.activeSession = args.session;
    this.identity = {
      uid: args.session.uid,
      gatewayId: args.session.gatewayId,
      sessionId: args.session.sessionId,
    };
    this.metricsIdentity = metricIdentity(args.env);
  }

  private connectIdentity(): OpenClawConnectIdentity {
    if (!this.args.proxyIdentity.enabled) {
      return { mode: "shared-operator", gatewayToken: this.gatewayToken };
    }
    return {
      mode: "per-user",
      device: this.args.proxyIdentity.deviceIdentity(this.activeSession),
      scopes: this.args.proxyIdentity.connectScopes(this.activeSession),
    };
  }

  async start(): Promise<void> {
    const perUser = this.args.proxyIdentity.enabled;
    this.gatewayToken = perUser
      ? ""
      : await this.args.loadGatewayToken({ gatewayId: this.args.session.gatewayId });
    if (this.args.browser.readyState !== WebSocket.OPEN) {
      this.args.socketLease.release();
      return;
    }
    const base = openClawControlUpstreamBase(this.args.env);
    const upstreamUrl = new URL(this.args.requestPath, base);
    upstreamUrl.protocol = "ws:";
    this.upstream = new WebSocket(upstreamUrl, {
      maxPayload: MAX_UPSTREAM_WS_FRAME_BYTES,
      ...(perUser
        ? { headers: this.args.proxyIdentity.userHeaders(this.args.session, this.args.request) }
        : {}),
    });
    this.args.metrics?.ws(this.metricsIdentity, "open", "ok");
    this.startAuthorizationChecks();
    this.attachSocketHandlers();
  }

  private upstreamSocket(): WebSocket {
    if (!this.upstream) throw new Error("OpenClaw Dashboard upstream is not initialized");
    return this.upstream;
  }

  private attachSocketHandlers(): void {
    const upstream = this.upstreamSocket();
    upstream.on("message", (data) => {
      if (this.closing) return;
      const bytes = frameBytes(data);
      if (this.args.mobile && (this.queuedUpstreamFrames >= 64 || this.queuedUpstreamBytes + bytes > 32 * 1024 * 1024)) {
        this.closeBoth('mobile-buffer-limited');
        return;
      }
      this.queuedUpstreamFrames += 1;
      this.queuedUpstreamBytes += bytes;
      this.upstreamMessages = this.upstreamMessages.then(() => {
        if (!this.closing) return this.handleUpstreamMessage(data);
      }).catch((error: unknown) => {
        logger.warn("OpenClaw control transport rejected", { errorType: error instanceof Error ? error.name : typeof error });
        this.closeBoth("transport-rejected");
      }).finally(() => {
        this.queuedUpstreamFrames -= 1;
        this.queuedUpstreamBytes -= bytes;
      });
    });
    upstream.once("close", () => {
      if (this.args.mobile) void this.upstreamMessages.finally(() => this.closeBoth("upstream-closed"));
      else this.closeBoth("upstream-closed");
    });
    upstream.once("error", () => this.closeBoth("upstream-unavailable"));
    this.args.browser.once("close", () => this.closeBoth("browser-closed"));
    this.args.browser.once("error", () => this.closeBoth("browser-error"));
    this.args.browser.on("message", (data, isBinary) => this.handleBrowserMessage(data, isBinary));
  }

  private startAuthorizationChecks(): void {
    this.authorizationTimer = setInterval(() => this.checkAuthorization(), this.args.authorizationIntervalMs);
    this.authorizationTimer.unref?.();
  }

  private checkAuthorization(): void {
    const local = this.args.mobile ? this.activeSession : this.args.sessions.verify({
      cookieHeader: this.args.cookieHeader,
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
    });
    if (!local) {
      this.closeBoth("session-expired");
      return;
    }
    void (this.args.mobile ? this.args.mobile.authorize() : this.args.authorizationCache.authorize({
      sessionId: this.activeSession.sessionId,
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      env: this.args.env,
    }, { forceRefresh: true })).then(async (allowed) => {
      if (allowed) {
        if (this.args.proxyIdentity.enabled) {
          await this.args.proxyIdentity.syncChannelMemberships(this.activeSession, { force: true });
        }
        if (this.closing) return;
        this.args.metrics?.session(this.metricsIdentity, "authorize", "ok");
        this.refreshProfile();
        return;
      }
      this.args.metrics?.session(this.metricsIdentity, "authorize", "policy_denied");
      logPolicyDenial({
        operation: "authorize",
        gatewayId: this.activeSession.gatewayId,
        revisionId: this.activeSession.revisionId,
      });
      this.args.sessions.revoke(this.activeSession.sessionId);
      this.closeBoth("capability-revoked");
    }).catch((error) => {
      const outcome = logBrokerFailure({
        operation: "authorize",
        gatewayId: this.activeSession.gatewayId,
        revisionId: this.activeSession.revisionId,
        error,
      });
      this.args.metrics?.session(this.metricsIdentity, "authorize", outcome);
      this.closeBoth(outcome === "broker_timeout" ? "broker-timeout" : "broker-unavailable");
    });
  }

  private refreshProfile(): void {
    if (this.closing || !this.installedMethods || !this.args.proxyIdentity.enabled
      || this.profileSyncPending || Date.now() < this.nextProfileSyncAt) return;
    this.profileSyncPending = true;
    this.nextProfileSyncAt = Date.now() + 60_000;
    void this.args.proxyIdentity.syncProfile(this.activeSession).catch((error: unknown) => {
      logger.error("OpenClaw Dashboard identity profile refresh failed", {
        gatewayId: this.activeSession.gatewayId,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { this.profileSyncPending = false; });
  }

  private touch(): boolean {
    if (this.args.mobile) return true;
    const touched = this.args.sessions.touchSession(this.activeSession);
    if (!touched) return false;
    this.activeSession = touched.session;
    return true;
  }

  private releaseMutationLease(lease: SystemConfigMutationLease): void {
    void lease.release().catch((error) => {
      logger.error("OpenClaw Dashboard config mutation lease release failed", {
        gatewayId: this.activeSession.gatewayId,
        revisionId: this.activeSession.revisionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeBoth("config-lease-release-failed");
    });
  }

  private retainMutationLease(lease: SystemConfigMutationLease, reason: string): void {
    this.args.retainMutationLeaseUntilProcessReplacement(lease, reason);
    logger.error("OpenClaw Dashboard config mutation outcome is uncertain; writer lease retained", {
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      reason,
    });
  }

  private takePending(id: string): PendingRpc | undefined {
    const item = this.pending.get(id);
    if (!item) return undefined;
    this.pending.delete(id);
    clearTimeout(item.timer);
    item.lease.release();
    return item;
  }

  private settlePending(id: string): PendingRpc | undefined {
    const item = this.takePending(id);
    if (item?.mutationLease) this.releaseMutationLease(item.mutationLease);
    return item;
  }

  private closeBoth(reason = "dashboard-session-invalid"): void {
    if (this.closing) return;
    this.closing = true;
    if (this.authorizationTimer) clearInterval(this.authorizationTimer);
    if (this.quarantineTimer) clearTimeout(this.quarantineTimer);
    this.bufferedConnect = undefined;
    for (const watch of this.mattermostWatches.values()) watch.abort();
    this.mattermostWatches.clear();
    for (const [id, preparation] of this.mattermostPreparations) {
      this.mattermostPreparations.delete(id);
      clearTimeout(preparation.timer);
      preparation.controller.abort(new DOMException(reason, "AbortError"));
      preparation.releaseRequest();
    }
    this.admittingIds.clear();
    this.retainUncertainLeases(reason);
    if (!this.socketReleased) {
      this.socketReleased = true;
      this.args.socketLease.release();
    }
    this.closeBrowser(reason);
    if (this.upstream) this.terminate(this.upstream);
    logger.debug("OpenClaw Dashboard socket closed", {
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      reason,
    });
    this.args.metrics?.ws(this.metricsIdentity, "close", reason);
  }

  private terminate(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate();
  }

  private closeBrowser(reason: string): void {
    if (this.args.browser.readyState === WebSocket.CONNECTING) {
      this.args.browser.terminate();
      return;
    }
    if (this.args.browser.readyState !== WebSocket.OPEN) return;
    const policyFailure = reason === "session-expired" || reason === "capability-revoked" ||
      reason === "invalid-dashboard-frame" || reason === "protocol-invalid";
    this.args.browser.close(policyFailure ? 1008 : 1011, reason);
  }

  private retainUncertainLeases(reason: string): void {
    for (const [id, mutationLease] of this.timedOut) {
      this.timedOut.delete(id);
      if (mutationLease) this.retainMutationLease(mutationLease, reason);
    }
    for (const id of [...this.pending.keys()]) {
      const item = this.takePending(id);
      if (item?.mutationLease) {
        if (item.mutationDispatched) this.retainMutationLease(item.mutationLease, reason);
        else this.releaseMutationLease(item.mutationLease);
      }
    }
  }

  private quarantine(
    id: string,
    timeoutMs: number,
    mutationLease?: SystemConfigMutationLease,
  ): void {
    this.timedOut.set(id, mutationLease);
    if (this.quarantineTimer) return;
    this.quarantineTimer = setTimeout(() => this.closeBoth("request-timeout"), timeoutMs);
    this.quarantineTimer.unref?.();
  }

  private drainQuarantined(id: string): boolean {
    if (!this.timedOut.has(id)) return false;
    const mutationLease = this.timedOut.get(id);
    this.timedOut.delete(id);
    if (mutationLease) this.releaseMutationLease(mutationLease);
    if (this.timedOut.size === 0 && this.quarantineTimer) {
      clearTimeout(this.quarantineTimer);
      this.quarantineTimer = undefined;
    }
    return true;
  }

  private track(
    id: string,
    method: string,
    category: OpenClawControlRpcCategory,
    lease: OpenClawControlLease,
    options: {
      internal?: boolean;
      proposed?: Record<string, unknown>;
      mutationLease?: SystemConfigMutationLease;
      mutationDispatched?: boolean;
      responseProjector?: (frame: Record<string, unknown>) => Record<string, unknown>;
      timerMs?: number;
    } = {},
  ): void {
    const pendingRpc = {} as PendingRpc;
    const timeoutMs = openClawControlRpcDeadlineMs({
      category,
      method,
      overrideMs: this.args.rpcTimeoutOverrideMs,
    });
    const timer = setTimeout(
      () => this.expirePending(id, method, category, pendingRpc),
      options.timerMs ?? timeoutMs,
    );
    timer.unref?.();
    Object.assign(pendingRpc, {
      category,
      method,
      internal: options.internal ?? false,
      timeoutMs,
      proposed: options.proposed,
      responseProjector: options.responseProjector,
      lease,
      mutationLease: options.mutationLease,
      mutationDispatched: options.mutationDispatched ?? true,
      timer,
    });
    this.pending.set(id, pendingRpc);
  }

  private expirePending(
    id: string,
    method: string,
    category: OpenClawControlRpcCategory,
    pendingRpc: PendingRpc,
  ): void {
    if (this.pending.get(id) !== pendingRpc) return;
    const expired = this.takePending(id);
    if (pendingRpc.internal) {
      this.closeBoth("request-timeout");
      return;
    }
    if (expired?.mutationLease && !expired.mutationDispatched) this.releaseMutationLease(expired.mutationLease);
    this.quarantine(id, pendingRpc.timeoutMs, expired?.mutationDispatched ? expired.mutationLease : undefined);
    if (this.args.browser.readyState === WebSocket.OPEN) {
      this.args.browser.send(openClawControlTimeoutError({ type: "req", id, method, params: {} }));
      this.args.metrics?.rpc(this.metricsIdentity, category, "timeout");
    }
  }

  private async handleUpstreamMessage(data: RawData): Promise<void> {
    let frame = parseFrame(data);
    if (!frame) {
      this.closeBoth("protocol-invalid");
      return;
    }
    const receivedNonce = challengeNonce(frame);
    this.nonce = receivedNonce ?? this.nonce;
    if (receivedNonce) this.flushBufferedConnect();
    frame = await this.prepareMobileUpstreamFrame(frame, receivedNonce);
    if (!frame) return;
    const response = isResponseFrame(frame) ? frame : undefined;
    if (frame.type === "res" && !response) {
      this.closeBoth("protocol-invalid");
      return;
    }
    if (response && this.drainQuarantined(response.id)) return;
    const request = response ? this.settlePending(response.id) : undefined;
    this.acceptNativeScopes(frame, request);
    this.acceptInstalledMethods(frame);
    this.updateCurrentConfig(frame, request);
    this.refreshConfigAfterMutation(frame, request);
    this.forwardProjectedFrame(request?.responseProjector?.(frame) ?? frame, request);
  }

  private async prepareMobileUpstreamFrame(frame: Record<string, unknown>, receivedNonce: string | null): Promise<Record<string, unknown> | null> {
    if (!this.args.mobile || receivedNonce) return frame;
    const responsePending = frame.type === 'res' && typeof frame.id === 'string' && this.pending.has(frame.id);
    if (!this.installedMethods && !responsePending) return null;
    return this.args.mobile.acceptFrame(frame);
  }

  private forwardProjectedFrame(
    frame: Record<string, unknown>,
    request: PendingRpc | undefined,
  ): void {
    if (request?.internal || this.args.browser.readyState !== WebSocket.OPEN) return;
    let projected = frame;
    if (!this.args.mobile && projected && request?.method === "desktop.observe") {
      try {
        projected = this.args.desktopTickets.project(projected, this.activeSession);
      } catch (error) {
        logger.error("OpenClaw desktop observer response rejected", {
          gatewayId: this.activeSession.gatewayId, error: error instanceof Error ? error.message : String(error),
        });
        projected = { type: "res", id: frame.id, ok: false,
          error: { code: "UNAVAILABLE", message: "Desktop observer could not be attached" } };
      }
    }
    if (projected) this.sendProjectedFrame(projected);
  }

  private sendProjectedFrame(frame: Record<string, unknown>): void {
    if (this.args.mobile) {
      if (this.args.browser.bufferedAmount > 32 * 1024 * 1024) { this.closeBoth('mobile-buffer-limited'); return; }
      this.args.browser.send(JSON.stringify(this.args.mobile.projectFrame?.(frame) ?? frame));
    } else this.args.browser.send(sanitizeOpenClawControlServerFrame(frame, [this.gatewayToken]));
  }

  private acceptNativeScopes(frame: Record<string, unknown>, request: PendingRpc | undefined): void {
    if (request?.method === "connect" && frame.ok === true) {
      const auth = (frame.payload as { auth?: { scopes?: unknown } } | undefined)?.auth;
      this.nativeScopes = new Set(Array.isArray(auth?.scopes) ? auth.scopes.filter((scope): scope is string => typeof scope === "string") : []);
    }
  }

  private acceptInstalledMethods(frame: Record<string, unknown>): void {
    const methods = installedMethodsFromHello(frame);
    if (methods) this.installedMethods = methods;
  }

  private updateCurrentConfig(frame: Record<string, unknown>, request: PendingRpc | undefined): void {
    const snapshot = openClawConfigSnapshotFromGetResponse(frame, request?.method);
    if (snapshot) this.currentConfig = snapshot;
    if (request?.proposed && frame.ok === true) {
      this.currentConfig = { raw: request.proposed, hash: this.currentConfig?.hash ?? "" };
    }
  }

  private refreshConfigAfterMutation(frame: Record<string, unknown>, request: PendingRpc | undefined): void {
    if (request?.category !== "config_mutation" || frame.ok !== true) return;
    const upstream = this.upstreamSocket();
    if (upstream.readyState !== WebSocket.OPEN || !this.installedMethods?.has("config.get")) return;
    const lease = this.args.limiter.acquireRequest(this.identity);
    if (!lease) return;
    const refreshId = `octogee-config-refresh-${randomUUID()}`;
    this.track(refreshId, "config.get", "read", lease, { internal: true });
    upstream.send(JSON.stringify({ type: "req", id: refreshId, method: "config.get", params: {} }));
  }

  private browserFrameLimit(): number {
    return this.args.mobile && this.installedMethods ? MAX_UPSTREAM_WS_FRAME_BYTES : MAX_BROWSER_WS_FRAME_BYTES;
  }

  private handleBrowserMessage(data: RawData, isBinary: boolean): void {
    const upstream = this.upstreamSocket();
    if (!this.touch() || isBinary || frameBytes(data) > this.browserFrameLimit()) {
      this.closeBoth("invalid-dashboard-frame");
      return;
    }
    if (this.args.mobile?.role === 'node' && this.installedMethods) {
      this.upstreamSocket().send(data);
      return;
    }
    const frame = browserRpcFrame(data);
    if (!frame) {
      if (this.args.browser.readyState === WebSocket.OPEN) {
        this.args.browser.send(openClawControlPolicyError(parseFrame(data), "invalid-frame"));
      }
      return;
    }
    if (this.rejectQuarantined(frame) || this.rejectPending(frame)) return;
    if (frame.method === "connect") {
      this.acceptConnect(frame);
      return;
    }
    if (upstream.readyState !== WebSocket.OPEN) {
      this.closeBoth("invalid-dashboard-frame");
      return;
    }
    if (!this.installedMethods) {
      this.args.browser.send(openClawControlPolicyError(frame, "connect-state"));
      return;
    }
    this.evaluateAndForward(frame);
  }

  private rejectQuarantined(frame: BrowserRpcFrame): boolean {
    if (this.timedOut.has(frame.id)) {
      this.args.browser.send(openClawControlPolicyError(frame, "request-id-quarantined"));
      this.recordPolicyDenial("unknown", "request-id-quarantined");
      return true;
    }
    const category = openClawControlRpcCategory(frame.method);
    if (this.timedOut.size === 0 || category === "read" || category === "approval_read") return false;
    this.args.browser.send(JSON.stringify({
      type: "res", id: frame.id, ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "An earlier OpenClaw operation is still pending. Wait for it to finish or for the Dashboard to reconnect before retrying.",
        details: { reason: "upstream-quarantined" },
      },
    }));
    this.args.metrics?.rpc(this.metricsIdentity, category, "timeout");
    return true;
  }

  private rejectPending(frame: BrowserRpcFrame): boolean {
    if (!this.pending.has(frame.id) && !this.admittingIds.has(frame.id)) return false;
    this.args.browser.send(openClawControlPolicyError(frame, "request-id-pending"));
    return true;
  }

  private acceptConnect(frame: BrowserRpcFrame): void {
    if (this.connectForwarded || this.bufferedConnect || this.installedMethods) {
      this.args.browser.send(openClawControlPolicyError(frame, "connect-state"));
      return;
    }
    if (this.upstreamSocket().readyState !== WebSocket.OPEN || !this.nonce) {
      this.bufferedConnect = frame;
      return;
    }
    this.forwardConnect(frame);
  }

  private flushBufferedConnect(): void {
    const frame = this.bufferedConnect;
    if (!frame || !this.nonce || this.upstreamSocket().readyState !== WebSocket.OPEN) return;
    this.bufferedConnect = undefined;
    this.forwardConnect(frame);
  }

  private forwardConnect(frame: BrowserRpcFrame): void {
    if (this.connectForwarded || !this.nonce || this.installedMethods) {
      this.args.browser.send(openClawControlPolicyError(frame, "connect-state"));
      return;
    }
    const lease = this.args.limiter.acquireRequest(this.identity);
    if (!lease) {
      this.args.browser.send(openClawControlPolicyError(frame, "inflight-limited"));
      return;
    }
    const rewritten = this.args.mobile ? JSON.stringify(frame) : rewriteTrustedOpenClawConnect({
      frame,
      nonce: this.nonce,
      identity: this.connectIdentity(),
    });
    if (!rewritten) {
      lease.release();
      this.args.browser.send(openClawControlPolicyError(frame, "invalid-frame"));
      return;
    }
    this.connectForwarded = true;
    this.track(frame.id, "connect", "unknown", lease);
    if (!this.args.proxyIdentity.enabled) {
      this.upstreamSocket().send(rewritten);
      return;
    }
    void this.args.proxyIdentity.syncProfile(this.activeSession)
      .then(() => this.args.proxyIdentity.syncChannelMemberships(this.activeSession, { force: true }))
      .then(
      () => {
        if (this.closing || this.upstreamSocket().readyState !== WebSocket.OPEN) return;
        this.nextProfileSyncAt = Date.now() + 60_000;
        if (this.args.mobile) {
          void this.args.mobile.prepareConnect(frame, this.nonce!).then(value => {
            if (!this.closing && this.upstreamSocket().readyState === WebSocket.OPEN) this.upstreamSocket().send(value);
          }).catch((error: unknown) => {
            this.settlePending(frame.id);
            if (this.args.browser.readyState === WebSocket.OPEN) this.args.browser.send(JSON.stringify({ type: 'res', id: frame.id, ok: false,
              error: { code: 'INVALID_REQUEST', message: 'Mobile connection rejected. Create a new QR if setup was interrupted.', details: { code: 'AUTH_BOOTSTRAP_TOKEN_INVALID' } } }));
            logger.warn('Mobile connect rejected', { errorType: error instanceof Error ? error.name : typeof error });
            this.closeBoth('mobile-connect-rejected');
          });
        } else this.upstreamSocket().send(rewritten);
      },
      (error: unknown) => {
        logger.error("OpenClaw Dashboard identity profile sync failed", {
          gatewayId: this.activeSession.gatewayId,
          revisionId: this.activeSession.revisionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.settlePending(frame.id);
        if (this.args.browser.readyState === WebSocket.OPEN) {
          this.args.browser.send(openClawControlPolicyError(frame, "identity-sync-failed"));
        }
        this.closeBoth("identity-sync-failed");
      },
    );
  }

  private servingDenial(category: OpenClawControlRpcCategory) {
    return category === "read" || category === "approval_read"
      ? null : workspaceServingDenial(this.args.workspaceServing());
  }

  private freshWriteAuthority(category: OpenClawControlRpcCategory): Promise<boolean> {
    if (this.args.mobile) return this.args.mobile.authorize();
    if (category === "read" || category === "approval_read") return Promise.resolve(true);
    return this.args.authorizationCache.authorize({
      sessionId: this.activeSession.sessionId,
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      env: this.args.env,
    }, { forceRefresh: true });
  }

  private evaluateAndForward(frame: BrowserRpcFrame): void {
    const category = openClawControlRpcCategory(frame.method);
    const managedConfigWrite = category === "config_mutation";
    const denial = this.servingDenial(category);
    if (denial) {
      this.deny(frame, { allowed: false, category, reason: denial }, denial);
      return;
    }
    const evaluated = this.args.proxyIdentity.enabled && !managedConfigWrite;
    const context = evaluated ? null : invariantContext(this.args.env, this.activeSession.gatewayId, claimedUserIdentity());
    if (!evaluated && !context) {
      this.deny(frame, { allowed: false, category, reason: "workspace-not-serving" }, "workspace-not-serving");
      return;
    }
    const decision: OpenClawControlRpcDecision = evaluated
      ? { allowed: true, category, outbound: frame }
      : evaluateOpenClawControlRpc(frame, {
        installedMethods: this.installedMethods!,
        invariantContext: context!,
        currentConfig: this.currentConfig,
        configFrozen: configFrozen(this.args.env),
      }, !this.args.proxyIdentity.enabled || this.nativeScopes.has("operator.admin"));
    if (!decision.allowed) {
      this.deny(frame, decision, decision.reason ?? "method-denied");
      return;
    }
    if (isOpenClawControlMutation(decision.category) && !this.args.limiter.consumeMutation(this.identity)) {
      this.deny(frame, decision, "rate-limited");
      return;
    }
    const lease = this.args.limiter.acquireRequest(this.identity);
    if (!lease) {
      this.deny(frame, decision, "inflight-limited");
      return;
    }
    void this.forwardAllowed(frame, decision, lease).catch((error) => {
      this.admittingIds.delete(frame.id);
      logger.error("OpenClaw Dashboard RPC forwarding failed", {
        gatewayId: this.activeSession.gatewayId,
        revisionId: this.activeSession.revisionId,
        category: decision.category,
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeBoth("rpc-forward-failed");
    });
  }

  private deny(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    reason: string,
    sendResponse = true,
  ): void {
    if (sendResponse) this.args.browser.send(openClawControlPolicyError(frame, reason));
    const outcome = reason === "rate-limited" || reason === "inflight-limited" ? "rate_limited" : "denied";
    this.recordPolicyDenial(decision.category, reason, outcome);
  }

  private recordPolicyDenial(
    category: OpenClawControlRpcCategory,
    reason: string,
    outcome: "denied" | "rate_limited" = "denied",
  ): void {
    logger.warn("OpenClaw Dashboard RPC denied by policy", {
      gatewayId: this.activeSession.gatewayId,
      revisionId: this.activeSession.revisionId,
      category,
      reason,
    });
    this.args.metrics?.rpc(this.metricsIdentity, category, outcome);
    this.args.metrics?.policy(this.metricsIdentity, reason.replaceAll("-", "_"));
  }

  private async authorizePreparedRequest(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    deadlineAt: number,
    releaseRequest: () => void,
    expireBeforeForward: () => void,
  ): Promise<number | null> {
    let remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      expireBeforeForward();
      return null;
    }
    let allowed: boolean;
    try {
      allowed = await awaitWithAbort(this.freshWriteAuthority(decision.category), AbortSignal.timeout(remainingMs));
    } catch (error) {
      if (Date.now() >= deadlineAt) {
        expireBeforeForward();
        return null;
      }
      releaseRequest();
      throw error;
    }
    if (browserCannotReceive(this.closing, this.args.browser)) {
      releaseRequest();
      return null;
    }
    if (!allowed) {
      releaseRequest();
      this.deny(frame, decision, "capability-revoked");
      return null;
    }
    const denial = this.servingDenial(decision.category);
    if (denial) {
      releaseRequest();
      this.deny(frame, { allowed: false, category: decision.category, reason: denial }, denial);
      return null;
    }
    remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      expireBeforeForward();
      return null;
    }
    return remainingMs;
  }

  private async prepareMobileRequest(frame: BrowserRpcFrame, signal: AbortSignal, decision: OpenClawControlRpcDecision): Promise<BrowserRpcFrame> {
    frame = (decision.outbound ?? frame) as BrowserRpcFrame;
    if (!this.args.mobile?.prepareRequest) return frame;
    return await awaitWithAbort(this.args.mobile.prepareRequest(frame), signal) as BrowserRpcFrame;
  }

  private async forwardAllowed(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    lease: OpenClawControlLease,
  ): Promise<void> {
    const timeoutMs = openClawControlRpcDeadlineMs({
      category: decision.category,
      method: frame.method,
      overrideMs: this.args.rpcTimeoutOverrideMs,
    });
    const deadlineAt = Date.now() + timeoutMs;
    const preparationController = new AbortController();
    let requestReleased = false;
    const releaseRequest = (mutationLease?: SystemConfigMutationLease): void => {
      if (mutationLease) this.releaseMutationLease(mutationLease);
      if (requestReleased) return;
      requestReleased = true;
      lease.release();
    };
    const preparationTimer = setTimeout(() => {
      preparationController.abort(new DOMException("OpenClaw Dashboard RPC timed out", "TimeoutError"));
    }, timeoutMs);
    preparationTimer.unref?.();
    const preparation: ActiveMattermostPreparation = {
      controller: preparationController,
      releaseRequest,
      timer: preparationTimer,
    };
    this.mattermostPreparations.set(frame.id, preparation);
    const finishPreparation = (): void => {
      if (this.mattermostPreparations.get(frame.id) !== preparation) return;
      this.mattermostPreparations.delete(frame.id);
      clearTimeout(preparationTimer);
    };
    const expireBeforeForward = (mutationLease?: SystemConfigMutationLease): void => {
      finishPreparation();
      releaseRequest(mutationLease);
      if (this.args.browser.readyState === WebSocket.OPEN) {
        this.args.browser.send(openClawControlTimeoutError(frame));
        this.args.metrics?.rpc(this.metricsIdentity, decision.category, "timeout");
      }
    };
    this.admittingIds.add(frame.id);
    let mattermost;
    try {
      if (!await awaitWithAbort(this.freshWriteAuthority(decision.category), preparationController.signal)) {
        finishPreparation();
        releaseRequest();
        this.deny(frame, decision, "capability-revoked");
        return;
      }
      frame = await this.prepareMobileRequest(frame, preparationController.signal, decision);
      decision = { ...decision, outbound: frame };
      mattermost = await awaitWithAbort(
        this.args.mattermostChat.prepare(
          frame,
          this.activeSession,
          preparationController.signal,
        ),
        preparationController.signal,
      );
    } catch (error) {
      if (mattermostPreparationExpired(preparationController, deadlineAt)) {
        expireBeforeForward();
        return;
      }
      finishPreparation();
      releaseRequest();
      throw error;
    } finally {
      this.admittingIds.delete(frame.id);
    }
    finishPreparation();
    if (browserCannotReceive(this.closing, this.args.browser)) {
      releaseRequest();
      return;
    }
    if (mattermostPreparationExpired(preparationController, deadlineAt)) {
      expireBeforeForward();
      return;
    }
    if (mattermost?.watch) this.watchMattermost(mattermost.watch);
    if (mattermost?.kind === "response") {
      releaseRequest();
      this.forwardProjectedFrame(mattermost.frame, undefined);
      this.args.metrics?.rpc(this.metricsIdentity, decision.category, "ok");
      return;
    }
    const mutationLease = await this.acquireMutationLease(frame, decision, lease);
    if (mutationLease === null) return;
    const remainingMs = await this.authorizePreparedRequest(frame, decision, deadlineAt,
      () => releaseRequest(mutationLease), () => expireBeforeForward(mutationLease));
    if (remainingMs === null) return;
    this.track(frame.id, frame.method, decision.category, lease, {
      proposed: decision.proposedConfig,
      mutationLease,
      mutationDispatched: true,
      timerMs: remainingMs,
      ...mattermostProjectionOptions(mattermost),
    });
    this.dispatchAllowed(frame, decision, mattermost);
    this.args.metrics?.rpc(this.metricsIdentity, decision.category, "ok");
  }

  private watchMattermost(watch: NonNullable<Extract<MattermostChatPreparation, { kind: "upstream" }>["watch"]>): void {
    if (this.mattermostWatches.has(watch.sessionKey)) return;
    if (this.mattermostWatches.size >= 8) {
      const oldest = this.mattermostWatches.keys().next().value!;
      this.mattermostWatches.get(oldest)!.abort();
      this.mattermostWatches.delete(oldest);
    }
    const controller = new AbortController();
    this.mattermostWatches.set(watch.sessionKey, controller);
    void watch.run(() => {
      if (controller.signal.aborted || browserCannotReceive(this.closing, this.args.browser)) return;
      this.forwardProjectedFrame({
        type: "event", event: "sessions.changed",
        payload: { key: watch.sessionKey, sessionKey: watch.sessionKey, agentId: watch.agentId, phase: "message", reason: "message" },
      }, undefined);
    }, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      logger.error("OpenClaw Dashboard Mattermost change feed failed", {
        gatewayId: this.activeSession.gatewayId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeBoth("mattermost-feed-unavailable");
    });
  }

  private dispatchAllowed(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    mattermost: MattermostChatPreparation | null,
  ): void {
    const outbound = decision.outbound ?? frame;
    try {
      this.args.mobile?.observeRequest(frame);
      this.upstreamSocket().send(JSON.stringify(mattermostOutboundFrame(outbound, mattermost)));
    } catch (error) {
      this.settlePending(frame.id);
      throw error;
    }
  }

  private async acquireMutationLease(
    frame: BrowserRpcFrame,
    decision: OpenClawControlRpcDecision,
    lease: OpenClawControlLease,
  ): Promise<SystemConfigMutationLease | undefined | null> {
    if (decision.category !== "config_mutation") return undefined;
    this.admittingIds.add(frame.id);
    let acquired;
    try {
      acquired = await acquireSystemConfigMutationLease({
        openclawDir: envValue(this.args.env, "OPENCLAW_DIR"),
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    this.admittingIds.delete(frame.id);
    if (!acquired.ok) {
      lease.release();
      this.deny(frame, decision, "config-writer-busy", this.args.browser.readyState === WebSocket.OPEN);
      return null;
    }
    if (this.closing || this.args.browser.readyState !== WebSocket.OPEN ||
      this.upstreamSocket().readyState !== WebSocket.OPEN) {
      lease.release();
      await acquired.lease.release();
      return null;
    }
    return acquired.lease;
  }
}

export async function bridgeControlSocket(args: BridgeControlSocketArgs): Promise<void> {
  await new OpenClawControlSocketBridge(args).start();
}

export interface AttachOpenClawControlWsRouteOptions {
  router: WsUpgradeRouter;
  env?: NodeJS.ProcessEnv;
  sessions?: OpenClawControlSessionManager;
  authorize?: typeof authorizeOpenClawControlSession;
  authorizationCache?: OpenClawControlAuthorizationCache;
  loadGatewayToken?: typeof fetchGatewayToken;
  proxyIdentity?: OpenClawControlProxyIdentity;
  resourceLimiter?: OpenClawControlResourceLimiter;
  rpcTimeoutMs?: number;
  authorizationIntervalMs?: number;
  metrics?: OpenClawControlMetrics;
  mattermostChat?: MattermostControlChat;
  workspaceServing?: WorkspaceServingResolver;
  retainMutationLeaseUntilProcessReplacement?: (
    lease: SystemConfigMutationLease,
    reason: string,
  ) => void;
}

function identityMattermostChat(proxyIdentity: OpenClawControlProxyIdentity): MattermostControlChat {
  return createMattermostControlChat({
    perUserIdentity: proxyIdentity.enabled,
    ...(proxyIdentity.enabled ? { resolveChatProfile: (session, source) => proxyIdentity.resolveChatProfile(session, source) } : {}),
  });
}

function workspaceServingOf(options: Pick<AttachOpenClawControlWsRouteOptions, "workspaceServing">): WorkspaceServingResolver {
  return options.workspaceServing ?? (() => "serving");
}

export function attachOpenClawControlWsRoute(options: AttachOpenClawControlWsRouteOptions): void {
  const env = options.env ?? process.env;
  const sessions = options.sessions ?? defaultSessions;
  const authorizeBroker = options.authorize ?? authorizeOpenClawControlSession;
  const authorizationCache = options.authorizationCache ?? createOpenClawControlAuthorizationCache({
    authorize: authorizeBroker,
  });
  const loadGatewayToken = options.loadGatewayToken ?? fetchGatewayToken;
  const proxyIdentity = options.proxyIdentity ?? defaultProxyIdentity(env);
  const limiter = options.resourceLimiter ?? defaultLimiter;
  const mattermostChat = options.mattermostChat ?? identityMattermostChat(proxyIdentity);
  const workspaceServing = workspaceServingOf(options);
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const authorizationIntervalMs = options.authorizationIntervalMs ?? DEFAULT_AUTHORIZATION_INTERVAL_MS;
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 ||
    !Number.isSafeInteger(authorizationIntervalMs) || authorizationIntervalMs <= 0) {
    throw new Error("OpenClaw Dashboard timeouts must be positive integers");
  }
  const gatewayId = envValue(env, "GATEWAY_ID");
  const revisionId = envValue(env, "GATEWAY_REVISION_ID");
  const desktopTickets = new DesktopObserverTickets();
  options.router.add({
    match: (pathname) => isOpenClawControlWsPath(pathname) || pathname === "/openclaw/desktop/observe",
    extractTicket: (pathname) => {
      if (pathname === "/openclaw/desktop/observe") return pathname;
      try {
        return openClawControlUpstreamPath(pathname, gatewayId);
      } catch {
        return null;
      }
    },
    allowedOrigins: new Set([apiOrigin(env)]),
    maxPayloadBytes: MAX_BROWSER_WS_FRAME_BYTES,
    authorize: async (req) => {
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      if (!session) {
        options.metrics?.session(metricIdentity(env), "authorize", "policy_denied");
        logPolicyDenial({ operation: "authorize", gatewayId, revisionId });
        throw new WsUpgradeAuthorizationError(401, "POLICY_DENIED");
      }
      let allowed: boolean;
      try {
        allowed = await authorizationCache.authorize({
          sessionId: session.sessionId,
          gatewayId,
          revisionId,
          env,
        }, { forceRefresh: true });
      } catch (error) {
        const outcome = logBrokerFailure({ operation: "authorize", gatewayId, revisionId, error });
        options.metrics?.session(metricIdentity(env), "authorize", outcome);
        throw brokerWsFailure(error);
      }
      if (!allowed) {
        options.metrics?.session(metricIdentity(env), "authorize", "policy_denied");
        logPolicyDenial({ operation: "authorize", gatewayId, revisionId });
        throw new WsUpgradeAuthorizationError(401, "POLICY_DENIED");
      }
      options.metrics?.session(metricIdentity(env), "authorize", "ok");
      return true;
    },
    onUpgrade: ({ ws, req, ticket }) => {
      const session = sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId });
      if (!session || !ticket) {
        ws.close(1008, "dashboard-session-invalid");
        return;
      }
      const identity = {
        uid: session.uid,
        gatewayId,
        sessionId: session.sessionId,
      };
      const desktopStream = ticket === "/openclaw/desktop/observe";
      const socketLease = desktopStream
        ? limiter.acquireDesktopStream(identity)
        : limiter.acquireSocket(identity);
      if (!socketLease) {
        ws.close(1013, desktopStream ? "desktop-stream-limit" : "dashboard-socket-limit");
        return;
      }
      if (desktopStream) {
        const observerUrl = new URL(req.url ?? "/", "http://localhost");
        const upstreamPath = desktopTickets.redeem(observerUrl.searchParams.get("token") ?? "", session);
        if (!upstreamPath || [...observerUrl.searchParams.keys()].some((key) => key !== "token")) {
          socketLease.release();
          ws.close(1008, "desktop-ticket-invalid");
          return;
        }
        const upstreamUrl = new URL(upstreamPath, openClawControlUpstreamBase(env));
        upstreamUrl.protocol = "ws:";
        bridgeDesktopObserver({
          browser: ws, upstreamUrl, release: () => socketLease.release(), authorizationIntervalMs,
          touch: () => Boolean(sessions.touchSession(session)),
          log: (message) => logger.error(message, { gatewayId, revisionId }),
          authorize: async () => Boolean(sessions.verify({ cookieHeader: req.headers.cookie, gatewayId, revisionId })) &&
            await authorizationCache.authorize({ sessionId: session.sessionId, gatewayId, revisionId, env }, { forceRefresh: true }),
        });
        return;
      }
      void bridgeControlSocket({
        desktopTickets,
        browser: ws,
        requestPath: ticket,
        cookieHeader: req.headers.cookie,
        session,
        sessions,
        env,
        authorizationCache,
        loadGatewayToken,
        proxyIdentity,
        request: req,
        limiter,
        socketLease,
        rpcTimeoutOverrideMs: options.rpcTimeoutMs,
        authorizationIntervalMs,
        metrics: options.metrics,
        mattermostChat,
        workspaceServing,
        retainMutationLeaseUntilProcessReplacement:
          options.retainMutationLeaseUntilProcessReplacement ?? retainMutationLeaseUntilProcessReplacement,
      }).catch(() => {
        options.metrics?.ws(metricIdentity(env), "connect", "error");
        socketLease.release();
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.terminate();
        logger.error("OpenClaw Dashboard WebSocket bridge failed", { gatewayId, revisionId });
      });
    },
  });
}
