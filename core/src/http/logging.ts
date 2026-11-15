import { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { createServiceLogger, withLogContext } from "@octogee/shared/server/service-logger";

export let logger = createServiceLogger("gateway-edge");

export function setLogService(service: "api" | "gateway-edge"): void {
  logger = createServiceLogger(service);
}

const ROUTINE_PATHS = new Set([
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/api/health",
  "/metrics",
  "/internal/fleet/assignment-roster",
  "/internal/byok/agent-model-token",
  "/internal/openclaw/activity/agent-identity",
]);

export function redactRequestPath(path: string): string {
  return path.replace(
    /((?:\/api)?\/g\/[^/]+\/openclaw\/launch\/)[^/?#]+/gu,
    "$1<redacted>",
  ).replace(/(\/p\/)[0-9a-f]{32}(?=\/|$)/gu, "$1<redacted>");
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = randomUUID();
  const requestPath = req.path;
  const path = redactRequestPath(requestPath);
  res.on("finish", () => {
    const duration = Date.now() - start;
    let level: "error" | "warn" | "debug" | "info";
    if (res.statusCode >= 500) level = "error";
    else if (res.statusCode >= 400 && ROUTINE_PATHS.has(requestPath)) level = "warn";
    else if (res.statusCode === 404 && req.route === undefined) {
      level = requestPath.startsWith("/internal/") ? "warn" : "debug";
    }
    else if (res.statusCode >= 400) level = "warn";
    else if (ROUTINE_PATHS.has(requestPath)) level = "debug";
    else level = "info";
    logger[level](`${req.method} ${path} ${res.statusCode} ${duration}ms`, {
      category: "request",
      requestId,
      ...(req.workspaceSlug ? { builderSlug: req.workspaceSlug } : {}),
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: duration,
    });
  });
  withLogContext({ category: "request", requestId }, next);
}
