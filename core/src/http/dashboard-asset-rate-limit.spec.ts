import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createDashboardAssetRateLimit } from "./dashboard-asset-rate-limit.js";
import { isDashboardAssetRequest } from "@octogee/shared/types/dashboard-asset-request";

function assetRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    path: "/api/g/ceckert-m-1088d802/openclaw/assets/app-123.js",
    ip: "192.0.2.1",
    ...overrides,
  } as Request;
}

function call(limiter: ReturnType<typeof createDashboardAssetRateLimit>, overrides: Partial<Request> = {}) {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const next = vi.fn();
  limiter(assetRequest(overrides), res as unknown as Response, next);
  return { res, next };
}

describe("dashboard asset request classification", () => {
  it.each(["GET", "HEAD"])("allows %s of bundled assets", (method) => {
    expect(isDashboardAssetRequest(assetRequest({ method }))).toBe(true);
    expect(isDashboardAssetRequest(assetRequest({ method, path: "/api/g/shared-0/openclaw/assets/nested/app.css" }))).toBe(true);
  });

  it.each([
    "/api/g/walter/openclaw",
    "/api/g/walter/openclaw/launch/ticket",
    "/api/g/walter/openclaw/control-ui-config.json",
    "/api/g/walter/api/v4/websocket",
    "/api/g/walter/openclaw/assets/../config.json",
    "/api/g/walter/openclaw/assets/%2e%2e/config.json",
    "/api/g/walter/openclaw/assets/app.js/extra",
    "/api/g/walter/openclaw/assets/app.html",
    "/api/g/walter/openclaw/assets/app.js/",
    "/api/g/walter/openclaw/assets/app.js;other",
  ])("keeps %s on the ordinary budget", (path) => {
    expect(isDashboardAssetRequest(assetRequest({ path }))).toBe(false);
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("does not give %s an asset allowance", (method) => {
    expect(isDashboardAssetRequest(assetRequest({ method }))).toBe(false);
  });
});

describe("dashboard asset token bucket", () => {
  it("admits three 60-file cold loads immediately, then rejects excess without forwarding it", () => {
    const limiter = createDashboardAssetRateLimit({ now: () => 0 });
    for (let index = 0; index < 180; index += 1) expect(call(limiter).next).toHaveBeenCalledOnce();
    const blocked = call(limiter);
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(429);
    expect(blocked.res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(blocked.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(blocked.res.json).toHaveBeenCalledWith({ error: "dashboard-assets-rate-limited", retryable: true, retryAfterSeconds: 1 });
  });

  it("refills continuously at two requests per second without accumulating debt for rejected retries", () => {
    let now = 0;
    const limiter = createDashboardAssetRateLimit({ now: () => now });
    for (let index = 0; index < 180; index += 1) call(limiter);
    now = 499;
    for (let index = 0; index < 20; index += 1) expect(call(limiter).res.status).toHaveBeenCalledWith(429);
    now = 500;
    expect(call(limiter).next).toHaveBeenCalledOnce();
    expect(call(limiter).res.status).toHaveBeenCalledWith(429);
    now = 1_000;
    expect(call(limiter).next).toHaveBeenCalledOnce();
  });

  it("caps idle credit at the initial burst", () => {
    let now = 0;
    const limiter = createDashboardAssetRateLimit({ now: () => now });
    call(limiter);
    now = 3_600_000;
    for (let index = 0; index < 180; index += 1) expect(call(limiter).next).toHaveBeenCalledOnce();
    expect(call(limiter).res.status).toHaveBeenCalledWith(429);
  });

  it("shares the budget across assets, sessions, and gateway paths from one IP", () => {
    const limiter = createDashboardAssetRateLimit({ now: () => 0 });
    for (let index = 0; index < 180; index += 1) call(limiter);
    expect(call(limiter, {
      path: "/api/g/another/openclaw/assets/different.css",
      headers: { cookie: "new-session", "x-forwarded-for": "192.0.2.50" },
    }).res.status).toHaveBeenCalledWith(429);
    expect(call(limiter, { ip: "192.0.2.2" }).next).toHaveBeenCalledOnce();
  });

  it("groups IPv6 addresses by /56 so address rotation cannot reset credit", () => {
    const limiter = createDashboardAssetRateLimit({ now: () => 0 });
    for (let index = 0; index < 180; index += 1) call(limiter, { ip: "2001:db8:1234:5600::1" });
    expect(call(limiter, { ip: "2001:db8:1234:56ff::2" }).res.status).toHaveBeenCalledWith(429);
    expect(call(limiter, { ip: "2001:db8:1234:5700::1" }).next).toHaveBeenCalledOnce();
  });

  it("bounds tracked IPs without evicting active limits and reclaims fully refilled buckets", () => {
    let now = 0;
    const limiter = createDashboardAssetRateLimit({ now: () => now, maxKeys: 1 });
    for (let index = 0; index < 180; index += 1) call(limiter);
    expect(call(limiter, { ip: "192.0.2.2" }).res.status).toHaveBeenCalledWith(503);
    expect(call(limiter).res.status).toHaveBeenCalledWith(429);
    now = 90_000;
    expect(call(limiter, { ip: "192.0.2.2" }).next).toHaveBeenCalledOnce();
  });

  it("passes a missing client IP to the error handler", () => {
    const result = call(createDashboardAssetRateLimit(), { ip: undefined });
    expect(result.next).toHaveBeenCalledWith(expect.any(Error));
  });
});
