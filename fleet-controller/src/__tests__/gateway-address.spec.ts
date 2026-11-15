import { describe, expect, it } from "vitest";
import { gatewayFleetBaseUrl, gatewayVmAddress } from "../lib/gateway-address";

const vmDoc = { runtime: "gce-vm", vm: { instanceName: "octogee-gw-b-x", internalIp: "172.20.0.9", instanceId: "1" } };

describe("gatewayVmAddress", () => {
  it("returns the VM address only for a gce-vm gateway with a recorded internal IP", () => {
    expect(gatewayVmAddress(vmDoc)).toEqual({ instanceName: "octogee-gw-b-x", internalIp: "172.20.0.9", instanceId: "1" });
    expect(gatewayVmAddress({ ...vmDoc, runtime: "cluster" })).toBeNull();
    expect(gatewayVmAddress({ runtime: "gce-vm", vm: null })).toBeNull();
    expect(gatewayVmAddress({ runtime: "gce-vm", vm: { instanceName: "n", internalIp: "" } })).toBeNull();
    expect(gatewayVmAddress(undefined)).toBeNull();
  });
});

describe("gatewayFleetBaseUrl", () => {
  it("addresses a VM gateway by internal IP and a cluster gateway by its Service", () => {
    expect(gatewayFleetBaseUrl({ runtimeDoc: vmDoc, gatewayId: "b-x", namespace: "octogee-test", port: 3003 }))
      .toBe("http://172.20.0.9:3003");
    expect(gatewayFleetBaseUrl({ runtimeDoc: { runtime: "cluster" }, gatewayId: "b-x", namespace: "octogee-test", port: "3003" }))
      .toBe("http://octogee-gateway-b-x.octogee-test.svc.cluster.local:3003");
  });
});
