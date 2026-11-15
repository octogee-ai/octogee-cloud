import { describe, it, expect, beforeEach } from "vitest";
import { resolveTeamId, resolveChannelId, _resetTeamCachesForTests, MmResolveError } from "../lib/chat-broker/team.js";

interface FakeFetcher {
  get: (path: string, pat: string) => Promise<any>;
  calls: string[];
  responses: Record<string, any>;
}

function makeFetcher(responses: Record<string, any>): FakeFetcher {
  const calls: string[] = [];
  return {
    calls,
    responses,
    async get(path) {
      calls.push(path);
      if (responses[path] === undefined) throw new Error(`unmocked ${path}`);
      return responses[path];
    },
  };
}

beforeEach(() => _resetTeamCachesForTests());

describe("resolveTeamId", () => {
  it("returns team id for slug", async () => {
    const f = makeFetcher({ "/api/v4/teams/name/christopher": { id: "team-1" } });
    const id = await resolveTeamId(f, "PAT", "christopher", { ttlSeconds: 300 });
    expect(id).toBe("team-1");
  });

  it("caches across calls within TTL", async () => {
    const f = makeFetcher({ "/api/v4/teams/name/christopher": { id: "team-1" } });
    const fixedNow = 1_000_000;
    await resolveTeamId(f, "PAT", "christopher", { ttlSeconds: 300, now: () => fixedNow });
    await resolveTeamId(f, "PAT", "christopher", { ttlSeconds: 300, now: () => fixedNow + 100_000 });
    expect(f.calls).toHaveLength(1);
  });

  it("re-fetches after TTL expires", async () => {
    const f = makeFetcher({ "/api/v4/teams/name/christopher": { id: "team-1" } });
    let now = 1_000_000;
    await resolveTeamId(f, "PAT", "christopher", { ttlSeconds: 60, now: () => now });
    now += 61_000;
    await resolveTeamId(f, "PAT", "christopher", { ttlSeconds: 60, now: () => now });
    expect(f.calls).toHaveLength(2);
  });

  it("throws team-not-found when MM returns no id", async () => {
    const f = makeFetcher({ "/api/v4/teams/name/missing": null });
    await expect(
      resolveTeamId(f, "PAT", "missing", { ttlSeconds: 300 }),
    ).rejects.toBeInstanceOf(MmResolveError);
  });
});

describe("resolveChannelId", () => {
  it("passes through 26-char id without an MM call", async () => {
    const f = makeFetcher({});
    const id = await resolveChannelId(f, "PAT", "team-1", "ch1id26charlongabcdefghijk", { ttlSeconds: 300 });
    expect(id).toBe("ch1id26charlongabcdefghijk");
    expect(f.calls).toHaveLength(0);
  });

  it("resolves channel name to id", async () => {
    const f = makeFetcher({
      "/api/v4/teams/team-1/channels/name/builder-pulse": { id: "ch1id26charlongabcdefghijk" },
    });
    const id = await resolveChannelId(f, "PAT", "team-1", "builder-pulse", { ttlSeconds: 300 });
    expect(id).toBe("ch1id26charlongabcdefghijk");
  });

  it("uses Mattermost's native deleted-channel lookup only for archive reads", async () => {
    const f = makeFetcher({
      "/api/v4/teams/team-1/channels/name/builder-pulse?include_deleted=true": {
        id: "ch1id26charlongabcdefghijk",
      },
    });
    const id = await resolveChannelId(f, "PAT", "team-1", "builder-pulse", {
      ttlSeconds: 300,
      includeDeleted: true,
    });
    expect(id).toBe("ch1id26charlongabcdefghijk");
  });

  it("caches per (team, name) pair", async () => {
    const f = makeFetcher({
      "/api/v4/teams/team-1/channels/name/builder-pulse": { id: "ch1id26charlongabcdefghijk" },
    });
    const fixedNow = 1_000_000;
    await resolveChannelId(f, "PAT", "team-1", "builder-pulse", { ttlSeconds: 300, now: () => fixedNow });
    await resolveChannelId(f, "PAT", "team-1", "builder-pulse", { ttlSeconds: 300, now: () => fixedNow });
    expect(f.calls).toHaveLength(1);
  });

  it("throws channel-not-found when MM returns no id", async () => {
    const f = makeFetcher({ "/api/v4/teams/team-1/channels/name/ghost": {} });
    await expect(
      resolveChannelId(f, "PAT", "team-1", "ghost", { ttlSeconds: 300 }),
    ).rejects.toBeInstanceOf(MmResolveError);
  });
});
