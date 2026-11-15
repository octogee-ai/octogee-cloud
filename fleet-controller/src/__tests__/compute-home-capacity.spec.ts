import { describe, expect, it, vi } from "vitest";
import { createVmHomeClient } from "../lib/compute-home.js";
import type { ComputeRequest } from "../lib/compute-vm.js";

const home = { projectId: "test", zone: "us-central1-a", name: "home-a", id: "123", sizeGb: 10, diskType: "pd-balanced" as const, source: "projects/test/zones/us-central1-a/disks/home-a" };
function fixture(overrides = {}) {
  let disk = { id: home.id, name: home.name, sizeGb: "10", type: "pd-balanced", labels: { "octogee-owner-uid": "owner", "octogee-storage": "customer-home" }, ...overrides };
  const request = vi.fn<ComputeRequest>(async (call) => {
    if (call.method === "GET") return { status: 200, data: disk };
    disk = { ...disk, sizeGb: (call.body as { sizeGb: string }).sizeGb };
    return { status: 200, data: { name: "resize", status: "DONE" } };
  });
  const journalHomeResize = vi.fn(async (_input, action) => action());
  const client = createVmHomeClient({ projectId: "test", request, readInstance: async () => null, waitForOperation: async () => {}, journalHomeResize });
  return { client, request, journalHomeResize };
}
describe("retained home capacity", () => {
  it("expands the same owned home and journals before mutation", async () => {
    const h = fixture();
    expect(await h.client.expandHome(home, "Owner", 50)).toEqual({ ...home, sizeGb: 50 });
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", url: expect.stringMatching(/home-a\/resize$/), body: { sizeGb: "50" } }));
    expect(h.journalHomeResize.mock.invocationCallOrder[0]).toBeLessThan(h.request.mock.invocationCallOrder[1]);
  });
  it("retains larger allocation after downgrade and retries an acknowledged expansion without mutation", async () => {
    const h = fixture({ sizeGb: "100" });
    expect((await h.client.expandHome(home, "Owner", 50)).sizeGb).toBe(100);
    expect((await h.client.expandHome(home, "Owner", 100)).sizeGb).toBe(100);
    expect(h.request.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
  });
  it.each([{ id: "456" }, { labels: { "octogee-owner-uid": "other", "octogee-storage": "customer-home" } }])("rejects changed custody before mutation: %j", async (overrides) => {
    const h = fixture(overrides);
    await expect(h.client.expandHome(home, "Owner", 50)).rejects.toThrow();
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("surfaces an unsuccessful resize and refuses unverified convergence", async () => {
    const h = fixture();
    h.request.mockImplementation(async () => ({ status: 503 }));
    await expect(h.client.expandHome(home, "Owner", 50)).rejects.toThrow(/503/);
    const unchanged = fixture();
    unchanged.request.mockImplementation(async (call) => ({ status: 200, data: call.method === "GET" ? { ...home, sizeGb: "10", type: "pd-balanced", labels: { "octogee-owner-uid": "owner", "octogee-storage": "customer-home" } } : { status: "DONE" } }));
    await expect(unchanged.client.expandHome(home, "Owner", 50)).rejects.toThrow(/capacity/);
  });
});
