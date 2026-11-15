import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const {
  claudeSsoCredentialsPath,
  claudeSsoStagingHomeDir,
  realClaudeSsoDeps,
} = await import("../lib/claude-sso-auth-io.js");

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sso-io-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  spawnMock.mockReset();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeSpawnChild() {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
}

describe("realClaudeSsoDeps", () => {
  it("spawns claude auth login --sso with a per-agent staging HOME", () => {
    const openclawDir = tmp();
    const child = fakeSpawnChild();
    spawnMock.mockReturnValue(child);

    const deps = realClaudeSsoDeps({
      openclawDir,
      internalServiceKey: "k",
      claudeBin: "claude-test",
    });
    const spawned = deps.spawnClaudeSso("octogee-a-coach");

    expect(spawnMock).toHaveBeenCalledWith(
      "claude-test",
      ["auth", "login", "--sso"],
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: claudeSsoStagingHomeDir(openclawDir, "octogee-a-coach"),
        }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    spawned.writeStdin("code\n");
    expect(child.stdin.write).toHaveBeenCalledWith("code\n");
  });

  it("reads and discards only the staging Claude credential home", async () => {
    const openclawDir = tmp();
    const agentId = "octogee-a-coach";
    const credentialPath = claudeSsoCredentialsPath(openclawDir, agentId);
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, '{"claudeAiOauth":{"accessToken":"a"}}');

    const deps = realClaudeSsoDeps({ openclawDir, internalServiceKey: "k" });
    await expect(deps.readCredentials(agentId)).resolves.toContain("claudeAiOauth");
    await deps.discardStaged(agentId);
    expect(fs.existsSync(claudeSsoStagingHomeDir(openclawDir, agentId))).toBe(false);
  });

  it("posts captured SSO credentials to the cluster capture endpoint", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; body: string | null }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), body: init.body ?? null });
      return { ok: true, text: async () => "", json: async () => ({}) } as any;
    }) as any;
    try {
      const deps = realClaudeSsoDeps({
        openclawDir: tmp(),
        internalServiceKey: "k",
        gatewayEdgeBaseUrl: "http://octogee-api:3001/",
      });
      await expect(deps.postCapture("flow-1", '{"claudeAiOauth":{}}')).resolves.toEqual({
        ok: true,
      });
      expect(seen[0]).toEqual({
        url: "http://octogee-api:3001/api/model-credentials/subscription/capture",
        body: JSON.stringify({ flowId: "flow-1", credential: '{"claudeAiOauth":{}}' }),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
