import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { logger, requestLogger } from "./logging.js";

// Two concerns under test:
//
//   1) `logger.debug()` is a new level gated by the standard LOG_LEVEL
//      env knob — same shape as scripts/lib/config.ts's `dlog()`, just
//      structured-JSON output matching this package's existing logger.
//      Default LOG_LEVEL is `info`, so debug is a no-op; setting
//      LOG_LEVEL=debug enables it.
//
//   2) `requestLogger` routes /health-style kubelet-probe paths through
//      `debug` when status<400 (probe success is pure noise — the line
//      that triggered this work fired every 10s on gw-walter). Status
//      >=400 still goes to warn/error so probe failures stay loud.
//      Non-probe paths are unchanged.

describe("middleware/logging — logger.debug + LOG_LEVEL gate", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const origLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (origLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLevel;
  });

  it("logger.debug() no-ops when LOG_LEVEL is unset (defaults to info)", () => {
    delete process.env.LOG_LEVEL;
    logger.debug("ignored");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logger.debug() no-ops when LOG_LEVEL=info", () => {
    process.env.LOG_LEVEL = "info";
    logger.debug("ignored");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logger.debug() emits structured DEBUG when LOG_LEVEL=debug (case-insensitive)", () => {
    process.env.LOG_LEVEL = "DEBUG";
    logger.debug("hello", { tag: "x" });
    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "DEBUG",
      message: "hello",
      tag: "x",
    });
  });
});

describe("middleware/logging — Error serialization in meta", () => {
  // Without a serializer, JSON.stringify on `{ err: new Error("boom") }`
  // emits `{ err: {} }` because Error's instance properties (name, message,
  // stack, code, cause) are non-enumerable. We were losing every caught
  // error this way — surfaced when the live no-enum spec's 500 logged
  // `"err":{}` and we couldn't see why. Any meta value (or recursive
  // value) that's an Error must serialize to `{ name, message, stack,
  // code?, cause? }`.

  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  function parseLastError(): Record<string, unknown> {
    expect(errSpy).toHaveBeenCalled();
    const lastCall = errSpy.mock.calls.at(-1) as unknown[] | undefined;
    return JSON.parse(lastCall![0] as string) as Record<string, unknown>;
  }

  it("serializes a top-level Error in meta to name/message/stack", () => {
    const err = new Error("boom");
    logger.error("op failed", { err });
    const out = parseLastError();
    const serialized = out.err as Record<string, unknown>;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("boom");
    expect(typeof serialized.stack).toBe("string");
  });

  it("preserves an SDK `code` field on AppError-like errors", () => {
    // Caught errors from SDK clients carry a `code` property like
    // "auth/user-not-found" that's NOT a standard Error field. The
    // serializer must include arbitrary string/number/boolean own keys so
    // the next reader can branch on code.
    const err = new Error("not found") as Error & { code?: string };
    err.code = "auth/user-not-found";
    logger.error("op failed", { err });
    const out = parseLastError();
    expect((out.err as Record<string, unknown>).code).toBe("auth/user-not-found");
  });

  it("redacts credentials from Error diagnostics and own fields", () => {
    const secret = "topsecret1234567890";
    const err = new Error(`Authorization: Bearer ${secret}`) as Error & { credential?: string };
    err.credential = secret;
    logger.error("op failed", { err });
    const serialized = parseLastError().err as Record<string, unknown>;
    expect(serialized.message).toBe("Authorization: Bearer [redacted]");
    expect(serialized.stack).toContain("Authorization: Bearer [redacted]");
    expect(serialized.credential).toBe("[redacted]");
    expect(JSON.stringify(serialized)).not.toContain(secret);
  });

  it("serializes a nested Error inside an object", () => {
    const err = new Error("inner");
    logger.error("op failed", { context: { cause: err } });
    const out = parseLastError();
    const serialized = ((out.context as Record<string, unknown>).cause) as Record<string, unknown>;
    expect(serialized.message).toBe("inner");
  });

  it("leaves non-Error meta untouched (no shape regression for existing callers)", () => {
    logger.error("op failed", { email: "a@b.com", count: 3, ok: false });
    const out = parseLastError();
    expect(out.email).toBe("a@b.com");
    expect(out.count).toBe(3);
    expect(out.ok).toBe(false);
  });
});

