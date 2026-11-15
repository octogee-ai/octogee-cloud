import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, debugFromEnv } from "../lib/logger.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("The fleet controller structured logger", () => {
  it("emits canonical service and warning severity without embedded color or timestamps", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger().warn("Retrying", { scope: "placement", builderSlug: "alice" });
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ severity: "WARNING", service: "cowboy", category: "placement", builderSlug: "alice", message: "Retrying" });
  });
  it("preserves context through children", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger().child("reconcile").info("Ready");
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ service: "cowboy", category: "reconcile", message: "Ready" });
  });
  it("retains severity for the existing tagged event callbacks", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger().legacy("[glm-controller] [reaper] ⚠ cleanup failed");
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ severity: "WARNING", service: "cowboy" });
  });
  it("supports DEBUG and LOG_LEVEL for local diagnostics", () => {
    vi.stubEnv("LOG_LEVEL", "DEBUG");
    expect(debugFromEnv()).toBe(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger({ debug: debugFromEnv() }).debug("Tick");
    expect(JSON.parse(spy.mock.calls[0][0]).severity).toBe("DEBUG");
  });
});
