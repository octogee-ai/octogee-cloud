

import { describe, it, expect, vi } from "vitest";
import { createChannelMemberResolver } from "../channel-members.js";

describe("createChannelMemberResolver", () => {
  it("CM1 fetches on miss, serves cached on hit", async () => {
    const fetchMembers = vi.fn(async () => new Set(["u1", "u2"]));
    const r = createChannelMemberResolver({ fetchMembers, ttlMs: 1000, now: () => 0 });
    expect(await r.getMembers("c1")).toEqual(new Set(["u1", "u2"]));
    expect(await r.getMembers("c1")).toEqual(new Set(["u1", "u2"]));
    expect(fetchMembers).toHaveBeenCalledTimes(1);
  });

  it("CM2 dedupes concurrent calls for the same channel", async () => {
    let resolve!: (s: Set<string>) => void;
    const fetchMembers = vi.fn(
      () => new Promise<Set<string>>((res) => { resolve = res; }),
    );
    const r = createChannelMemberResolver({ fetchMembers, ttlMs: 1000, now: () => 0 });
    const p1 = r.getMembers("c1");
    const p2 = r.getMembers("c1");
    resolve(new Set(["u1"]));
    expect(await p1).toEqual(new Set(["u1"]));
    expect(await p2).toEqual(new Set(["u1"]));
    expect(fetchMembers).toHaveBeenCalledTimes(1);
  });

  it("CM3 refetches after TTL expiry", async () => {
    let t = 0;
    const fetchMembers = vi.fn(async () => new Set([`u${t}`]));
    const r = createChannelMemberResolver({ fetchMembers, ttlMs: 100, now: () => t });
    expect(await r.getMembers("c1")).toEqual(new Set(["u0"]));
    t = 50;
    expect(await r.getMembers("c1")).toEqual(new Set(["u0"])); 
    t = 201;
    expect(await r.getMembers("c1")).toEqual(new Set(["u201"])); 
    expect(fetchMembers).toHaveBeenCalledTimes(2);
  });

  it("CM4 invalidate() forces a refetch", async () => {
    const fetchMembers = vi.fn(async () => new Set(["u1"]));
    const r = createChannelMemberResolver({ fetchMembers, ttlMs: 1e6, now: () => 0 });
    await r.getMembers("c1");
    r.invalidate("c1");
    await r.getMembers("c1");
    expect(fetchMembers).toHaveBeenCalledTimes(2);
  });

  it("CM5 a fetch rejection yields an empty set and is not cached", async () => {
    const fetchMembers = vi
      .fn<(c: string) => Promise<Set<string>>>()
      .mockRejectedValueOnce(new Error("MM 500"))
      .mockResolvedValueOnce(new Set(["u1"]));
    const r = createChannelMemberResolver({ fetchMembers, ttlMs: 1000, now: () => 0 });
    expect(await r.getMembers("c1")).toEqual(new Set()); 
    expect(await r.getMembers("c1")).toEqual(new Set(["u1"])); 
    expect(fetchMembers).toHaveBeenCalledTimes(2);
  });

  it("CM6 invokes onError on a fetch failure (so the degradation isn't silent)", async () => {
    const boom = new Error("MM 401");
    const onError = vi.fn();
    const r = createChannelMemberResolver({
      fetchMembers: vi.fn().mockRejectedValue(boom),
      ttlMs: 1000,
      now: () => 0,
      onError,
    });
    expect(await r.getMembers("c1")).toEqual(new Set());
    expect(onError).toHaveBeenCalledWith("c1", boom);
  });
});
