import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROKER_TOKEN_REFRESH_FALLBACK_MS,
  BROKER_TOKEN_REFRESH_RETRY_MS,
  BROKER_TOKEN_REFRESH_SKEW_MS,
  createBrokerTokenRefreshScheduler,
  readBrokerTokenExpiries,
  removeBrokerTokenExpiriesForSlug,
} from "../lib/broker-token-refresh.js";

describe("broker token refresh scheduler", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(input: {
    expiries?: Array<{ refId: string; expiresAt: number }>;
    now?: number;
    reload?: () => Promise<{ ok?: boolean; warningCount?: number }>;
  } = {}) {
    const timers: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
    const cleared: object[] = [];
    const log = vi.fn();
    const readExpiries = vi.fn(() => input.expiries ?? []);
    const rpc = { secretsReload: vi.fn(input.reload ?? (async () => ({ ok: true }))) };
    const scheduler = createBrokerTokenRefreshScheduler({
      rpc,
      log,
      now: () => input.now ?? 1_000,
      readExpiries,
      setTimer: (callback, delayMs) => {
        const handle = {};
        timers.push({ callback, delayMs, handle });
        return handle as ReturnType<typeof setTimeout>;
      },
      clearTimer: (handle) => {
        cleared.push(handle as object);
      },
    });
    return { scheduler, rpc, log, readExpiries, timers, cleared };
  }

  it("cold-re-resolves immediately and then uses the broker-issued expiry", async () => {
    const expiresAt = 1_000_000;
    const { scheduler, rpc, timers } = setup({
      now: 1_000,
      expiries: [{ refId: "agent-model-token-octogee-alice-coach", expiresAt }],
    });

    await scheduler.refresh();

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(expiresAt - BROKER_TOKEN_REFRESH_SKEW_MS - 1_000);
  });

  it("does not reload again for an expiry that was already due when the last reload succeeded", async () => {
    const now = 10_000_000;
    const { scheduler, rpc, timers } = setup({
      now,
      expiries: [{
        refId: "agent-model-token-octogee-departed-coach",
        expiresAt: now + BROKER_TOKEN_REFRESH_SKEW_MS - 1_000,
      }],
    });

    await scheduler.refresh();

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(BROKER_TOKEN_REFRESH_FALLBACK_MS);
  });

  it("uses a conservative cap when the resolver has no expiry metadata", async () => {
    const { scheduler, timers } = setup({ now: 1_000 });

    await scheduler.refresh();

    expect(timers[0]?.delayMs).toBe(BROKER_TOKEN_REFRESH_FALLBACK_MS);
  });

  it("retries promptly after a failed reload without advancing the successful-refresh cap", async () => {
    const { scheduler, rpc, log, timers } = setup({
      reload: async () => {
        throw new Error("gateway unavailable");
      },
    });

    await scheduler.refresh();

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("refresh failed"));
    expect(timers[0]?.delayMs).toBe(BROKER_TOKEN_REFRESH_RETRY_MS);
  });

  it("does not accept an unacknowledged reload as a successful token refresh", async () => {
    const { scheduler, log, timers } = setup({
      reload: async () => ({}),
    });

    await scheduler.refresh();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("refresh failed"));
    expect(timers[0]?.delayMs).toBe(BROKER_TOKEN_REFRESH_RETRY_MS);
  });

  it("retries a warning-bearing refresh soon enough to repair an unresolved owner", async () => {
    const { scheduler, rpc, timers } = setup({
      reload: async () => ({ ok: true, warningCount: 1 }),
    });

    await scheduler.refresh();

    expect(timers[0]?.delayMs).toBe(BROKER_TOKEN_REFRESH_RETRY_MS);
    timers[0]?.callback();
    await vi.waitFor(() => expect(rpc.secretsReload).toHaveBeenCalledTimes(2));
  });

  it("single-flights concurrent refresh requests", async () => {
    let finish: (() => void) | undefined;
    const { scheduler, rpc } = setup({
      reload: () => new Promise<void>((resolve) => {
        finish = resolve;
      }).then(() => ({ ok: true })),
    });

    const first = scheduler.refresh();
    const second = scheduler.refresh();
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    finish?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("starts through its timer and clears the outstanding timer when stopped", () => {
    const { scheduler, timers, cleared } = setup();

    scheduler.start();

    expect(timers[0]?.delayMs).toBe(0);
    scheduler.stop();
    expect(cleared).toEqual([timers[0]?.handle]);
  });
});

describe("readBrokerTokenExpiries", () => {
  it("uses only valid ref/expiry metadata and logs malformed records", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-token-expiry-"));
    const log = vi.fn();
    try {
      fs.writeFileSync(
        path.join(directory, "valid.json"),
        JSON.stringify({ refId: "agent-model-token-octogee-alice-coach", expiresAt: 2_000 }),
      );
      fs.writeFileSync(path.join(directory, "invalid.json"), JSON.stringify({ refId: "wrong", expiresAt: 2_000 }));

      expect(readBrokerTokenExpiries(directory, log)).toEqual([
        { refId: "agent-model-token-octogee-alice-coach", expiresAt: 2_000 },
      ]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("invalid.json"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an unreadable expiry directory and schedules from no metadata", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-token-expiry-"));
    const log = vi.fn();
    try {
      const notADirectory = path.join(directory, "expiry");
      fs.writeFileSync(notADirectory, "");

      expect(readBrokerTokenExpiries(notADirectory, log)).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("expiry metadata read failed"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("removeBrokerTokenExpiriesForSlug", () => {
  function record(directory: string, name: string, refId: string): string {
    const filename = path.join(directory, `${name}.json`);
    fs.writeFileSync(filename, JSON.stringify({ refId, expiresAt: 2_000 }));
    return filename;
  }

  it("removes every expiry record of the user's agents and nobody else's", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-token-expiry-"));
    const log = vi.fn();
    try {
      const departed = [
        record(directory, "model", "agent-model-token-octogee-alice-coach"),
        record(directory, "openrouter", "agent-model-token-openrouter-octogee-alice-coach"),
        record(directory, "openai", "agent-model-token-openai-octogee-alice-coach"),
        record(directory, "vertex", "agent-model-token-vertex-octogee-alice-coach"),
        record(directory, "embedding", "agent-embedding-token-openai-octogee-alice-coach"),
        record(directory, "project", "agent-model-token-openrouter-octogee-alice-proj-demo-coach"),
      ];
      const kept = [
        record(directory, "neighbor", "agent-model-token-octogee-alice-smith-coach"),
        record(directory, "other", "agent-model-token-openrouter-octogee-bob-proj-alice-coach"),
        record(directory, "malformed", "octogee-alice-coach"),
      ];

      removeBrokerTokenExpiriesForSlug(directory, "alice", log);

      expect(departed.filter((filename) => fs.existsSync(filename))).toEqual([]);
      expect(kept.filter((filename) => !fs.existsSync(filename))).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("malformed.json"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("has nothing to remove on a pod that never recorded an expiry", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-token-expiry-"));
    try {
      expect(() => removeBrokerTokenExpiriesForSlug(path.join(directory, "absent"), "alice", vi.fn())).not.toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails the removal when the expiry directory cannot be read", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-token-expiry-"));
    try {
      const notADirectory = path.join(directory, "expiry");
      fs.writeFileSync(notADirectory, "");

      expect(() => removeBrokerTokenExpiriesForSlug(notADirectory, "alice", vi.fn())).toThrow(/ENOTDIR/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
