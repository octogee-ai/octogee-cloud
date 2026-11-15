import { describe, expect, it } from "vitest";
import type { FleetRegistryRecord, Revision, Stored, WatchChange } from "@octogee/core/platform-state";
import { applyVmDiskDelivery, vmDiskSampleFromRecord } from "./vm-disk-usage.js";

const disk = { sizeBytes: 40_000_000_000, freeBytes: 3_000_000_000, instanceId: "4242", observedAt: 1_000 };
const running = (gatewayId: string, overrides: Record<string, unknown> = {}): Stored<FleetRegistryRecord> => ({
  gatewayId,
  release: 1,
  lifecycle: "serving",
  runtime: "gce-vm",
  vm: { status: "RUNNING", instanceId: "4242" },
  vmDisk: disk,
  revision: "r1" as Revision,
  ...overrides,
}) as unknown as Stored<FleetRegistryRecord>;
const change = (type: WatchChange<"fleetRegistry">["type"], key: string, record: Stored<FleetRegistryRecord> | null): WatchChange<"fleetRegistry"> =>
  ({ type, key, record });

describe("vmDiskSampleFromRecord", () => {
  it("samples only a running gce-vm whose observation came from its current instance", () => {
    expect(vmDiskSampleFromRecord(running("b-x"))).toEqual({ gatewayId: "b-x", sizeBytes: disk.sizeBytes, freeBytes: disk.freeBytes, observedAt: 1_000 });
    expect(vmDiskSampleFromRecord(running("b-x", { runtime: "cluster" }))).toBeNull();
    expect(vmDiskSampleFromRecord(running("b-x", { vm: { status: "TERMINATED", instanceId: "4242" } }))).toBeNull();
    expect(vmDiskSampleFromRecord(running("b-x", { vm: { status: "RUNNING", instanceId: "9999" } }))).toBeNull();
    expect(vmDiskSampleFromRecord(running("b-x", { vmDisk: { ...disk, freeBytes: -1 } }))).toBeNull();
    expect(vmDiskSampleFromRecord(running("b-x", { vmDisk: undefined }))).toBeNull();
  });
});

describe("applyVmDiskDelivery", () => {
  it("tracks the mirror: adds, modifies, drops removed or no-longer-sampled gateways, and replaces on a reset", () => {
    const samples = new Map();
    expect(applyVmDiskDelivery(samples, { kind: "reset", records: [running("b-y"), running("b-x")] }).map((s) => s.gatewayId)).toEqual(["b-x", "b-y"]);
    expect(applyVmDiskDelivery(samples, { kind: "changes", changes: [change("modified", "b-x", running("b-x", { vmDisk: { ...disk, freeBytes: 1 } }))] })).toMatchObject([{ gatewayId: "b-x", freeBytes: 1 }, { gatewayId: "b-y" }]);
    expect(applyVmDiskDelivery(samples, { kind: "changes", changes: [change("modified", "b-y", running("b-y", { vm: { status: "STOPPING", instanceId: "4242" } }))] }).map((s) => s.gatewayId)).toEqual(["b-x"]);
    expect(applyVmDiskDelivery(samples, { kind: "changes", changes: [change("removed", "b-x", null)] })).toEqual([]);
    samples.set("stale", { gatewayId: "stale", sizeBytes: 1, freeBytes: 1, observedAt: 1 });
    expect(applyVmDiskDelivery(samples, { kind: "reset", records: [running("b-x")] }).map((s) => s.gatewayId)).toEqual(["b-x"]);
  });
});
