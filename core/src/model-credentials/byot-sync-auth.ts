import { Request, Response, NextFunction } from "express";
import {
  MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER,
  MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER,
  isValidModelCredentialSyncSignature,
  validModelCredentialSyncPublicKey,
} from "./byot-sync-internal-auth.js";
import { logger } from "../http/logging.js";

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function handleModelCredentialSyncInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const publicKey = nonBlank(process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY);
  const gatewayId = nonBlank(process.env.GATEWAY_ID);
  if (!publicKey || !validModelCredentialSyncPublicKey(publicKey) || !gatewayId) {
    logger.error("model credential sync public key or gateway identity is not configured");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  if (isValidModelCredentialSyncSignature({
    body: req.body,
    publicKey,
    gatewayId,
    timestamp: readHeader(req, MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER),
    signature: readHeader(req, MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER),
  })) {
    next();
    return;
  }

  logger.warn(
    `model credential sync internal auth rejected from ${req.socket.remoteAddress}`,
  );
  res.status(401).json({ error: "Invalid internal auth" });
}

export function requireByotSyncInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  handleModelCredentialSyncInternalAuth(req, res, next).catch(next);
}
