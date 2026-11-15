import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { assertIsolatedRuntimeStorage } from "../isolated-runtime-storage.js";

function fixture(runtime: "cluster" | "gce-vm") {
  const disk = { id: "42", source: "projects/test/zones/us-central1-a/disks/home" };
  const provisioning: Record<string, unknown> = { homeStorage: { runtime: "gce-vm", disk }, homeDisk: disk };
  const store = createDocumentFixtureStore({ "users/owner": { provisioning } });
  const get = vi.spyOn(store.users.records, "get");
  return { input: { store, runtime, ownerUid: "owner" }, provisioning, disk, get };
}

describe("Isolated runtime storage admission", () => {
  it("admits the recorded native home and refuses a substituted disk", async () => {
    const h = fixture("gce-vm");
    await expect(assertIsolatedRuntimeStorage(h.input)).resolves.toBeUndefined();
    h.provisioning.homeDisk = { ...h.disk, id: "43" };
    await expect(assertIsolatedRuntimeStorage(h.input)).rejects.toThrow(/native home differs/);
  });

  it("refuses a native activation whose recorded primary home is not native", async () => {
    const h = fixture("gce-vm");
    h.provisioning.homeStorage = { runtime: "cluster", disk: h.disk };
    await expect(assertIsolatedRuntimeStorage(h.input)).rejects.toThrow(/not a native home/);
  });

  it("refuses a native activation whose storage owner record is missing", async () => {
    const h = fixture("gce-vm");
    await expect(assertIsolatedRuntimeStorage({ ...h.input, ownerUid: "missing" })).rejects.toThrow(/storage owner is missing/);
  });

  it("admits a cluster user without reading storage, even with retained native state", async () => {
    const h = fixture("cluster");
    h.provisioning.computer = { instanceName: "computer", instanceId: "1", zone: "us-central1-a" };
    await expect(assertIsolatedRuntimeStorage(h.input)).resolves.toBeUndefined();
    expect(h.get).not.toHaveBeenCalled();
  });
});
