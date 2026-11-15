import { describe, expect, it } from "vitest";

import { createProductivityRateLimiter } from "./rate-limit.js";

describe("createProductivityRateLimiter", () => {
  it("allows up to the tier limit and rejects the next attempt with a retryAfterSeconds", () => {
    const limiter = createProductivityRateLimiter();

    for (let i = 0; i < 60; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "read")).toEqual({ allowed: true });
    }
    const result = limiter.consume("gw-1", "octogee-eggman-coach", "read");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("enforces the write tier at 20 per window", () => {
    const limiter = createProductivityRateLimiter();

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write").allowed).toBe(false);
  });

  it("keeps tiers independent for the same gateway/agent pair", () => {
    const limiter = createProductivityRateLimiter();

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write").allowed).toBe(false);
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "read")).toEqual({ allowed: true });
  });

  it("keeps different gateway/agent pairs independent", () => {
    const limiter = createProductivityRateLimiter();

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write").allowed).toBe(false);
    expect(limiter.consume("gw-1", "octogee-other-coach", "write")).toEqual({ allowed: true });
    expect(limiter.consume("gw-2", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
  });

  it("resets the window once it elapses, using the injectable clock", () => {
    let now = 0;
    const limiter = createProductivityRateLimiter({ now: () => now, limits: { write: 2 } });

    for (let i = 0; i < 2; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write").allowed).toBe(false);

    now += 15 * 60_000;
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
  });

  it("reports retryAfterSeconds as the whole seconds remaining until the window resets", () => {
    let now = 0;
    const limiter = createProductivityRateLimiter({ now: () => now, limits: { write: 2 } });

    for (let i = 0; i < 2; i += 1) {
      limiter.consume("gw-1", "octogee-eggman-coach", "write");
    }

    now = 15 * 60_000 - 5_000;
    const result = limiter.consume("gw-1", "octogee-eggman-coach", "write");
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 5 });
  });

  it("rounds a partial second up when reporting retryAfterSeconds", () => {
    let now = 0;
    const limiter = createProductivityRateLimiter({ now: () => now, limits: { write: 2 } });

    for (let i = 0; i < 2; i += 1) {
      limiter.consume("gw-1", "octogee-eggman-coach", "write");
    }

    now = 15 * 60_000 - 4_500;
    const result = limiter.consume("gw-1", "octogee-eggman-coach", "write");
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 5 });
  });

  it("overrides a tier's limit when `limits` is provided", () => {
    const limiter = createProductivityRateLimiter({ limits: { write: 2 } });

    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    const result = limiter.consume("gw-1", "octogee-eggman-coach", "write");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("leaves tiers absent from a partial `limits` override at their production defaults", () => {
    const limiter = createProductivityRateLimiter({ limits: { write: 2 } });

    for (let i = 0; i < 60; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "read")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "read").allowed).toBe(false);

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "prepare")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "prepare").allowed).toBe(false);
  });

  it("uses production defaults for every tier when `limits` is absent entirely", () => {
    const limiter = createProductivityRateLimiter();

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume("gw-1", "octogee-eggman-coach", "write")).toEqual({ allowed: true });
    }
    expect(limiter.consume("gw-1", "octogee-eggman-coach", "write").allowed).toBe(false);
  });
  it("bounds retained windows and evicts the one that expires first", () => {
    let now = 0;
    const limiter = createProductivityRateLimiter({
      now: () => now,
      limits: { write: 1 },
      maxWindows: 2,
    });

    expect(limiter.consume("gw-1", "agent-1", "write")).toEqual({ allowed: true });
    now = 1;
    expect(limiter.consume("gw-1", "agent-2", "write")).toEqual({ allowed: true });
    now = 2;
    expect(limiter.consume("gw-1", "agent-3", "write")).toEqual({ allowed: true });

    expect(limiter.consume("gw-1", "agent-1", "write")).toEqual({ allowed: true });
    expect(limiter.consume("gw-1", "agent-2", "write").allowed).toBe(true);
  });
});
