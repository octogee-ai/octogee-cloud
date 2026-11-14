import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveSystemConfigWatchPlan,
  runSystemConfigWatch,
} from "../entrypoints/system-config-watch.js";
import { disableSystemConfigWatch } from "../lib/system-config-watch-state.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("system-config-watch entrypoint planning", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs only for isolated gateways with a user slug and canonical path", () => {
    expect(resolveSystemConfigWatchPlan({
      GATEWAY_CLASS: "isolated",
      ...withUserClaim({}, "alice"),
      OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/system_config/openclaw.json",
    })).toEqual({
      action: "watch",
      slug: "alice",
      configPath: "/home/node/.openclaw/system_config/openclaw.json",
    });
  });

  it("skips shared gateways and rejects an isolated runtime without the durable path", () => {
    expect(resolveSystemConfigWatchPlan({ GATEWAY_CLASS: "shared" })).toEqual({
      action: "skip",
      reason: "shared-gateway",
    });
    expect(() => resolveSystemConfigWatchPlan({
      GATEWAY_CLASS: "isolated",
      ...withUserClaim({}, "alice"),
      HOME: "/home/node",
    })).toThrow(/OPENCLAW_CONFIG_PATH/);
  });

  it("wires invariant validation and the full Git audit into the isolated watcher", async () => {
    const createWatcher = vi.fn(() => ({ close: vi.fn() }));
    const sync = vi.fn(() => ({ committed: false, pushed: true }));
    const audit = vi.fn(() => ({ state: "clean", needsSync: false }));
    const release = vi.fn();

    runSystemConfigWatch({
      env: {
        GATEWAY_CLASS: "isolated",
        ...withUserClaim({}, "alice"),
        OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/system_config/openclaw.json",
      },
      createWatcher,
      sync,
      audit,
      acquireSyncLease: vi.fn(() => ({ ownerToken: "watcher", release })),
      installSignalHandlers: false,
    });

    const options = createWatcher.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      configPath: "/home/node/.openclaw/system_config/openclaw.json",
      sync: expect.any(Function),
      audit: expect.any(Function),
    });
    await options.sync();
    await options.audit();
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      lockHeld: true,
    }));
    expect(audit).toHaveBeenCalledWith("alice");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps an unmounted dedicated gateway quiet until a later target activation re-enables its watcher", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-disabled-"));
    dirs.push(openclawDir);
    await disableSystemConfigWatch(openclawDir, "alice");
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    const createWatcher = vi.fn(() => ({ close: vi.fn() }));
    const sync = vi.fn(async () => ({ committed: false, pushed: true }));
    const audit = vi.fn(async () => ({ state: "clean" as const, needsSync: false }));

    runSystemConfigWatch({
      env: {
        GATEWAY_CLASS: "isolated",
        ...withUserClaim({}, "alice"),
        OPENCLAW_CONFIG_PATH: configPath,
      },
      createWatcher,
      sync,
      audit,
      installSignalHandlers: false,
    });

    const options = createWatcher.mock.calls[0]?.[0];
    await expect(options.sync()).resolves.toEqual({ committed: false, pushed: true });
    await expect(options.audit()).resolves.toEqual({ state: "clean", needsSync: false });
    expect(sync).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("rechecks the watcher fence after acquiring the mutation lease", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-race-"));
    dirs.push(openclawDir);
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    const createWatcher = vi.fn(() => ({ close: vi.fn() }));
    const release = vi.fn();
    const acquireSyncLease = vi.fn(() => {
      fs.writeFileSync(
        path.join(openclawDir, "system_config.watch.disabled"),
        JSON.stringify({ slug: "alice", generation: "unmount-fence" }),
      );
      return { ownerToken: "watcher", release };
    });
    const sync = vi.fn(async () => ({ committed: false, pushed: true }));

    runSystemConfigWatch({
      env: {
        GATEWAY_CLASS: "isolated",
        ...withUserClaim({}, "alice"),
        OPENCLAW_CONFIG_PATH: configPath,
      },
      createWatcher,
      sync,
      acquireSyncLease,
      installSignalHandlers: false,
    });

    const options = createWatcher.mock.calls[0]?.[0];
    await expect(options.sync()).resolves.toEqual({
      committed: false,
      pushed: true,
    });
    expect(acquireSyncLease).toHaveBeenCalledWith({ openclawDir });
    expect(release).toHaveBeenCalledOnce();
    expect(sync).not.toHaveBeenCalled();
  });

  it("persists watcher state transitions without persisting raw error messages", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-watch-status-"));
    dirs.push(openclawDir);
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    const createWatcher = vi.fn(() => ({ close: vi.fn() }));

    runSystemConfigWatch({
      env: {
        GATEWAY_CLASS: "isolated",
        ...withUserClaim({}, "alice"),
        OPENCLAW_CONFIG_PATH: configPath,
      },
      createWatcher,
      installSignalHandlers: false,
    });

    const onStatusChange = createWatcher.mock.calls[0]?.[0].onStatusChange;
    onStatusChange({ state: "dirty", generation: 1 });
    onStatusChange({
      state: "error",
      generation: 1,
      lastError: "secret-bearing exception text",
      errorCode: "watcher-sync-failed",
    });

    const status = JSON.parse(fs.readFileSync(
      path.join(openclawDir, "system_config.status.json"),
      "utf8",
    ));
    expect(status).toMatchObject({
      state: "error",
      watcherState: "running",
      lastErrorCode: "watcher-sync-failed",
    });
    expect(JSON.stringify(status)).not.toContain("secret-bearing exception text");
  });
});
