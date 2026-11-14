import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants as assertCorePlatformInvariants,
  platformInvariantTable as corePlatformInvariantTable,
  platformInvariantViolations as corePlatformInvariantViolations,
  reconcilePlatformInvariants as reconcileCorePlatformInvariants,
  reconcilePlatformProjections as reconcileCorePlatformProjections,
  platformBrokerProviderDeclarations,
  type GatewayConfigClass,
  type PlatformInvariant,
  type SystemConfigInvariantContext,
} from "@octogee/core/system-config-invariants";
import { resolveControlIdentityFromEnv } from "@octogee/shared/types/openclaw-proxy-identity";
import { readUserClaimFromEnv } from "@octogee/shared/server/user-claim";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export {
  PlatformInvariantPolicyError,
  platformBrokerProviderDeclarations,
  type PlatformInvariant,
  type SystemConfigInvariantContext,
};

export function systemConfigInvariantContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SystemConfigInvariantContext {
  const rawClass = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE ?? "shared";
  const gatewayClass: GatewayConfigClass = isIsolatedGatewayClassValue(rawClass) ? "isolated" : "shared";
  const claim = gatewayClass === "isolated" ? readUserClaimFromEnv(env) : null;
  return {
    gatewayClass,
    ...(env.GATEWAY_ID ? { gatewayId: env.GATEWAY_ID } : {}),
    ...(env.API_PUBLIC_URL ? { apiOrigin: env.API_PUBLIC_URL } : {}),
    controlIdentity: resolveControlIdentityFromEnv(env),
    ...(claim ? { ownerUid: claim.ownerUid, workspaceSlug: claim.builderSlug } : {}),
    brokerProviderEnv: {
      OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
      PLATFORM_OPENAI_BASE_URL: env.PLATFORM_OPENAI_BASE_URL,
      PLATFORM_VERTEX_BASE_URL: env.PLATFORM_VERTEX_BASE_URL,
      PLATFORM_META_BASE_URL: env.PLATFORM_META_BASE_URL,
    },
  };
}

export function platformInvariantTable(
  env: NodeJS.ProcessEnv = process.env,
): readonly PlatformInvariant[] {
  return corePlatformInvariantTable(systemConfigInvariantContextFromEnv(env));
}

export function platformInvariantViolations(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return corePlatformInvariantViolations(config, systemConfigInvariantContextFromEnv(env));
}

export function assertPlatformInvariants(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertCorePlatformInvariants(config, systemConfigInvariantContextFromEnv(env));
}

export function reconcilePlatformInvariants(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { changedPaths: string[] } {
  return reconcileCorePlatformInvariants(config, systemConfigInvariantContextFromEnv(env));
}

export function reconcilePlatformProjections(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { changedPaths: string[] } {
  return reconcileCorePlatformProjections(config, systemConfigInvariantContextFromEnv(env));
}
