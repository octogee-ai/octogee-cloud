import type { FleetRegistryRecord } from "@octogee/core/platform-state";
import { isGatewayVmDiskObservation, resolveGatewayRuntime } from "@octogee/shared/types/glm";
import type { MirrorDelivery } from "../fleet-informer.js";

export interface VmDiskSample {
  gatewayId: string;
  sizeBytes: number;
  freeBytes: number;
  observedAt: number;
}

export function vmDiskSampleFromRecord(record: FleetRegistryRecord): VmDiskSample | null {
  if (resolveGatewayRuntime(record.runtime) !== "gce-vm") return null;
  const vm = record.vm;
  const disk = record.vmDisk;
  if (!vm || vm.status !== "RUNNING" || !isGatewayVmDiskObservation(disk) || disk.instanceId !== vm.instanceId) return null;
  return { gatewayId: record.gatewayId, sizeBytes: disk.sizeBytes, freeBytes: disk.freeBytes, observedAt: disk.observedAt };
}

function setSample(samples: Map<string, VmDiskSample>, gatewayId: string, record: FleetRegistryRecord | null): void {
  const sample = record === null ? null : vmDiskSampleFromRecord(record);
  if (sample) samples.set(gatewayId, sample);
  else samples.delete(gatewayId);
}

export function applyVmDiskDelivery(
  samples: Map<string, VmDiskSample>,
  delivery: MirrorDelivery<"fleetRegistry">,
): VmDiskSample[] {
  if (delivery.kind === "reset") {
    samples.clear();
    for (const record of delivery.records) setSample(samples, record.gatewayId, record);
  } else {
    for (const change of delivery.changes) setSample(samples, change.key, change.record);
  }
  return [...samples.values()].sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
}
