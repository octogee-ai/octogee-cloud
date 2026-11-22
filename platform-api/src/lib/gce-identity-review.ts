import { computeInstanceFromPayload, createGoogleIdTokenVerifier, GOOGLE_TOKEN_ISSUERS, type VerifyGoogleIdToken } from "@octogee/core/gce-instance-identity";
import type { ReviewResult, Reviewer } from "./token-review.js";

export { computeInstanceFromPayload, GOOGLE_TOKEN_ISSUERS };
export type { VerifyGoogleIdToken };

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

export function createGceIdentityReviewer(opts: GceIdentityReviewerOptions): Reviewer {
  const verify = opts.verify ?? createGoogleIdTokenVerifier();
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
