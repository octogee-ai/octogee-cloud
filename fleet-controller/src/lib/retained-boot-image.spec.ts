import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { GatewayVmSpec, RetainedUserHome } from "@octogee/shared/types/glm";
import { describe, expect, it, vi } from "vitest";
import type { ComputeImageRef } from "./compute-vm.js";
import { selectRetainedBootImage } from "./retained-boot-image.js";

const ownerUid = "owner-a";
const gatewayId = "builder-a";
const zone = "us-central1-b";
const physical = (instanceId: string) => ({ instanceId, name: "owner-a-computer", gatewayId, zone });
const home: RetainedUserHome = { zone, id: "100", name: "owner-a-home", projectId: "test-project", sizeGb: 10,
  diskType: "pd-balanced", source: "projects/test-project/zones/us-central1-b/disks/owner-a-home" };
const pending = { uid: ownerUid, slug: "alice", returnOperationId: "return-a", migrationId: "scheduler-a",
  sourceGatewayId: gatewayId, sharedGatewayId: "shared-a", instanceName: physical("400").name, instanceId: "400", zone,
  homeDiskId: home.id, homeDiskSource: home.source, completedAt: 20, cutoverCommittedAt: 10 };
const spec: GatewayVmSpec = { zones: [zone], desktop: "x11", imageFamily: "boot-family", imageProject: "test-project",
  diskSizeGb: 80, bootDiskType: "pd-balanced", homeDiskSizeGb: 10, machineType: "e2-medium", provisioningModel: "STANDARD",
  serviceAccountEmail: "fixture@example.invalid", subnetwork: "fixture" };
const image = (suffix: number) => ({ id: String(500 + suffix), name: `boot-release-${suffix}`, homeAdmission: true as const });

function fixture() {
  const store = createDocumentFixtureStore({
    [`users/${ownerUid}`]: { provisioning: { homeDisk: home, pendingNativeSchedulerRetirement: pending, openclaw: { slug: "alice" } } },
  });
  let family = image(1);
  const vm = { readFamilyImage: vi.fn(async () => family), readImage: vi.fn(async () => family) };
  const select = (version: number, source: ReturnType<typeof physical>, previous: ComputeImageRef) => {
    family = image(version);
    return selectRetainedBootImage({ store, vm, ownerUid, home, spec, previous,
      operationId: `boot-${source.instanceId}-${family.id}`, sourceComputer: source });
  };
  return { store, select };
}

describe("scheduler retirement across retained boot image replacements", () => {
  it("keeps the original scheduler receipt across three upgrades and preserves direct retry sources", async () => {
    const h = fixture();
    const first = await h.select(1, physical("400"), image(0));
    expect(first.sourceComputer).toEqual(physical("400"));

    const second = await h.select(2, physical("401"), image(1));
    const third = await h.select(3, physical("402"), image(2));
    expect(second).toMatchObject({ sourceComputer: physical("401"), nativeSchedulerRetirement: pending });
    expect(third).toMatchObject({ sourceComputer: physical("402"), nativeSchedulerRetirement: pending });
    await expect(h.select(3, physical("402"), image(2))).resolves.toEqual(third);
    await expect(h.select(3, { ...physical("402"), zone: "us-central1-f" }, image(2))).rejects.toThrow(/source changed/);
  });

  it.each(["previous image", "home disk", "name", "zone", "gateway", "retirement"] as const)(
    "preserves the prior boot pin when the incoming %s does not establish continuity", async mismatch => {
      const h = fixture();
      const first = await h.select(1, physical("400"), image(0));
      if (mismatch === "home disk" || mismatch === "retirement") {
        await h.store.users.records.setFence(ownerUid, "pendingNativeSchedulerRetirement", {
          ...pending, ...(mismatch === "home disk" ? { homeDiskId: "999" } : { instanceId: "987" }),
        }, pending);
      }
      const next = physical("401");
      if (mismatch === "name") next.name = "other-computer";
      if (mismatch === "zone") next.zone = "us-central1-f";
      if (mismatch === "gateway") next.gatewayId = "other-builder";
      await expect(h.select(2, next, mismatch === "previous image" ? image(999) : image(1))).rejects.toThrow(/scheduler/i);
      expect((await h.store.users.records.get(ownerUid))?.home.homeDisk?.bootImage).toEqual(first);
    },
  );
});
