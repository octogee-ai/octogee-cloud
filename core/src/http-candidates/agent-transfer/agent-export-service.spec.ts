import { describe, expect, it, vi } from "vitest";
import { exportDigest } from "./agent-export-snapshot.js";
import { AgentExportService, agentExportApproval, withinAgentExportDeadline, type AgentExportRecord } from "./agent-export-service.js";
const oldHead = "a".repeat(40), newHead = "b".repeat(40);
function fixture() {
  let record: AgentExportRecord | null = null;
  const snapshot = { files: [{ path: "SOUL.md", mode: "100644" as const, content: "bmV3", size: 3, sha256: "c".repeat(64) }], digest: "d".repeat(64), assetIdentity: "e".repeat(64) };
  snapshot.digest = exportDigest(snapshot.files);
  const source = { uid: "u1", slug: "alice", gatewayId: "shared-a", epoch: 7, agentId: "octogee-alice-coach", project: null };
  const deps = {
    authorize: vi.fn(async () => source), capture: vi.fn(async () => snapshot),
    destination: vi.fn(async () => ({ owner: "alice", repo: "agent", branch: "main", head: oldHead, tree: "f".repeat(40), files: [{ path: "SOUL.md", mode: "100644", type: "blob", sha: "1".repeat(40) }] })),
    prepareCommit: vi.fn(async () => newHead), readHead: vi.fn(async () => oldHead),
    publish: vi.fn(async (_record: AgentExportRecord, _assertCurrent: () => Promise<void>) => {}),
    put: vi.fn(async (next: AgentExportRecord) => { record = structuredClone(next); }),
    get: vi.fn(async () => record),
    putSnapshot: vi.fn(async () => {}), getSnapshot: vi.fn(async () => snapshot),
    now: () => new Date("2026-10-23T00:00:00Z"), id: () => "export-one",
  };
  return { deps, service: new AgentExportService(deps), source, snapshot };
}
function sortedMaps<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)) as T;
}
describe("one-time authored export", () => {
  it("hashes nested JSON maps canonically while preserving arrays and literal prototype keys", () => {
    expect(exportDigest({ z: [{ b: 2, a: 1 }], a: null })).toBe(exportDigest({ a: null, z: [{ a: 1, b: 2 }] }));
    expect(exportDigest([1, 2])).not.toBe(exportDigest([2, 1]));
    expect(exportDigest(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe(exportDigest(JSON.parse('{"a":2,"__proto__":{"x":1}}')));
    expect(exportDigest(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(exportDigest({}));
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "hidden" });
    for (const value of [new Date(), new Map(), Buffer.from("x"), Object.create({ inherited: true }), accessor, Object.defineProperty({}, "hidden", { value: 1 }), cycle, undefined, NaN, [undefined], Array(1), { [Symbol("x")]: 1 }]) {
      expect(() => exportDigest(value)).toThrow(/invalid authored export digest/);
    }
  });
  it("keeps approval identity through sorted-map journal serialization", async () => {
    const { service, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    expect(agentExportApproval(sortedMaps(preview))).toBe(preview.approvalHash);
  });
  it("applies a preview after persisted source and nested snapshot map keys reorder", async () => {
    const { service, deps, source, snapshot } = fixture();
    const originalPut = deps.put.getMockImplementation()!;
    deps.put.mockImplementation(record => originalPut(sortedMaps(record)));
    deps.getSnapshot.mockResolvedValue(sortedMaps(snapshot));
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    deps.publish.mockImplementation(async () => { deps.readHead.mockResolvedValue(newHead); });
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
    const saved = await deps.get();
    expect(agentExportApproval(saved!)).toBe(preview.approvalHash);
    expect(deps.publish).toHaveBeenCalledOnce();
  });
  it("previews overwrites, persists expected commit before a single non-force publication, and reads back", async () => {
    const { service, deps } = fixture();
    const preview = await service.preview("octogee-alice-coach", { owner: "alice", repo: "agent" });
    expect(preview.changes).toEqual([{ path: "SOUL.md", action: "overwrite", size: 3 }]);
    deps.publish.mockImplementation(async () => { expect((await deps.get())?.expectedCommit).toBe(newHead); deps.readHead.mockResolvedValue(newHead); });
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
    expect(deps.publish).toHaveBeenCalledOnce();
    await service.apply(preview.id, preview.approvalHash);
    expect(deps.publish).toHaveBeenCalledOnce();
  });
  it("recovers an ambiguous ref update by exact expected-commit readback", async () => {
    const { service, deps } = fixture(); const preview = await service.preview("octogee-alice-coach", { owner: "alice", repo: "agent" });
    deps.publish.mockImplementation(async () => { deps.readHead.mockResolvedValue(newHead); throw new Error("connection lost"); });
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
  });
  it("acknowledges an already-published commit after preview expiry without another PATCH", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    deps.publish.mockRejectedValue(new Error("lost update response"));
    await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow("lost update response");
    deps.now = () => new Date("2026-10-24T00:00:20Z");
    deps.readHead.mockResolvedValue(newHead); deps.publish.mockClear(); deps.authorize.mockClear();
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
    expect(deps.publish).not.toHaveBeenCalled(); expect(deps.authorize).not.toHaveBeenCalled();
  });
  it.each([false, true])("refuses a new publication after24h even with an unpublished expected commit (prepared=%s)", async prepared => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    if (prepared) await deps.put({ ...preview, expectedCommit: newHead, status: "publishing" });
    deps.now = () => new Date(prepared ? "2026-10-24T00:00:20Z" : "2026-10-24T00:00:00Z");
    await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow("preview expired");
    expect(deps.prepareCommit).not.toHaveBeenCalled(); expect(deps.publish).not.toHaveBeenCalled();
  });
  it("completes a publication admitted immediately before preview expiry", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    deps.now = () => new Date("2026-10-23T23:59:59Z");
    deps.publish.mockImplementation(async () => {
      deps.now = () => new Date("2026-10-24T00:00:20Z"); deps.readHead.mockResolvedValue(newHead);
    });
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
    expect(deps.publish).toHaveBeenCalledOnce();
  });
  it("refuses stale destination, changed content or epoch before creating any Git object", async () => {
    for (const change of ["destination", "content", "epoch"] as const) {
      const { service, deps, source, snapshot } = fixture(); const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
      if (change === "destination") deps.readHead.mockResolvedValue("9".repeat(40));
      if (change === "content") deps.capture.mockResolvedValue({ ...snapshot, digest: "0".repeat(64) });
      if (change === "epoch") deps.authorize.mockResolvedValue({ ...source, epoch: 8 });
      await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow(/changed/);
      expect(deps.prepareCommit).not.toHaveBeenCalled(); expect(deps.publish).not.toHaveBeenCalled();
    }
  });
  it("performs only receipt readback after custody moved following an ambiguous successful update", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    deps.publish.mockRejectedValue(new Error("unknown update result"));
    await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow("unknown update result");
    deps.authorize.mockResolvedValue({ ...source, gatewayId: "replacement", epoch: 8 });
    deps.readHead.mockResolvedValue(newHead);
    deps.capture.mockClear(); deps.publish.mockClear();
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
    expect(deps.capture).not.toHaveBeenCalled(); expect(deps.publish).not.toHaveBeenCalled();
  });
  it("refuses a new publication when source custody changes while preparing Git objects", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    deps.prepareCommit.mockImplementation(async () => { deps.authorize.mockResolvedValue({ ...source, epoch: 8 }); return newHead; });
    await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow("source authority changed");
    expect(deps.publish).not.toHaveBeenCalled();
  });
  it("refuses publication when custody moves during the final head read", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    let reads = 0;
    deps.readHead.mockImplementation(async () => {
      if (++reads === 2) deps.authorize.mockResolvedValue({ ...source, epoch: 8 });
      return oldHead;
    });
    await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow("source authority changed");
    expect(deps.publish).not.toHaveBeenCalled();
  });
  it("passes exact source custody to the last outbound publication assertion", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    const patch = vi.fn();
    deps.publish.mockImplementation(async (_record, assertCurrent) => {
      deps.authorize.mockResolvedValue({ ...source, gatewayId: "replacement", epoch: source.epoch + 1 });
      await assertCurrent();
      patch();
    });
    await expect(service.apply(preview.id, preview.approvalHash)).rejects.toThrow("source authority changed");
    expect(patch).not.toHaveBeenCalled();
  });
  it("rejects file/directory conflicts and import-purpose records", async () => {
    const { service, deps } = fixture();
    deps.destination.mockResolvedValue({ ...(await deps.destination()), files: [{ path: "SOUL.md/child", mode: "100644", type: "blob", sha: oldHead }] });
    await expect(service.preview("octogee-alice-coach", { owner: "alice", repo: "agent" })).rejects.toThrow(/conflict/);
    deps.get.mockResolvedValue({ kind: "import" } as never);
    await expect(service.apply("old-import", "approval")).rejects.toThrow(/export/);
  });
  it("retains expected commit when the request expires after publication and recovers without republishing", async () => {
    const { service, deps, source } = fixture();
    const preview = await service.preview(source.agentId, { owner: "alice", repo: "agent" });
    const controller = new AbortController();
    deps.publish.mockImplementation(async () => {
      deps.readHead.mockResolvedValue(newHead);
      controller.abort();
      await new Promise<void>(() => {});
    });
    await expect(withinAgentExportDeadline(service.apply(preview.id, preview.approvalHash), controller.signal)).rejects.toMatchObject({ code: "export_unconfirmed" });
    expect(await deps.get()).toMatchObject({ status: "publishing", expectedCommit: newHead });
    expect((await service.apply(preview.id, preview.approvalHash)).status).toBe("complete");
    expect(deps.publish).toHaveBeenCalledOnce();
  });

});
