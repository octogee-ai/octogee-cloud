import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logSpy = vi.hoisted(() => vi.fn());
vi.mock("../lib/config.js", () => ({
  log: logSpy,
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: "/tmp/octogee-fixture",
  CUSTOMERS_DIR: "/tmp/octogee-fixture/users-doesnt-exist",
  CUSTOMER_KEYS_DIR: "/tmp/octogee-fixture/keys",
  AGENTS_DIR: "/tmp/octogee-fixture/agents",
}));

const { gitExec } = await import("../lib/git.js");

describe("gitExec failure logging carries the diagnosable detail", () => {
  const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const originalGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
  let repo: string;

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-log-"));
    execSync("git init -b main .", { cwd: repo, env: process.env });
    execSync("git config user.email test@octogee.test && git config user.name tester", {
      cwd: repo,
      env: process.env,
    });
    logSpy.mockClear();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    if (originalGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = originalGitConfigSystem;
  });

  it("logs exit code + stdout when git fails with its reason on stdout (the 5-min auto-commit case)", () => {
    const result = gitExec(repo, ["commit", "-m", "auto: test"]);

    expect(result).toBeNull();
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("exec failed"));
    expect(line).toBeDefined();
    expect(line).toMatch(/code=1/);
    expect(line).toContain("nothing to commit");
  });

  it("still logs stderr for stderr-reporting failures", () => {
    const result = gitExec(repo, ["checkout", "no-such-branch"]);

    expect(result).toBeNull();
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("exec failed"));
    expect(line).toBeDefined();
    expect(line).toMatch(/pathspec|did not match|no-such-branch/);
  });
});
