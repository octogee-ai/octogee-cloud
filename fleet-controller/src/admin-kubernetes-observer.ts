import { isGatewayKubernetesStatus, type GatewayKubernetesReading } from "@octogee/shared/types/gateway-releases";
import { UNKNOWN_GATEWAY_KUBERNETES } from "@octogee/core/fleet-state-sections";
import type { FleetRegistryRecord } from "@octogee/core/platform-state";
import { KUBERNETES_OBSERVATION_REFRESH_MS } from "./gateway-kubernetes-observation.js";

export const ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS = 2 * KUBERNETES_OBSERVATION_REFRESH_MS;

function isPodCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readAdminGatewayKubernetes(
  runtime: Pick<FleetRegistryRecord, "kubernetes"> | null,
  now: number,
): GatewayKubernetesReading {
  const observation = runtime?.kubernetes as Record<string, unknown> | null | undefined;
  if (typeof observation !== "object" || observation === null) return UNKNOWN_GATEWAY_KUBERNETES;
  const { status, totalPods, readyPods, observedAt } = observation;
  if (
    !isGatewayKubernetesStatus(status)
    || !isPodCount(totalPods)
    || !isPodCount(readyPods)
    || !isPodCount(observedAt)
    || observedAt > now
  ) {
    return UNKNOWN_GATEWAY_KUBERNETES;
  }
  const ageMs = now - observedAt;
  if (ageMs > ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS) {
    return { kubernetes: { ...UNKNOWN_GATEWAY_KUBERNETES.kubernetes, ageMs }, kubernetesObservedAt: observedAt };
  }
  return {
    kubernetes: { status, totalPods, readyPods, ageMs },
    kubernetesObservedAt: observedAt,
  };
}
