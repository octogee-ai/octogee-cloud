import { describe, expect, it, vi } from "vitest";
import type { DockerEngine } from "../../lib/vm-gateway-agent/docker-engine.js";
import { inspectInactiveScratchVolumes, scratchVolumeName } from "../../lib/vm-gateway-agent/scratch.js";

const root = "/var/lib/docker";
function volume(owner: string, name = "builder-cache") {
  const Name = scratchVolumeName(owner, name);
  return { Name, Driver: "local", Mountpoint: `${root}/volumes/${Name}/_data`, Options: {},
    Labels: { "ai.octogee.computer-id": owner, "ai.octogee.storage": "ephemeral" } };
}
function fixture() {
  const volumes = new Map<string, ReturnType<typeof volume>>();
  const containers: Array<{ Mounts?: Array<{ Type: string; Name?: string; Source?: string }> }> = [];
  const calls: string[] = [];
  const replies = new Map<string, number>();
  const engine: DockerEngine = { request: vi.fn(async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path === "/info") return { status: 200, body: { DockerRootDir: root } as never };
    if (path.startsWith("/volumes?")) return { status: 200, body: { Volumes: [...volumes.values()] } as never };
    if (path.startsWith("/containers/json?")) return { status: 200, body: containers as never };
    const name = decodeURIComponent(path.slice("/volumes/".length));
    if (method === "GET") return { status: replies.get(name) ?? (volumes.has(name) ? 200 : 404), body: volumes.get(name) as never };
    const status = replies.get(name) ?? 204;
    if (status === 204) volumes.delete(name);
    return { status, body: {} as never };
  }) };
  const log = vi.fn();
  return { volumes, containers, calls, replies, engine, log,
    inspect: (vmId = "b-current") => inspectInactiveScratchVolumes({ engine, vmId, stateRoot: "/srv/octogee", log }) };
}

describe("inactive gateway scratch inspection", () => {
  it("retains prior-owner scratch across rebindings until exclusive custody is available", async () => {
    const h = fixture();
    const durable = { ...volume("b-user"), Name: "customer-home", Labels: { "ai.octogee.computer-id": "b-user", "ai.octogee.storage": "durable" } };
    durable.Mountpoint = `${root}/volumes/customer-home/_data`;
    h.volumes.set(durable.Name, durable);
    const retained = [durable.Name];
    for (let cycle = 0; cycle < 4; cycle++) {
      const current = `b-${cycle}`;
      const cache = volume(current);
      h.volumes.set(cache.Name, cache);
      retained.push(cache.Name);
      await h.inspect(current);
      expect([...h.volumes.keys()].sort()).toEqual(retained.sort());
    }
    expect(h.calls.filter(call => call.startsWith("DELETE"))).toHaveLength(0);
    expect(h.calls.every(call => !call.includes("prune") && !call.includes("force=true"))).toBe(true);
  });

  it("preserves scratch referenced by running, paused or stopped containers", async () => {
    const h = fixture();
    for (const owner of ["b-running", "b-paused", "b-stopped"]) {
      const cache = volume(owner);
      h.volumes.set(cache.Name, cache);
      h.containers.push({ Mounts: [{ Type: "volume", Name: cache.Name, Source: cache.Mountpoint }] });
    }
    expect(await h.inspect()).toEqual([]);
    expect(h.calls.some(call => call.startsWith("DELETE"))).toBe(false);
    expect(h.calls).toContain("GET /containers/json?all=true");
  });

  it.each(["exact", "parent", "child", "root"])("preserves an old named scratch volume used through a host bind: %s", async (kind) => {
    const h = fixture();
    const cache = volume("b-old");
    h.volumes.set(cache.Name, cache);
    const Source = kind === "root" ? "/" : kind === "exact" ? cache.Mountpoint : kind === "parent" ? root : `${cache.Mountpoint}/nested`;
    h.containers.push({ Mounts: [{ Type: "bind", Source }] });
    expect(await h.inspect()).toEqual([]);
    expect(h.calls.some(call => call.startsWith("DELETE"))).toBe(false);
  });

  it.each(["owner", "name", "driver", "mountpoint", "options"])("retains an unverified disposable candidate: %s", async (kind) => {
    const h = fixture();
    const cache = volume("b-old");
    if (kind === "owner") cache.Labels["ai.octogee.computer-id"] = "b-other";
    if (kind === "name") cache.Name = "user-cache";
    if (kind === "driver") cache.Driver = "nfs";
    if (kind === "mountpoint") cache.Mountpoint = "/srv/octogee/user-home";
    if (kind === "options") Object.assign(cache.Options, { type: "none", device: "/home/user", o: "bind" });
    h.volumes.set(cache.Name, cache);
    expect(await h.inspect()).toEqual([]);
    expect(h.calls.some(call => call.startsWith("DELETE"))).toBe(false);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("retaining unverified scratch"));
  });

  it("retains apparently detached storage on repeated inspections without relying on Docker conflicts", async () => {
    const h = fixture();
    const cache = volume("b-old");
    h.volumes.set(cache.Name, cache);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await h.inspect()).toEqual([cache.Name]);
      expect(h.volumes.has(cache.Name)).toBe(true);
    }
    expect(h.calls.some(call => call.startsWith("DELETE"))).toBe(false);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("exclusive writer custody unavailable"));
  });

  it("does not delete when the complete container mount inventory is missing", async () => {
    const h = fixture();
    const cache = volume("b-old");
    h.volumes.set(cache.Name, cache);
    h.containers.push({});
    await expect(h.inspect()).rejects.toThrow("container mounts");
    expect(h.calls.some(call => call.startsWith("DELETE"))).toBe(false);
  });

  it.each([403, 500])("reports a Docker reinspection error %s and preserves storage", async (status) => {
    const h = fixture();
    const cache = volume("b-old");
    h.volumes.set(cache.Name, cache);
    h.replies.set(cache.Name, status);
    await expect(h.inspect()).rejects.toThrow(`HTTP ${status}`);
    expect(h.volumes.has(cache.Name)).toBe(true);
  });
});
