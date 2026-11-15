import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logLevel, dlog, bootBanner } from "../lib/config.js";

describe("LOG_LEVEL verbosity lever", () => {
  const orig = process.env.LOG_LEVEL;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
    if (orig === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = orig;
  });

  it("defaults to info when LOG_LEVEL is unset", () => {
    delete process.env.LOG_LEVEL;
    expect(logLevel()).toBe("info");
  });

  it("is case-insensitive and read per-call (env stable in a pod)", () => {
    process.env.LOG_LEVEL = "DEBUG";
    expect(logLevel()).toBe("debug");
    process.env.LOG_LEVEL = "warn";
    expect(logLevel()).toBe("warn");
  });

  it("dlog is SILENT at the default (info) — the PROD ratchet", () => {
    delete process.env.LOG_LEVEL;
    dlog("[reconcile] scanned=2 assigned users");
    expect(spy).not.toHaveBeenCalled();
  });

  it("dlog EMITS when LOG_LEVEL=debug (operator cranks it back for diagnosis)", () => {
    process.env.LOG_LEVEL = "debug";
    dlog("heartbeat");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("heartbeat");
  });
});

describe("bootBanner", () => {
  const origSha = process.env.BUILD_SHA;
  afterEach(() => {
    if (origSha === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = origSha;
  });

  it("includes the build SHA, component, node version, and active log level", () => {
    process.env.BUILD_SHA = "abc1234";
    const b = bootBanner("provisioner");
    expect(b).toContain("boot provisioner");
    expect(b).toContain("sha=abc1234");
    expect(b).toContain(`node=${process.version}`);
    expect(b).toMatch(/logLevel=\w+/);
  });

  it("falls back to unknown when BUILD_SHA is absent (never throws)", () => {
    delete process.env.BUILD_SHA;
    expect(bootBanner("x")).toContain("sha=unknown");
  });
});
