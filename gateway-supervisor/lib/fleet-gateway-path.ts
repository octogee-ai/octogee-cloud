import type { Request, Response } from "express";

// In-pod migration RPC path guard (GATEWAY-RELEASES-SPEC transport/tenant
// split): the path carries the BARE tenant gatewayId and must equal the pod's
// GATEWAY_ID. A revision id ({gw}-r{n}) in the path is REJECTED — transport is
// addressed by the K8s Service (revision), never smuggled into the tenant path.
export function pathGatewayIdMatchesPod(
  pathGatewayId: string | string[] | undefined,
  podGatewayId: string,
): boolean {
  return pathGatewayId === podGatewayId;
}

// Runs only AFTER a request proves a fleet-controller signature: an unsigned
// caller must not be able to tell a wrong-gateway rejection from a bad-signature
// one and so confirm which tenant answers at this address. The rejection body
// stays identity-free for the same reason.
export function rejectMisaddressedGateway(
  req: Request,
  res: Response,
  podGatewayId: string,
  log: (msg: string) => void,
): boolean {
  if (pathGatewayIdMatchesPod(req.params.gatewayId, podGatewayId)) return false;
  log(
    `[migration-http] ⚠ path gatewayId=${String(req.params.gatewayId)} does not match this pod's ` +
      `gatewayId=${podGatewayId} — rejecting`,
  );
  res.status(400).json({ error: "path gatewayId does not match this gateway" });
  return true;
}
