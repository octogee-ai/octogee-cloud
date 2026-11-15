import { describe, it, expect, vi } from "vitest";
import {
  sweepStuckReleasesOnce,
  type SweepStuckReleasesDeps,
} from "../helm-recovery-sweeper.js";

const STALE = 15 * 60_000;

function makeDeps(over: Partial<SweepStuckReleasesDeps> = {}): SweepStuckReleasesDeps {
  return {
    listPending: vi.fn(async () => [] as string[]),
    isRecoverableRevision: vi.fn(async () => true),
    recover: vi.fn(async (gw: string) => `rolled back ${gw} to revision 1`),
    now: () => 0,
    staleMs: STALE,
    log: vi.fn(),
    ...over,
  };
}

describe("sweepStuckReleasesOnce", () => {
  it("on first sighting, starts the clock but does NOT recover", async () => {
    const deps = makeDeps({ listPending: vi.fn(async () => ["default-blue"]), now: () => 1000 });
    const state = new Map<string, number>();
    const res = await sweepStuckReleasesOnce(deps, state);
    expect(res).toEqual({ pending: 1, recovered: 0, skipped: 0 });
    expect(deps.recover).not.toHaveBeenCalled();
    expect(state.get("default-blue")).toBe(1000);
  });

  it("recovers a release pending continuously past staleMs", async () => {
    const deps = makeDeps({
      listPending: vi.fn(async () => ["default-blue"]),
      now: () => 1000 + STALE,
    });
    const state = new Map<string, number>([["default-blue", 1000]]);
    const res = await sweepStuckReleasesOnce(deps, state);
    expect(res).toEqual({ pending: 1, recovered: 1, skipped: 0 });
    expect(deps.recover).toHaveBeenCalledWith("default-blue");
    expect(state.has("default-blue")).toBe(false); // cleared after a successful recover
  });

  it("does NOT recover a release that is pending but not yet stale", async () => {
    const deps = makeDeps({
      listPending: vi.fn(async () => ["default-blue"]),
      now: () => 1000 + STALE - 1,
    });
    const state = new Map<string, number>([["default-blue", 1000]]);
    const res = await sweepStuckReleasesOnce(deps, state);
    expect(res.recovered).toBe(0);
    expect(deps.recover).not.toHaveBeenCalled();
  });

  it("resets the clock for a release that settled on its own (no longer pending)", async () => {
    const deps = makeDeps({ listPending: vi.fn(async () => []), now: () => 1000 + STALE });
    const state = new Map<string, number>([["default-blue", 1000]]);
    await sweepStuckReleasesOnce(deps, state);
    expect(state.has("default-blue")).toBe(false);
    expect(deps.recover).not.toHaveBeenCalled();
  });

  it("backs off (keeps tracking, resets clock) when recovery throws — retries after staleMs", async () => {
    const deps = makeDeps({
      listPending: vi.fn(async () => ["default-blue"]),
      recover: vi.fn(async () => {
        throw new Error("rollback failed");
      }),
      now: () => 1000 + STALE,
    });
    const state = new Map<string, number>([["default-blue", 1000]]);
    const res = await sweepStuckReleasesOnce(deps, state);
    expect(res.recovered).toBe(0);
    expect(state.get("default-blue")).toBe(1000 + STALE); // clock reset to now = back off
  });

  it("recovers only the stale release, starting the clock on a freshly-seen one", async () => {
    const deps = makeDeps({
      listPending: vi.fn(async () => ["old", "new"]),
      now: () => STALE + 5000,
    });
    const state = new Map<string, number>([["old", 1000]]);
    const res = await sweepStuckReleasesOnce(deps, state);
    expect(res.recovered).toBe(1);
    expect(deps.recover).toHaveBeenCalledWith("old");
    expect(deps.recover).not.toHaveBeenCalledWith("new");
    expect(state.get("new")).toBe(STALE + 5000);
  });

  it("never recovers a stale bare release, clearing any old retry clock", async () => {
    const deps = makeDeps({
      listPending: vi.fn(async () => ["default", "default-r42"]),
      isRecoverableRevision: vi.fn(async (revisionId: string) => revisionId === "default-r42"),
      now: () => 1000 + STALE,
    });
    const state = new Map<string, number>([
      ["default", 1000],
      ["default-r42", 1000],
    ]);

    const res = await sweepStuckReleasesOnce(deps, state);

    expect(res).toEqual({ pending: 1, recovered: 1, skipped: 1 });
    expect(deps.recover).toHaveBeenCalledWith("default-r42");
    expect(deps.recover).not.toHaveBeenCalledWith("default");
    expect(state.has("default")).toBe(false);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("skipping unmanaged pending release default"));
  });

  it("returns zero and logs when listing pending releases fails", async () => {
    const deps = makeDeps({
      listPending: vi.fn(async () => {
        throw new Error("helm list failed");
      }),
    });
    const res = await sweepStuckReleasesOnce(deps, new Map());
    expect(res).toEqual({ pending: 0, recovered: 0, skipped: 0 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("listPending failed"));
  });
});
