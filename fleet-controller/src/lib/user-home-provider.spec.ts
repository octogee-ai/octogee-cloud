import { describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { GatewayVmClient, GatewayVmDescription } from "./compute-vm.js";
import { createUserHomeProvider } from "./user-home-provider.js";

const uid = "OwnerUid123";
const projectId = "octogee-test";
const zone = "us-central1-f";
const instanceName = "octogee-computer-test-owneruid123";
const recorded = { instanceName, instanceId: "1001", zone };
const instanceSource = `projects/${projectId}/zones/${zone}/instances/${instanceName}`;
const diskSource = `projects/${projectId}/zones/${zone}/disks/${instanceName}-home`;

function legacyFixture(initialStatus: string, vmName = instanceName) {
  let status = initialStatus;
  const description = (): GatewayVmDescription => ({
    name: vmName, zone, status, instanceId: recorded.instanceId,
    metadata: { "octogee-owner-uid": uid },
  }) as unknown as GatewayVmDescription;
  const vm = {
    findByLabels: vi.fn(async () => description()),
    stop: vi.fn(async () => { status = "TERMINATED"; }),
    retainHome: vi.fn(),
    delete: vi.fn(),
  };
  const request = vi.fn(async ({ url }: { url: string }) => {
    if (url.endsWith(`/instances/${instanceName}`)) {
      return { status: 200, data: {
        id: recorded.instanceId, status,
        metadata: { items: [{ key: "octogee-owner-uid", value: uid }] },
        labels: { "octogee-owner-uid": uid.toLowerCase(), "octogee-environment": "test", purpose: "octogee-computer" },
        disks: [{ deviceName: "octogee-home", source: `https://www.googleapis.com/compute/v1/${diskSource}`, boot: false, autoDelete: false }],
      } };
    }
    if (url.endsWith(diskSource)) {
      return { status: 200, data: {
        id: "2002", sizeGb: "50", type: `zones/${zone}/diskTypes/pd-balanced`,
        users: [`https://www.googleapis.com/compute/v1/${instanceSource}`],
        labels: { "octogee-owner-uid": uid.toLowerCase() },
      } };
    }
    return { status: 404 };
  });
  const journal = vi.fn(async (_what: string, _uid: string, action: () => Promise<unknown>) => action());
  const provider = createUserHomeProvider({
    store: {} as PlatformStateStore, projectId, environment: "test", request,
    vm: vm as unknown as GatewayVmClient, journal: journal as unknown as Parameters<typeof createUserHomeProvider>[0]["journal"],
  });
  return { provider, vm, journal };
}

describe("legacy Builder computer home inventory", () => {
  it("stops a suspended recorded owner VM and keeps its retained home", async () => {
    const h = legacyFixture("SUSPENDED");

    const home = await h.provider.inventory(uid, { computer: recorded });

    expect(h.vm.stop).toHaveBeenCalledOnce();
    expect(h.vm.stop).toHaveBeenCalledWith(instanceName, zone);
    expect(h.journal).toHaveBeenCalledWith("stop-suspended-builder-computer", uid, expect.any(Function), `zones/${zone}/instances/${instanceName}`);
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(home).toMatchObject({ runtime: "gce-vm", layout: "flat", disk: { id: "2002", source: diskSource }, computer: { name: instanceName, id: recorded.instanceId, zone } });
  });

  it("does not stop a suspended owner VM that is not the recorded computer", async () => {
    const h = legacyFixture("SUSPENDED", "octogee-computer-test-replacement");

    await expect(h.provider.inventory(uid, { computer: recorded })).rejects.toThrow("legacy home VM identity changed");
    expect(h.vm.stop).not.toHaveBeenCalled();
  });

  it("reads a stopped recorded owner VM without stopping it again", async () => {
    const h = legacyFixture("TERMINATED");

    await expect(h.provider.inventory(uid, { computer: recorded })).resolves.toMatchObject({ disk: { id: "2002" } });
    expect(h.vm.stop).not.toHaveBeenCalled();
  });
});
