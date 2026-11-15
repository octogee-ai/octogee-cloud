import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IsolatedToolchainHydrationError,
  runIsolatedToolchainHydrationLoop,
} from "../lib/isolated-toolchain-hydrator.js";
import { resolveToolchainCommand } from "../lib/isolated-toolchain-wrapper.js";
import { runIsolatedToolchainCommand } from "../entrypoints/isolated-toolchain-command.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-toolchain-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Isolated toolchain hydration loop", () => {
  it("waits for interactive readiness, retries with backoff, and never turns hydration into readiness", async () => {
    const states: string[] = [];
    const probes = [false, false, true];
    const hydrate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("transient"), { reasonCode: "npm-install-failed" }))
      .mockResolvedValue({
        schemaVersion: 1,
        status: "ready",
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
    const sleeps: number[] = [];

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => probes.shift() ?? true,
      hydrate,
      writeStatus: async (status) => { states.push(status); },
      sleep: async (ms) => { sleeps.push(ms); },
      waitForShutdown: async () => {},
      initialBackoffMs: 1_000,
      maxBackoffMs: 8_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(states).toEqual(["pending"]);
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it("logs every failed hydration attempt with its reason before retrying", async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError("npm-install-failed"))
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError(
        "internal-error",
        { cause: new Error("ENOSPC: no space left on device") },
      ))
      .mockResolvedValue({
        schemaVersion: 1,
        status: "ready",
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
    const logs: string[] = [];

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      writeStatus: async () => {},
      log: (message) => { logs.push(message); },
      sleep: async () => {},
      waitForShutdown: async () => {},
      initialBackoffMs: 1_000,
      maxBackoffMs: 8_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([
      "[isolated-toolchain] hydration attempt 1 failed reason=npm-install-failed; retrying",
      "[isolated-toolchain] hydration attempt 2 failed reason=internal-error error=ENOSPC: no space left on device; retrying",
    ]);
  });

  it("doubles the retry delay after each transient failure up to the cap", async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError("npm-install-failed"))
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError("npm-install-failed"))
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError("npm-install-failed"))
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError("npm-install-failed"))
      .mockResolvedValue({
        schemaVersion: 1,
        status: "ready",
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
    const sleeps: number[] = [];

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      writeStatus: async () => {},
      log: () => {},
      sleep: async (ms) => { sleeps.push(ms); },
      waitForShutdown: async () => {},
      initialBackoffMs: 1_000,
      maxBackoffMs: 4_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 4_000]);
  });

  it.each([
    "invalid-command-version:chromium",
    "missing-command:firebase",
    "unsafe-command-path",
  ])("does not reinstall after a deterministic %s verification failure", async (reasonCode) => {
    const hydrate = vi.fn().mockRejectedValue(new IsolatedToolchainHydrationError(
      reasonCode,
      { cause: new Error("chromium executable expected 153.x: unresolved (invalid Chromium module)") },
    ));
    const logs: string[] = [];
    const waitForShutdown = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      writeStatus: async () => {},
      log: (message) => { logs.push(message); },
      sleep,
      waitForShutdown,
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForShutdown).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      `[isolated-toolchain] hydration attempt 1 failed reason=${reasonCode} ` +
        "error=chromium executable expected 153.x: unresolved (invalid Chromium module); " +
        "not retrying until the gateway restarts",
    ]);
  });

  it("stops hydrating once the broker reports the runtime retired", async () => {
    const hydrate = vi.fn().mockRejectedValue(new IsolatedToolchainHydrationError("runtime-retired"));
    const logs: string[] = [];
    const waitForShutdown = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      writeStatus: async () => {},
      log: (message) => { logs.push(message); },
      sleep,
      waitForShutdown,
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForShutdown).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      "[isolated-toolchain] runtime retired; hydration stopped until the gateway restarts",
    ]);
  });

  it("stops retrying ready publication once the broker reports the runtime retired", async () => {
    const ready = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const ensureReadyPublished = vi.fn().mockRejectedValue(
      new IsolatedToolchainHydrationError("runtime-retired"),
    );
    const waitForShutdown = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate: async () => ready,
      ensureReadyPublished,
      writeStatus: async () => {},
      log: () => {},
      sleep,
      waitForShutdown,
    });

    expect(ensureReadyPublished).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForShutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps assignment-gated credential retries on the initial cadence", async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError(
        "npm-proxy-credentials-unavailable",
      ))
      .mockRejectedValueOnce(new IsolatedToolchainHydrationError(
        "npm-proxy-credentials-unavailable",
      ))
      .mockResolvedValue({
        schemaVersion: 1,
        status: "ready",
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
    const sleeps: number[] = [];

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      writeStatus: async () => {},
      sleep: async (ms) => { sleeps.push(ms); },
      waitForShutdown: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 40_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("retries immutable ready publication without hydrating the toolchain again", async () => {
    const ready = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const hydrate = vi.fn(async () => ready);
    const ensureReadyPublished = vi.fn()
      .mockRejectedValueOnce(new Error("assignment not cut over"))
      .mockResolvedValueOnce(undefined);
    const sleeps: number[] = [];

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      ensureReadyPublished,
      writeStatus: async () => {},
      sleep: async (ms) => { sleeps.push(ms); },
      waitForShutdown: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 40_000,
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(ensureReadyPublished.mock.calls).toEqual([[ready], [ready]]);
    expect(sleeps).toEqual([5_000]);
  });
});

