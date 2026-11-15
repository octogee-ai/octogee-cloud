import { logger } from "@octogee/core/http/logging";
import * as crypto from "crypto";
import { readFileSync } from "node:fs";
import { isIsolatedGatewayClassValue, isolatedGatewayServiceAccountName } from "@octogee/shared/types/glm";
import {
  createKubernetesTokenReviewer,
  TOKEN_REVIEW_AUDIENCE,
  type Reviewer,
} from "./kubernetes-token-review.js";
import {
  createGceIdentityReviewer,
  createIssuerDispatchingReviewer,
  parseGatewayVmIdentity,
  serviceAccountLocalPart,
  type VerifyGoogleIdToken,
} from "./gce-identity-review.js";

export type GatewayInternalAuthMode = "platform" | "gateway-service-account";

export const GATEWAY_K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
export const GATEWAY_INTERNAL_KEY_HEADER = "x-internal-service-key";
export const DEFAULT_PROJECTED_API_TOKEN_PATH = "/var/run/secrets/octogee-api/token";

export interface GatewayInternalAuthSecret {
  value: string;
  mode: GatewayInternalAuthMode;
  headerName: typeof GATEWAY_INTERNAL_KEY_HEADER | typeof GATEWAY_K8S_SA_TOKEN_HEADER;
}

export interface GatewayInternalAuthValidationOptions {
  reviewer?: Reviewer;
  allowSharedGateway?: boolean;
}

let sharedReviewer: Reviewer | null = null;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readProjectedServiceAccountToken(env: Record<string, string | undefined>): string | undefined {
  const tokenPath = nonBlank(env.OCTOGEE_API_SA_TOKEN_PATH) ?? DEFAULT_PROJECTED_API_TOKEN_PATH;
  try {
    return nonBlank(readFileSync(tokenPath, "utf8"));
  } catch {
    return undefined;
  }
}

export interface GatewayInternalAuthReviewerDeps {
  kubernetes?: Reviewer;
  verify?: VerifyGoogleIdToken;
  onVmTokenRejected?: (reason: string) => void;
}

export function createGatewayInternalAuthReviewer(
  env: Record<string, string | undefined>,
  deps: GatewayInternalAuthReviewerDeps = {},
): Reviewer {
  const kubernetes = deps.kubernetes ?? createKubernetesTokenReviewer();
  const vm = parseGatewayVmIdentity(env);
  if (!vm) return kubernetes;
  return createIssuerDispatchingReviewer({
    kubernetes,
    gce: createGceIdentityReviewer({
      ...vm,
      audience: TOKEN_REVIEW_AUDIENCE,
      namespace: expectedNamespace(env),
      verify: deps.verify,
      onRejected: deps.onVmTokenRejected ?? ((reason) => {
        logger.warn(`Gateway VM identity token rejected — ${reason}`);
      }),
    }),
  });
}

function getReviewer(env: Record<string, string | undefined>): Reviewer {
  if (env !== process.env) return createGatewayInternalAuthReviewer(env);
  if (sharedReviewer === null) sharedReviewer = createGatewayInternalAuthReviewer(env);
  return sharedReviewer;
}

function expectedNamespace(env: Record<string, string | undefined>): string {
  return nonBlank(env.K8S_NAMESPACE) ?? nonBlank(env.POD_NAMESPACE) ?? "octogee";
}

function allowedGatewayServiceAccounts(env: Record<string, string | undefined>): Set<string> {
  const allowed = new Set<string>(["octogee-api"]);
  const vm = parseGatewayVmIdentity(env);
  if (vm) allowed.add(serviceAccountLocalPart(vm.serviceAccountEmail));
  const configured = nonBlank(env.GATEWAY_ALLOWED_K8S_SERVICE_ACCOUNTS);
  if (configured) {
    for (const item of configured.split(",")) {
      const serviceAccount = nonBlank(item);
      if (serviceAccount) allowed.add(serviceAccount);
    }
  }

  const own = nonBlank(env.K8S_SERVICE_ACCOUNT_NAME);
  if (own) allowed.add(own);

  const gatewayId = nonBlank(env.GATEWAY_ID);
  if (gatewayId) allowed.add(isolatedGatewayServiceAccountName(gatewayId));
  return allowed;
}

function timingSafeStringEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  try {
    return (
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"))
    );
  } catch {
    return false;
  }
}

export function resolveGatewayInternalAuthSecret(
  env: Record<string, string | undefined> = process.env,
  opts: GatewayInternalAuthValidationOptions = {},
): GatewayInternalAuthSecret | null {
  const sharedGateway = opts.allowSharedGateway === true && env.GATEWAY_CLASS === "shared";
  const platformKey = sharedGateway ? undefined : nonBlank(env.INTERNAL_SERVICE_KEY);
  if (platformKey) {
    return {
      value: platformKey,
      mode: "platform",
      headerName: GATEWAY_INTERNAL_KEY_HEADER,
    };
  }

  if (sharedGateway || (isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && isIsolatedGatewayClassValue(env.GATEWAY_PROFILE))) {
    const serviceAccountToken = readProjectedServiceAccountToken(env);
    if (serviceAccountToken) {
      return {
        value: serviceAccountToken,
        mode: "gateway-service-account",
        headerName: GATEWAY_K8S_SA_TOKEN_HEADER,
      };
    }
  }

  return null;
}

export async function isValidGatewayInternalAuth(
  provided: string | undefined,
  env: Record<string, string | undefined> = process.env,
  opts: GatewayInternalAuthValidationOptions = {},
): Promise<boolean> {
  if (!provided) return false;
  const secret = resolveGatewayInternalAuthSecret(env, opts);
  if (!secret) return false;

  if (secret.mode === "platform") return timingSafeStringEqual(provided, secret.value);

  const review = await (opts.reviewer ?? getReviewer(env))(provided);
  if (!review.authenticated) return false;
  if (!review.audiences.includes(TOKEN_REVIEW_AUDIENCE)) return false;
  if (review.namespace !== expectedNamespace(env)) return false;
  if (opts.allowSharedGateway && env.GATEWAY_CLASS === "shared") {
    const own = nonBlank(env.K8S_SERVICE_ACCOUNT_NAME);
    return Boolean(own) && review.saName === own;
  }
  return allowedGatewayServiceAccounts(env).has(review.saName);
}
