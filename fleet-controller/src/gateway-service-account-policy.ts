import type { GatewayServiceAccountSpec } from "@octogee/shared/types/glm";

const WORKLOAD_IDENTITY_ANNOTATION = "iam.gke.io/gcp-service-account";

export function withoutGatewayWorkloadIdentity(
  serviceAccount: GatewayServiceAccountSpec | null | undefined,
): GatewayServiceAccountSpec | undefined {
  if (!serviceAccount) return undefined;
  if (
    !serviceAccount.annotations ||
    !Object.prototype.hasOwnProperty.call(
      serviceAccount.annotations,
      WORKLOAD_IDENTITY_ANNOTATION,
    )
  ) {
    return serviceAccount;
  }
  const sanitized: GatewayServiceAccountSpec = {
    ...serviceAccount,
    annotations: { ...serviceAccount.annotations },
  };
  delete sanitized.annotations?.[WORKLOAD_IDENTITY_ANNOTATION];
  if (Object.keys(sanitized.annotations ?? {}).length === 0) delete sanitized.annotations;
  return sanitized;
}
