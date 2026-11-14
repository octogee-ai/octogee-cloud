import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { hydrateGithubCliAuth } from "../lib/github-cli-auth-hydrate.js";
import { withUserClaim, writeTestUserClaim } from "./helpers/user-claim.js";

const execFile = promisify(execFileCallback);
const connected = (token = "gho_test_owner") => Response.json({
  status: "connected", connectorId: "github", accessToken: token,
});

describe("User GitHub CLI authentication", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let hostsPath: string;
  const fetchImpl = vi.fn<typeof fetch>();
  const setupGit = vi.fn(async () => undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), "user-gh-auth-"));
    hostsPath = path.join(root, "gh", "hosts.yml");
    env = withUserClaim({
      HOME: root,
      GH_CONFIG_DIR: path.dirname(hostsPath),
      GATEWAY_CLASS: "isolated",
      OPENCLAW_DIR: path.join(root, ".openclaw"),
      OCTOGEE_API_SA_TOKEN_PATH: path.join(root, "gateway-token"),
    }, "alice");
    await writeFile(env.OCTOGEE_API_SA_TOKEN_PATH!, "projected-gateway-token");
    fetchImpl.mockImplementation(async (url) => url === "https://api.github.com/user"
      ? Response.json({ login: "alice-github" }) : connected());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("materializes privately through the gateway-authenticated sidecar and configures native Git", async () => {
    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).resolves.toBe("hydrated");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3001/internal/connectors/github/materialize");
    expect(new Headers(init?.headers).get("x-k8s-sa-token")).toBe("projected-gateway-token");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(parse(await readFile(hostsPath, "utf8"))).toEqual({
      "github.com": {
        git_protocol: "https", user: "alice-github", oauth_token: "gho_test_owner",
        users: { "alice-github": { oauth_token: "gho_test_owner" } },
      },
    });
    expect((await stat(hostsPath)).mode & 0o777).toBe(0o600);
    expect(setupGit).toHaveBeenCalledWith(expect.objectContaining({ GH_CONFIG_DIR: path.dirname(hostsPath) }));
    expect(JSON.stringify(setupGit.mock.calls)).not.toContain("gho_test_owner");
  });

  it("refreshes rotated credentials while preserving other hosts", async () => {
    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });
    await writeFile(hostsPath, 'enterprise.example:\n  oauth_token: enterprise-token\ngithub.com:\n  user: old-user\n  oauth_token: old-token\n  users:\n    old-user:\n      oauth_token: old-token\n');
    fetchImpl.mockImplementation(async (url) => url === "https://api.github.com/user"
      ? Response.json({ login: "new-github-user" }) : connected("gho_rotated"));

    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });

    expect(parse(await readFile(hostsPath, "utf8"))).toEqual({
      "enterprise.example": { oauth_token: "enterprise-token" },
      "github.com": {
        git_protocol: "https", user: "new-github-user", oauth_token: "gho_rotated",
        users: { "new-github-user": { oauth_token: "gho_rotated" } },
      },
    });
    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).resolves.toBe("unchanged");
  });

  it.each([
    [404, { status: "disconnected", connectorId: "github", reason: "not_connected" }],
    [409, { status: "disconnected", connectorId: "github", reason: "reauth_required" }],
    [403, { error: "forbidden" }],
    [401, { error: "Invalid internal service key" }],
  ])("clears the GitHub credential after HTTP %s", async (status, body) => {
    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });
    setupGit.mockClear();
    fetchImpl.mockResolvedValue(Response.json(body, { status }));

    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).resolves.toBe("cleared");
    expect(parse(await readFile(hostsPath, "utf8"))).toEqual({});
    expect(setupGit).not.toHaveBeenCalled();
  });

  it.each(["shared", "operator", undefined])("does not fetch or write credentials on a %s runtime", async (gatewayClass) => {
    env.GATEWAY_CLASS = gatewayClass;

    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).resolves.toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setupGit).not.toHaveBeenCalled();
    await expect(stat(hostsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before fetching when the user identity or gateway token is absent", async () => {
    await rm(path.join(env.OPENCLAW_DIR!, "builder-claim.json"));
    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).rejects.toThrow("User identity");
    writeTestUserClaim(env.OPENCLAW_DIR!, "alice");
    await rm(env.OCTOGEE_API_SA_TOKEN_PATH!);
    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).rejects.toThrow("projected service-account token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves working credentials during an upstream outage and reports failure", async () => {
    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });
    const before = await readFile(hostsPath, "utf8");
    fetchImpl.mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));

    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).rejects.toThrow("HTTP 503");
    expect(await readFile(hostsPath, "utf8")).toBe(before);
  });

  it("leaves other hosts intact when GitHub disconnects", async () => {
    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });
    await writeFile(hostsPath, 'enterprise.example:\n  oauth_token: enterprise-token\ngithub.com:\n  oauth_token: old-token\n');
    fetchImpl.mockResolvedValue(Response.json({ status: "disconnected", connectorId: "github" }, { status: 404 }));

    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });

    expect(parse(await readFile(hostsPath, "utf8"))).toEqual({ "enterprise.example": { oauth_token: "enterprise-token" } });
  });

  it("reports malformed local configuration without exposing its contents", async () => {
    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });
    await writeFile(hostsPath, "github.com: [unclosed-sensitive-token");
    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).rejects.toThrow(/^GitHub CLI hosts configuration is invalid YAML$/);
  });

  it("keeps credentials unchanged if GitHub account lookup fails", async () => {
    await hydrateGithubCliAuth({ env, fetchImpl, setupGit });
    const before = await readFile(hostsPath, "utf8");
    fetchImpl.mockImplementation(async (url) => url === "https://api.github.com/user"
      ? Response.json({ error: "private-provider-detail" }, { status: 503 }) : connected("gho_rotated"));

    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).rejects.toThrow(/^GitHub account lookup failed: HTTP 503$/);
    expect(await readFile(hostsPath, "utf8")).toBe(before);
  });

  it.each([
    { status: "connected", connectorId: "google", accessToken: "other-secret" },
    { status: "connected", connectorId: "github", accessToken: "" },
    { status: "disconnected", connectorId: "github" },
  ])("refuses an invalid successful broker response without installing credentials", async (body) => {
    fetchImpl.mockResolvedValue(Response.json(body));
    await expect(hydrateGithubCliAuth({ env, fetchImpl, setupGit })).rejects.toThrow("invalid response");
    expect(setupGit).not.toHaveBeenCalled();
    await expect(stat(hostsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the actual gh credential helper without requiring broader login scopes", async () => {
    const commandEnv = {
      ...env, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GH_PROMPT_DISABLED: "1",
    };
    await hydrateGithubCliAuth({ env: commandEnv, fetchImpl });
    const { stdout } = await execFile("gh", ["auth", "token", "--hostname", "github.com"], { env: commandEnv });
    expect(stdout.trim()).toBe("gho_test_owner");
    const { stdout: helper } = await execFile("git", ["config", "--global", "--get-all", "credential.https://github.com.helper"], { env: commandEnv });
    expect(helper).toContain("gh auth git-credential");
    expect(helper).not.toContain("gho_test_owner");
    const credential = spawnSync("git", ["credential", "fill"], {
      env: { ...commandEnv, GIT_TERMINAL_PROMPT: "0" },
      input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", timeout: 10_000,
    });
    expect(credential.status).toBe(0);
    expect(credential.stdout).toContain("password=gho_test_owner");
  });
});
