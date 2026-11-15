import type { NextFunction, Request, Response } from "express";
import { Counter, type Registry } from "prom-client";
import { isWellFormedServiceAccountJwt } from "../../../gateway-edge/src/middleware/security.js";
import {
  mapReviewToTenant,
  type BoundTenant,
  type TenantBindingResult,
} from "../lib/sa-to-tenant.js";
import {
  createKubernetesTokenReviewer,
  IN_CLUSTER_IDENTITY_CA_PATH,
  IN_CLUSTER_IDENTITY_TOKEN_PATH,
  type Reviewer,
  type ReviewResult,
} from "../lib/token-review.js";
import { logger as defaultLogger } from "../../../gateway-edge/src/middleware/logging.js";
import { gatewayVmPodName } from "@octogee/shared/types/glm";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      boundTenant?: BoundTenant;
      tenantBindingAttempted?: boolean;
    }
  }
}

export const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";

type TenantBindingMetricResult =
  | TenantBindingResult
  | "missing"
  | "malformed"
  | "invalid"
  | "reviewer_error"
  | "audience_mismatch";

export interface TenantBindingMetrics {
  attemptsTotal: Counter<"result" | "route">;
}

export interface TenantBindingLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface TenantBindingMiddlewareOptions {
  reviewer?: Reviewer;
  store: Parameters<typeof mapReviewToTenant>[0];
  namespace?: string;
  metrics: TenantBindingMetrics;
  logger?: TenantBindingLogger;
}

export function createTenantBindingMetrics(register: Registry): TenantBindingMetrics {
  return {
    attemptsTotal: new Counter({
      name: "tenant_binding_attempts_total",
      help: "Internal tenant binding attempts by soft-fail result and route",
      labelNames: ["result", "route"] as const,
      registers: [register],
    }),
  };
}

function routeLabel(req: Request): string {
  return req.route?.path ? String(req.route.path) : req.path || "unknown";
}

function record(
  metrics: TenantBindingMetrics,
  req: Request,
  result: TenantBindingMetricResult,
): void {
  metrics.attemptsTotal.inc({ result, route: routeLabel(req) });
}

function warn(
  logger: TenantBindingLogger,
  msg: string,
  meta: Record<string, unknown>,
): void {
  logger.warn(`[tenant-binding] ${msg}`, meta);
}

function boundTenantForReview(
  tenant: BoundTenant,
  review: Extract<ReviewResult, { authenticated: true }>,
): BoundTenant {
  if (tenant.kind !== "gateway" || !review.podName || !review.podUid) return tenant;
  return {
    ...tenant,
    saName: review.saName,
    podName: review.computeInstance
      ? gatewayVmPodName(tenant.gatewayId, review.computeInstance.instanceId)
      : review.podName,
    podUid: review.podUid,
  };
}

export function createTenantBindingMiddleware(
  opts: TenantBindingMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const reviewer = opts.reviewer ?? createKubernetesTokenReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
  });
  const logger = opts.logger ?? defaultLogger;
  const namespace = opts.namespace ?? process.env.K8S_NAMESPACE ?? "octogee";

  const retiringPodStillLive = async (
    req: Request,
    token: string,
    review: Extract<ReviewResult, { authenticated: true }>,
  ): Promise<boolean> => {
    let fresh;
    try {
      fresh = await reviewer(token, { fresh: true });
    } catch (err) {
      record(opts.metrics, req, "reviewer_error");
      warn(logger, "retiring gateway fresh TokenReview failed", {
        route: req.path,
        saName: review.saName,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (fresh.authenticated && fresh.saName === review.saName && fresh.podUid === review.podUid) {
      return true;
    }
    record(opts.metrics, req, "invalid");
    warn(logger, "retiring gateway pod token failed fresh review", {
      route: req.path,
      saName: review.saName,
      podName: review.podName,
    });
    return false;
  };

  const handleTenantBinding = async (req: Request): Promise<void> => {
    req.tenantBindingAttempted = true;
    const token = req.get(K8S_SA_TOKEN_HEADER);
    if (!token) {
      record(opts.metrics, req, "missing");
      return;
    }

    if (!isWellFormedServiceAccountJwt(token)) {
      record(opts.metrics, req, "malformed");
      warn(logger, "service account token malformed — skipping TokenReview", {
        route: req.path,
      });
      return;
    }

    let review;
    try {
      review = await reviewer(token);
    } catch (err) {
      record(opts.metrics, req, "reviewer_error");
      warn(logger, "TokenReview failed", {
        route: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!review.authenticated) {
      record(opts.metrics, req, "invalid");
      warn(logger, "service account token rejected", { route: req.path });
      return;
    }

    if (!review.audiences.includes("octogee-api")) {
      record(opts.metrics, req, "audience_mismatch");
      warn(logger, "service account token audience mismatch", {
        route: req.path,
        audiences: review.audiences,
      });
      return;
    }

    let mapped;
    try {
      mapped = await mapReviewToTenant(opts.store, review, namespace);
    } catch (err) {
      record(opts.metrics, req, "reviewer_error");
      warn(logger, "tenant lookup failed", {
        route: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (mapped.attached && mapped.retiring && !(await retiringPodStillLive(req, token, review))) {
      return;
    }
    record(opts.metrics, req, mapped.result);
    if (mapped.attached) {
      req.boundTenant = boundTenantForReview(mapped.tenant, review);
    } else if (mapped.result !== "shared_gateway") {
      warn(logger, "service account did not map to a tenant", {
        route: req.path,
        result: mapped.result,
        namespace: review.namespace,
        saName: review.saName,
      });
    }
  };

  return (req: Request, _res: Response, next: NextFunction): void => {
    handleTenantBinding(req).then(() => next(), next);
  };
}
