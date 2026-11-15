import { describe, it, expect, vi } from "vitest";
import {
  createClaudeSsoManager,
  parseClaudeSsoPrompt,
  type ClaudeSsoChild,
} from "../lib/claude-sso-auth.js";

const SSO_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=challenge&code_challenge_method=S256&state=state-1&login_method=sso";

const CLAUDE_STDOUT = [
  "Opening browser to sign in...",
  `If the browser didn't open, visit: ${SSO_URL}`,
  "Paste code here if prompted > ",
].join("\n");

const GOOD_CREDENTIAL = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-access",
    refreshToken: "sk-ant-oat01-refresh",
    expiresAt: 1_782_344_797_336,
  },
});

interface FakeChild extends ClaudeSsoChild {
  emit(chunk: string): void;
  fireExit(code: number): void;
  killed: boolean;
  writes: string[];
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
    writeStdin(value) {
      this.writes.push(value);
    },
    kill() {
      this.killed = true;
    },
    emit: (c) => outCb(c),
    fireExit: (n) => exitCb(n),
    killed: false,
    writes: [],
  };
}

function harness(over: Partial<Parameters<typeof createClaudeSsoManager>[0]> = {}) {
  const child = makeFakeChild();
  const spawnClaudeSso = vi.fn((_agentId: string) => {
    queueMicrotask(() => child.emit(CLAUDE_STDOUT));
    return child;
  });
  const readCredentials = vi.fn(async (_agentId: string) => GOOD_CREDENTIAL as string | null);
  const postCapture = vi.fn(async (_flowId: string, _credential: string) => ({ ok: true }));
  const discardStaged = vi.fn(async (_agentId: string) => {});
  const log = vi.fn();
  let t = 1_000_000;
  const manager = createClaudeSsoManager({
    spawnClaudeSso,
    readCredentials,
    postCapture,
    discardStaged,
    now: () => t,
    spawnTimeoutMs: 50,
    log,
    ...over,
  });
  return {
    manager,
    child,
    spawnClaudeSso,
    readCredentials,
    postCapture,
    discardStaged,
    log,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("parseClaudeSsoPrompt", () => {
  it("extracts the Claude SSO authorize URL from the real prompt shape", () => {
    expect(parseClaudeSsoPrompt(CLAUDE_STDOUT)).toEqual({
      verificationUrl: SSO_URL,
      expiresInMinutes: null,
    });
  });

  it("returns null until both the URL and paste-code prompt are present", () => {
    expect(parseClaudeSsoPrompt(`visit: ${SSO_URL}`)).toBeNull();
    expect(parseClaudeSsoPrompt("Paste code here if prompted >")).toBeNull();
  });
});

describe("createClaudeSsoManager", () => {
  it("spawns claude auth login --sso, scrapes the URL, and returns awaiting_user", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    expect(h.spawnClaudeSso).toHaveBeenCalledWith("octogee-a-coach");
    expect(r).toMatchObject({
      verificationUrl: SSO_URL,
      expiresInMinutes: null,
      state: "awaiting_user",
    });
    expect(typeof r.flowId).toBe("string");
  });

  it("submit writes the browser code to stdin, captures credentials on exit, and marks connected", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    expect(h.manager.submit(r.flowId, "code#state")).toEqual({
      state: "submitting",
    });
    expect(h.child.writes).toEqual(["code#state\n"]);
    h.child.fireExit(0);
    await vi.waitFor(() => expect(h.manager.status(r.flowId)?.state).toBe("connected"));
    expect(h.readCredentials).toHaveBeenCalledWith("octogee-a-coach");
    expect(h.postCapture).toHaveBeenCalledWith(r.flowId, GOOD_CREDENTIAL);
  });

  it("exit 0 without .credentials.json fails loudly and never captures", async () => {
    const h = harness({ readCredentials: vi.fn(async () => null) });
    const r = await h.manager.start("octogee-a-coach");
    h.manager.submit(r.flowId, "code");
    h.child.fireExit(0);
    await vi.waitFor(() => expect(h.manager.status(r.flowId)?.state).toBe("failed"));
    expect(h.postCapture).not.toHaveBeenCalled();
  });

  it("credential read failures mark the flow failed instead of escaping the exit callback", async () => {
    const h = harness({
      readCredentials: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });
    const r = await h.manager.start("octogee-a-coach");
    h.manager.submit(r.flowId, "code");
    h.child.fireExit(0);
    await vi.waitFor(() =>
      expect(h.manager.status(r.flowId)).toEqual({
        state: "failed",
        reason: "claude SSO credential read failed: permission denied",
      }),
    );
    expect(h.postCapture).not.toHaveBeenCalled();
  });

  it("expiry kills the waiting child and discards the staging home", async () => {
    const h = harness();
    const r = await h.manager.start("octogee-a-coach");
    h.advance(16 * 60_000);
    expect(h.manager.status(r.flowId)?.state).toBe("expired");
    expect(h.child.killed).toBe(true);
    expect(h.discardStaged).toHaveBeenCalledWith("octogee-a-coach");
  });

  it("logs staging cleanup failures from terminal flows", async () => {
    const h = harness({
      discardStaged: vi.fn(async () => {
        throw new Error("busy");
      }),
    });
    const r = await h.manager.start("octogee-a-coach");
    h.advance(16 * 60_000);
    expect(h.manager.status(r.flowId)?.state).toBe("expired");
    await vi.waitFor(() =>
      expect(h.log).toHaveBeenCalledWith(
        expect.stringContaining("staging cleanup failed for octogee-a-coach"),
      ),
    );
  });
});
