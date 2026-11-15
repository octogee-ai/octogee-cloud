import { describe, expect, it, vi } from "vitest";
import {
  departedFromAssigned,
  createBackgroundGatewayRecovery,
  intersectMounted,
  parseFleetStateResponse,
  pollGatewayHeartbeatsOnce,
  type EvictionInFlight,
  type EvictionStreaks,
  type GatewayHeartbeatPollerDeps,
} from "../gateway-heartbeat-poller.js";

describe("background gateway recovery", () => {
  it("continues polling other gateways while recovery waits and deduplicates requests", async () => {
    let release!: () => void;
    const recover = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const schedule = createBackgroundGatewayRecovery(recover, vi.fn());
    const deps = makeDeps({
      listGatewayIds: vi.fn(async () => ["offline", "healthy"]),
      fetchFleetState: vi.fn(async (id: string) => id === "offline" ? null : { status: "ready", users: [] }),
      readAssignedSlugs: vi.fn(async () => []), onUnreachable: async id => { schedule(id); },
    });
    await pollGatewayHeartbeatsOnce(deps);
    schedule("offline");
    expect(recover).toHaveBeenCalledTimes(1);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("healthy", expect.objectContaining({ status: "ready" }));
    release();
  });
  it("logs recovery failures and allows a retry", async () => {
    const recover = vi.fn().mockRejectedValueOnce(new Error("recovery failed")).mockResolvedValue(undefined);
    const log = vi.fn();
    const schedule = createBackgroundGatewayRecovery(recover, log);
    schedule("b-x");
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("recovery failed")));
    schedule("b-x");
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
  });
});

describe("parseFleetStateResponse", () => {
  it("parses a well-formed /fleet-state body", () => {
    expect(parseFleetStateResponse({ status: "ready", customers: ["a", "b"] })).toEqual({
      status: "ready",
      users: ["a", "b"],
    });
  });

  it("filters non-string entries out of users", () => {
    expect(
      parseFleetStateResponse({ status: "ready", customers: ["a", 1, null, "b"] }),
    ).toEqual({ status: "ready", users: ["a", "b"] });
  });

  it("returns null for malformed bodies (skipped like unreachable, never fabricated)", () => {
    expect(parseFleetStateResponse(null)).toBeNull();
    expect(parseFleetStateResponse("ready")).toBeNull();
    expect(parseFleetStateResponse({ customers: ["a"] })).toBeNull(); // missing status
    expect(parseFleetStateResponse({ status: "", customers: ["a"] })).toBeNull(); // empty status
    expect(parseFleetStateResponse({ status: 1, customers: ["a"] })).toBeNull(); // non-string status
    expect(parseFleetStateResponse({ status: "ready" })).toBeNull(); // missing users
    expect(parseFleetStateResponse({ status: "ready", customers: "a" })).toBeNull(); // non-array
  });

  it("carries startedAt when /health reports a number, ignores a non-number", () => {
    expect(
      parseFleetStateResponse({ status: "ready", customers: [], startedAt: 1700 }),
    ).toEqual({ status: "ready", users: [], startedAt: 1700 });
    expect(
      parseFleetStateResponse({ status: "ready", customers: [], startedAt: "x" }),
    ).toEqual({ status: "ready", users: [] });
  });

  it("carries the running build version used by revision readiness", () => {
    expect(
      parseFleetStateResponse({ status: "ready", customers: [], version: "93073bd" }),
    ).toEqual({ status: "ready", users: [], version: "93073bd" });
  });

  it("carries the OpenClaw runtime version used by retirement fencing", () => {
    expect(
      parseFleetStateResponse({
        status: "ready",
        customers: [],
        openclawVersion: "2026.7.1",
      }),
    ).toEqual({
      status: "ready",
      users: [],
      openclawVersion: "2026.7.1",
    });
  });

  it("carries the configured user report, nulling a malformed one and omitting an absent one", () => {
    expect(parseFleetStateResponse({ status: "ready", customers: [], configuredBuilder: { state: "claimed", generation: null } }))
      .toEqual({ status: "ready", users: [], configuredBuilder: { state: "claimed", generation: null } });
    expect(parseFleetStateResponse({ status: "ready", customers: [], configuredBuilder: { state: "claimed", generation: 2 } }))
      .toEqual({ status: "ready", users: [], configuredBuilder: { state: "claimed", generation: 2 } });
    expect(parseFleetStateResponse({ status: "ready", customers: [], configuredBuilder: null }))
      .toEqual({ status: "ready", users: [], configuredBuilder: null });
    expect(parseFleetStateResponse({ status: "ready", customers: [], configuredBuilder: { state: "owner" } }))
      .toEqual({ status: "ready", users: [], configuredBuilder: null });
    expect(parseFleetStateResponse({ status: "ready", customers: [] })).toEqual({ status: "ready", users: [] });
  });

  it("carries the OpenClaw process report, nulling a malformed one and omitting an absent one", () => {
    expect(parseFleetStateResponse({ status: "booting", customers: [], openclawProcess: { state: "held", migrationId: null } }))
      .toEqual({ status: "booting", users: [], openclawProcess: { state: "held", migrationId: null } });
    expect(parseFleetStateResponse({ status: "booting", customers: [], openclawProcess: { state: "stuck" } }))
      .toEqual({ status: "booting", users: [], openclawProcess: null });
    expect(parseFleetStateResponse({ status: "booting", customers: [] })).toEqual({ status: "booting", users: [] });
  });

  it("carries migratingIn (string entries only); omits it when absent or non-array", () => {
    expect(
      parseFleetStateResponse({ status: "ready", customers: ["a"], migratingIn: ["a", 1, "b"] }),
    ).toEqual({ status: "ready", users: ["a"], migratingIn: ["a", "b"] });
    expect(parseFleetStateResponse({ status: "ready", customers: ["a"] })).toEqual({
      status: "ready",
      users: ["a"],
    });
    expect(
      parseFleetStateResponse({ status: "ready", customers: ["a"], migratingIn: "a" }),
    ).toEqual({ status: "ready", users: ["a"] });
  });

});

