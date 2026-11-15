import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { createRepeatSquelch } from "@octogee/shared/server/repeat-squelch";
const runtimeLogger = createServiceLogger("system-config-runtime-health");
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  readSystemConfigStatus,
  type SystemConfigObservedStatus,
  updateSystemConfigStatus,
} from "./system-config-status.js";
import {
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
  type OpenClawDashboardBridgeCapability,
} from "@octogee/shared/types/fleet-controller";

export interface SystemConfigRuntimeHealthOptions {
  openclawDir: string;
  env?: NodeJS.ProcessEnv;
  probeOpenClaw?: () => Promise<boolean>;
  now?: () => Date;
}

interface SystemConfigStatusPublisherOptions {
  openclawDir: string;
  publish: (status: SystemConfigObservedStatus) => Promise<void>;
  intervalMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
  refreshRuntimeHealth?: () => Promise<SystemConfigObservedStatus>;
}

const SYSTEM_CONFIG_STATUS_PUBLISH_HEARTBEAT_MS = 10_000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function statusFingerprint(status: SystemConfigObservedStatus): string {
  const stable = { ...status };
  delete stable.runtimeHealthCheckedAt;
  delete stable.updatedAt;
  return createHash("sha256").update(canonicalJson(stable)).digest("hex");
}

type DashboardControlObservation = Pick<
  SystemConfigObservedStatus,
  "dashboardControlState" | "dashboardControlProtocol" | "dashboardControlObservedAt"
>;

function unavailableDashboardControl(
  dashboardControlState: "missing" | "stale" | "invalid",
): DashboardControlObservation {
  return {
    dashboardControlState,
    dashboardControlProtocol: undefined,
    dashboardControlObservedAt: undefined,
  };
}

function hasDashboardCapabilityIdentity(
  capability: Record<string, unknown>,
  gatewayId: string,
): boolean {
  return capability.protocol === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL &&
    capability.version === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION &&
    Boolean(gatewayId) &&
    capability.revisionId === gatewayId &&
    typeof capability.instanceId === "string" &&
    /^[A-Za-z0-9._:-]{8,128}$/.test(capability.instanceId);
}

function canonicalObservedAt(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const observedAt = Date.parse(value);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== value) return null;
  return observedAt;
}

function parseDashboardCapability(
  contents: string,
  gatewayId: string,
): OpenClawDashboardBridgeCapability | null {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capability = value as Record<string, unknown>;
  if (!hasDashboardCapabilityIdentity(capability, gatewayId)) return null;
  if (canonicalObservedAt(capability.observedAt) === null) return null;
  return capability as unknown as OpenClawDashboardBridgeCapability;
}

export function observeDashboardControl(
  openclawDir: string,
  gatewayId: string,
  now: number,
): DashboardControlObservation {
  const capabilityPath = path.join(openclawDir, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE);
  let contents: string;
  try {
    contents = fs.readFileSync(capabilityPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return unavailableDashboardControl("missing");
    }
    throw error;
  }
  const capability = parseDashboardCapability(contents, gatewayId);
  if (!capability) return unavailableDashboardControl("invalid");
  const observedAt = Date.parse(capability.observedAt);
  const stat = fs.statSync(capabilityPath);
  if (!stat.isFile() || stat.mtimeMs > now + 5_000 || observedAt > now + 5_000) {
    return unavailableDashboardControl("invalid");
  }
  if (
    now - stat.mtimeMs > OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS ||
    now - observedAt > OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS
  ) {
    return unavailableDashboardControl("stale");
  }
  return {
    dashboardControlState: "ready",
    dashboardControlProtocol: {
      protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
      version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
    },
    dashboardControlObservedAt: capability.observedAt,
  };
}

const healthFailures = createRepeatSquelch({ windowMs: 60_000 });

function reportHealthFailure(healthUrl: string, fields: { failure: string; status?: number; durationMs: number }): void {
  const admitted = healthFailures.admit(healthUrl, `${fields.failure}:${fields.status ?? ""}`);
  if (admitted) runtimeLogger.warn("[openclaw-health] probe failed", { ...fields, ...(admitted.suppressed ? { repeatsSuppressed: admitted.suppressed } : {}) });
}

