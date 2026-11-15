import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import {
  isUserActivationStatus,
  type UserActivationSummary,
} from "@octogee/shared/types/gateway-control";
import type { UserActivationLease } from "@octogee/core/platform-state";
import {
  isGatewayRuntimeDoc,
  type GatewayHeartbeatStatus,
} from "@octogee/shared/types/gateway-releases";

const MAX_CLOCK_SKEW_MS = 5_000;
const HEARTBEAT_STATUSES: ReadonlySet<string> = new Set<GatewayHeartbeatStatus>([
  "unknown", "booting", "ready", "unreachable", "error",
]);

function isGatewayHeartbeatStatus(value: unknown): value is GatewayHeartbeatStatus {
  return typeof value === "string" && HEARTBEAT_STATUSES.has(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function epochMillis(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const item = record(value);
  if (!item) return null;
  if (typeof item.toMillis === "function") {
    const parsed = item.toMillis.call(value) as unknown;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof item.seconds === "number" && typeof item.nanoseconds === "number") {
    return item.seconds * 1_000 + item.nanoseconds / 1_000_000;
  }
  return null;
}

function heartbeatIsFresh(lastHeartbeatAt: unknown, now: number): boolean {
  const observedAt = epochMillis(lastHeartbeatAt);
  return observedAt !== null &&
    observedAt <= now + MAX_CLOCK_SKEW_MS &&
    now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

export function projectGatewayRuntimeStatus(
  runtime: unknown,
  input: { gatewayId: string; now: number },
): GatewayHeartbeatStatus {
  if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== input.gatewayId) return "unknown";
  if (runtime.lifecycle === "provisioning") return "booting";
  if (runtime.lifecycle === "failed") return "error";
  const heartbeat = record(runtime.heartbeat);
  const status = heartbeat?.status;
  if (!isGatewayHeartbeatStatus(status)) return "unknown";
  if ((status === "ready" || status === "booting") && !heartbeatIsFresh(heartbeat?.lastHeartbeatAt, input.now)) {
    return "unreachable";
  }
  return status;
}

export function projectOwnerActivation(lease: UserActivationLease | null): UserActivationSummary | null {
  if (!lease || !isUserActivationStatus(lease.status)) return null;
  return {
    status: lease.status,
    targetGatewayId: typeof lease.targetGatewayId === "string" && lease.targetGatewayId.length > 0
      ? lease.targetGatewayId
      : null,
  };
}