describe("intersectMounted", () => {
  it("keeps only locally-present users that are also assigned, sorted", () => {
    expect(intersectMounted(["c", "a", "ghost"], ["a", "c", "notpresent"])).toEqual([
      "a",
      "c",
    ]);
  });

  it("drops a locally-present user that is no longer assigned (the stale-mount case)", () => {
    expect(intersectMounted(["eggman"], [])).toEqual([]);
  });

  it("drops an assigned user the pod has not actually mounted yet", () => {
    expect(intersectMounted([], ["pending"])).toEqual([]);
  });
});

function makeDeps(
  over: Partial<GatewayHeartbeatPollerDeps> = {},
): GatewayHeartbeatPollerDeps {
  return {
    listGatewayIds: vi.fn(async () => ["walter"]),
    fetchFleetState: vi.fn(async () => ({
      status: "ready",
      users: ["ceckert", "ghost"],
    })),
    readAssignedSlugs: vi.fn(async () => ["ceckert"]),
    writeHeartbeat: vi.fn(async () => {}),
    listActiveMigrations: vi.fn(async () => []),
    log: vi.fn(),
    ...over,
  };
}

describe("pollGatewayHeartbeatsOnce", () => {
  it("writes assigned∩present as mountedCustomers, carrying the health status", async () => {
    const deps = makeDeps();
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      openclawProcess: null,
    });
  });

  it("persists the configured user report a user publishes", async () => {
    const deps = makeDeps({
      fetchFleetState: vi.fn(async () => ({ status: "ready", users: [], configuredBuilder: { state: "claimed" as const, generation: 2 } })),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", {
      status: "ready",
      mountedCustomers: [],
      openclawProcess: null,
      configuredBuilder: { state: "claimed", generation: 2 },
    });
  });

  it("persists why OpenClaw is not serving", async () => {
    const deps = makeDeps({
      fetchFleetState: vi.fn(async () => ({ status: "booting", users: [], openclawProcess: { state: "held" as const, migrationId: null } })),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", {
      status: "booting",
      mountedCustomers: [],
      openclawProcess: { state: "held", migrationId: null },
    });
  });

  it("clears the OpenClaw process report once the gateway stops sending one, as after a rollback to an image that never did", async () => {
    const deps = makeDeps({ fetchFleetState: vi.fn(async () => ({ status: "booting", users: [] })) });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", expect.objectContaining({ openclawProcess: null }));
  });

  it("persists startedAt from /health across a roll", async () => {
    const deps = makeDeps({
      fetchFleetState: vi.fn(async () => ({
        status: "ready",
        users: ["ceckert"],
        startedAt: 1700000,
      })),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      openclawProcess: null,
      startedAt: 1700000,
    });
  });

  it("persists the build version from /health so a revision can become ready", async () => {
    const deps = makeDeps({
      fetchFleetState: vi.fn(async () => ({
        status: "ready",
        users: ["ceckert"],
        version: "93073bd",
      })),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      openclawProcess: null,
      version: "93073bd",
    });
  });

  it("persists the OpenClaw runtime version from /health", async () => {
    const deps = makeDeps({
      fetchFleetState: vi.fn(async () => ({
        status: "ready",
        users: ["ceckert"],
        openclawVersion: "2026.7.1",
      })),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("walter", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      openclawProcess: null,
      openclawVersion: "2026.7.1",
    });
  });

  it("skips a gateway it cannot reach (does NOT clobber the doc to empty)", async () => {
    const onUnreachable = vi.fn(async () => {});
    const deps = makeDeps({
      fetchFleetState: vi.fn(async () => null),
      onUnreachable,
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).not.toHaveBeenCalled();
    expect(onUnreachable).toHaveBeenCalledWith("walter");
  });

  it("isolates per-gateway failures so one bad gateway does not block the rest", async () => {
    const deps = makeDeps({
      listGatewayIds: vi.fn(async () => ["bad", "good"]),
      fetchFleetState: vi.fn(async (id: string) => {
        if (id === "bad") throw new Error("connection refused");
        return { status: "ready", users: ["x"] };
      }),
      readAssignedSlugs: vi.fn(async () => ["x"]),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith(
      "good",
      expect.objectContaining({ mountedCustomers: ["x"] }),
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });

  it("logs and returns without writing when listing gateways fails", async () => {
    const deps = makeDeps({
      listGatewayIds: vi.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    });
    await pollGatewayHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("gateways"));
  });
});

describe("departedFromAssigned", () => {
  it("returns locally-present users that are no longer assigned, sorted", () => {
    expect(departedFromAssigned(["ghost", "ceckert"], ["ceckert"])).toEqual(["ghost"]);
  });

  it("is empty when everything present is still assigned", () => {
    expect(departedFromAssigned(["ceckert"], ["ceckert", "other"])).toEqual([]);
  });
});

describe("pollGatewayHeartbeatsOnce — controller-driven local eviction", () => {
  function evictDeps(over: Partial<GatewayHeartbeatPollerDeps> = {}) {
    // makeDeps reports ghost present but not assigned → ghost is the departed one.
    return makeDeps({ evictSlug: vi.fn(async () => {}), evictAfterStreak: 2, ...over });
  }

  it("evicts a departed local user only after the streak threshold", async () => {
    const deps = evictDeps();
    const streaks: EvictionStreaks = new Map();
    await pollGatewayHeartbeatsOnce(deps, streaks); // ghost departed, streak 1
    expect(deps.evictSlug).not.toHaveBeenCalled();
    await pollGatewayHeartbeatsOnce(deps, streaks); // streak 2 → evict
    expect(deps.evictSlug).toHaveBeenCalledTimes(1);
    expect(deps.evictSlug).toHaveBeenCalledWith("walter", "ghost");
  });

  it("never evicts a user that is still assigned, no matter how many ticks", async () => {
    const deps = evictDeps({ readAssignedSlugs: vi.fn(async () => ["ceckert", "ghost"]) });
    const streaks: EvictionStreaks = new Map();
    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).not.toHaveBeenCalled();
  });

  it("resets the streak when a departed user is re-assigned before the threshold", async () => {
    let assigned = ["ceckert"];
    const deps = evictDeps({ readAssignedSlugs: vi.fn(async () => assigned) });
    const streaks: EvictionStreaks = new Map();
    await pollGatewayHeartbeatsOnce(deps, streaks); // ghost departed, streak 1
    assigned = ["ceckert", "ghost"]; // re-assigned
    await pollGatewayHeartbeatsOnce(deps, streaks); // ghost assigned → streak reset
    assigned = ["ceckert"]; // departs again
    await pollGatewayHeartbeatsOnce(deps, streaks); // streak back to 1, not 2 → no evict
    expect(deps.evictSlug).not.toHaveBeenCalled();
  });

  it("never evicts a slug /health flags migrating-in, even when departed past the threshold", async () => {
    // ghost is present + unassigned (departed) but mid-migration-import: default-agent-wired on the
    // target before cutover moves its assignment. The fleet controller must not drain the fresh import.
    const deps = evictDeps({
      evictAfterStreak: 1,
      fetchFleetState: vi.fn(async () => ({
        status: "ready",
        users: ["ceckert", "ghost"],
        migratingIn: ["ghost"],
      })),
    });
    const streaks: EvictionStreaks = new Map();
    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).not.toHaveBeenCalled();
    // ...and it's still correctly absent from mountedCustomers (unassigned pre-cutover).
    expect(deps.writeHeartbeat).toHaveBeenLastCalledWith(
      "walter",
      expect.objectContaining({ mountedCustomers: ["ceckert"] }),
    );
  });

  it("leaves a departed user to the migration still moving it off this gateway", async () => {
    const listActiveMigrations = vi.fn<GatewayHeartbeatPollerDeps["listActiveMigrations"]>(async () => [
      { input: { fromGatewayId: "walter", toGatewayId: "shared-1" } },
    ]);
    const deps = evictDeps({ evictAfterStreak: 1, listActiveMigrations });
    const streaks: EvictionStreaks = new Map();

    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).not.toHaveBeenCalled();

    listActiveMigrations.mockResolvedValue([]);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).toHaveBeenCalledWith("walter", "ghost");
  });

  it.each([
    ["leaves another gateway", { fromGatewayId: "other", toGatewayId: "shared-1" }],
    ["arrives on this gateway", { fromGatewayId: "other", toGatewayId: "walter" }],
  ])("still evicts when the only active migration %s", async (_name, input) => {
    const deps = evictDeps({ evictAfterStreak: 1, listActiveMigrations: vi.fn(async () => [{ input }]) });
    await pollGatewayHeartbeatsOnce(deps, new Map());
    expect(deps.evictSlug).toHaveBeenCalledWith("walter", "ghost");
  });

  it("does not evict when active migrations cannot be read", async () => {
    const deps = evictDeps({
      evictAfterStreak: 1,
      listActiveMigrations: vi.fn(async () => { throw new Error("journal unavailable"); }),
    });
    await pollGatewayHeartbeatsOnce(deps, new Map());
    expect(deps.evictSlug).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("journal unavailable"));
    expect(deps.writeHeartbeat).toHaveBeenCalled();
  });

  it("does nothing (but still reports) when no evictSlug is configured", async () => {
    const deps = makeDeps({ evictAfterStreak: 1 }); // no evictSlug
    const streaks: EvictionStreaks = new Map();
    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);
    expect(deps.writeHeartbeat).toHaveBeenCalled();
  });

  it("never issues fleet controller eviction when the gateway owns eviction in-pod", async () => {
    const deps = evictDeps({
      evictAfterStreak: 1,
      ownsEviction: vi.fn(async () => false),
    });
    const streaks: EvictionStreaks = new Map();

    await pollGatewayHeartbeatsOnce(deps, streaks);
    await pollGatewayHeartbeatsOnce(deps, streaks);

    expect(deps.evictSlug).not.toHaveBeenCalled();
    expect(deps.writeHeartbeat).toHaveBeenCalledTimes(2);
    expect(streaks.has("walter")).toBe(false);
  });

  it("keeps reporting the remaining gateways while an eviction is still running", async () => {
    const deps = evictDeps({
      evictAfterStreak: 1,
      listGatewayIds: vi.fn(async () => ["walter", "flexo"]),
      evictSlug: vi.fn(() => new Promise<void>(() => {})),
    });
    await pollGatewayHeartbeatsOnce(deps, new Map());
    expect(deps.evictSlug).toHaveBeenCalledWith("walter", "ghost");
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("flexo", expect.anything());
  });

  it("logs and continues the poll when an eviction call fails", async () => {
    const deps = evictDeps({
      evictAfterStreak: 1,
      evictSlug: vi.fn(async () => {
        throw new Error("unmount 500");
      }),
    });
    const streaks: EvictionStreaks = new Map();
    await pollGatewayHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).toHaveBeenCalledWith("walter", "ghost");
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("evict")));
    expect(deps.writeHeartbeat).toHaveBeenCalled();
  });

  it("does not double-issue eviction while a prior /unmount is still in flight", async () => {
    let markStarted!: () => void;
    let releaseEviction!: () => void;
    const evictionStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const evictionRelease = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    const deps = evictDeps({
      evictAfterStreak: 1,
      evictSlug: vi.fn(async () => {
        markStarted();
        await evictionRelease;
      }),
    });
    const streaks: EvictionStreaks = new Map();
    const inFlight: EvictionInFlight = new Set();

    const firstPoll = pollGatewayHeartbeatsOnce(deps, streaks, inFlight);
    await evictionStarted;
    await pollGatewayHeartbeatsOnce(deps, streaks, inFlight);

    expect(deps.evictSlug).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("already in flight"));

    releaseEviction();
    await firstPoll;
  });
});
