import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ProvisioningRole } from "@octogee/shared/types/provisioning-service";
import type { Logger } from "../logger.js";
import { sendError } from "../http/errors.js";
import type { Reviewer } from "./token-review.js";

export interface Caller {
  serviceAccount: string;
  roles: readonly ProvisioningRole[];
}

const BEARER = /^Bearer ([^\s]+)$/;

export function callerOf(response: Response): Caller {
  const caller = response.locals.caller as Caller | undefined;
  if (!caller) throw new Error("route reached without an authenticated caller");
  return caller;
}

export function authenticate(options: {
  reviewer: Reviewer;
  namespace: string;
  roleTable: Readonly<Record<string, readonly ProvisioningRole[]>>;
  log: Logger;
}): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const match = BEARER.exec(request.header("authorization") ?? "");
    if (!match) return sendError(response, 401, "unauthenticated", "a bearer service account token is required");
    let review;
    try {
      review = await options.reviewer(match[1]);
    } catch (error) {
      options.log.error("token review failed", { error: error instanceof Error ? error.message : String(error) });
      response.setHeader("Retry-After", "5");
      return sendError(response, 503, "unavailable", "token review is unavailable");
    }
    if (!review.authenticated) return sendError(response, 401, "unauthenticated", "the token is not valid for this audience");
    const known = review.namespace === options.namespace && Object.hasOwn(options.roleTable, review.serviceAccount);
    const roles = known ? options.roleTable[review.serviceAccount] : undefined;
    if (!roles) {
      options.log.warn("caller has no role", { namespace: review.namespace, serviceAccount: review.serviceAccount });
      return sendError(response, 403, "forbidden", "this service account has no role here");
    }
    response.locals.caller = { serviceAccount: review.serviceAccount, roles } satisfies Caller;
    next();
  };
}

export function requireRole(...allowed: ProvisioningRole[]): RequestHandler {
  return (_request, response, next) => {
    const caller = callerOf(response);
    if (!caller.roles.some((role) => allowed.includes(role))) {
      return sendError(response, 403, "forbidden", `this route needs one of: ${allowed.join(", ")}`);
    }
    next();
  };
}
