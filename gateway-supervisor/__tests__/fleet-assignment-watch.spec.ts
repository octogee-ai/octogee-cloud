import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: fetcher }));
import { watchFleetAssignments } from "../lib/fleet-assignment-watch.js";

describe("fleet assignment push client", () => {
  beforeEach(() => { fetcher.mockReset(); });

  it("reconnects with fresh credentials after a failed stream", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
      init.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true });
      return new Response(body);
    });
    const headers = vi.fn().mockResolvedValueOnce({ authorization: "old" }).mockResolvedValue({ authorization: "new" });
    const wake = vi.fn();
    const log = vi.fn();
    const stop = watchFleetAssignments({ url: "http://broker/internal/fleet/assignment-watch", gatewayId: "shared-a", revisionId: "shared-a", headers, wake, log });
    try {
      await vi.waitFor(() => expect(stream).toBeDefined(), { timeout: 3000 });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("503"));
      expect(fetcher.mock.calls[1][1].headers.authorization).toBe("new");
      stream.enqueue(new TextEncoder().encode("data: changed\n\n"));
      await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    } finally { stop(); }
  });

  it("assembles fragmented notifications, ignores heartbeats, and cancels on shutdown", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
      init.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true });
      return new Response(body);
    });
    const wake = vi.fn();
    const log = vi.fn();
    const stop = watchFleetAssignments({ url: "http://broker/internal/fleet/assignment-watch", gatewayId: "shared-a", revisionId: "shared-a", headers: async () => ({ "x-test": "tenant" }), wake, log });
    try {
      await vi.waitFor(() => expect(stream).toBeDefined());
      stream.enqueue(new TextEncoder().encode(": keepalive\n\ndata: cha"));
      await Promise.resolve();
      expect(wake).not.toHaveBeenCalled();
      stream.enqueue(new TextEncoder().encode("nged\n\n"));
      await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ gatewayId: "shared-a", revisionId: "shared-a" });
    } finally { stop(); }
    await Promise.resolve();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
