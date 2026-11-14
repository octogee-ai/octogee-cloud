import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "@octogee/shared/types/fleet-controller";
import { dualReadIsolatedProfileImage, isGatewayRuntimeDoc, projectGatewayDesiredRootForGateway, type GatewayDoc, type GatewayRuntimeDoc } from "@octogee/shared/types/gateway-releases";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import type { GatewayArtifact, GatewayMutableConfig } from "./gateway-live-release.js";

export const OPENCLAW_CONTROL_RUNTIME_FRESH_MS = GATEWAY_HEARTBEAT_INTERVAL_MS * 4;
const MAX_CLOCK_SKEW_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function epochMillis(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const item = record(value);
  if (!item) return null;
  if (typeof item.seconds === "number" && typeof item.nanoseconds === "number") {
    return item.seconds * 1_000 + item.nanoseconds / 1_000_000;
  }
  if (typeof item.toMillis === "function") {
    const parsed = item.toMillis.call(value) as unknown;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isFreshWithin(value: unknown, now: number, freshMs: number): boolean {
  const observedAt = epochMillis(value);
  return observedAt !== null &&
    observedAt <= now + MAX_CLOCK_SKEW_MS &&
    now - observedAt <= freshMs;
}

function hasReadyRevisionIdentity(
  revision: Record<string, unknown> | null,
  input: { gatewayId: string; revisionId: string },
): boolean {
  return revision?.docKind === "runtime" &&
    revision.gatewayId === input.gatewayId &&
    input.revisionId === input.gatewayId &&
    revision.lifecycle === "serving";
}

function hasExpectedRuntimeIdentity(configStatus: Record<string, unknown> | null): boolean {
  return configStatus?.runtimeReady === true &&
    configStatus.runtimeHealth === "healthy";
}

function hasReadyDashboard(
  configStatus: Record<string, unknown> | null,
  now: number,
): boolean {
  const dashboardProtocol = record(configStatus?.dashboardControlProtocol);
  return configStatus?.dashboardControlState === "ready" &&
    dashboardProtocol?.protocol === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL &&
    dashboardProtocol.version === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION &&
    isFreshWithin(
      configStatus.dashboardControlObservedAt,
      now,
      OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
    );
}

function hasFreshRuntimeProof(
  heartbeat: Record<string, unknown> | null,
  configStatus: Record<string, unknown> | null,
  now: number,
): boolean {
  return heartbeat?.status === "ready" &&
    isFreshWithin(heartbeat.lastHeartbeatAt, now, OPENCLAW_CONTROL_RUNTIME_FRESH_MS) &&
    isFreshWithin(configStatus?.runtimeHealthCheckedAt, now, OPENCLAW_CONTROL_RUNTIME_FRESH_MS) &&
    isFreshWithin(configStatus?.observedAt, now, OPENCLAW_CONTROL_RUNTIME_FRESH_MS);
}

export function isOpenClawControlRevisionRuntimeReady(
  value: unknown,
  input: { gatewayId: string; revisionId: string; now?: number },
): boolean {
  const revision = record(value);
  if (!revision || !hasReadyRevisionIdentity(revision, input)) return false;
  const now = input.now ?? Date.now();
  const heartbeat = record(revision.heartbeat);
  const configStatus = record(heartbeat?.configStatus);
  return hasExpectedRuntimeIdentity(configStatus) &&
    hasReadyDashboard(configStatus, now) &&
    hasFreshRuntimeProof(heartbeat, configStatus, now);
}

export async function isOpenClawControlServingRevision(
  root: unknown,
  runtime: unknown,
  input: {
    gatewayId: string;
    revisionId: string;
    now?: number;
    readArtifact: (release: number) => Promise<GatewayArtifact | null>;
  },
): Promise<boolean> {
  const gateway = projectGatewayDesiredRootForGateway(root, input.gatewayId);
  if (!gateway || gateway.desiredStatus !== "running" || gateway.liveRelease === null ||
    input.revisionId !== input.gatewayId || !isGatewayRuntimeDoc(runtime) ||
    runtime.gatewayId !== input.gatewayId || runtime.lifecycle !== "serving") return false;
  if (gateway.desiredRelease === gateway.liveRelease) return runtime.release === gateway.liveRelease;
  return isServingUserDuringRoll(root, gateway, runtime, input);
}

async function isServingUserDuringRoll(
  root: unknown,
  gateway: GatewayDoc & GatewayMutableConfig,
  runtime: GatewayRuntimeDoc,
  input: Parameters<typeof isOpenClawControlServingRevision>[2],
): Promise<boolean> {
  if (gateway.gatewayClass !== "isolated" || gateway.liveRelease === null || gateway.desiredRelease < gateway.liveRelease ||
    gateway.retireAfter != null ||
    record(root)?.retirementClaim != null || record(root)?.runtimeRestartFence !== undefined ||
    (runtime.release !== gateway.liveRelease && runtime.release !== gateway.desiredRelease) ||
    !isOpenClawControlRevisionRuntimeReady(runtime, input)) return false;
  const artifact = await input.readArtifact(gateway.liveRelease);
  const image = artifact?.profileImages === undefined ? undefined : dualReadIsolatedProfileImage(artifact.profileImages);
  return image !== undefined && gatewayHeartbeatMatchesImageTag(runtime.heartbeat.version, image.imageTag);
}
