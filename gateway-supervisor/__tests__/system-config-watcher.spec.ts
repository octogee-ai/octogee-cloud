import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSystemConfigWatcher,
  systemConfigFingerprint,
} from "../lib/system-config-watcher.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("system_config watcher", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-watch-"));
    configPath = path.join(dir, "openclaw.json");
    fs.writeFileSync(configPath, "{\"version\":1}\n");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("watches the parent directory because OpenClaw replaces the file atomically", () => {
    const watch = vi.fn(() => ({ close: vi.fn() }));
    const watcher = createSystemConfigWatcher({
      configPath,
      sync: vi.fn(async () => ({ committed: false, pushed: true })),
      watch,
      startImmediately: false,
    });

    expect(watch).toHaveBeenCalledWith(dir, expect.any(Function));
    watcher.close();
  });

  it("batches a burst into one commit pass", async () => {
    const sync = vi.fn(async () => ({ committed: true, pushed: true }));
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      debounceMs: 2_000,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    fs.writeFileSync(configPath, "{\"version\":2}\n");
    watcher.notify();
    watcher.notify();
    watcher.notify();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("reports dirty and syncing state before the durable sync completes", async () => {
    const active = deferred<{ committed: boolean; pushed: boolean }>();
    const onStatusChange = vi.fn();
    const watcher = createSystemConfigWatcher({
      configPath,
      sync: () => active.promise,
      onStatusChange,
      debounceMs: 10,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    fs.writeFileSync(configPath, "{\"version\":2}\n");
    watcher.notify();
    expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "dirty" }));

    await vi.advanceTimersByTimeAsync(10);
    expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "syncing" }));

    active.resolve({ committed: true, pushed: true });
    await vi.runAllTimersAsync();
    expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "clean" }));
    watcher.close();
  });

  it("runs another pass when content changes during an active commit", async () => {
    const first = deferred<{ committed: boolean; pushed: boolean }>();
    const sync = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ committed: true, pushed: true });
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      debounceMs: 10,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    fs.writeFileSync(configPath, "{\"version\":2}\n");
    watcher.notify();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync).toHaveBeenCalledTimes(1);

    fs.writeFileSync(configPath, "{\"version\":3}\n");
    watcher.notify();
    first.resolve({ committed: true, pushed: true });
    await vi.runAllTimersAsync();

    expect(sync).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it("does not recursively commit a file rewrite performed by its own sync pass", async () => {
    const sync = vi.fn(async () => {
      fs.writeFileSync(configPath, "{\"version\":2,\"normalized\":true}\n");
      watcher.notify();
      return {
        committed: true,
        pushed: true,
        processedFingerprint: systemConfigFingerprint(configPath),
      };
    });
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      debounceMs: 10,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    fs.writeFileSync(configPath, "{\"version\":2}\n");
    watcher.notify();
    await vi.runAllTimersAsync();

    expect(sync).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("keeps a rejected deletion observable after restoring accepted bytes", async () => {
    const onStatusChange = vi.fn();
    const accepted = "{\"version\":1}\n";
    const sync = vi.fn(async () => {
      fs.writeFileSync(configPath, accepted);
      return {
        committed: false,
        pushed: false,
        rejected: true,
        errorCode: "openclaw-json-missing",
        processedFingerprint: systemConfigFingerprint(configPath),
      };
    });
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      onStatusChange,
      debounceMs: 10,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    fs.rmSync(configPath);
    watcher.notify();
    await vi.runAllTimersAsync();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(configPath, "utf8")).toBe(accepted);
    expect(watcher.status()).toMatchObject({
      state: "error",
      errorCode: "openclaw-json-missing",
    });
    expect(onStatusChange).not.toHaveBeenLastCalledWith(expect.objectContaining({ state: "clean" }));
    watcher.close();
  });

  it("retries a pending local commit without another filesystem edit", async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce({ committed: true, pushed: false, pending: true })
      .mockResolvedValueOnce({ committed: false, pushed: true });
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      debounceMs: 10,
      retryMs: 100,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    fs.writeFileSync(configPath, "{\"version\":2}\n");
    watcher.notify();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it("stays live while config is frozen and commits the first post-finalize edit", async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce({
        committed: false,
        pushed: false,
        processedFingerprint: systemConfigFingerprint(configPath),
      })
      .mockResolvedValueOnce({ committed: true, pushed: true });
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      debounceMs: 10,
      pollMs: 0,
      watch: () => ({ close: vi.fn() }),
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(sync).toHaveBeenCalledTimes(1);

    fs.writeFileSync(configPath, "{\"version\":2}\n");
    watcher.notify();
    await vi.advanceTimersByTimeAsync(10);
    expect(sync).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it("uses the slow Git audit to heal index or metadata drift with unchanged config bytes", async () => {
    const audit = vi.fn(async () => ({ needsSync: true }));
    const sync = vi.fn(async () => ({
      committed: true,
      pushed: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    }));
    const watcher = createSystemConfigWatcher({
      configPath,
      sync,
      audit,
      debounceMs: 10,
      pollMs: 100,
      watch: () => ({ close: vi.fn() }),
      startImmediately: false,
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(10);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    watcher.close();
  });
});
