import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { BackendFailureError, type PlatformStateStore, type WatchAggregate, type WatchCursor, type WatchListener, type WatchRequest } from "@octogee/core/platform-state";
import { streamAssignmentChanges } from "./fleet-assignment-watch.js";

const CURSOR = "cursor" as WatchCursor;

function setup() {
  const subscriptions: Array<{ request: WatchRequest<WatchAggregate>; listener: WatchListener<WatchAggregate>; close: ReturnType<typeof vi.fn> }> = [];
  const store: Pick<PlatformStateStore, "watch"> = {
    watch: (request, listener) => {
      const close = vi.fn(async () => undefined);
      subscriptions.push({ request: request as WatchRequest<WatchAggregate>, listener: listener as WatchListener<WatchAggregate>, close });
      return { closed: new Promise(() => undefined), close };
    },
  };
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), {
    status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), writableNeedDrain: false,
  });
  const log = vi.fn();
  streamAssignmentChanges(req as Request, res as unknown as Response, store, "shared-a", log);
  const snapshot = (index: number) => subscriptions[index].listener.onEvent({ kind: "snapshot", records: [], cursor: CURSOR });
  return { req, res, subscriptions, snapshot, log };
}

describe("assignment change stream", () => {
  it("watches only the bound gateway's assignments, users and root and emits invalidations without user data", () => {
    const h = setup();
    try {
      expect(h.subscriptions.map(({ request }) => request)).toEqual([
        { aggregate: "assignments", filter: { gatewayId: "shared-a" } },
        { aggregate: "builders", filter: { gatewayId: "shared-a" } },
        { aggregate: "gateways", filter: { gatewayId: "shared-a" } },
      ]);
      h.subscriptions.forEach((_subscription, index) => h.snapshot(index));
      expect(h.res.write.mock.calls).toEqual([["data: changed\n\n"], ["data: changed\n\n"], ["data: changed\n\n"]]);
    } finally { h.res.emit("close"); }
    h.subscriptions.forEach((subscription) => expect(subscription.close).toHaveBeenCalledOnce());
  });

  it("wakes the pod when its own gateway root changes or its watch resyncs", () => {
    const h = setup();
    try {
      h.subscriptions[2].listener.onEvent({ kind: "changes", changes: [{ type: "modified", key: "shared-a", record: null }], cursor: CURSOR });
      h.subscriptions[1].listener.onEvent({ kind: "resync", reason: "backend-restart" });
      expect(h.res.write.mock.calls).toEqual([["data: changed\n\n"], ["data: changed\n\n"]]);
    } finally { h.res.emit("close"); }
  });

  it("closes every watch and logs a failed store watch", () => {
    const h = setup();
    h.subscriptions[0].listener.onError(new BackendFailureError("firestore", "watch assignments", { cause: new Error("listener unavailable") }));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("watch assignments"));
    expect(h.res.end).toHaveBeenCalledOnce();
    h.subscriptions.forEach((subscription) => expect(subscription.close).toHaveBeenCalledOnce());
    h.res.emit("close");
    h.subscriptions.forEach((subscription) => expect(subscription.close).toHaveBeenCalledOnce());
  });

  it("logs a watch that fails while closing", async () => {
    const h = setup();
    h.subscriptions[1].close.mockRejectedValueOnce(new Error("delivery failed"));
    h.res.emit("close");
    await vi.waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.stringContaining("delivery failed")));
  });

  it("delivers a coalesced notification when a slow connection drains", () => {
    const h = setup();
    try {
      h.res.writableNeedDrain = true;
      h.subscriptions.forEach((_subscription, index) => h.snapshot(index));
      expect(h.res.write).not.toHaveBeenCalled();
      h.res.writableNeedDrain = false;
      h.res.emit("drain");
      h.res.emit("drain");
      expect(h.res.write.mock.calls).toEqual([["data: changed\n\n"]]);
    } finally { h.res.emit("close"); }
  });
});
