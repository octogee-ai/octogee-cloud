import { describe, expect, it, vi } from "vitest";

import {
  runGatewayPreStopFlush,
  runGatewaySystemConfigConvergenceCheckpoint,
} from "../lib/gateway-prestop-flush.js";

describe("runGatewayPreStopFlush", () => {
  it("lets the predecessor complete its final pushes before releasing its stale key", async () => {
    const calls: string[] = [];
    const result = await runGatewayPreStopFlush({
      gatewayId: "eggman-devdays",
      gatewayClass: "isolated",
      quiesceSessions: vi.fn(async () => { calls.push("quiesce"); }),
      flushFiles: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => { calls.push("system_config-push"); }),
      releaseGiteaKey: vi.fn(async () => { calls.push("release-key"); }),
      log: () => {},
    });

    expect(calls).toEqual(["quiesce", "workspaces", "blobs", "system_config-push", "release-key"]);
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({ name: "gitea-key-release", status: "done" });
  });

  it("fences stale-key cleanup when the predecessor final push fails", async () => {
    const releaseGiteaKey = vi.fn(async () => {});
    const result = await runGatewayPreStopFlush({
      gatewayId: "eggman-devdays",
      gatewayClass: "isolated",
      flushFiles: vi.fn(async () => {}),
      syncSystemConfig: vi.fn(async () => { throw new Error("push failed"); }),
      releaseGiteaKey,
      log: () => {},
    });

    expect(releaseGiteaKey).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: "gitea-key-release", status: "skipped" });
  });

  it("runs workspace, blob, and system_config flushes in order", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    let now = 100;

    const result = await runGatewayPreStopFlush({
      gatewayId: "builder-a",
      gatewayClass: "isolated",
      flushFiles: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => {
        calls.push("system_config");
        return { acceptedCommit: "a".repeat(40) };
      }),
      log: (msg) => logs.push(msg),
      now: () => {
        now += 10;
        return now;
      },
    });

    expect(calls).toEqual(["workspaces", "blobs", "system_config"]);
    expect(result.ok).toBe(true);
    expect(result.systemConfigCommit).toBe("a".repeat(40));
    expect(result.steps.map((step) => step.status)).toEqual([
      "skipped",
      "done",
      "done",
      "done",
      "skipped",
      "skipped",
    ]);
    expect(logs.join("\n")).toMatch(/starting gateway=builder-a class=isolated/);
    expect(logs.join("\n")).toMatch(/complete ok=true/);
  });

  it("logs a failed step and still attempts later flushes", async () => {
    const calls: string[] = [];
    const logs: string[] = [];

    const result = await runGatewayPreStopFlush({
      gatewayId: "default",
      gatewayClass: "shared",
      flushFiles: vi.fn(async () => {
        calls.push("workspaces");
        throw new Error("git unavailable");
      }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      log: (msg) => logs.push(msg),
      now: () => 1000,
    });

    expect(calls).toEqual(["workspaces", "blobs"]);
    expect(result.ok).toBe(false);
    expect(result.steps).toMatchObject([
      { name: "session-quiesce", status: "skipped" },
      { name: "customer-files", status: "failed", error: "git unavailable" },
      { name: "blob-sync", status: "done" },
      { name: "system-config", status: "skipped" },
      { name: "runtime-state", status: "skipped" },
      { name: "gitea-key-release", status: "skipped" },
    ]);
    expect(logs.join("\n")).toMatch(/customer-files failed/);
    expect(logs.join("\n")).toMatch(/complete ok=false/);
  });

  it("continues strict durable saves when best-effort session quiescence fails", async () => {
    const calls: string[] = [];
    const releaseGiteaKey = vi.fn(async () => {});
    const result = await runGatewayPreStopFlush({
      gatewayId: "builder-a",
      gatewayClass: "isolated",
      quiesceSessions: vi.fn(async () => {
        calls.push("quiesce");
        throw new Error("2 sessions still running");
      }),
      flushFiles: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => { calls.push("system-config"); }),
      releaseGiteaKey,
      log: () => {},
    });

    expect(calls).toEqual(["quiesce", "workspaces", "blobs", "system-config"]);
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      name: "session-quiesce",
      status: "failed",
      error: "2 sessions still running",
    });
    expect(releaseGiteaKey).not.toHaveBeenCalled();
    expect(result.steps.at(-1)).toMatchObject({ name: "gitea-key-release", status: "skipped" });
  });

  it("checks only durable system config before a target workspace is materialized", async () => {
    const syncSystemConfig = vi.fn(async () => ({ acceptedCommit: "a".repeat(40) }));
    const result = await runGatewaySystemConfigConvergenceCheckpoint({
      gatewayId: "builder-alice",
      gatewayClass: "isolated",
      syncSystemConfig,
      log: () => {},
    });

    expect(syncSystemConfig).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      systemConfigCommit: "a".repeat(40),
      steps: [
        { name: "session-quiesce", status: "skipped" },
        { name: "customer-files", status: "skipped" },
        { name: "blob-sync", status: "skipped" },
        { name: "system-config", status: "done" },
        { name: "runtime-state", status: "skipped" },
        { name: "gitea-key-release", status: "skipped" },
      ],
    });
  });

  it("keeps convergence fenced when the system config checkpoint fails", async () => {
    const result = await runGatewaySystemConfigConvergenceCheckpoint({
      gatewayId: "builder-alice",
      gatewayClass: "isolated",
      syncSystemConfig: vi.fn(async () => { throw new Error("checkpoint failed"); }),
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "customer-files", status: "skipped" }),
      expect.objectContaining({
        name: "system-config",
        status: "failed",
        error: "checkpoint failed",
      }),
    ]));
  });

  it("keeps convergence fenced without an accepted system config commit", async () => {
    const result = await runGatewaySystemConfigConvergenceCheckpoint({
      gatewayId: "builder-alice",
      gatewayClass: "isolated",
      syncSystemConfig: vi.fn(async () => undefined) as never,
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.systemConfigCommit).toBeUndefined();
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "system-config",
        status: "failed",
        error: "system config checkpoint returned no accepted commit",
      }),
    ]));
  });

  it("starts the final runtime snapshot after quiescence without serializing it behind repository flushes", async () => {
    const calls: string[] = [];
    let releaseRuntime: (() => void) | undefined;
    const runtimeDone = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const resultPromise = runGatewayPreStopFlush({
      gatewayId: "builder-a",
      gatewayClass: "isolated",
      quiesceSessions: async () => { calls.push("quiesce"); },
      syncRuntimeState: async () => {
        calls.push("runtime");
        await runtimeDone;
      },
      flushFiles: async () => { calls.push("workspace"); },
      log: () => {},
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["quiesce", "runtime", "workspace"]);
    releaseRuntime?.();
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });
});
