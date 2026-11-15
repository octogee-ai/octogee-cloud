import { describe, expect, it, vi } from "vitest";
import type { GatewayVmDescription } from "../lib/compute-vm";
import { occupiedVmZones, spreadZones } from "../vm-placement";

const ZONES = ["us-central1-b", "us-central1-c", "us-central1-f"];

function vm(name: string, zone: string, labels: Record<string, string> = {}): GatewayVmDescription {
  return {
    name, zone, machineType: "n2-standard-2", status: "RUNNING", instanceId: `id-${name}`, internalIp: null, provisioningModel: "SPOT", gatewayId: null,
    labels: { "octogee-environment": "prod", purpose: "octogee-computer", ...labels },
    metadata: {}, lastStartedAt: null, serviceAccounts: [],
  };
}

describe("spreadZones", () => {
  it("keeps the configured order when every zone is equally occupied", () => {
    expect(spreadZones(ZONES, [])).toEqual(ZONES);
  });

  it("puts the least-occupied zone first and breaks ties by configured order", () => {
    expect(spreadZones(ZONES, ["us-central1-b", "us-central1-b", "us-central1-c"])).toEqual(["us-central1-f", "us-central1-c", "us-central1-b"]);
    expect(spreadZones(ZONES, ["us-central1-b"])).toEqual(["us-central1-c", "us-central1-f", "us-central1-b"]);
  });

  it("ignores VMs in zones that are no longer configured", () => {
    expect(spreadZones(ZONES, ["us-central1-a", "us-central1-a", "us-central1-c"])).toEqual(["us-central1-b", "us-central1-f", "us-central1-c"]);
  });

  it("tries avoided zones last, still spread among themselves", () => {
    expect(spreadZones(ZONES, [], new Set(["us-central1-b"]))).toEqual(["us-central1-c", "us-central1-f", "us-central1-b"]);
    expect(spreadZones(ZONES, ["us-central1-c"], new Set(["us-central1-b", "us-central1-f"]))).toEqual(["us-central1-c", "us-central1-b", "us-central1-f"]);
  });
});

describe("occupiedVmZones", () => {
  it("counts every VM of the environment", async () => {
    const list = vi.fn(async () => [
      vm("octogee-computer-prod-uida", "us-central1-b", { "octogee-owner-uid": "uida" }),
      vm("octogee-computer-prod-uidb", "us-central1-c", { "octogee-owner-uid": "uidb" }),
    ]);

    expect(await occupiedVmZones({ list }, "prod")).toEqual(["us-central1-b", "us-central1-c"]);
    expect(list).toHaveBeenCalledWith({ labels: { "octogee-environment": "prod", purpose: "octogee-computer" } });
  });
});