describe("middleware/logging — requestLogger probe-path noise gating", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const origLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    if (origLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLevel;
  });

  function fakeReqRes(
    method: string,
    urlPath: string,
    statusCode: number,
    options: { matchedRoute?: boolean } = {},
  ) {
    const listeners: Record<string, () => void> = {};
    const req = {
      method,
      path: urlPath,
      ...(options.matchedRoute ? { route: { path: urlPath } } : {}),
    } as Request;
    const res = {
      statusCode,
      on: (event: string, cb: () => void) => {
        listeners[event] = cb;
        return res as unknown;
      },
    } as unknown as Response;
    return { req, res, fire: (event: string) => listeners[event]?.() };
  }

  it("GET /health 200 is silent at default LOG_LEVEL", () => {
    delete process.env.LOG_LEVEL;
    const { req, res, fire } = fakeReqRes("GET", "/health", 200);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("GET /health 200 emits at DEBUG when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const { req, res, fire } = fakeReqRes("GET", "/health", 200);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "DEBUG",
      path: "/health",
      status: 200,
    });
  });

  it.each([
    "/internal/fleet/assignment-roster",
    "/internal/byok/agent-model-token",
    "/internal/openclaw/activity/agent-identity",
  ])("keeps successful internal polling at DEBUG: %s", (path) => {
    process.env.LOG_LEVEL = "info";
    const { req, res, fire } = fakeReqRes("POST", path, 200);
    requestLogger(req, res, vi.fn());
    Object.defineProperty(req, "path", { value: path.slice(path.lastIndexOf("/")) });
    fire("finish");
    expect(logSpy).not.toHaveBeenCalled();
    process.env.LOG_LEVEL = "debug";
    fire("finish");
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "DEBUG", path,
    });
  });

  it("retains the full mounted route in a failed internal request", () => {
    const path = "/internal/fleet/assignment-roster";
    const { req, res, fire } = fakeReqRes("POST", path, 503);
    requestLogger(req, res, vi.fn());
    Object.defineProperty(req, "path", { value: "/assignment-roster" });
    fire("finish");
    expect(JSON.parse(errSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "ERROR", path, status: 503,
    });
  });

  it("successful metrics scrapes are quiet at INFO and available at DEBUG", () => {
    process.env.LOG_LEVEL = "info";
    const first = fakeReqRes("GET", "/metrics", 200);
    requestLogger(first.req, first.res, vi.fn());
    first.fire("finish");
    expect(logSpy).not.toHaveBeenCalled();

    process.env.LOG_LEVEL = "debug";
    const second = fakeReqRes("GET", "/metrics", 200);
    requestLogger(second.req, second.res, vi.fn());
    second.fire("finish");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "DEBUG", path: "/metrics", status: 200,
    });
  });

  it.each([401, 404, 500])("failed metrics scrapes remain visible: %s", (status) => {
    process.env.LOG_LEVEL = "info";
    const { req, res, fire } = fakeReqRes("GET", "/metrics", status);
    requestLogger(req, res, vi.fn());
    fire("finish");
    const spy = status >= 500 ? errSpy : warnSpy;
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({
      severity: status >= 500 ? "ERROR" : "WARNING", path: "/metrics", status,
    });
  });

  it("non-probe path still logs at INFO regardless of LOG_LEVEL", () => {
    delete process.env.LOG_LEVEL;
    const { req, res, fire } = fakeReqRes("GET", "/api/foo", 200);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "INFO",
      path: "/api/foo",
    });
  });

  it("redacts one-time OpenClaw launch tickets from request logs", () => {
    const ticket = "ticket-secret-that-must-never-be-logged";
    const { req, res, fire } = fakeReqRes(
      "GET",
      `/api/g/walter/openclaw/launch/${ticket}`,
      303,
    );
    requestLogger(req, res, vi.fn());
    fire("finish");
    const logged = logSpy.mock.calls[0][0] as string;
    expect(logged).not.toContain(ticket);
    expect(JSON.parse(logged)).toMatchObject({
      path: "/api/g/walter/openclaw/launch/<redacted>",
    });
  });

  it("redacts static preview capabilities from request logs", () => {
    const capability = "0123456789abcdef0123456789abcdef";
    const { req, res, fire } = fakeReqRes("GET", `/p/${capability}/assets/app.js`, 200);
    requestLogger(req, res, vi.fn());
    fire("finish");
    const logged = logSpy.mock.calls[0][0] as string;
    expect(logged).not.toContain(capability);
    expect(JSON.parse(logged)).toMatchObject({
      path: "/p/<redacted>/assets/app.js",
    });
  });

  it("/health 500 logs at ERROR regardless of LOG_LEVEL (failure signal preserved)", () => {
    delete process.env.LOG_LEVEL;
    const { req, res, fire } = fakeReqRes("GET", "/health", 500);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(errSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(errSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "ERROR",
      path: "/health",
      status: 500,
    });
  });

  it("/healthz, /ready, /readyz, /api/health are also gated as probe paths", () => {
    delete process.env.LOG_LEVEL;
    for (const p of ["/healthz", "/ready", "/readyz", "/api/health"]) {
      const { req, res, fire } = fakeReqRes("GET", p, 200);
      requestLogger(req, res, vi.fn());
      fire("finish");
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("/health 404 logs at WARN (probe failure on 4xx preserved, not silenced)", () => {
    // Pins the `>=400 → warn` branch in the ternary in front of the
    // PROBE_PATHS check. A future refactor that reorders the ternary
    // to `PROBE_PATHS.has(path) ? "debug" : statusCode >= 400 ? ...`
    // would silently flip 4xx probe failures to DEBUG; this guard
    // fails loud in that case.
    delete process.env.LOG_LEVEL;
    const { req, res, fire } = fakeReqRes("GET", "/health", 404);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "WARNING",
      path: "/health",
      status: 404,
    });
  });

  it("an unmatched /internal/ 404 logs at WARN — only our own services call those, so it is a wiring bug", () => {
    delete process.env.LOG_LEVEL;
    const { req, res, fire } = fakeReqRes("POST", "/internal/openclaw/project-publish", 404);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "WARNING",
      path: "/internal/openclaw/project-publish",
      status: 404,
    });
  });

  it("unmatched 404 scanner paths are silent at default LOG_LEVEL", () => {
    delete process.env.LOG_LEVEL;
    const { req, res, fire } = fakeReqRes("GET", "/wp-login.php", 404);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("unmatched 404 scanner paths remain available at DEBUG", () => {
    process.env.LOG_LEVEL = "debug";
    const { req, res, fire } = fakeReqRes("GET", "/wp-login.php", 404);
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      severity: "DEBUG",
      path: "/wp-login.php",
      status: 404,
    });
  });

  it("matched route 404s stay at WARN", () => {
    const { req, res, fire } = fakeReqRes(
      "GET",
      "/api/projects/missing",
      404,
      { matchedRoute: true },
    );
    requestLogger(req, res, vi.fn());
    fire("finish");
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
