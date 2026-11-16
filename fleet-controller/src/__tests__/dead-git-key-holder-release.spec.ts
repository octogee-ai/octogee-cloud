import { describe, expect, it, vi } from "vitest";
import type { GitKeyHolderSummary } from "@octogee/shared/types/provisioning-service";
import { readLiveKeyHoldersReleasingDead } from "../gitea-gateway-key-gc.js";

function summary(holder: string): GitKeyHolderSummary {
  return { holder, gatewayId: holder.slice(0, holder.indexOf("/")), rows: 1, newestUpdatedAt: "2026-11-15T18:00:00.000Z" };
}

function setup(options: { mode?: "enforce" | "dry-run"; listed?: string[] } = {}) {
  let now = Date.parse("2026-11-15T18:00:00Z");
  let live = new Set<string>(["shared-0/pod-live"]);
  let liveRead: "complete" | "failed" = "complete";
  const listed = options.listed ?? ["shared-0/pod-live", "shared-0/pod-gone"];
  const keys = {
    listGitKeyHolders: vi.fn(async () => listed.map(summary)),
    releaseGitKeyHolder: vi.fn(async () => ({ remaining: 1 })),
  };
  const logs: string[] = [];
  const read = readLiveKeyHoldersReleasingDead(async () => {
    if (liveRead === "failed") throw new Error("gateway pod liveness is unknown for shared-0: pods not found");
    return { owners: new Set(live) };
  }, { keys, mode: options.mode ?? "enforce", graceMs: 10 * 60_000, now: () => now, log: (message) => logs.push(message) });
  return {
    keys,
    logs,
    read,
    pass: async () => read().catch(() => undefined),
    advance: (ms: number) => { now += ms; },
    setLive: (owners: string[]) => { live = new Set(owners); },
    failLiveRead: () => { liveRead = "failed"; },
    restoreLiveRead: () => { liveRead = "complete"; },
  };
}

describe("releasing git key holders that are gone", () => {
  it("keeps a holder missing from the live set once", async () => {
    const harness = setup();

    await harness.pass();

    expect(harness.keys.releaseGitKeyHolder).not.toHaveBeenCalled();
    expect(harness.logs.some((line) => line.includes("shared-0/pod-gone") && line.includes("absent"))).toBe(true);
  });

  it("releases a holder missing from two consecutive complete live sets, and never a live one", async () => {
    const harness = setup();

    await harness.pass();
    harness.advance(60_000);
    await harness.pass();

    expect(harness.keys.releaseGitKeyHolder.mock.calls).toEqual([["shared-0/pod-gone"]]);
  });

  it("keeps a holder that reappears in the live set and counts its absence afresh", async () => {
    const harness = setup();

    await harness.pass();
    harness.setLive(["shared-0/pod-live", "shared-0/pod-gone"]);
    await harness.pass();
    harness.setLive(["shared-0/pod-live"]);
    await harness.pass();

    expect(harness.keys.releaseGitKeyHolder).not.toHaveBeenCalled();
  });

  it("releases nothing and lists no holders when the live set cannot be read completely, and does not count that pass", async () => {
    const harness = setup();

    await harness.pass();
    harness.failLiveRead();
    await expect(harness.read()).rejects.toThrow(/liveness is unknown/);
    await harness.pass();

    expect(harness.keys.listGitKeyHolders).toHaveBeenCalledTimes(1);
    expect(harness.keys.releaseGitKeyHolder).not.toHaveBeenCalled();
    expect(harness.logs.some((line) => line.includes("releases no git key holder") && line.includes("liveness is unknown"))).toBe(true);

    harness.restoreLiveRead();
    await harness.pass();
    expect(harness.keys.releaseGitKeyHolder.mock.calls).toEqual([["shared-0/pod-gone"]]);
  });

  it("releases a holder absent past the grace period even when a pass in between could not read the live set", async () => {
    const harness = setup();

    await harness.pass();
    harness.failLiveRead();
    harness.advance(11 * 60_000);
    await harness.pass();
    harness.restoreLiveRead();
    await harness.pass();

    expect(harness.keys.releaseGitKeyHolder.mock.calls).toEqual([["shared-0/pod-gone"]]);
  });

  it("logs and keeps the sweep's live set when the provisioning service cannot list holders", async () => {
    const harness = setup();
    harness.keys.listGitKeyHolders.mockRejectedValueOnce(new Error("503 unavailable"));

    await expect(harness.read()).resolves.toEqual({ owners: new Set(["shared-0/pod-live"]) });

    expect(harness.logs.some((line) => line.includes("listing git key holders failed") && line.includes("503 unavailable"))).toBe(true);
  });

  it("logs a failed release and tries the holder again on the next pass", async () => {
    const harness = setup();
    harness.keys.releaseGitKeyHolder.mockRejectedValueOnce(new Error("502 bad gateway"));

    await harness.pass();
    await harness.pass();
    await harness.pass();

    expect(harness.keys.releaseGitKeyHolder.mock.calls).toEqual([["shared-0/pod-gone"], ["shared-0/pod-gone"]]);
    expect(harness.logs.some((line) => line.includes("releasing git key holder shared-0/pod-gone failed") && line.includes("502 bad gateway"))).toBe(true);
  });

  it("only reports the holders it would release in dry-run mode", async () => {
    const harness = setup({ mode: "dry-run" });

    await harness.pass();
    await harness.pass();

    expect(harness.keys.releaseGitKeyHolder).not.toHaveBeenCalled();
    expect(harness.logs.some((line) => line.includes("dry-run") && line.includes("shared-0/pod-gone"))).toBe(true);
  });
});
