import { describe, expect, it, vi } from "vitest";

import {
  authorizeOpenClawControlSession,
  createOpenClawControlAuthorizationCache,
  OPENCLAW_CONTROL_BROKER_TIMEOUT_MS,
  openClawControlBrokerFailureKind,
  redeemOpenClawControlTicket,
} from "./broker.js";

const sessionId = "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70";

describe("OpenClaw Dashboard broker client", () => {
  it("redeems and reauthorizes the broker session by opaque session id", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response(JSON.stringify({
            uid: "uid-owner",
            gatewayId: "walter",
            workspaceSlug: "alice",
            revisionId: "walter-r7",



            expiresAt: 10_000,
          }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await expect(redeemOpenClawControlTicket({
      ticket: "ticket",
      sessionId,
      gatewayId: "walter",
      revisionId: "walter-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).resolves.toMatchObject({
      uid: "uid-owner",
      workspaceSlug: "alice",

    });
    await expect(authorizeOpenClawControlSession({
      sessionId,
      gatewayId: "walter",
      revisionId: "walter-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).resolves.toBe(true);
    expect(bodies).toEqual([
      { gatewayId: "walter", revisionId: "walter-r7", sessionId, ticket: "ticket" },
      { gatewayId: "walter", revisionId: "walter-r7", sessionId },
    ]);
  });

  it("does not turn a retryable gateway-readiness response into session revocation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: "gateway-not-ready",
      retryable: true,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await expect(authorizeOpenClawControlSession({
      sessionId,
      gatewayId: "walter",
      revisionId: "walter-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).rejects.toThrow("authorization broker returned 409");
  });

  it("rejects a malformed redemption response before issuing a local session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      uid: "",
      gatewayId: "walter",
      revisionId: "walter-r7",
      expiresAt: "later",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(redeemOpenClawControlTicket({
      ticket: "ticket",
      sessionId,
      gatewayId: "walter",
      revisionId: "walter-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).rejects.toThrow(/invalid JSON/i);
  });

  it("classifies a broker deadline separately from an unavailable broker", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const timedOutFetch = vi.fn(async () => {
      throw new DOMException("request aborted", "AbortError");
    }) as unknown as typeof fetch;

    await expect(authorizeOpenClawControlSession({
      sessionId,
      gatewayId: "walter",
      revisionId: "walter-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl: timedOutFetch,
    })).rejects.toSatisfy((error) => openClawControlBrokerFailureKind(error) === "timeout");
    expect(timeout).toHaveBeenCalledWith(OPENCLAW_CONTROL_BROKER_TIMEOUT_MS);
    timeout.mockRestore();

    const unavailableFetch = vi.fn(async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    await expect(authorizeOpenClawControlSession({
      sessionId,
      gatewayId: "walter",
      revisionId: "walter-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl: unavailableFetch,
    })).rejects.toSatisfy((error) => openClawControlBrokerFailureKind(error) === "unavailable");
  });

  it("single-flights only positive authorizations until their short TTL expires", async () => {
    let now = 1_000;
    let calls = 0;
    let resolveAuthorization!: (allowed: boolean) => void;
    const authorize = vi.fn(() => {
      calls += 1;
      if (calls > 1) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => { resolveAuthorization = resolve; });
    });
    const cache = createOpenClawControlAuthorizationCache({ authorize, now: () => now, ttlMs: 10_000 });
    const input = { sessionId, gatewayId: "walter", revisionId: "walter-r7" };

    const concurrent = Promise.all([
      cache.authorize(input),
      cache.authorize(input),
      cache.authorize(input),
    ]);
    expect(authorize).toHaveBeenCalledTimes(1);
    resolveAuthorization(true);
    await expect(concurrent).resolves.toEqual([true, true, true]);

    await expect(cache.authorize(input)).resolves.toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
    now += 10_000;
    await expect(cache.authorize(input)).resolves.toBe(true);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("does not cache broker denials or failures and forces WS rechecks past a positive cache", async () => {
    const now = 1_000;
    const authorize = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce(true);
    const cache = createOpenClawControlAuthorizationCache({ authorize, now: () => now, ttlMs: 10_000 });
    const input = { sessionId, gatewayId: "walter", revisionId: "walter-r7" };

    await expect(cache.authorize(input)).resolves.toBe(true);
    await expect(cache.authorize(input, { forceRefresh: true })).resolves.toBe(false);
    await expect(cache.authorize(input)).rejects.toThrow("broker unavailable");
    await expect(cache.authorize(input)).resolves.toBe(true);
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(now).toBe(1_000);
  });
});
