import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { acquireSystemConfigSyncLeaseSync } from "@octogee/core/system-config-mutation-lease";

import {
  disableSystemConfigWatch,
  enableSystemConfigWatch,
  isConfiguredGatewayUser,
  isSystemConfigWatchDisabled,
  readSystemConfigWatchFenceGeneration,
  systemConfigWatchDisabledPath,
} from "../lib/system-config-watch-state.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("system-config watch state", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("holds the durable watcher silent until a successful target activation re-enables it", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-state-"));
    dirs.push(openclawDir);

    await disableSystemConfigWatch(openclawDir, "alice");

    expect(isSystemConfigWatchDisabled(openclawDir, "alice")).toBe(true);
    expect(isSystemConfigWatchDisabled(openclawDir, "bob")).toBe(false);
    expect(fs.statSync(systemConfigWatchDisabledPath(openclawDir)).mode & 0o777).toBe(0o600);

    await expect(enableSystemConfigWatch(openclawDir, "bob")).rejects.toThrow(
      "belongs to alice",
    );
    expect(isSystemConfigWatchDisabled(openclawDir, "alice")).toBe(true);

    await enableSystemConfigWatch(openclawDir, "alice");

    expect(isSystemConfigWatchDisabled(openclawDir, "alice")).toBe(false);
  });

  it("acknowledges the fence only after an in-flight writer has drained", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-drain-"));
    dirs.push(openclawDir);
    const writer = acquireSystemConfigSyncLeaseSync({ openclawDir });
    expect(writer).not.toBeNull();
    let acknowledged = false;

    const fencing = disableSystemConfigWatch(openclawDir, "alice", {
      retryMs: 1,
      timeoutMs: 1_000,
    }).then(() => {
      acknowledged = true;
    });
    await expect.poll(
      () => isSystemConfigWatchDisabled(openclawDir, "alice"),
    ).toBe(true);
    expect(acknowledged).toBe(false);

    writer!.release();
    await fencing;

    expect(acknowledged).toBe(true);
  });

  it("does not let stale convergence clear a newer unmount fence", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-generation-"));
    dirs.push(openclawDir);
    const convergenceFence = await disableSystemConfigWatch(openclawDir, "alice");
    expect(readSystemConfigWatchFenceGeneration(openclawDir, "alice")).toBe(
      convergenceFence,
    );

    const unmountFence = await disableSystemConfigWatch(openclawDir, "alice");
    expect(unmountFence).not.toBe(convergenceFence);

    await expect(
      enableSystemConfigWatch(openclawDir, "alice", convergenceFence),
    ).resolves.toBe(false);
    expect(readSystemConfigWatchFenceGeneration(openclawDir, "alice")).toBe(
      unmountFence,
    );
    expect(isSystemConfigWatchDisabled(openclawDir, "alice")).toBe(true);
  });

  it("recovers a watcher state lease left by a crashed process", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-crash-"));
    dirs.push(openclawDir);
    const lockPath = path.join(openclawDir, "system_config.watch.state.lock");
    fs.mkdirSync(lockPath);
    const expired = new Date(0);
    fs.utimesSync(lockPath, expired, expired);

    await expect(
      disableSystemConfigWatch(openclawDir, "alice", {
        heartbeatMs: 1,
        staleAfterMs: 2,
      }),
    ).resolves.toEqual(expect.any(String));
    expect(isSystemConfigWatchDisabled(openclawDir, "alice")).toBe(true);
  });

  it("retains the generated key only for the configured dedicated user", () => {
    const env = withUserClaim({}, "alice");
    expect(isConfiguredGatewayUser("alice", env)).toBe(true);
    expect(isConfiguredGatewayUser("bob", env)).toBe(false);
    expect(isConfiguredGatewayUser("alice", { GATEWAY_BUILDER_SLUG: "alice" })).toBe(false);
    expect(isConfiguredGatewayUser("alice", {})).toBe(false);
  });
});