describe("Isolated toolchain stable wrappers", () => {
  it("reports loading/unavailable states with stable exit codes instead of ENOENT", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "downloading",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }));

    await expect(resolveToolchainCommand({ root, command: "claude" })).resolves.toMatchObject({
      kind: "loading",
      exitCode: 75,
      message: expect.stringMatching(/loading/i),
    });

    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      updatedAt: "2026-08-30T00:00:01.000Z",
    }));
    await fs.writeFile(path.join(root, "detail.json"), JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      reasonCode: "npm-install-failed",
    }));
    await expect(resolveToolchainCommand({ root, command: "codex" })).resolves.toMatchObject({
      kind: "unavailable",
      exitCode: 69,
      message: expect.stringMatching(/unavailable.*npm-install-failed/i),
    });
  });

  it("executes an active npm bin and preserves its exit status", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const digest = "a".repeat(64);
    const objectPath = path.join(root, "objects", `sha256-${digest}`);
    await fs.mkdir(path.join(objectPath, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(objectPath, "node_modules", ".bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(objectPath, "node_modules", ".bin", "codex"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const chromiumPackage = path.join(objectPath, "node_modules", "@sparticuz", "chromium");
    const chromiumExecutable = path.join(home, "chromium");
    await fs.mkdir(path.join(chromiumPackage, "build"), { recursive: true });
    await fs.writeFile(
      path.join(chromiumPackage, "package.json"),
      `${JSON.stringify({ type: "module" })}\n`,
    );
    await fs.writeFile(
      path.join(chromiumPackage, "build", "index.js"),
      `export default class Chromium { static async executablePath() { return ${JSON.stringify(chromiumExecutable)}; } }\n`,
    );
    await fs.writeFile(chromiumExecutable, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    await fs.writeFile(path.join(objectPath, ".toolchain-lock.json"), JSON.stringify({
      schemaVersion: 1,
      lockSha256: digest,
      commands: {
        claude: "node_modules/.bin/claude",
        codex: "node_modules/.bin/codex",
        chromium: "node_modules/@sparticuz/chromium/build/index.js",
      },
    }));
    await fs.symlink(`objects/sha256-${digest}`, path.join(root, "active"));
    await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }));
    await fs.writeFile(path.join(root, "detail.json"), JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      lockSha256: digest,
    }));

    await expect(runIsolatedToolchainCommand(["codex"], { HOME: home })).resolves.toBe(7);
    await expect(runIsolatedToolchainCommand(["chromium"], { HOME: home })).resolves.toBe(9);
  });
});
