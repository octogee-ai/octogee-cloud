import { afterEach, expect, it, vi } from "vitest";
import { probeOpenClawHealth } from "../lib/system-config-runtime-health.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([503, 502])("records HTTP %s separately from a health timeout", async (status) => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
  expect(await probeOpenClawHealth()).toBe(false);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
    service: "system-config-runtime-health", severity: "WARNING", message: "[openclaw-health] probe failed",
    failure: "http-error", status, durationMs: expect.any(Number),
  });
});

it("records an aborted health probe as a timeout without logging its URL", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  })));
  expect(await probeOpenClawHealth("http://127.0.0.1/healthz?private=value", 1)).toBe(false);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
    service: "system-config-runtime-health", severity: "WARNING", message: "[openclaw-health] probe failed",
    failure: "timeout", durationMs: expect.any(Number),
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});

it("distinguishes a failed connection and stays quiet on success", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(new Response(null, { status: 200 })));
  expect(await probeOpenClawHealth()).toBe(false);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
    service: "system-config-runtime-health", severity: "WARNING", message: "[openclaw-health] probe failed",
    failure: "request-failed", durationMs: expect.any(Number),
  });
  expect(await probeOpenClawHealth()).toBe(true);
  expect(log).toHaveBeenCalledOnce();
});

it("logs a persistent failure once a minute and says how many repeats it held back", async () => {
  const url = "http://127.0.0.1/healthz?case=persistent";
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  await probeOpenClawHealth(url);
  await probeOpenClawHealth(url);
  await probeOpenClawHealth(url);
  expect(log).toHaveBeenCalledOnce();
  now += 60_000;
  await probeOpenClawHealth(url);
  expect(log).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(log.mock.calls[1][0]))).toMatchObject({ failure: "request-failed", repeatsSuppressed: 2 });
});

it("logs recovery after a failure and stays quiet when nothing had failed", async () => {
  const url = "http://127.0.0.1/healthz?case=recovery";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementation(async () => new Response(null, { status: 200 })));
  await probeOpenClawHealth(url);
  await probeOpenClawHealth(url);
  expect(info.mock.calls.map(([line]) => String(line)).filter(line => line.includes("probe recovered"))).toHaveLength(1);
  await probeOpenClawHealth(url);
  expect(info.mock.calls.map(([line]) => String(line)).filter(line => line.includes("probe recovered"))).toHaveLength(1);
});
