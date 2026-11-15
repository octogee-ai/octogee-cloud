import type { GatewayConfigStatus } from "@octogee/shared/types/gateway-control";

const STATES = new Set(["clean", "dirty", "syncing", "error", "unavailable"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

export function projectOpenClawConfigStatus(
  heartbeat: Record<string, unknown> | null,
): GatewayConfigStatus | undefined {
  const source = record(heartbeat?.configStatus);
  if (!source || typeof source.state !== "string" || !STATES.has(source.state)) return undefined;
  const acceptedCommit = boundedString(source.acceptedCommit, 128);
  const lastSyncedAt = boundedString(source.lastSyncedAt, 64);
  const lastErrorCode = boundedString(source.lastErrorCode, 80);
  return {
    state: source.state as GatewayConfigStatus["state"],
    ...(acceptedCommit ? { acceptedCommit } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
  };
}
