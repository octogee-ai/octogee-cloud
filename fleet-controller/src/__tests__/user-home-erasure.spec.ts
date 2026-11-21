import { expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { eraseUserComputerStorage, eraseUserHomeMigrationStorage } from "../lib/user-home-erasure.js";
function fixture(){
 const source={runtime:"gce-vm",layout:"flat",disk:{id:"100"}};
 const target={runtime:"gce-vm",layout:"portable",disk:{id:"200"}};
 const records:Record<string,any>={"users/owner":{provisioning:{homeStorage:{...target,retained:[source]},homeMigration:{phase:"complete",source,target:target.disk,copy:{}}}}};
 const deps={store:createDocumentFixtureStore(records),copy:{abort:vi.fn(async()=>true),sweep:vi.fn(async()=>true)},removeStoppedHome:vi.fn(async()=>true),remainingOwnerHomes:vi.fn(async()=>[] as string[]),log:vi.fn()};
 return {records,provisioning:()=>records["users/owner"].provisioning,source,target,deps,run:()=>eraseUserHomeMigrationStorage(deps,"owner")};
}
it("keeps all disk identities until asynchronous erasure completes",async()=>{
 const h=fixture();h.deps.removeStoppedHome.mockResolvedValueOnce(false);
 expect(await h.run()).toBe(false);expect(h.provisioning().homeErasure).toHaveLength(2);
 expect(h.deps.removeStoppedHome).toHaveBeenLastCalledWith("owner",h.source);
 expect(await h.run()).toBe(false);expect(h.provisioning().homeErasure).toHaveLength(1);
 expect(await h.run()).toBe(false);expect(h.provisioning().homeErasure).toEqual([]);
 expect(await h.run()).toBe(true);expect(h.deps.copy.abort).not.toHaveBeenCalled();
 expect(h.provisioning()).toEqual({});
});
it("cleans unadopted helpers before touching tracked homes and retains the queue on failure",async()=>{
 const h=fixture();h.provisioning().homeMigration.phase="copying";h.deps.copy.abort.mockResolvedValueOnce(false);
 expect(await h.run()).toBe(false);expect(h.deps.removeStoppedHome).not.toHaveBeenCalled();
 h.deps.removeStoppedHome.mockRejectedValueOnce(new Error("disk ownership changed"));
 await expect(h.run()).rejects.toThrow(/ownership/);
 expect(h.provisioning().homeErasure[0]).toEqual(h.source);
});
it("treats an already-erased owner record as finished only when no owner-labelled home storage remains",async()=>{
 const h=fixture();delete h.records["users/owner"];
 expect(await h.run()).toBe(true);
 expect(h.deps.remainingOwnerHomes).toHaveBeenCalledWith("owner");
 expect(h.deps.removeStoppedHome).not.toHaveBeenCalled();expect(h.deps.copy.sweep).not.toHaveBeenCalled();
 expect(h.records).toEqual({});expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("owner record already erased"));
});
it("refuses to finish when the owner record is gone but home storage remains",async()=>{
 const h=fixture();delete h.records["users/owner"];
 h.deps.remainingOwnerHomes.mockResolvedValueOnce(["projects/octogee/zones/us-central1-b/disks/orphan-home"]);
 await expect(h.run()).rejects.toThrow(/home storage remains: projects\/octogee\/zones\/us-central1-b\/disks\/orphan-home/);
 expect(h.deps.log).not.toHaveBeenCalled();
});

const retainedHome = {
  projectId: "sandbox", zone: "us-central1-b", name: "builder-home", id: "100", sizeGb: 10,
  diskType: "pd-balanced", source: "projects/sandbox/zones/us-central1-b/disks/builder-home",
} as const;
const archivedHome = {
  phase: "archived", operationId: "archive-op", gatewayId: "hobby-s", instanceId: "99",
  snapshot: {
    projectId: "sandbox", name: "owner-home-archive", id: "102",
    sourceDiskId: retainedHome.id, sourceDisk: retainedHome.source, sizeGb: retainedHome.sizeGb,
  },
  bootDisk: { id: "101", source: "projects/sandbox/zones/us-central1-b/disks/builder-boot" },
} as const;

