import { describe, expect, it } from "vitest";
import { idleSnapshotDesktop, isGatewaySizingProfile, isGatewayVmProfile, type GatewaySizingProfile } from "./sizing-profile.js";

const vm = { runtime: "gce-vm", desktop: "omarchy", machineType: "e2-standard-2", provisioningModel: "SPOT",
  bootDisk: { sizeGb: 80, type: "pd-ssd" }, homeSizeGiB: 10 } as const;
const isolated = (computer: unknown) => ({ isolation: "isolated", sizingTier: "s", computer, fallbackStorageGb: null });

describe("idle storage policy on a VM sizing profile", () => {
  it("retains idle disks unless the profile asks for a snapshot", () => {
    expect(isGatewayVmProfile(vm)).toBe(true);
    expect(idleSnapshotDesktop(isolated(vm) as GatewaySizingProfile)).toBeUndefined();
    expect(idleSnapshotDesktop({ isolation: "shared" })).toBeUndefined();
    expect(idleSnapshotDesktop(undefined)).toBeUndefined();
  });

  it("names the desktop whose idle VM is replaced by a home snapshot", () => {
    const profile = isolated({ ...vm, idleStorage: "snapshot" });
    expect(isGatewaySizingProfile(profile)).toBe(true);
    expect(idleSnapshotDesktop(profile as GatewaySizingProfile)).toBe("omarchy");
  });

  it.each(["retain", "checkpoint", true, null, 1])("rejects the unknown idle storage policy %j", (idleStorage) => {
    expect(isGatewayVmProfile({ ...vm, idleStorage })).toBe(false);
    expect(isGatewaySizingProfile(isolated({ ...vm, idleStorage }))).toBe(false);
  });

  it("does not let a pod profile carry the VM idle storage policy", () => {
    expect(idleSnapshotDesktop(isolated({ runtime: "cluster", homeSizeGiB: 4, idleStorage: "snapshot" }) as GatewaySizingProfile)).toBeUndefined();
  });
});
