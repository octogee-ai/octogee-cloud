import type { Request, RequestHandler, Response } from "express";

import { verifyFleetRequest } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  type FleetStateRequestBody,
  type FleetStateResponse,
} from "@octogee/shared/types/fleet-controller";

export interface FleetStateHandlerDeps {
  publicKey: string;
  gatewayId: string;
  readState: (request: FleetStateRequestBody) => FleetStateResponse | Promise<FleetStateResponse>;
  log: (message: string) => void;
}

// Signature first, identity second: a caller that cannot sign learns nothing —
// not the roster, and not which gateway answered. Every rejection body is
// identity-free for the same reason.
function verifiedBody(
  req: Request,
  res: Response,
  deps: FleetStateHandlerDeps,
): FleetStateRequestBody | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: FleetStateRequestBody;
  try {
    body = JSON.parse(rawBody) as FleetStateRequestBody;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (
    typeof body?.requestId !== "string" || body.requestId.length === 0 ||
    typeof body?.gatewayId !== "string" || body.gatewayId.length === 0
  ) {
    res.status(400).json({ error: "missing requestId/gatewayId" });
    return null;
  }
  if (!verifyFleetRequest(deps.publicKey, body.requestId, rawBody, req.header(SIGNATURE_HEADER))) {
    deps.log(`[fleet-state] ⚠ bad signature requestId=${body.requestId}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  return body;
}

export function createFleetStateHandler(deps: FleetStateHandlerDeps): RequestHandler {
  return async (req, res) => {
    const body = verifiedBody(req, res, deps);
    if (!body) return;
    // The signature covers the body, not the path, so the signed gatewayId is what
    // binds a capture to one pod; the path must agree with it and with this pod.
    if (body.gatewayId !== deps.gatewayId || req.params.gatewayId !== deps.gatewayId) {
      deps.log(
        `[fleet-state] ⚠ rejecting requestId=${body.requestId}: signed gatewayId=${body.gatewayId} ` +
          `path gatewayId=${req.params.gatewayId} does not match this pod's gatewayId=${deps.gatewayId}`,
      );
      res.status(400).json({ error: "gatewayId does not address this gateway" });
      return;
    }
    try {
      res.status(200).json(await deps.readState(body));
    } catch (error) {
      deps.log(`[fleet-state] ⚠ state read failed requestId=${body.requestId}: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ error: "fleet state is unavailable" });
    }
  };
}
