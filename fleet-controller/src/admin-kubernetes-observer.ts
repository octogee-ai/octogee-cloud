import { UNKNOWN_GATEWAY_KUBERNETES, type GatewayKubernetesReading } from "@octogee/core/fleet-state-sections";
import type { FleetRegistryRecord } from "@octogee/core/platform-state";
import { KUBERNETES_OBSERVATION_REFRESH_MS, type GatewayKubernetesStatus } from "./gateway-kubernetes-observation.js";

export const ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS = 2 * KUBERNETES_OBSERVATION_REFRESH_MS;

const STATUSES: readonly GatewayKubernetesStatus[] = ["ready", "not-ready", "missing", "unknown"];

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
    !STATUSES.includes(status as GatewayKubernetesStatus)
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
    kubernetes: { status: status as GatewayKubernetesStatus, totalPods, readyPods, ageMs },
    kubernetesObservedAt: observedAt,
  };
}
