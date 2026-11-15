import type { NextFunction, Request, Response } from "express";

import {
  createKubernetesTokenReviewer,
  TOKEN_REVIEW_AUDIENCE,
  type ReviewResult,
  type Reviewer,
} from "../lib/kubernetes-token-review.js";
import { logger } from "@octogee/core/http/logging";

const API_SERVICE_ACCOUNT = "octogee-api";
const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";

let tokenReviewerForTests: Reviewer | null = null;
let sharedReviewer: Reviewer | null = null;

export function _setAgentMessageTokenReviewerForTests(reviewer: Reviewer | null): void {
  tokenReviewerForTests = reviewer;
}

function reviewer(): Reviewer {
  if (tokenReviewerForTests) return tokenReviewerForTests;
  sharedReviewer ??= createKubernetesTokenReviewer();
  return sharedReviewer;
}

function expectedNamespace(): string | null {
  return process.env.K8S_NAMESPACE?.trim() || process.env.POD_NAMESPACE?.trim() || null;
}

function header(req: Request): string | undefined {
  const raw = req.headers[K8S_SA_TOKEN_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function handleAgentMessageAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const namespace = expectedNamespace();
  if (!namespace) {
    logger.error("agent-message service-account auth namespace is not configured");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }
  const token = header(req);
  if (!token) {
    res.status(401).json({ error: `${K8S_SA_TOKEN_HEADER} header required` });
    return;
  }

  let review: ReviewResult;
  try {
    review = await reviewer()(token);
  } catch (error) {
    logger.error("agent-message service-account TokenReview failed — refusing request", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  const authorized = review.authenticated &&
    review.saName === API_SERVICE_ACCOUNT &&
    review.namespace === namespace &&
    review.audiences.includes(TOKEN_REVIEW_AUDIENCE);
  if (!authorized) {
    logger.warn("agent-message service-account identity rejected", {
      sourceIp: req.socket.remoteAddress,
    });
    res.status(401).json({ error: "Invalid service-account identity" });
    return;
  }

  next();
}

export function requireAgentMessageAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  handleAgentMessageAuth(req, res, next).catch(next);
}
