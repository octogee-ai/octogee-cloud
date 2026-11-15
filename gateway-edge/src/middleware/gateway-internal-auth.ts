import { Request, Response, NextFunction } from "express";
import {
  isValidGatewayInternalAuth,
  resolveGatewayInternalAuthSecret,
  type GatewayInternalAuthValidationOptions,
} from "../lib/gateway-internal-auth.js";
import type { Reviewer } from "../lib/kubernetes-token-review.js";
import { logger } from "@octogee/core/http/logging";

let tokenReviewerForTests: Reviewer | null = null;

export function _setGatewayTokenReviewerForTests(reviewer: Reviewer | null): void {
  tokenReviewerForTests = reviewer;
}

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function handleGatewayInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  options: GatewayInternalAuthValidationOptions = {},
): Promise<void> {
  const secret = resolveGatewayInternalAuthSecret(process.env, options);
  if (!secret) {
    logger.error("gateway internal auth is not configured — refusing request");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  const provided = readHeader(req, secret.headerName);
  if (!provided) {
    res.status(401).json({ error: `${secret.headerName} header required` });
    return;
  }

  let valid = false;
  try {
    valid = await isValidGatewayInternalAuth(provided, process.env, {
      ...options,
      reviewer: tokenReviewerForTests ?? undefined,
    });
  } catch (err) {
    logger.error("gateway service-account TokenReview failed — refusing request", {
      err: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  if (!valid) {
    logger.warn(
      `Gateway internal auth rejected from ${req.socket.remoteAddress} — invalid ${secret.mode} credential`,
    );
    res.status(401).json({ error: "Invalid internal service key" });
    return;
  }

  next();
}

export function createGatewayInternalAuth(options: GatewayInternalAuthValidationOptions): typeof requireGatewayInternalAuth {
  return (req, res, next) => { handleGatewayInternalAuth(req, res, next, options).catch(next); };
}

export function requireGatewayInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  handleGatewayInternalAuth(req, res, next).catch(next);
}
