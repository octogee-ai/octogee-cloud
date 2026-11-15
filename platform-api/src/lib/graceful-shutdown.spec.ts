import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "./graceful-shutdown.js";

describe("graceful shutdown", () => {
  it("stops accepting connections once and then flushes PostHog", async () => {
    const close = vi.fn((callback: (error?: Error) => void) => callback());
    const flushPostHog = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown({
      server: { close },
      flushPostHog,
      onError: vi.fn(),
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(flushPostHog).toHaveBeenCalledTimes(1);
  });

  it("closes the platform state store after the server has drained", async () => {
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      server: { close: (callback) => { order.push("server"); callback(); } },
      closePlatformState: async () => { order.push("platform-state"); },
      onError: vi.fn(),
    });

    await shutdown();

    expect(order).toEqual(["server", "platform-state"]);
  });

  it("reports a platform state close failure", async () => {
    const onError = vi.fn();
    const failure = new Error("close failed");
    const shutdown = createGracefulShutdown({
      server: { close: (callback) => callback() },
      closePlatformState: async () => { throw failure; },
      onError,
    });

    await shutdown();

    expect(onError).toHaveBeenCalledWith("platform state shutdown failed", failure);
  });

  it("still flushes PostHog when closing the HTTP server fails", async () => {
    const onError = vi.fn();
    const flushPostHog = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown({
      server: { close: (callback) => callback(new Error("close failed")) },
      flushPostHog,
      onError,
    });

    await shutdown();

    expect(flushPostHog).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("octogee-api HTTP shutdown failed", expect.any(Error));
  });
});
