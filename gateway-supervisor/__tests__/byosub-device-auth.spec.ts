import { describe, it, expect, vi } from "vitest";
import {
  createDeviceAuthManager,
  type DeviceAuthChild,
} from "../lib/byosub-device-auth.js";

const CODEX_STDOUT = [
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "1. Open this link in your browser and sign in to your account",
  "   https://auth.openai.com/codex/device",
  "2. Enter this one-time code (expires in 15 minutes)",
  "   5BLJ-IWPLN",
].join("\n");

const GOOD_AUTH = '{"auth_mode":"chatgpt","tokens":{"access_token":"a","refresh_token":"r"}}';

interface FakeChild extends DeviceAuthChild {
  emit(chunk: string): void;
  fireExit(code: number): void;
  killed: boolean;
}
function makeFakeChild(): FakeChild {
  let outCb: (c: string) => void = () => {};
  let exitCb: (n: number) => void = () => {};
  return {
    onStdout: (cb) => {
      outCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill() {
      this.killed = true;
    },
    emit: (c) => outCb(c),
    fireExit: (n) => exitCb(n),
    killed: false,
  };
}

function harness(over: Partial<Parameters<typeof createDeviceAuthManager>[0]> = {}) {
  const child = makeFakeChild();
  const spawnDeviceAuth = vi.fn((_agentId: string) => {
    
    queueMicrotask(() => child.emit(CODEX_STDOUT));
    return child;
  });
  const readAuthJson = vi.fn(async (_agentId: string) => GOOD_AUTH as string | null);
  const postCapture = vi.fn(async (_flowId: string, _cred: string) => ({ ok: true }));
  const discardStaged = vi.fn(async (_agentId: string) => {});
  let t = 1_000_000;
  const manager = createDeviceAuthManager({
    spawnDeviceAuth,
    readAuthJson,
    postCapture,
    discardStaged,
    now: () => t,
    spawnTimeoutMs: 50,
    log: () => {},
    ...over,
  });
  return {
    manager,
    child,
    spawnDeviceAuth,
    readAuthJson,
    postCapture,
    discardStaged,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createDeviceAuthManager — start", () => {
  it("spawns codex, scrapes the prompt, returns awaiting_user {url,code,exp}", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    expect(h.spawnDeviceAuth).toHaveBeenCalledWith("octogee-a-coach");
    expect(r).toMatchObject({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "5BLJ-IWPLN",
      expiresInMinutes: 15,
      state: "awaiting_user",
    });
    expect(typeof r.flowId).toBe("string");
    expect(r.flowId.length).toBeGreaterThan(0);
    expect(h.manager.status(r.flowId)?.state).toBe("awaiting_user");
  });

  it("is idempotent per agent — a live flow is reused, codex spawned once", async () => {
    const h = harness();
    const a = await h.manager.start("octogee-a-coach");
    const b = await h.manager.start("octogee-a-coach");
    expect(b.flowId).toBe(a.flowId);
    expect(h.spawnDeviceAuth).toHaveBeenCalledTimes(1);
  });

  it("throws if codex exits before emitting a device prompt (spawn failure → caller 503)", async () => {
    const child = makeFakeChild();
    const h = harness({
      spawnDeviceAuth: () => {
        queueMicrotask(() => child.fireExit(1));
        return child;
      },
    });
    await expect(h.manager.start("octogee-a-coach")).rejects.toThrow();
  });

  it("throws on spawn timeout when no parsable prompt appears", async () => {
    const child = makeFakeChild();
    const h = harness({
      spawnDeviceAuth: () => {
        queueMicrotask(() => child.emit("booting...\n"));
        return child;
      },
      spawnTimeoutMs: 10,
    });
    await expect(h.manager.start("octogee-a-coach")).rejects.toThrow(/timeout/i);
  });
});

describe("createDeviceAuthManager — capture on child exit", () => {
  it("exit 0 + auth.json present → POSTs {flowId,credential} → connected", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(0);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)?.state).toBe("connected"),
    );
    expect(h.postCapture).toHaveBeenCalledWith(r.flowId, GOOD_AUTH);
  });

  it("exit 0 but no auth.json → failed, no capture POST", async () => {
    const h = harness({ readAuthJson: vi.fn(async () => null) });
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(0);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)?.state).toBe("failed"),
    );
    expect(h.postCapture).not.toHaveBeenCalled();
  });

  it("non-zero exit → failed, no capture POST", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(7);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)?.state).toBe("failed"),
    );
    expect(h.postCapture).not.toHaveBeenCalled();
  });

  it("capture POST failure → failed (loud, user retries)", async () => {
    const h = harness({
      postCapture: vi.fn(async () => ({ ok: false, reason: "writeSecret 500" })),
    });
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(0);
    await vi.waitFor(() => {
      const s = h.manager.status(r.flowId);
      expect(s?.state).toBe("failed");
      expect(s?.reason).toMatch(/capture|writeSecret/i);
    });
  });
});

