import { isolatedPrelaunchReserved, type PrelaunchAuthorityReader } from "@octogee/core/isolated-prelaunch";
import type { FleetRegistryRecord } from "@octogee/core/platform-state";
import { timestampMillis } from "@octogee/core/timestamps";
export { isolatedPrelaunchReserved } from "@octogee/core/isolated-prelaunch";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import type { DurableGateway } from "./converge-gateway.js";

function sameReleaseResumeReady(gateway: DurableGateway, runtime: { lifecycle: string; heartbeat?: { lastHeartbeatAt?: unknown } }): boolean {
  const heartbeatAt = timestampMillis(runtime.heartbeat?.lastHeartbeatAt);
  const now = Date.now();
  return gateway.liveRelease === gateway.desiredRelease && runtime.lifecycle === "provisioning" &&
    heartbeatAt != null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

export function runtimeMatchesPrelaunchRelease(
  gateway: DurableGateway,
  runtime: FleetRegistryRecord | null | undefined,
  image: { imageRepository: string; imageTag: string },
): boolean {
  if (!runtime || runtime.runtime !== "gce-vm") return false;
  return [
    gateway.liveRelease !== null && (gateway.liveRelease < gateway.desiredRelease || sameReleaseResumeReady(gateway, runtime)),
    runtime.gatewayId === gateway.gatewayId,
    runtime.release === gateway.desiredRelease,
    runtime.helm?.imageRepository === image.imageRepository,
    runtime.helm?.imageTag === image.imageTag,
    runtime.heartbeat?.status === "booting",
    gatewayHeartbeatMatchesImageTag(runtime.heartbeat?.version, image.imageTag),
    Array.isArray(runtime.heartbeat?.mountedCustomers) && runtime.heartbeat.mountedCustomers.length === 0,
  ].every(Boolean);
}

export async function readIsolatedPrelaunchRefresh(input: {
  reader: PrelaunchAuthorityReader;
  gateway: DurableGateway;
  runtime: FleetRegistryRecord | null | undefined;
  image: { imageRepository: string; imageTag: string };
  observedImage: { imageRepository: string | null; imageTag: string | null } | null;
}): Promise<boolean> {
  return runtimeMatchesPrelaunchRelease(input.gateway, input.runtime, input.image) &&
    input.observedImage?.imageRepository === input.image.imageRepository &&
    input.observedImage.imageTag === input.image.imageTag &&
    await isolatedPrelaunchReserved(input);
}
