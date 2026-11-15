import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { validAgentControlRouterPublicKey, verifyAgentControlRouterRequest } from "@octogee/core/http-candidates/agent-control-callback-router";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const LOOPBACK_PROTOCOL = "http:";
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_LOOPBACK_ORIGIN = `${LOOPBACK_PROTOCOL}${LOOPBACK_HOST}:18789`;
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("body_read_timeout"));
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function readUpstreamBody(upstream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    upstream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        upstream.destroy(new Error("upstream_response_too_large"));
        reject(new Error("upstream_response_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    upstream.on("end", () => resolve(Buffer.concat(chunks)));
    upstream.on("error", reject);
  });
}

function responseHeaders(
  incoming: http.IncomingHttpHeaders,
  bodyLength: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const connectionHeaders = new Set(
    (typeof incoming.connection === "string" ? incoming.connection : "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      lower === "content-length" ||
      HOP_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) continue;
    headers[name] = value;
  }
  headers["content-length"] = String(bodyLength);
  return headers;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function originFormPath(url: string): string | null {
  if (!url.startsWith("/")) return null;
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface MattermostInteractionProxyInput {
  gatewayId: string;
  routerPublicKey: string;
  targetOrigin?: string;
  upstreamTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

interface MattermostInteractionProxyConfig {
  gatewayId: string;
  routerPublicKey: string;
  target: URL;
  upstreamTimeoutMs: number;
  maxResponseBytes: number;
  now: () => number;
  log: MattermostInteractionProxyInput["log"];
}

function validateTargetOrigin(targetOrigin: string | undefined): URL {
  const target = new URL(targetOrigin ?? DEFAULT_LOOPBACK_ORIGIN);
  if (
    target.protocol !== LOOPBACK_PROTOCOL ||
    target.hostname !== LOOPBACK_HOST ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("invalid Mattermost interaction targetOrigin");
  }
  return target;
}

function interactionProxyConfig(input: MattermostInteractionProxyInput): MattermostInteractionProxyConfig {
  if (!validAgentControlRouterPublicKey(input.routerPublicKey)) {
    throw new Error("AGENT_CONTROL_ROUTER_PUBLIC_KEY must be an Ed25519 public key");
  }
  const upstreamTimeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) {
    throw new Error("invalid Mattermost interaction upstreamTimeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("invalid Mattermost interaction maxResponseBytes");
  }
  return {
    gatewayId: input.gatewayId,
    routerPublicKey: input.routerPublicKey,
    target: validateTargetOrigin(input.targetOrigin),
    upstreamTimeoutMs,
    maxResponseBytes,
    now: input.now ?? Date.now,
    log: input.log,
  };
}

function createInteractionRequestHandler(
  config: MattermostInteractionProxyConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const path = originFormPath(req.url ?? "");
    const match = path && /^\/internal\/openclaw\/mattermost\/interactions\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (!match) {
      req.resume();
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "body_too_large") writeJson(res, 413, { error: "body_too_large" });
      else if (message === "body_read_timeout") writeJson(res, 400, { error: "body_read_timeout" });
      else {
        config.log("Mattermost interaction body read failed", { error: message });
        writeJson(res, 400, { error: "invalid_body" });
      }
      return;
    }
    const proof = {
      gatewayId: header(req, "x-octogee-agent-control-gateway"),
      timestamp: header(req, "x-octogee-agent-control-timestamp"),
      signature: header(req, "x-octogee-agent-control-signature"),
    };
    if (
      proof.gatewayId !== config.gatewayId ||
      !verifyAgentControlRouterRequest(body, proof, config.routerPublicKey, config.now())
    ) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const headers: http.OutgoingHttpHeaders = {
      "content-type": header(req, "content-type") || "application/json",
      "content-length": String(body.length),
    };
    let responded = false;
    const fail = (error: Error): void => {
      config.log("[mattermost-interaction-proxy] OpenClaw request failed", {
        accountId: match[1],
        error: error.message,
      });
      if (responded) return;
      responded = true;
      writeJson(res, 502, { error: "openclaw_unavailable" });
    };
    const proxy = http.request({
      protocol: config.target.protocol,
      hostname: config.target.hostname,
      port: config.target.port,
      method: "POST",
      path: `/mattermost/interactions/${match[1]}`,
      headers,
    }, async (upstream) => {
      try {
        const upstreamBody = await readUpstreamBody(upstream, config.maxResponseBytes);
        if (responded) return;
        responded = true;
        res.writeHead(
          upstream.statusCode ?? 502,
          responseHeaders(upstream.headers, upstreamBody.length),
        );
        res.end(upstreamBody);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    proxy.setTimeout(config.upstreamTimeoutMs, () => proxy.destroy(new Error("upstream_timeout")));
    proxy.on("error", fail);
    proxy.end(body);
  };
}

export function createMattermostInteractionProxyHandler(
  input: MattermostInteractionProxyInput,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return createInteractionRequestHandler(interactionProxyConfig(input));
}
