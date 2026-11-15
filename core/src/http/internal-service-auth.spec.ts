import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const { warn, error, info } = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./logging", () => ({ logger: { warn, error, info } }));

import {
  requireInternalServiceAuth,
  requireInternalPlatformAuth,
  requireSocialNotificationAuth,
} from "./auth.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function run(mw: Middleware, req: Partial<Request>): { status?: number; nextCalled: boolean } {
  let status: number | undefined;
  let nextCalled = false;
  const res = {
    status: (c: number) => {
      status = c;
      return res;
    },
    json: () => res,
  } as unknown as Response;
  mw(req as Request, res, () => {
    nextCalled = true;
  });
  return { status, nextCalled };
}

describe("requireInternalServiceAuth — gateway-bound only (legacy key retired)", () => {
  it("passes a gateway-bound caller", () => {
    const r = run(requireInternalServiceAuth, {
      headers: {},
      boundTenant: { kind: "gateway", gatewayId: "walter" },
    } as unknown as Request);
    expect(r.nextCalled).toBe(true);
  });

  it("rejects a platform-bound caller — platform is cron-route-scoped now", () => {
    const r = run(requireInternalServiceAuth, {
      headers: {},
      boundTenant: { kind: "platform", actor: "cron" },
    } as unknown as Request);
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });

  it("does NOT honor a legacy X-Internal-Service-Key", () => {
    process.env.INTERNAL_SERVICE_KEY = "platform-key";
    const r = run(requireInternalServiceAuth, {
      headers: { "x-internal-service-key": "platform-key" },
      path: "/internal/csi",
    } as unknown as Request);
    delete process.env.INTERNAL_SERVICE_KEY;
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });
});

describe("requireInternalPlatformAuth — gateway or platform (cron routes)", () => {
  it("passes a gateway-bound caller", () => {
    const r = run(requireInternalPlatformAuth, {
      headers: {},
      boundTenant: { kind: "gateway", gatewayId: "walter" },
    } as unknown as Request);
    expect(r.nextCalled).toBe(true);
  });

  it("passes a platform-bound cron caller", () => {
    const r = run(requireInternalPlatformAuth, {
      headers: {},
      boundTenant: { kind: "platform", actor: "cron" },
    } as unknown as Request);
    expect(r.nextCalled).toBe(true);
  });

  it("rejects an unbound caller (no legacy key path)", () => {
    process.env.INTERNAL_SERVICE_KEY = "platform-key";
    const r = run(requireInternalPlatformAuth, {
      headers: { "x-internal-service-key": "platform-key" },
      path: "/internal/billing/check-trial-expiry",
    } as unknown as Request);
    delete process.env.INTERNAL_SERVICE_KEY;
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });
});

describe("requireSocialNotificationAuth — dedicated bearer only (legacy key retired)", () => {
  beforeEach(() => {
    process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN = "social-bearer";
  });
  afterEach(() => {
    delete process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN;
  });

  it("accepts the dedicated bearer", () => {
    const r = run(requireSocialNotificationAuth, {
      headers: { authorization: "Bearer social-bearer" },
      path: "/api/notifications/social",
    } as unknown as Request);
    expect(r.nextCalled).toBe(true);
  });

  it("rejects when the bearer is absent — no key fallback", () => {
    process.env.INTERNAL_SERVICE_KEY = "platform-key";
    const r = run(requireSocialNotificationAuth, {
      headers: { "x-internal-service-key": "platform-key" },
      path: "/api/notifications/social",
    } as unknown as Request);
    delete process.env.INTERNAL_SERVICE_KEY;
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });

  it("rejects a wrong bearer", () => {
    const r = run(requireSocialNotificationAuth, {
      headers: { authorization: "Bearer wrong" },
      path: "/api/notifications/social",
    } as unknown as Request);
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });
});
