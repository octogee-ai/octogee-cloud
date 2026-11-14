import type { GatewayMutableConfig } from "@octogee/core/gateway-live-release";

export type ApiServerEgressResolver = () => Promise<string[]>;

export async function prepareGatewayRuntimeConfig<T extends GatewayMutableConfig>(
  config: T,
  gatewayId: string,
  resolveApiServerEgressCidrs: ApiServerEgressResolver,
): Promise<T> {
  if (config.gatewayClass !== "isolated") {
    return config;
  }
  const isolatedAccess = config.builderAccess ?? {};
  const kubeApiServerEgressCidrs = await resolveApiServerEgressCidrs();
  if (kubeApiServerEgressCidrs.length === 0) {
    if ((isolatedAccess.kubeApiServerEgressCidrs?.length ?? 0) > 0) {
      return config;
    }
    throw new Error(`isolated gateway ${gatewayId} has no API-server egress CIDRs`);
  }
  return {
    ...config,
    builderAccess: {
      ...isolatedAccess,
      kubeApiServerEgressCidrs,
    },
  } as T;
}

export function createGatewayRuntimeConfigPreparer(
  resolveApiServerEgressCidrs: ApiServerEgressResolver,
): <T extends GatewayMutableConfig & { gatewayId: string }>(config: T) => Promise<T> {
  return <T extends GatewayMutableConfig & { gatewayId: string }>(config: T) =>
    prepareGatewayRuntimeConfig(
      config,
      config.gatewayId,
      resolveApiServerEgressCidrs,
    );
}
