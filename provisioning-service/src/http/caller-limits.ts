import type { NextFunction, Request, RequestHandler, Response } from "express";
import { rateLimit, type AugmentedRequest } from "express-rate-limit";
import { callerOf } from "../auth/authenticate.js";
import type { Logger } from "../logger.js";
import { sendError } from "./errors.js";

export interface CallerLimits {
  requestsPerMinute: number;
  concurrentWaits: number;
}

const WINDOW_MS = 60_000;
const WAIT_RETRY_AFTER_SECONDS = 1;

function refuse(response: Response, retryAfterSeconds: number, error: string): void {
  response.setHeader("Retry-After", String(retryAfterSeconds));
  sendError(response, 429, "rate-limited", error);
}

export function callerRequestLimit(options: { requestsPerMinute: number; log: Logger }): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: options.requestsPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (_request, response) => callerOf(response).serviceAccount,
    handler: (request, response) => {
      const state = (request as AugmentedRequest).rateLimit;
      const serviceAccount = callerOf(response).serviceAccount;
      if (state.used === state.limit + 1) {
        options.log.warn("caller exceeded its request limit", { serviceAccount, limit: state.limit, path: request.path });
      }
      const resetAt = state.resetTime?.getTime() ?? Date.now() + WINDOW_MS;
      refuse(response, Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000)), "too many requests from this caller; retry later");
    },
  });
}

export function callerWaitLimit(options: { concurrentWaits: number; log: Logger; holds: (request: Request) => boolean }): RequestHandler {
  const active = new Map<string, number>();
  return (request: Request, response: Response, next: NextFunction) => {
    if (!options.holds(request)) return next();
    const serviceAccount = callerOf(response).serviceAccount;
    const held = active.get(serviceAccount) ?? 0;
    if (held >= options.concurrentWaits) {
      options.log.warn("caller exceeded its concurrent waits", { serviceAccount, limit: options.concurrentWaits, path: request.path });
      return refuse(response, WAIT_RETRY_AFTER_SECONDS, "too many held requests from this caller; retry later");
    }
    active.set(serviceAccount, held + 1);
    response.once("close", () => {
      const remaining = (active.get(serviceAccount) ?? 1) - 1;
      if (remaining > 0) active.set(serviceAccount, remaining);
      else active.delete(serviceAccount);
    });
    next();
  };
}
