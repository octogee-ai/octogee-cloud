import type { NextFunction, Request, Response } from "express";

import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  GATEWAY_CREDENTIAL_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import { isWellFormedServiceAccountJwt } from "../../../gateway-edge/src/middleware/security.js";
import { logger as defaultLogger } from "../../../gateway-edge/src/middleware/logging.js";
import { mapReviewToTenant, type BoundTenant } from "../lib/sa-to-tenant.js";
import type { ReviewResult, Reviewer } from "../lib/token-review.js";

type GatewayBinding = Extract<BoundTenant, { kind: "gateway" }>;

interface GatewayCredentialAuthBaseOptions {
  reviewer: Reviewer;
  tokenHeader?: string;
  audience?: string;
  namespace?: string;
  logger?: Pick<typeof defaultLogger, "warn">;
}

export type GatewayCredentialAuthOptions = GatewayCredentialAuthBaseOptions & (
  | { store: Parameters<typeof mapReviewToTenant>[0] }
  | { mapIdentity: (review: Extract<ReviewResult, { authenticated: true }>) => Promise<BoundTenant | null> }
);

const FORBIDDEN = { error: "forbidden" } as const;

function exactPodMatch(
  bound: GatewayBinding,
  review: Extract<Awaited<ReturnType<Reviewer>>, { authenticated: true }>,
): boolean {
  if (!bound.podName || !bound.podUid || !bound.saName || review.saName !== bound.saName) return false;
  if (review.computeInstance) return review.computeInstance.instanceId === bound.podUid;
  return review.podName === bound.podName && review.podUid === bound.podUid;
}

export function createGatewayCredentialAuth(
  opts: GatewayCredentialAuthOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const namespace = opts.namespace ?? process.env.K8S_NAMESPACE ?? "octogee";
  const logger = opts.logger ?? defaultLogger;
  const tokenHeader = opts.tokenHeader ?? GATEWAY_CREDENTIAL_TOKEN_HEADER;
  const audience = opts.audience ?? GATEWAY_CREDENTIAL_TOKEN_AUDIENCE;
  const mapIdentity = "mapIdentity" in opts ? opts.mapIdentity : async (review: Extract<ReviewResult, { authenticated: true }>) => {
    const mapped = await mapReviewToTenant(opts.store, review, namespace);
    return mapped.attached ? mapped.tenant : null;
  };

  return (req, res, next): void => {
    const authenticate = async (): Promise<boolean> => {
      const bound = req.boundTenant;
      const token = req.get(tokenHeader) ?? "";
      if (!bound || bound.kind !== "gateway" || !isWellFormedServiceAccountJwt(token)) {
        return false;
      }
      const review = await opts.reviewer(token);
      if (
        !review.authenticated
        || !review.audiences.includes(audience)
        || review.namespace !== namespace
        || !exactPodMatch(bound, review)
      ) return false;
      const credentialTenant = await mapIdentity(review);
      return credentialTenant?.kind === "gateway"
        && credentialTenant.gatewayId === bound.gatewayId;
    };

    authenticate().then((authenticated) => {
      if (!authenticated) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      next();
    }).catch((error) => {
      logger.warn("[gateway-credential-auth] credential TokenReview failed", { err: error });
      res.status(403).json(FORBIDDEN);
    });
  };
}