describe("createDeviceAuthManager — status", () => {
  it("returns null for an unknown flowId (caller 404s)", () => {
    const h = harness();
    expect(h.manager.status("nope")).toBeNull();
  });

  it("ticks to expired once the device-code TTL elapses", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    expect(h.manager.status(r.flowId)?.state).toBe("awaiting_user");
    h.advance(16 * 60_000);
    expect(h.manager.status(r.flowId)?.state).toBe("expired");
  });

  it("a new start after expiry spawns a fresh flow", async () => {
    const h = harness();
    const a = await h.manager.start("octogee-a-coach");
    h.advance(16 * 60_000);
    expect(h.manager.status(a.flowId)?.state).toBe("expired");
    const b = await h.manager.start("octogee-a-coach");
    expect(b.flowId).not.toBe(a.flowId);
    expect(h.spawnDeviceAuth).toHaveBeenCalledTimes(2);
  });
});

describe("createDeviceAuthManager — lifecycle invariants", () => {
  it("concurrent start() for one agent shares a single codex child (P0-A)", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.manager.start("octogee-a-coach"),
      h.manager.start("octogee-a-coach"),
    ]);
    expect(a.flowId).toBe(b.flowId);
    expect(h.spawnDeviceAuth).toHaveBeenCalledTimes(1);
  });

  it("a failed scrape clears the in-flight reservation so a retry can proceed", async () => {
    let n = 0;
    const h = harness({
      spawnDeviceAuth: () => {
        n += 1;
        const c = makeFakeChild();
        
        queueMicrotask(() => (n === 1 ? c.fireExit(1) : c.emit(CODEX_STDOUT)));
        return c;
      },
    });
    await expect(h.manager.start("octogee-a-coach")).rejects.toThrow();
    const ok = await h.manager.start("octogee-a-coach");
    expect(ok.state).toBe("awaiting_user");
    expect(n).toBe(2);
  });

  it("expiry kills the orphaned codex child — no stranded OAuth credential (P0-B)", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    expect(h.child.killed).toBe(false);
    h.advance(16 * 60_000);
    expect(h.manager.status(r.flowId)?.state).toBe("expired");
    expect(h.child.killed).toBe(true);
  });

  it("a successful capture never writes a live codex-home auth.json — the staging home is discarded", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(0);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)?.state).toBe("connected"),
    );
    expect(h.discardStaged).toHaveBeenCalledWith("octogee-a-coach");
  });

  it("discards staging on capture failure", async () => {
    const h = harness({
      postCapture: vi.fn(async () => ({ ok: false, reason: "writeSecret 500" })),
    });
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(0);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)?.state).toBe("failed"),
    );
    expect(h.discardStaged).toHaveBeenCalledWith("octogee-a-coach");
  });

  it("discards staging on expiry", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    h.advance(16 * 60_000);
    expect(h.manager.status(r.flowId)?.state).toBe("expired");
    expect(h.discardStaged).toHaveBeenCalledWith("octogee-a-coach");
  });

  it("surfaces a post-terminal codex success instead of dropping it silently", async () => {
    const logs: string[] = [];
    const h = harness({ log: (m: string) => logs.push(m) });
    const r = await h.manager.start("octogee-a-coach");
    h.advance(16 * 60_000);
    expect(h.manager.status(r.flowId)?.state).toBe("expired"); 
    h.child.fireExit(0); 
    await vi.waitFor(() =>
      expect(logs.some((m) => /post-terminal.*uncaptured/.test(m))).toBe(true),
    );
    expect(h.postCapture).not.toHaveBeenCalled();
  });

  it("evicts a terminal flow after the read-grace window (no unbounded map)", async () => {
    const h = harness({ terminalGraceMs: 1_000 });
    const r = await h.manager.start("octogee-a-coach");
    h.child.fireExit(0);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)?.state).toBe("connected"),
    );
    h.advance(1_500);
    expect(h.manager.status(r.flowId)).toBeNull();
  });
});
