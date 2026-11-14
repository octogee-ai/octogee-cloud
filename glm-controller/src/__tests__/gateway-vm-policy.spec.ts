import { describe, expect, it } from "vitest";
import { FIXTURE_SIZING_PROFILES } from "@octogee/core/testing/journal-store";
import { resolveGatewayVmPolicy } from "../vm-gateway-runtime.js";

function storeWith(sizingProfiles: Record<string, unknown>) {
  return {
    config: { orchestrator: { get: async () => ({ sizingProfiles }) } },
  } as unknown as Parameters<typeof resolveGatewayVmPolicy>[0];
}

const store = storeWith(FIXTURE_SIZING_PROFILES);

describe("User tier VM placement", () => {
  it.each([
    ["hobby", "s", "gce-vm", "x11", "e2-medium", "STANDARD", { sizeGb: 80, type: "pd-balanced" }, 10, 100],
    ["pro", "m", "gce-vm", "omarchy", "e2-standard-2", "STANDARD", { sizeGb: 80, type: "pd-ssd" }, 50, 500],
    ["team", "l", "gce-vm", "omarchy", "e2-standard-4", "STANDARD", { sizeGb: 80, type: "pd-ssd" }, 100, 1024],
  ] as const)("keeps %s home capacity separate from project storage", async (tier, sizing, runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB, projectStorageGb) => {
    expect(FIXTURE_SIZING_PROFILES[tier]).toMatchObject({ sizingTier: sizing, fallbackStorageGb: projectStorageGb });
    await expect(resolveGatewayVmPolicy(store, sizing)).resolves.toEqual({ runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB });
  });

  it("refuses a sizing tier claimed by profiles with different VMs", async () => {
    const conflicting = storeWith({ hobby: FIXTURE_SIZING_PROFILES.hobby, pro: { ...FIXTURE_SIZING_PROFILES.pro, sizingTier: "s" } });
    await expect(resolveGatewayVmPolicy(conflicting, "s")).rejects.toThrow("Conflicting gateway VM policies for sizing tier s: hobby, pro");
  });

  it("accepts profiles that share a sizing tier and VM", async () => {
    const shared = storeWith({ hobby: FIXTURE_SIZING_PROFILES.hobby, starter: FIXTURE_SIZING_PROFILES.hobby });
    await expect(resolveGatewayVmPolicy(shared, "s")).resolves.toMatchObject({ desktop: "x11" });
  });

  it("uses Hobby sizing for an unspecified user and rejects a tier no profile names", async () => {
    await expect(resolveGatewayVmPolicy(store, undefined)).resolves.toMatchObject({ desktop: "x11" });
    await expect(resolveGatewayVmPolicy(storeWith({ hobby: FIXTURE_SIZING_PROFILES.hobby }), "l")).rejects.toThrow(/gateway VM/);
  });
});
