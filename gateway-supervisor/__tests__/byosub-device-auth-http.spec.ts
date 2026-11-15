import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  createDeviceAuthStartHandler,
  createDeviceAuthStatusHandler,
} from "../lib/byosub-device-auth-http.js";
import type { DeviceAuthManager } from "../lib/byosub-device-auth.js";

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
function fakeManager(over: Partial<DeviceAuthManager> = {}): DeviceAuthManager {
  return {
    start: vi.fn(async () => ({
      flowId: "f1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "5BLJ-IWPLN",
      expiresInMinutes: 15,
      state: "awaiting_user" as const,
    })),
    status: vi.fn(() => ({ state: "awaiting_user" as const, expiresInMinutes: 12 })),
    ...over,
  };
}

describe("device-auth start handler — internal-key guarded", () => {
  it("allows start when no internal key is configured", async () => {
    const mgr = fakeManager();
    const { res, getBody } = mkRes();
    await createDeviceAuthStartHandler({
      manager: mgr,
      internalServiceKey: "",
    })(mkReq({ body: { agentId: "octogee-a-coach" } }), res, vi.fn());
    expect(mgr.start).toHaveBeenCalledWith("octogee-a-coach");
    expect(getBody()).toMatchObject({ flowId: "f1", state: "awaiting_user" });
  });

  it("401 when the key is missing or wrong", async () => {
    const { res, getStatus } = mkRes();
    await createDeviceAuthStartHandler({ manager: fakeManager(), internalServiceKey: KEY })(
      mkReq({ key: "nope", body: { agentId: "octogee-a-coach" } }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(401);
  });

  it("constant-time-rejects a key of a different length without throwing", async () => {
    const { res, getStatus } = mkRes();
    await createDeviceAuthStartHandler({ manager: fakeManager(), internalServiceKey: KEY })(
      mkReq({ key: "short", body: { agentId: "octogee-a-coach" } }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(401);
  });

  it("400 when agentId is missing", async () => {
    const { res, getStatus } = mkRes();
    await createDeviceAuthStartHandler({ manager: fakeManager(), internalServiceKey: KEY })(
      mkReq({ key: KEY, body: {} }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(400);
  });

  it("400 + no spawn when agentId is path-unsafe (traversal guarded at ingress)", async () => {
    const mgr = fakeManager();
    const { res, getStatus } = mkRes();
    await createDeviceAuthStartHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { agentId: "../../etc/passwd" } }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(400);
    expect(mgr.start).not.toHaveBeenCalled();
  });

  it("200 with the manager's start result on a valid request", async () => {
    const mgr = fakeManager();
    const { res, getBody } = mkRes();
    await createDeviceAuthStartHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { agentId: "octogee-a-coach" } }),
      res,
      vi.fn(),
    );
    expect(mgr.start).toHaveBeenCalledWith("octogee-a-coach");
    expect(getBody()).toMatchObject({ flowId: "f1", state: "awaiting_user" });
  });

  it("503 when the manager throws (spawn failure → caller surfaces transient)", async () => {
    const mgr = fakeManager({
      start: vi.fn(async () => {
        throw new Error("spawn timeout");
      }),
    });
    const { res, getStatus, getBody } = mkRes();
    await createDeviceAuthStartHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, body: { agentId: "octogee-a-coach" } }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(503);
    expect(JSON.stringify(getBody())).toMatch(/spawn timeout/);
  });
});

describe("device-auth status handler", () => {
  it("allows status when no internal key is configured", () => {
    const mgr = fakeManager();
    const { res, getBody } = mkRes();
    createDeviceAuthStatusHandler({ manager: mgr, internalServiceKey: "" })(
      mkReq({ params: { flowId: "f1" } }),
      res,
      vi.fn(),
    );
    expect(mgr.status).toHaveBeenCalledWith("f1");
    expect(getBody()).toEqual({ state: "awaiting_user", expiresInMinutes: 12 });
  });

  it("401 on a bad internal key (no flow info leaked)", () => {
    const mgr = fakeManager();
    const { res, getStatus } = mkRes();
    createDeviceAuthStatusHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: "wrong", params: { flowId: "f1" } }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(401);
    expect(mgr.status).not.toHaveBeenCalled();
  });

  it("404 for an unknown flowId", () => {
    const mgr = fakeManager({ status: vi.fn(() => null) });
    const { res, getStatus } = mkRes();
    createDeviceAuthStatusHandler({ manager: mgr, internalServiceKey: KEY })(
      mkReq({ key: KEY, params: { flowId: "ghost" } }),
      res,
      vi.fn(),
    );
    expect(getStatus()).toBe(404);
  });

  it("200 with the flow state for a known flow", () => {
    const { res, getBody } = mkRes();
    createDeviceAuthStatusHandler({ manager: fakeManager(), internalServiceKey: KEY })(
      mkReq({ key: KEY, params: { flowId: "f1" } }),
      res,
      vi.fn(),
    );
    expect(getBody()).toEqual({ state: "awaiting_user", expiresInMinutes: 12 });
  });
});
