import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerMetricsServer } from "../entrypoints/runner-metrics-exporter.js";
import type { RunnerHeartbeat } from "../lib/runner-heartbeat.js";

const openServers: ReturnType<typeof createRunnerMetricsServer>[] = [];

function hb(overrides: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat {
  return {
    name: "codex",
    running: true,
    startedAt: 100,
    restarts: 0,
    lastExitCode: null,
    ts: 200,
    ...overrides,
  };
}

async function listen(server: ReturnType<typeof createRunnerMetricsServer>): Promise<string> {
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("runner metrics exporter entrypoint", () => {
  afterEach(async () => {
    await Promise.all(
      openServers.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  it("serves health, metrics, and 404 responses without requiring process startup", async () => {
    const read = vi.fn(() => [hb()]);
    const render = vi.fn(() => "octogee_runner_up 1\n");
    const readSystemConfig = vi.fn(() => ({ state: "dirty" as const }));
    const renderSystemConfig = vi.fn(() => "octogee_system_config_state 1\n");
    const baseUrl = await listen(createRunnerMetricsServer({
      dir: "/heartbeats",
      now: () => 123,
      read,
      render,
      openclawDir: "/openclaw",
      readSystemConfig,
      renderSystemConfig,
    }));

    await expect(fetch(`${baseUrl}/healthz`).then((r) => r.text())).resolves.toBe("ok");

    const metrics = await fetch(`${baseUrl}/metrics`);
    await expect(metrics.text()).resolves.toBe(
      "octogee_runner_up 1\noctogee_system_config_state 1\n",
    );
    expect(metrics.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(read).toHaveBeenCalledWith("/heartbeats");
    expect(render).toHaveBeenCalledWith([hb()], 123);
    expect(readSystemConfig).toHaveBeenCalledWith("/openclaw");
    expect(renderSystemConfig).toHaveBeenCalledWith({ state: "dirty" }, 123);

    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe("not found");
  });
});
