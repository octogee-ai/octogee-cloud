import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  createClaudeSsoStartHandler,
  createClaudeSsoStatusHandler,
  createClaudeSsoSubmitHandler,
} from "../lib/claude-sso-auth-http.js";
import type { ClaudeSsoManager } from "../lib/claude-sso-auth.js";

const KEY = "internal-key-123";

function mkReq(opts: {
  key?: string;
  body?: unknown;
  params?: Record<string, string>;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers["x-internal-service-key"] = opts.key;
  return {
    header: (n: string) => headers[n.toLowerCase()],
    body: opts.body,
    params: opts.params ?? {},
  } as unknown as Request;
}

function mkRes() {
  let status: number | undefined;
  let payload: unknown;
  const res = {
    status: vi.fn(function (this: Response, c: number) {
      status = c;
      return this;
    }),
    json: vi.fn(function (this: Response, b: unknown) {
      payload = b;
      return this;
    }),
  } as unknown as Response;
  return { res, getStatus: () => status, getBody: () => payload };
}

function fakeManager(over: Partial<ClaudeSsoManager> = {}): ClaudeSsoManager {
  return {
    start: vi.fn(async () => ({
      flowId: "f1",
      verificationUrl: "https://claude.com/cai/oauth/authorize?login_method=sso",
      expiresInMinutes: null,
      state: "awaiting_user" as const,
    })),
    submit: vi.fn(() => ({ state: "submitting" as const })),
    status: vi.fn(() => ({ state: "awaiting_user" as const, expiresInMinutes: 12 })),
    ...over,
  };
}

describe("Claude SSO HTTP handlers", () => {
  it("fails closed when the internal key is not configured", async () => {
    const mgr = fakeManager();
    const denied = mkRes();
    await createClaudeSsoStartHandler({ manager: mgr, internalServiceKey: "" })(
      mkReq({ key: undefined, body: { agentId: "octogee-a-coach" } }),
      denied.res,
      vi.fn(),
    );
    expect(denied.getStatus()).toBe(503);
    expect(denied.getBody()).toEqual({ error: "Claude SSO internal auth is not configured" });
    expect(mgr.start).not.toHaveBeenCalled();
  });

  it("start is internal-key guarded and validates the agent id", async () => {
    const mgr = fakeManager();
    const denied = mkRes();
    await createClaudeSsoStartHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: "wrong", body: { agentId: "octogee-a-coach" } }),
      denied.res,
      vi.fn(),
    );
    expect(denied.getStatus()).toBe(401);
    expect(mgr.start).not.toHaveBeenCalled();

    const badAgent = mkRes();
    await createClaudeSsoStartHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { agentId: "../../etc/passwd" } }),
      badAgent.res,
      vi.fn(),
    );
    expect(badAgent.getStatus()).toBe(400);

    const ok = mkRes();
    await createClaudeSsoStartHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { agentId: "octogee-a-coach" } }),
      ok.res,
      vi.fn(),
    );
    expect(mgr.start).toHaveBeenCalledWith("octogee-a-coach");
    expect(ok.getBody()).toMatchObject({ flowId: "f1", state: "awaiting_user" });
  });

  it("submit forwards flowId + browser code and 404s unknown flows", () => {
    const mgr = fakeManager({ submit: vi.fn(() => null) });
    const missing = mkRes();
    createClaudeSsoSubmitHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { flowId: "ghost", code: "code" } }),
      missing.res,
      vi.fn(),
    );
    expect(missing.getStatus()).toBe(404);

    const okMgr = fakeManager();
    const ok = mkRes();
    createClaudeSsoSubmitHandler({ manager: okMgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { flowId: "f1", code: "code#state" } }),
      ok.res,
      vi.fn(),
    );
    expect(okMgr.submit).toHaveBeenCalledWith("f1", "code#state");
    expect(ok.getBody()).toEqual({ state: "submitting" });
  });

  it("status returns the manager state and does not leak unknown flows", () => {
    const mgr = fakeManager();
    const ok = mkRes();
    createClaudeSsoStatusHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, params: { flowId: "f1" } }),
      ok.res,
      vi.fn(),
    );
    expect(ok.getBody()).toEqual({ state: "awaiting_user", expiresInMinutes: 12 });

    const missing = mkRes();
    createClaudeSsoStatusHandler({
      manager: fakeManager({ status: vi.fn(() => null) }),
      internalServiceKey: KEY,
    })(
      mkReq({ key: KEY, params: { flowId: "ghost" } }),
      missing.res,
      vi.fn(),
    );
    expect(missing.getStatus()).toBe(404);
  });
});
