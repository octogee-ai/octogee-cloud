import { expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { eraseUserHomeMigrationStorage } from "../lib/user-home-erasure.js";
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
