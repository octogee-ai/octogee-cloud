import { describe, expect, it, vi } from "vitest";
import { assertHeldNativeOfflineCustody } from "./held-native-offline-custody.js";

const scope = {
  operationId: "operation", uid: "owner", slug: "fixture", sourceGatewayId: "source",
  targetGatewayId: "target", sourceEpoch: 20, schedulerMigrationId: "journal", requestId: "request",
};
const original = { projectId: "test", zone: "zone", instanceName: "legacy", instanceId: "81", bootDiskId: "82", homeDiskId: "83" };
const maintenance = { projectId: "test", zone: "zone", instanceName: "clean", instanceId: "91", bootDiskId: "92", imageId: "93", bootId: "336053f2-c076-4202-9851-d713bce658a3", lastStartedAt: 130, serviceAccountEmail: null, readOnlyCloneDiskId: "94" };
const snapshot = { id: "84", projectId: "test", sourceDiskId: "83", createdAt: 150, status: "READY" };

function fixture() {
  const source = {
    ...original, status: "TERMINATED", lastStoppedAt: 100, lastStartedAt: 90, bootImageId: "older-image",
    publicAccess: false, serviceAccounts: [], attachedDisks: [{ id: "83", mode: "READ_WRITE" as const }],
  };
  const worker = {
    ...maintenance, status: "RUNNING", lastStoppedAt: null, bootImageId: "93",
    publicAccess: false, serviceAccounts: [], attachedDisks: [{ id: "92", mode: "READ_WRITE" as "READ_WRITE" | "READ_ONLY" }, { id: "94", mode: "READ_ONLY" as const }],
  };
  const originalDisk = { id: "83", projectId: "test", users: ["projects/test/zones/zone/instances/legacy"], sourceSnapshotId: null };
  const originalBoot = { id: "82", projectId: "test", users: [...originalDisk.users], sourceSnapshotId: null };
  const cloningDisk = { id: "94", projectId: "test", users: ["projects/test/zones/zone/instances/clean"], sourceSnapshotId: "84" };
  const compute = {
    instance: vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(worker),
    disk: vi.fn().mockResolvedValueOnce(originalDisk).mockResolvedValueOnce(originalBoot).mockResolvedValueOnce(cloningDisk),
    snapshot: vi.fn().mockResolvedValue(snapshot),
  };
  return {
    source, worker, originalDisk, originalBoot, cloningDisk,
    input: { expected: { scope, original, maintenance, immutableHomeSnapshotId: "84" }, compute,
      assertCanonicalSourceAndDestinationHold: vi.fn().mockResolvedValue(undefined),
      assertOwnerStoreBarrier: vi.fn().mockResolvedValue(undefined),
      assertMaintenanceNetworkIsolation: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("offline Native return provider custody", () => {
  it("verifies provider-stopped old compute, distinct accepted boot, and only a read-only snapshot clone under both fences", async () => {
    const { input } = fixture();
    await expect(assertHeldNativeOfflineCustody(input)).resolves.toBeUndefined();
    expect(input.assertCanonicalSourceAndDestinationHold).toHaveBeenNthCalledWith(2, scope);
    expect(input.assertOwnerStoreBarrier).toHaveBeenNthCalledWith(2, scope);
  });

  it("refuses an old writer, original mounted on maintenance, mutable clone, or obsolete image", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.source.status = "RUNNING"; },
      (f: ReturnType<typeof fixture>) => { f.worker.attachedDisks.push({ id: "83", mode: "READ_ONLY" }); },
      (f: ReturnType<typeof fixture>) => { f.worker.attachedDisks.push({ id: "95", mode: "READ_WRITE" }); },
      (f: ReturnType<typeof fixture>) => { f.originalBoot.users.push("projects/test/zones/zone/instances/clean"); },
      (f: ReturnType<typeof fixture>) => { f.cloningDisk.sourceSnapshotId = "87"; },
      (f: ReturnType<typeof fixture>) => { f.worker.bootImageId = "old-maintenance-image"; },
    ]) {
      const f = fixture();
      change(f);
      await expect(assertHeldNativeOfflineCustody(f.input)).rejects.toThrow(/custody|clone/);
    }
  });

  it("refuses a private-IP alternate that has a routable internal network", async () => {
    const f = fixture();
    f.input.assertMaintenanceNetworkIsolation.mockRejectedValueOnce(new Error("internal ingress can reach the maintenance process"));
    await expect(assertHeldNativeOfflineCustody(f.input)).rejects.toThrow("internal ingress");
  });

  it("refuses captures predating the stop and a SQL fence lost during verification", async () => {
    const first = fixture();
    first.input.compute.snapshot.mockResolvedValueOnce({ ...snapshot, createdAt: 90 });
    await expect(assertHeldNativeOfflineCustody(first.input)).rejects.toThrow("snapshot");
    const second = fixture();
    second.input.assertOwnerStoreBarrier.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("SQL hold changed"));
    await expect(assertHeldNativeOfflineCustody(second.input)).rejects.toThrow("SQL hold changed");
  });
});
