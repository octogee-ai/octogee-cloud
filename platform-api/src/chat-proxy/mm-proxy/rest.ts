import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { BridgeLog } from "@octogee/core/http/bridge-log";

export interface MmRestCapture {
  status: number;
  body: string;
}

export interface MmRestProxyDeps {
  mmInternalUrl: string;
  log: BridgeLog;
  captureResponse?: (req: http.IncomingMessage) => boolean;
  onCapturedResponse?: (captured: MmRestCapture) => void;
}

export const MAX_CAPTURED_RESPONSE_BYTES = 256 * 1024;

function attachResponseCapture(
  deps: MmRestProxyDeps,
  req: http.IncomingMessage,
  upstreamRes: http.IncomingMessage,
): void {
  const onCaptured = deps.onCapturedResponse;
  if (!onCaptured) return;
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  upstreamRes.on("data", (chunk: Buffer) => {
    if (overflow) return;
    size += chunk.length;
    if (size > MAX_CAPTURED_RESPONSE_BYTES) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  upstreamRes.on("end", () => {
    if (overflow) {
      deps.log(
        `[mm-proxy/rest] captured response exceeded ${MAX_CAPTURED_RESPONSE_BYTES} bytes for ${req.method} ${req.url}; dropped`,
        "warn",
      );
      return;
    }
    try {
      onCaptured({
        status: upstreamRes.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    } catch (err) {
      deps.log(
        `[mm-proxy/rest] capture handler threw for ${req.method} ${req.url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "warn",
      );
    }
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export function forwardMmRest(
  deps: MmRestProxyDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const target = new URL(req.url ?? "/", deps.mmInternalUrl);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;

const forwardedHeaders: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value !== undefined) forwardedHeaders[key] = value;
  }
  forwardedHeaders["host"] = target.host;
  const capture = Boolean(deps.captureResponse?.(req) && deps.onCapturedResponse);
  if (capture) delete forwardedHeaders["accept-encoding"];

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: forwardedHeaders,
      timeout: 30_000,
    },
    (upstreamRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        if (value !== undefined) responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      if (capture) attachResponseCapture(deps, req, upstreamRes);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    deps.log(`[mm-proxy/rest] upstream error: ${err.message} for ${req.method} ${req.url}`, "warn");

req.unpipe(upstream);
    req.resume();
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Mattermost upstream unavailable" }));
    } else {
      res.end();
    }
  });

  upstream.on("timeout", () => {
    upstream.destroy(new Error("upstream timeout"));
  });

  req.pipe(upstream);
}
