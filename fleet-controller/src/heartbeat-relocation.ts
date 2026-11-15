import { GATEWAY_HEARTBEAT_INTERVAL_MS, type ConfiguredUserReport, type OpenClawProcessReport } from "@octogee/shared/types/fleet-controller";
import type { FleetHeartbeatReport } from "@octogee/core/platform-state";

export const HEARTBEAT_FIELD = "heartbeat";

export interface PollerHeartbeatRecord {
  status: string;
  mountedCustomers: string[];
  startedAt?: number;
  version?: string;
  openclawVersion?: string;
  configuredBuilder?: ConfiguredUserReport | null;
  openclawProcess?: OpenClawProcessReport | null;
}

export function pollerHeartbeatReport(record: PollerHeartbeatRecord, internalUrl: string): FleetHeartbeatReport {
  return {
    status: record.status as FleetHeartbeatReport["status"],
    mountedCustomers: record.mountedCustomers,
    ...(typeof record.startedAt === "number" ? { startedAt: record.startedAt } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.openclawVersion === "string" ? { openclawVersion: record.openclawVersion } : {}),
    ...(record.configuredBuilder !== undefined ? { configuredBuilder: record.configuredBuilder } : {}),
    ...(record.openclawProcess !== undefined ? { openclawProcess: record.openclawProcess } : {}),
    internalUrl,
  };
}

// Must stay a poll interval inside the OpenClaw control readiness window.
export const HEARTBEAT_REFRESH_MS = GATEWAY_HEARTBEAT_INTERVAL_MS * 3;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withoutPollerStamps(heartbeat: Record<string, unknown>): Record<string, unknown> {
  const comparable: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(heartbeat)) {
    if (field === "lastHeartbeatAt") continue;
    comparable[field] = value;
  }
  return comparable;
}

function alreadyStored(stored: unknown, candidate: unknown): boolean {
  if (Array.isArray(candidate)) {
    return Array.isArray(stored) &&
      stored.length === candidate.length &&
      candidate.every((item, index) => alreadyStored(stored[index], item));
  }
  const candidateRecord = plainRecord(candidate);
  if (!candidateRecord) return Object.is(stored, candidate);
  const storedRecord = plainRecord(stored);
  return storedRecord !== null &&
    Object.entries(candidateRecord).every(
      ([field, value]) => alreadyStored(storedRecord[field], value),
    );
}

export function heartbeatReportIsRedundant(
  stored: unknown,
  candidate: FleetHeartbeatReport,
  now: number,
): boolean {
  const current = plainRecord(stored);
  if (!current) return false;
  const lastHeartbeatAt = coerceMillis(current.lastHeartbeatAt);
  if (lastHeartbeatAt === null) return false;
  if (lastHeartbeatAt > now || now - lastHeartbeatAt >= HEARTBEAT_REFRESH_MS) return false;
  return alreadyStored(withoutPollerStamps(current), withoutPollerStamps(candidate));
}

function heartbeatSubDoc(glmData: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const hb = glmData?.[HEARTBEAT_FIELD];
  return hb && typeof hb === "object" && !Array.isArray(hb) ? (hb as Record<string, unknown>) : undefined;
}

export function readHeartbeatLiveness(
  glmData: Record<string, unknown> | undefined,
): { lastHeartbeatAt: number; version?: string | null } | null {
  const source = heartbeatSubDoc(glmData);
  if (!source) return null;
  const ms = coerceMillis(source.lastHeartbeatAt);
  if (ms == null) return null;
  return {
    lastHeartbeatAt: ms,
    version: typeof source.version === "string" ? source.version : null,
  };
}

export function readMountedUsers(
  glmData: Record<string, unknown> | undefined,
): string[] {
  const source = heartbeatSubDoc(glmData);
  const raw = source?.mountedCustomers;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

function coerceMillis(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  if (raw instanceof Date) return raw.getTime();
  if (typeof (raw as { toMillis?: () => number }).toMillis === "function") {
    return (raw as { toMillis: () => number }).toMillis();
  }
  return null;
}
