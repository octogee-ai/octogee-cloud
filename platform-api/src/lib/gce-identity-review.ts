import { OAuth2Client } from "google-auth-library";
import type { ComputeInstanceIdentity, ReviewResult, Reviewer } from "./token-review.js";

export const GOOGLE_TOKEN_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export type VerifyGoogleIdToken = (idToken: string, audience: string) => Promise<Record<string, unknown> | null>;

export interface GceIdentityReviewerOptions {
  audience: string;
  projectId: string;
  serviceAccountEmail: string;
  namespace: string;
  verify?: VerifyGoogleIdToken;
}

export interface GatewayVmIdentityConfig {
  serviceAccountEmail: string;
  projectId: string;
}

export function jwtIssuer(token: string): string | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss : null;
  } catch {
    return null;
  }
}

export function isGoogleIssuedJwt(token: string): boolean {
  const issuer = jwtIssuer(token);
  return issuer !== null && GOOGLE_TOKEN_ISSUERS.has(issuer);
}

export function parseGatewayVmIdentity(
  env: Record<string, string | undefined>,
): GatewayVmIdentityConfig | null {
  const serviceAccountEmail = env.GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL?.trim();
  const projectId = env.GATEWAY_COMPUTER_PROJECT_ID?.trim();
  if (!serviceAccountEmail && !projectId) return null;
  if (!serviceAccountEmail || !projectId) {
    throw new Error(
      "GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL and GATEWAY_COMPUTER_PROJECT_ID must be set together",
    );
  }
  return { serviceAccountEmail, projectId };
}

export function serviceAccountLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function defaultVerify(): VerifyGoogleIdToken {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return (ticket.getPayload() as Record<string, unknown> | undefined) ?? null;
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function computeInstanceFromPayload(
  payload: Record<string, unknown>,
  expected: { projectId: string; serviceAccountEmail: string },
): ComputeInstanceIdentity | null {
  if (payload.email !== expected.serviceAccountEmail || payload.email_verified !== true) return null;
  const google = payload.google as { compute_engine?: Record<string, unknown> } | undefined;
  const engine = google?.compute_engine;
  if (!engine) return null;
  const projectId = nonEmptyString(engine.project_id);
  const zone = nonEmptyString(engine.zone);
  const instanceId = nonEmptyString(engine.instance_id);
  const instanceName = nonEmptyString(engine.instance_name);
  if (!projectId || !zone || !instanceId || !instanceName) return null;
  if (projectId !== expected.projectId) return null;
  return { projectId, zone, instanceId, instanceName };
}

export function createGceIdentityReviewer(opts: GceIdentityReviewerOptions): Reviewer {
  const verify = opts.verify ?? defaultVerify();
  const saName = serviceAccountLocalPart(opts.serviceAccountEmail);
  return async (jwt: string): Promise<ReviewResult> => {
    let payload: Record<string, unknown> | null;
    try {
      payload = await verify(jwt, opts.audience);
    } catch {
      return { authenticated: false };
    }
    if (!payload || !GOOGLE_TOKEN_ISSUERS.has(String(payload.iss))) return { authenticated: false };
    const computeInstance = computeInstanceFromPayload(payload, opts);
    if (!computeInstance) return { authenticated: false };
    return {
      authenticated: true,
      saName,
      namespace: opts.namespace,
      audiences: [opts.audience],
      podName: computeInstance.instanceName,
      podUid: computeInstance.instanceId,
      computeInstance,
    };
  };
}

export function createIssuerDispatchingReviewer(reviewers: { kubernetes: Reviewer; gce: Reviewer }): Reviewer {
  return (jwt, opts) =>
    isGoogleIssuedJwt(jwt) ? reviewers.gce(jwt, opts) : reviewers.kubernetes(jwt, opts);
}