function reportHealthRecovered(healthUrl: string): void {
  const settled = healthFailures.settle(healthUrl);
  if (settled) runtimeLogger.info("[openclaw-health] probe recovered", { repeatsSuppressed: settled.suppressed });
}

export async function probeOpenClawHealth(
  healthUrl = "http://127.0.0.1:18789/healthz",
  timeoutMs = 2_000,
): Promise<boolean> {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(healthUrl, { signal });
    await response.body?.cancel();
    if (response.ok) reportHealthRecovered(healthUrl);
    else reportHealthFailure(healthUrl, { failure: "http-error", status: response.status, durationMs: Math.round(performance.now() - startedAt) });
    return response.ok;
  } catch {
    reportHealthFailure(healthUrl, { failure: signal.aborted ? "timeout" : "request-failed", durationMs: Math.round(performance.now() - startedAt) });
    return false;
  }
}

function resolveRuntimeHealth(
  healthy: boolean,
  dashboardRequired: boolean,
  dashboardReady: boolean,
): Pick<SystemConfigObservedStatus, "runtimeHealth" | "runtimeReady"> {
  if (!healthy) return { runtimeHealth: "unhealthy", runtimeReady: false };
  if (dashboardRequired && !dashboardReady) {
    return { runtimeHealth: "repair", runtimeReady: false };
  }
  return { runtimeHealth: "healthy", runtimeReady: true };
}

// Identity-pure runtime health (GATEWAY-SIMPLE-ROLL-SPEC): the deep OpenClaw
// probe and the local Dashboard capability file are the only inputs — no boot
// acceptance, no roll role, no fleet state. The boot loop does not start
// OpenClaw until the durable config checkpoint passed, so "OpenClaw healthy"
// already implies the accepted config is live.
export async function refreshSystemConfigRuntimeHealth(
  options: SystemConfigRuntimeHealthOptions,
): Promise<SystemConfigObservedStatus> {
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const current = readSystemConfigStatus(options.openclawDir);
  const env = options.env ?? process.env;
  const dashboard = observeDashboardControl(
    options.openclawDir,
    env.GATEWAY_ID?.trim() ?? "",
    observedAt.getTime(),
  );
  const healthy = await (options.probeOpenClaw ?? probeOpenClawHealth)();
  const dashboardRequired = env.OPENCLAW_DASHBOARD_BRIDGE_REQUIRED === "true";
  const dashboardReady = dashboard.dashboardControlState === "ready";
  const runtime = resolveRuntimeHealth(healthy, dashboardRequired, dashboardReady);
  return updateSystemConfigStatus(options.openclawDir, {
    state: current.state,
    ...dashboard,
    openclawVersion: env.OPENCLAW_VERSION?.trim() || "unknown",
    openclawForkSha: env.OPENCLAW_FORK_SHA?.trim() || "unknown",
    ...runtime,
    runtimeHealthCheckedAt: observedAt.toISOString(),
  }, now);
}

export function createSystemConfigStatusPublisher(options: SystemConfigStatusPublisherOptions) {
  const intervalMs = options.intervalMs ?? 5_000;
  const heartbeatMs = options.heartbeatMs ?? SYSTEM_CONFIG_STATUS_PUBLISH_HEARTBEAT_MS;
  const log = options.log ?? runtimeLogger.info;
  let lastPublishedFingerprint = "";
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  let publishing = false;
  let closed = false;

  async function publishNow(): Promise<void> {
    if (closed || publishing) return;
    publishing = true;
    try {
      let status: SystemConfigObservedStatus;
      try {
        status = options.refreshRuntimeHealth
          ? await options.refreshRuntimeHealth()
          : readSystemConfigStatus(options.openclawDir);
      } catch (error) {
        log(`[system_config] status refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const fingerprint = statusFingerprint(status);
      const now = Date.now();
      if (
        fingerprint === lastPublishedFingerprint &&
        now - lastPublishedAt < heartbeatMs
      ) return;
      await options.publish(status);
      lastPublishedFingerprint = fingerprint;
      lastPublishedAt = now;
    } catch (error) {
      log(`[system_config] status publish failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      publishing = false;
    }
  }

  const timer = setInterval(() => void publishNow(), intervalMs);
  return {
    publishNow,
    close(): void {
      closed = true;
      clearInterval(timer);
    },
  };
}