function archiveFixture() {
  const h = fixture();
  h.records["users/owner"] = {
    accountLifecycle: { status: "erasing", deletionId: "user-deletion" },
    provisioning: { homeArchive: archivedHome, homeDisk: retainedHome },
  };
  const compute = {
    archiveDisksAbsent: vi.fn(async () => true),
    eraseHomeSnapshot: vi.fn(async () => true),
  };
  const deleteVm = vi.fn(async () => true);
  return { ...h, compute, deleteVm,
    erase: () => eraseUserComputerStorage({ ...h.deps, compute, deleteVm }, "owner"),
  };
}

it("preserves snapshot and old disk receipts through erase retries and skips generic VM cleanup until both are verified", async () => {
  const h = archiveFixture();
  h.compute.archiveDisksAbsent.mockResolvedValueOnce(false);
  h.compute.eraseHomeSnapshot
    .mockRejectedValueOnce(new Error("HTTP 403"))
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);

  await expect(h.erase()).rejects.toThrow("disk absence");
  expect(h.compute.eraseHomeSnapshot).not.toHaveBeenCalled();
  await expect(h.erase()).rejects.toThrow("403");
  await expect(h.erase()).rejects.toThrow("snapshot erasure");
  expect(h.provisioning().homeArchive).toEqual(archivedHome);
  expect(h.provisioning().homeDisk).toEqual(retainedHome);
  expect(h.deleteVm).not.toHaveBeenCalled();

  h.deleteVm.mockImplementation(async () => {
    expect(h.provisioning().homeArchive).toBeUndefined();
    expect(h.provisioning().homeDisk).toBeUndefined();
    return false;
  });
  await expect(h.erase()).resolves.toBe(true);
  expect(h.compute.archiveDisksAbsent).toHaveBeenCalledWith(retainedHome, archivedHome.bootDisk);
  expect(h.compute.eraseHomeSnapshot).toHaveBeenLastCalledWith(archivedHome.snapshot, "owner");
  expect(h.deleteVm).toHaveBeenCalledOnce();
  await expect(h.erase()).resolves.toBe(false);
  expect(h.compute.eraseHomeSnapshot).toHaveBeenCalledTimes(3);
});

it.each(["preparing", "snapshot-ready", "restoring"])("leaves %s archive state and staged resources to its owner", async phase => {
  const h = archiveFixture();
  h.provisioning().homeArchive = { ...archivedHome, phase };
  await expect(h.erase()).rejects.toThrow("archive");
  expect(h.provisioning().homeArchive.phase).toBe(phase);
  expect(h.compute.archiveDisksAbsent).not.toHaveBeenCalled();
  expect(h.deleteVm).not.toHaveBeenCalled();
});

it("requires the account erasure mark and no recovery or secondary home writer", async () => {
  const h = archiveFixture();
  h.records["users/owner"].accountLifecycle.status = "active";
  await expect(h.erase()).rejects.toThrow("erasure authority");
  h.records["users/owner"].accountLifecycle.status = "erasing";
  h.provisioning().computerRecovery = { operationId: "other-operation" };
  await expect(h.erase()).rejects.toThrow("archive");
  delete h.provisioning().computerRecovery;
  h.provisioning().homeMigration = { phase: "copying", copy: {} };
  await expect(h.erase()).rejects.toThrow("archive");
  expect(h.compute.archiveDisksAbsent).not.toHaveBeenCalled();
  expect(h.compute.eraseHomeSnapshot).not.toHaveBeenCalled();
  expect(h.deps.copy.abort).not.toHaveBeenCalled();
  expect(h.deleteVm).not.toHaveBeenCalled();
});

it("refuses to clear either receipt if the durable archive changed while cloud erasure was in progress", async () => {
  const h = archiveFixture();
  h.compute.eraseHomeSnapshot.mockImplementation(async () => {
    h.provisioning().homeArchive = { ...archivedHome, operationId: "changed-archive" };
    return true;
  });
  await expect(h.erase()).rejects.toThrow("archive custody changed");
  expect(h.provisioning().homeArchive.operationId).toBe("changed-archive");
  expect(h.provisioning().homeDisk).toEqual(retainedHome);
  expect(h.deleteVm).not.toHaveBeenCalled();
});

it("rejects absent or conflicting source evidence before contacting Compute", async () => {
  const h = archiveFixture();
  h.provisioning().homeDisk = { ...retainedHome, id: "999" };
  await expect(h.erase()).rejects.toThrow("source disk receipt");
  expect(h.compute.archiveDisksAbsent).not.toHaveBeenCalled();
  expect(h.compute.eraseHomeSnapshot).not.toHaveBeenCalled();
});
