import { describe, expect, it, vi } from "vitest";
import type { FleetRegistryRecord, PlatformStateStore, Stored, WatchCursor, WatchListener } from "@octogee/core/platform-state";
import { vmCheckpointCursor, waitForVmCheckpointChange } from "./vm-checkpoint-watch.js";

const CURSOR = "test-watch-cursor" as WatchCursor;

function runtime(fields?: FleetRegistryRecord["vmHome"], instanceId = "42"): Stored<FleetRegistryRecord> {
  return {
    gatewayId: "builder", runtime: "gce-vm", vm: { instanceId }, vmHome: fields,
  } as Stored<FleetRegistryRecord>;
}

function harness(initial = runtime()) {
  let current = initial;
  let listener!: WatchListener<"fleetRegistry">;
  const close = vi.fn(async () => {});
  const get = vi.fn(async () => current);
  const watch = vi.fn((_request: unknown, handler: WatchListener<"fleetRegistry">) => {
    listener = handler;
    return { close, closed: new Promise<void>(() => {}) };
  });
  const abort = new AbortController();
  return {
    close, get, watch, abort,
    wait: (cursor = vmCheckpointCursor(initial, "42")!) => waitForVmCheckpointChange({
      watch: watch as PlatformStateStore["watch"], fleetRegistry: { get },
    }, { gatewayId: "builder", instanceId: "42", cursor, signal: abort.signal }),
    snapshot: (value = current) => { current = value; return listener.onEvent({ kind: "snapshot", records: [value], cursor: CURSOR }); },
    resync: () => listener.onEvent({ kind: "resync", reason: "notification-gap" }),
    change: (value: Stored<FleetRegistryRecord>) => {
      current = value;
      return listener.onEvent({ kind: "changes", changes: [{ type: "modified", key: "builder", record: value }], cursor: CURSOR });
    },
  };
}

describe("checkpoint change wait", () => {
  it("subscribes before detecting a request already committed by the initial snapshot", async () => {
    const h = harness();
    const pending = h.wait();
    expect(h.watch).toHaveBeenCalledWith({ aggregate: "fleetRegistry", filter: { gatewayId: "builder" } }, expect.anything());
    expect(h.get).not.toHaveBeenCalled();

    await h.snapshot(runtime({ checkpointRequestedAt: 7 }));
    await expect(pending).resolves.toBe("changed");
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("ignores unrelated records and detects writer release after a resync", async () => {
    const active = runtime({ checkpointRequestedAt: 7 });
    const h = harness(active);
    const pending = h.wait();
    await h.snapshot();
    await h.change({ ...active, openclawHealthyBuild: "other-build" });
    expect(h.get).not.toHaveBeenCalled();
    await h.resync();
    await h.snapshot(runtime());
    await expect(pending).resolves.toBe("changed");
  });

  it("returns without a wake when the bounded wait expires unchanged", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const pending = h.wait();
      await h.snapshot();
      await vi.runOnlyPendingTimersAsync();
      await expect(pending).resolves.toBe("unchanged");
      expect(h.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on disconnect and revisits the instance fence before returning a change", async () => {
    const disconnected = harness();
    const waiting = disconnected.wait();
    await disconnected.snapshot();
    disconnected.abort.abort();
    await expect(waiting).resolves.toBe("unchanged");
    expect(disconnected.close).toHaveBeenCalledOnce();
    expect(disconnected.get).not.toHaveBeenCalled();

    const replaced = harness();
    const pending = replaced.wait();
    await replaced.snapshot();
    await replaced.change(runtime({ checkpointRequestedAt: 7 }, "43"));
    await expect(pending).resolves.toBe("unbound");
    expect(replaced.close).toHaveBeenCalledOnce();
  });
});
