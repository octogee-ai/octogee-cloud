import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateUserSshKey,
  gitExec,
  setRepoSshCommand,
} from "../lib/git.js";
import { brokeredGitHost } from "../lib/gitea-admin-broker-client.js";
import {
  auditSystemConfigForSlug,
  prepareIsolatedPrelaunchConfig,
  checkpointDurableSystemConfigForSlug,
  readAcceptedUserConfig,
  extractLegacyMattermostAccountSecrets,
  pushDirtySystemConfigForSlug,
  readDurableSystemConfigHeadForSlug,
  reconcileSystemConfigSchema,
  removeLegacyMacConfig,
  removeLegacyMacState,
  restoreSystemConfigForSlug,
  syncSystemConfigForSlug,
  systemConfigPath,
  systemConfigDir,
  defaultSystemConfigTemplatePath,
} from "../lib/system-config.js";
import { systemConfigFingerprint } from "../lib/system-config-watcher.js";
import { disableSystemConfigWatch } from "../lib/system-config-watch-state.js";
import { buildProjectAgents } from "../lib/openclaw-config-users.js";
import {
  assertPlatformInvariants,
  reconcilePlatformInvariants,
} from "../lib/system-config-invariants.js";
import { CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION, readSystemConfigCommitBlob } from "../lib/system-config-durable-files.js";
import { withUserClaim } from "./helpers/user-claim.js";
import { applyAgentStoreDatabasePatch } from "../entrypoints/pre-boot-config.js";

vi.mock("../lib/git.js", () => ({
  userSshKeyPath: vi.fn((slug: string) => `/tmp/customer-keys/${slug}/id_ed25519`),
  generateUserSshKey: vi.fn(() => "ssh-ed25519 AAA octogee-acme@gateway"),
  gitExec: vi.fn(() => "ok"),
  setRepoSshCommand: vi.fn(),
}));

vi.mock("../lib/gitea-admin-broker-client.js", () => ({
  brokeredGitHost: {
    registerKey: vi.fn(async () => {}),
    ensureOwner: vi.fn(async () => {}),
    ensureRepo: vi.fn(async () => {}),
  },
}));

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("system_config restore", () => {
  let dir: string;
  let openclawDir: string;
  let repoDir: string;
  let templatePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-system-config-"));
    openclawDir = path.join(dir, ".openclaw");
    repoDir = systemConfigDir(openclawDir);
    templatePath = path.join(dir, "openclaw.template.json");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    vi.clearAllMocks();
    vi.mocked(gitExec).mockReset().mockReturnValue("ok");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips invalid user slugs before touching brokered Gitea", async () => {
    const result = await restoreSystemConfigForSlug("../bad", {
      openclawDir,
      templatePath,
      log: () => {},
    });

    expect(result).toEqual({ skipped: "invalid-builder-slug", seeded: false, restored: false });
    expect(generateUserSshKey).not.toHaveBeenCalled();
    expect(brokeredGitHost.ensureRepo).not.toHaveBeenCalled();
  });

  it("reads the accepted system config commit without requiring a local checkout", () => {
    const acceptedCommit = "a".repeat(40);
    vi.mocked(gitExec).mockReturnValue(`${acceptedCommit}\trefs/heads/main`);

    expect(readDurableSystemConfigHeadForSlug("alice", { openclawDir })).toBe(acceptedCommit);
    expect(gitExec).toHaveBeenCalledWith(
      openclawDir,
      ["ls-remote", "git@gitea:alice/system_config.git", "refs/heads/main"],
      "/tmp/customer-keys/alice/id_ed25519",
    );
  });

  it("fails when the durable system config head is unavailable", () => {
    vi.mocked(gitExec).mockReturnValue(null);

    expect(() => readDurableSystemConfigHeadForSlug("alice", { openclawDir }))
      .toThrow("durable system config head unavailable for alice");
  });

  it("reruns schema migration after Doctor repairs invalid legacy JSON", async () => {
    const configPath = path.join(repoDir, "openclaw.json");
    fs.writeFileSync(configPath, "not-json\n");
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "walter",
    }, "ceckert");

    await expect(reconcileSystemConfigSchema(openclawDir, env)).resolves.toBe(false);
    expect(fs.existsSync(path.join(repoDir, ".octogee.json"))).toBe(false);

    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        list: [
          {
            id: "octogee-ops-walter",
            workspace: "/home/node/.openclaw/workspace/ops",
            identity: { name: "Mac" },
          },
          { id: "octogee-ceckert-coach" },
        ],
      },
      channels: {
        mattermost: {
          accounts: {
            "ceckert-coach": { botToken: "user-pat" },
          },
        },
      },
    }));

    await expect(reconcileSystemConfigSchema(openclawDir, env)).resolves.toBe(true);
    const migrated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(migrated.agents.list).toEqual([{ id: "octogee-ceckert-coach", default: true }]);
    expect(migrated.channels.mattermost.accounts["ceckert-coach"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/ceckert-coach",
    });
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8")))
      .toMatchObject({ schemaVersion: 5 });
    expect(JSON.parse(fs.readFileSync(
      path.join(openclawDir, "secrets", "mattermost-accounts.json"),
      "utf8",
    ))).toEqual({ "ceckert-coach": "user-pat" });
  });

  it("seeds a missing repo config from the safe template without resolving secrets", async () => {
    fs.writeFileSync(
      templatePath,
      JSON.stringify({
        agents: { list: [] },
        channels: {
          mattermost: {
            baseUrl: "${MM_URL}",
            accounts: {},
          },
        },
      }),
      "utf-8",
    );
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: withUserClaim({
        GATEWAY_ID: "walter-green",
        MM_URL: "http://mm",
      }, "walter"),
      log: () => {},
    });

    expect(result).toEqual({
      seeded: true,
      restored: true,
      configPath: path.join(repoDir, "openclaw.json"),
    });
    expect(brokeredGitHost.registerKey).toHaveBeenCalledWith("acme", "ssh-ed25519 AAA octogee-acme@gateway");
    expect(brokeredGitHost.ensureOwner).toHaveBeenCalledWith("acme");
    expect(brokeredGitHost.ensureRepo).toHaveBeenCalledWith("acme", { kind: "system-config" });
    expect(setRepoSshCommand).toHaveBeenCalledWith(repoDir, "acme");
    expect(gitExec).toHaveBeenCalledWith(repoDir, ["add", "openclaw.json", ".octogee.json", ".gitignore"]);
    expect(gitExec).toHaveBeenCalledWith(
      repoDir,
      ["commit", "-m", "initial system_config openclaw template"],
    );
    const tracked = fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8");
    const mattermost = JSON.parse(tracked).channels.mattermost;
    expect(mattermost.accounts).toEqual({});
    expect(mattermost).not.toHaveProperty("baseUrl");
    expect(mattermost.interactions.callbackBaseUrl).toBe("${MM_INTERACTIONS_CALLBACK_BASE_URL}");
    expect(tracked).not.toContain("http://mm");
    expect(tracked).not.toContain("Mac");
    expect(tracked).not.toContain("botToken");
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf-8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "initial",
    });
    expect(fs.readFileSync(path.join(repoDir, ".gitignore"), "utf-8")).toContain("*.tmp");
  });

  it("does not write a seed through an existing link or use a predictable metadata file", async () => {
    fs.writeFileSync(templatePath, JSON.stringify({ agents: { list: [] } }));
    const outsideConfig = path.join(dir, "outside-config.json");
    const outsideMetadata = path.join(dir, "outside-metadata.json");
    const config = path.join(repoDir, "openclaw.json");
    fs.writeFileSync(outsideMetadata, "unchanged");
    fs.symlinkSync(outsideConfig, config);
    fs.symlinkSync(outsideMetadata, path.join(repoDir, ".octogee.json.tmp"));
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) => argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok");
    const restore = () => restoreSystemConfigForSlug("acme", {
      openclawDir, templatePath,
      env: withUserClaim({ GATEWAY_ID: "walter-green", MM_URL: "http://mm" }, "walter"), log: () => {},
    });
    await expect(restore()).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.existsSync(outsideConfig)).toBe(false);
    fs.unlinkSync(config);
    await expect(restore()).resolves.toMatchObject({ seeded: true, restored: true });
    expect(fs.readFileSync(outsideMetadata, "utf8")).toBe("unchanged");
  });

  it("does not force shared-class Google write approval into a new user system config", async () => {
    templatePath = path.resolve(__dirname, "../../infra/gateway/openclaw.template.json");
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );

    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: withUserClaim({
        GATEWAY_CLASS: "isolated",
        GATEWAY_ID: "user-green",
        API_PUBLIC_URL: "https://api.octogee.com",
      }, "acme"),
      log: () => {},
    });

    const seeded = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(seeded.plugins.entries["octogee-connector-tools"].config)
      .not.toHaveProperty("requireWriteApproval");
  });

  it("stamps the isolated platform shape onto a config seeded from the shared template", async () => {
    templatePath = path.resolve(__dirname, "../../infra/gateway/openclaw.template.json");
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "robert-xs-bd6a8f5a",
      API_PUBLIC_URL: "https://api.octogee.com",
    }, "robert");

    await restoreSystemConfigForSlug("robert", {
      openclawDir,
      templatePath,
      env,
      log: () => {},
    });

    const seeded = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(() => assertPlatformInvariants(seeded, env)).not.toThrow();
    expect(seeded.gateway.controlUi).toMatchObject({
      allowedOrigins: ["https://api.octogee.com"],
      basePath: "/g/robert-xs-bd6a8f5a/openclaw",
    });
    expect(seeded.gateway.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(seeded.gateway.controlUi).not.toHaveProperty("dangerouslyDisableDeviceAuth");
  });

  it("seeds a isolated gateway from the slim boot template by default", async () => {
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "robert-xs-bd6a8f5a",
      API_PUBLIC_URL: "https://api.octogee.com",
    }, "robert");
    expect(defaultSystemConfigTemplatePath(env)).toMatch(/openclaw\.isolated\.template\.json$/);
    expect(defaultSystemConfigTemplatePath({ GATEWAY_CLASS: "shared" }))
      .toMatch(/openclaw\.template\.json$/);

    await restoreSystemConfigForSlug("robert", {
      openclawDir,
      templatePath: path.resolve(__dirname, "../../infra/gateway/openclaw.isolated.template.json"),
      env,
      log: () => {},
    });

    const seeded = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(() => assertPlatformInvariants(seeded, env)).not.toThrow();
    expect(seeded.tools).toEqual({
      profile: "coding",
      alsoAllow: expect.arrayContaining(["octogee_project_create", "workspace_commit", "browser"]),
      web: expect.any(Object),
    });
    expect(seeded.tools).not.toHaveProperty("deny");
    expect(seeded.tools).not.toHaveProperty("exec");
    expect(seeded.gateway.terminal).toEqual({ enabled: true });
    expect(seeded.commands).not.toHaveProperty("bash");
    expect(seeded).not.toHaveProperty("cron");
    expect(seeded.plugins.allow).toContain("browser");
    expect(seeded.plugins.allow).toContain("codex");
    expect(seeded.plugins.entries.browser).toEqual({ enabled: false });
    expect(seeded.plugins.entries.codex).toEqual({ enabled: true });
    expect(seeded.browser).toEqual({
      enabled: false,
      defaultProfile: "openclaw",
      headless: true,
      noSandbox: true,
      evaluateEnabled: true,
      executablePath: "/usr/bin/chromium",
    });
    expect(seeded.channels.mattermost).not.toHaveProperty("baseUrl");
    expect(seeded.gateway.controlUi.basePath).toBe("/g/robert-xs-bd6a8f5a/openclaw");
  });

  it("persists PostgreSQL selectors before fresh user bootstrap creates its state anchor", async () => {
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );
    const env = withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_ID: "acme-user", API_PUBLIC_URL: "https://api.octogee.com" }, "acme");
    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath: path.resolve(__dirname, "../../infra/gateway/openclaw.isolated.template.json"),
      env,
      log: () => {},
    });
    const config = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(() => applyAgentStoreDatabasePatch(config, env, "anchor")).not.toThrow();
    expect(config.database).toEqual({
      engine: "postgres",
      postgres: {
        connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" },
        schemaPrefix: "octogee",
      },
    });
    expect(applyAgentStoreDatabasePatch(config, env, "anchor")).toBe(false);
  });

  it.each([
    { database: undefined, stateStore: "sqlite" as const },
    { database: { engine: "sqlite", families: { state: { engine: "postgres" } } }, stateStore: "anchor" as const },
  ])(
    "preserves retained SQLite selection when restoring with the PostgreSQL user template: %j",
    async ({ database, stateStore }) => {
      writeJson(path.join(repoDir, "openclaw.json"), database ? { database } : {});
      const env = withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_ID: "acme-user", API_PUBLIC_URL: "https://api.octogee.com" }, "acme");
      await restoreSystemConfigForSlug("acme", {
        openclawDir,
        templatePath: path.resolve(__dirname, "../../infra/gateway/openclaw.isolated.template.json"),
        env,
        log: () => {},
      });
      const config = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
      expect(config.database).toEqual(database);
      expect(() => applyAgentStoreDatabasePatch(config, env, stateStore)).toThrow("database port --family");
      expect(config.database).toEqual(database);
    },
  );

  it("restores an empty legacy user roster using keyed entries for native prelaunch", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
      lastMigration: "initial",
    });
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated", GATEWAY_ID: "pipio-user", API_PUBLIC_URL: "https://api.octogee.com",
    }, "pipio");

    await restoreSystemConfigForSlug("pipio", { openclawDir, env, log: () => {} });

    const restored = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(restored.agents).not.toHaveProperty("list");
    expect(Object.keys(restored.agents.entries)).toEqual(["octogee-pipio-coach", "octogee-unmatched-route"]);
    expect(restored.agents.ownership).toBe("explicit");
    expect(restored.agents.defaults.authInheritance).toEqual({ agentId: "octogee-unmatched-route" });
    expect(restored.agents.defaults.systemAgent).toEqual({ agentId: "octogee-pipio-coach" });
  });

  it("seeds a user roster that leads with the configured agent and keeps the anchor last", async () => {
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "robert-xs-bd6a8f5a",
      API_PUBLIC_URL: "https://api.octogee.com",
    }, "robert");

    await restoreSystemConfigForSlug("robert", {
      openclawDir,
      templatePath: path.resolve(__dirname, "../../infra/gateway/openclaw.isolated.template.json"),
      env,
      log: () => {},
    });

    const seeded = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(seeded.agents.ownership).toBe("explicit");
    expect(Object.keys(seeded.agents.entries)).toEqual(["octogee-robert-coach", "octogee-unmatched-route"]);
    expect(seeded.agents.entries["octogee-robert-coach"]).toMatchObject({
      workspace: expect.stringMatching(/\/robert$/),
      agentDir: expect.stringMatching(/octogee-robert-coach\/agent$/),
      model: "platform-openai/gpt-6.1-terra",
    });
    expect(seeded.agents.entries["octogee-unmatched-route"]).not.toHaveProperty("heartbeat");
    expect(seeded.agents.defaults.authInheritance).toEqual({ agentId: "octogee-unmatched-route" });
    expect(seeded.agents.defaults.systemAgent).toEqual({ agentId: "octogee-robert-coach" });
    expect(() => assertPlatformInvariants(seeded, env)).not.toThrow();
  });

  it("removes a materialized main agent and restores coach-first order on a user restore", async () => {
    const configPath = path.join(repoDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        ownership: "explicit",
        defaults: {
          authInheritance: { agentId: "main" },
          systemAgent: { agentId: "main" },
        },
        entries: {
          main: {},
          "octogee-robert-proj-golf-coach": { workspace: "/customers/robert/projects/golf", model: "house" },
          "octogee-unmatched-route": { name: "Unmatched Mattermost route" },
          "octogee-robert-coach": { workspace: "/customers/robert", model: { primary: "house", fallbacks: [] } },
        },
      },
      talk: { agentId: "main" },
    }));
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), `${JSON.stringify({ schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION, lastMigration: "initial" })}\n`);
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "robert-xs-bd6a8f5a",
      API_PUBLIC_URL: "https://api.octogee.com",
    }, "robert");

    await restoreSystemConfigForSlug("robert", { openclawDir, env, log: () => {} });

    const restored = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(Object.keys(restored.agents.entries)).toEqual([
      "octogee-robert-coach",
      "octogee-robert-proj-golf-coach",
      "octogee-unmatched-route",
    ]);
    expect(restored.agents.entries["octogee-robert-coach"].model).toEqual({ primary: "house", fallbacks: [] });
    expect(restored.agents.defaults).toMatchObject({
      authInheritance: { agentId: "octogee-unmatched-route" },
      systemAgent: { agentId: "octogee-robert-coach" },
    });
    expect(restored.talk).toEqual({ agentId: "octogee-robert-coach" });
  });

  it("leaves a detached agent out of a retained user roster so the import's agents.create brings it back", async () => {
    const configPath = path.join(repoDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        ownership: "explicit",
        defaults: {
          authInheritance: { agentId: "octogee-unmatched-route" },
          systemAgent: { agentId: "octogee-unmatched-route" },
        },
        entries: {
          "octogee-unmatched-route": { name: "Unmatched Mattermost route" },
        },
      },
    }));
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), `${JSON.stringify({ schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION, lastMigration: "initial" })}\n`);
    const env = withUserClaim({
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "robert-m-2271ce5a",
      API_PUBLIC_URL: "https://api.octogee.com",
    }, "robert");

    await restoreSystemConfigForSlug("robert", { openclawDir, env, log: () => {} });

    const restored = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(Object.keys(restored.agents.entries)).toEqual(["octogee-unmatched-route"]);
    expect(restored.agents.defaults.systemAgent).toEqual({ agentId: "octogee-unmatched-route" });
    expect(restored.agents.ownership).toBe("explicit");
  });

  it("refuses to seed an isolated gateway that cannot resolve its own api origin", async () => {
    templatePath = path.resolve(__dirname, "../../infra/gateway/openclaw.template.json");
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );

    await expect(restoreSystemConfigForSlug("robert", {
      openclawDir,
      templatePath,
      env: { GATEWAY_CLASS: "isolated", GATEWAY_ID: "robert-xs-bd6a8f5a" },
      log: () => {},
    })).rejects.toThrow(/apiOrigin/);
  });

  it("leaves a shared-class seeded config on the shared platform shape", async () => {
    templatePath = path.resolve(__dirname, "../../infra/gateway/openclaw.template.json");
    vi.mocked(gitExec).mockImplementation((_cwd: string, argv: string[]) =>
      argv.join(" ") === "rev-parse --verify HEAD" ? null : "ok"
    );
    const env = withUserClaim({ GATEWAY_ID: "shared-a", }, "acme");

    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env,
      log: () => {},
    });

    const seeded = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(() => assertPlatformInvariants(seeded, env)).not.toThrow();
    expect(seeded.gateway.controlUi.basePath).toBeUndefined();
    expect(seeded.agents.defaults?.systemAgent).toBeUndefined();
  });

  it("does not report a seeded durable config until its initial commit is pushed", async () => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(templatePath, "{\"agents\":{\"list\":[]}}\n");
    vi.mocked(gitExec).mockImplementation((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "rev-parse --verify HEAD") return null;
      return args === "push -u origin main" ? null : "ok";
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).rejects.toThrow(/initial push failed/);
  });

  it("seeds main when an empty remote clones with a different default branch", async () => {
    const remote = path.join(dir, "remote.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { stdio: "pipe" });
    fs.rmSync(repoDir, { recursive: true });
    execFileSync("git", ["clone", remote, repoDir], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.test"]);
    fs.writeFileSync(templatePath, '{"agents":{"list":[]}}\n');
    vi.mocked(gitExec).mockImplementation((cwd, args) => {
      try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
      catch { return null; }
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir, templatePath, env: {}, log: () => {},
    })).resolves.toMatchObject({ seeded: true, restored: true });
    expect(execFileSync("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim()).toBe("main");
    expect(execFileSync("git", ["--git-dir", remote, "show", "refs/heads/main:openclaw.json"], { encoding: "utf8" })).toContain('"agents"');
  });

  it("seeds a reused checkout only when both local and remote history are empty", async () => {
    fs.writeFileSync(templatePath, '{"agents":{"list":[]}}\n');
    vi.mocked(gitExec).mockImplementation((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "fetch origin main") return null;
      if (args === "ls-remote origin refs/heads/main") return "";
      if (args === "rev-parse --verify HEAD") return null;
      return "ok";
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).resolves.toMatchObject({ seeded: true, restored: true });
  });

  it("retries a retained valid initial commit when the first seed push transiently fails", async () => {
    fs.writeFileSync(templatePath, "{\"agents\":{\"list\":[]}}\n");
    let initialCommitted = false;
    let pushAttempts = 0;
    vi.mocked(gitExec).mockImplementation((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "fetch origin main") return initialCommitted ? null : "ok";
      if (args === "rev-parse --verify HEAD") return initialCommitted ? "a".repeat(40) : null;
      if (args === "merge --ff-only origin/main") return "ok";
      if (args === "commit -m initial system_config openclaw template") {
        initialCommitted = true;
        return "ok";
      }
      if (args === "push -u origin main") {
        pushAttempts += 1;
        return pushAttempts === 1 ? null : "ok";
      }
      if (args === "ls-remote origin refs/heads/main") return "";
      if (args === "rev-parse HEAD") return "a".repeat(40);
      if (args === "symbolic-ref --short HEAD") return "main";
      if (args === "rev-list --count HEAD") return "1";
      if (args === "log -1 --pretty=%s") return "initial system_config openclaw template";
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      if (args === "diff-tree --root --no-commit-id --name-only -r HEAD") {
        return ".gitignore\n.octogee.json\nopenclaw.json";
      }
      return "ok";
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).rejects.toThrow(/initial push failed/);
    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).resolves.toMatchObject({ restored: true, seeded: false });
    expect(pushAttempts).toBe(2);
  });

  it("does not push a retained seed when empty-remote recovery history is not the initial commit", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 1,
      lastMigration: "initial",
    });
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    vi.mocked(gitExec).mockImplementation((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "fetch origin main") return null;
      if (args === "ls-remote origin refs/heads/main") return "";
      if (args === "rev-parse HEAD") return "a".repeat(40);
      if (args === "symbolic-ref --short HEAD") return "main";
      if (args === "rev-list --count HEAD") return "2";
      return "ok";
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).resolves.toEqual({ skipped: "checkout-unavailable", seeded: false, restored: false });
    expect(gitExec).not.toHaveBeenCalledWith(
      repoDir,
      ["push", "-u", "origin", "main"],
      "/tmp/customer-keys/acme/id_ed25519",
    );
  });

  it("recovers a committed config deletion instead of seeding the stock template over history", async () => {
    fs.writeFileSync(templatePath, '{"stock":true}\n');
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    const recover = vi.fn(() => {
      writeJson(path.join(repoDir, "openclaw.json"), { recovered: true });
      return {
        outcome: "recovered" as const,
        rejectedCommit: "a".repeat(40),
        recoveredFromCommit: "b".repeat(40),
        acceptedCommit: "c".repeat(40),
      };
    });
    vi.mocked(gitExec).mockImplementation((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "rev-parse --verify HEAD") return "a".repeat(40);
      return "ok";
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
      recover,
    })).resolves.toMatchObject({ seeded: false, restored: true });
    expect(recover).toHaveBeenCalledOnce();
    const restored = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(restored).toMatchObject({ recovered: true });
    expect(restored).not.toHaveProperty("stock");
    expect(gitExec).not.toHaveBeenCalledWith(
      repoDir,
      ["commit", "-m", "initial system_config openclaw template"],
    );
  });

  it("fast-forwards a reused checkout before reading its authoritative config", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });

    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    });

    expect(gitExec).toHaveBeenCalledWith(repoDir, ["fetch", "origin", "main"], "/tmp/customer-keys/acme/id_ed25519");
    expect(gitExec).toHaveBeenCalledWith(repoDir, ["merge", "--ff-only", "origin/main"], "/tmp/customer-keys/acme/id_ed25519");
  });

  it.each([
    ["acme", true, true, true],
    ["other", true, true, false],
    [null, true, true, false],
    ["acme", false, true, false],
    ["acme", true, false, false],
  ])("restores only a fenced runtime projection before fast-forward (%s, %s, %s)", async (fenceSlug, ancestor, restoreSucceeds, restored) => {
    writeJson(path.join(repoDir, "openclaw.json"), { projected: true, agents: { entries: {} } });
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION, lastMigration: "initial" });
    if (fenceSlug) writeJson(path.join(openclawDir, "system_config.watch.disabled"), { slug: fenceSlug, generation: "projection", runtimeProjection: true });
    let cleared = false;
    vi.mocked(gitExec).mockImplementation((_cwd, argv) => {
      if (argv.join(" ") === "merge-base --is-ancestor HEAD origin/main") return ancestor ? "" : null;
      if (argv[0] === "restore") {
        if (!restoreSucceeds) return null;
        cleared = true;
        writeJson(path.join(repoDir, "openclaw.json"), { accepted: true, agents: { entries: {} } });
        return "";
      }
      if (argv.join(" ") === "merge --ff-only origin/main") return cleared ? "ok" : null;
      return "ok";
    });
    const result = await restoreSystemConfigForSlug("acme", { openclawDir, templatePath, log: () => {},
      env: withUserClaim({ GATEWAY_CLASS: "isolated", API_PUBLIC_URL: "https://api.octogee.com" }, "acme") });
    expect(result.restored).toBe(restored);
    if (restored) {
      expect(gitExec).toHaveBeenCalledWith(repoDir, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "openclaw.json", ".octogee.json"], "/tmp/customer-keys/acme/id_ed25519");
      expect(JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"))).toHaveProperty("accepted", true);
    } else expect(cleared).toBe(false);
  });

  it("one-time cleanup removes only the historical Mac lane and preserves user identities", () => {
    const config = {
      agents: {
        list: [
          {
            id: "octogee-ops-${GATEWAY_ID}",
            name: "Mac (${GATEWAY_ID})",
            workspace: "/home/node/.openclaw/workspace/ops",
            agentDir: "/home/node/.openclaw/agents/octogee-ops-${GATEWAY_ID}/agent",
          },
          {
            id: "octogee-ceckert-coach",
            name: "BenderEcho (ceckert)",
            workspace: "/home/node/.openclaw/customers/ceckert",
          },
        ],
      },
      bindings: [
        { agentId: "octogee-ops-${GATEWAY_ID}", match: { channel: "mattermost" } },
        { agentId: "octogee-ceckert-coach", match: { channel: "mattermost" } },
      ],
      channels: {
        mattermost: {
          defaultAccount: "default",
          accounts: {
            default: {
              botToken: "${MM_BOT_TOKEN}",
              commands: { native: false },
            },
            "ceckert-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/ceckert-coach" } },
          },
        },
      },
    };

    expect(removeLegacyMacConfig(config, withUserClaim({ GATEWAY_ID: "walter", }, "ceckert"))).toBe(true);
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-ceckert-coach", default: true }),
    ]);
    expect(config.bindings).toEqual([
      expect.objectContaining({ agentId: "octogee-ceckert-coach" }),
    ]);
    expect(config.channels.mattermost.accounts).toEqual({
      "ceckert-coach": expect.any(Object),
    });
    expect(config.channels.mattermost).not.toHaveProperty("defaultAccount");
  });

  it("preserves user-owned Mattermost defaults and root tokens while removing exact Mac state", () => {
    const config = {
      agents: {
        list: [
          {
            id: "octogee-ops-walter",
            identity: { name: "Mac" },
            workspace: "/home/node/.openclaw/workspace/ops",
          },
          { id: "octogee-ceckert-coach" },
        ],
      },
      bindings: [
        { agentId: "octogee-ops-walter", match: { channel: "mattermost" } },
        { agentId: "octogee-ceckert-coach", match: { channel: "mattermost", accountId: "default" } },
      ],
      channels: {
        mattermost: {
          defaultAccount: "default",
          botToken: "user-root-bot-token",
          token: "user-root-token",
          accounts: {
            default: {
              botToken: "user-default-token",
              groupPolicy: "open",
            },
          },
        },
      },
    };

    expect(removeLegacyMacConfig(config, withUserClaim({
      GATEWAY_ID: "walter",
    }, "ceckert"))).toBe(true);
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-ceckert-coach", default: true }),
    ]);
    expect(config.bindings).toEqual([
      expect.objectContaining({ agentId: "octogee-ceckert-coach" }),
    ]);
    expect(config.channels.mattermost).toMatchObject({
      defaultAccount: "default",
      botToken: "user-root-bot-token",
      token: "user-root-token",
      accounts: {
        default: {
          botToken: "user-default-token",
          groupPolicy: "open",
        },
      },
    });
  });

  it("removes only exact historical Mattermost placeholder shapes", () => {
    const config = {
      channels: {
        mattermost: {
          defaultAccount: "default",
          botToken: "${MM_BOT_TOKEN}",
          token: "${MM_BOT_TOKEN}",
          accounts: {
            default: {
              botToken: "${MM_BOT_TOKEN}",
              commands: { native: false },
            },
          },
        },
      },
    };

    expect(removeLegacyMacConfig(config, {})).toBe(true);
    expect(config.channels.mattermost.accounts).toEqual({});
    expect(config.channels.mattermost).not.toHaveProperty("defaultAccount");
    expect(config.channels.mattermost).not.toHaveProperty("botToken");
    expect(config.channels.mattermost).not.toHaveProperty("token");
  });

  // openclaw 2026.7.2 migrates agents.list into keyed agents.entries at pre-boot,
  // where the key is the id and the entry carries none. Reading only the list
  // leaves the user's agent un-defaulted on every current pod.
  it("selects the user agent out of a migrated keyed roster", () => {
    const config = {
      agents: {
        entries: {
          "octogee-ceckert-coach": { name: "BenderEcho (ceckert)" },
          "octogee-bob-coach": { name: "Bob" },
        },
      },
    };

    expect(removeLegacyMacConfig(config, withUserClaim({ }, "ceckert"))).toBe(true);
    expect(config.agents.entries["octogee-ceckert-coach"]).toMatchObject({ default: true });
    expect(config.agents.entries["octogee-bob-coach"]).not.toHaveProperty("default");
  });

  it("is a no-op on a keyed roster whose user agent is already the default", () => {
    const config = {
      agents: { entries: { "octogee-ceckert-coach": { default: true } } },
    };

    expect(removeLegacyMacConfig(config, withUserClaim({ }, "ceckert"))).toBe(false);
  });

  it("does not add a legacy default selector under explicit ownership", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: { "octogee-ceckert-coach": { name: "BenderEcho (ceckert)" } },
      },
    };

    expect(removeLegacyMacConfig(config, withUserClaim({ }, "ceckert"))).toBe(false);
    expect(config.agents.entries["octogee-ceckert-coach"]).not.toHaveProperty("default");
  });

  it("does not default a agent when no user slug is configured", () => {
    const config = { agents: { entries: { "octogee-ceckert-coach": {} } } };

    expect(removeLegacyMacConfig(config, {})).toBe(false);
    expect(config.agents.entries["octogee-ceckert-coach"]).not.toHaveProperty("default");
  });

  it("preserves historical-looking Mattermost variants and never externalizes the placeholder", () => {
    const missingDefaultSelector = {
      channels: {
        mattermost: {
          accounts: {
            default: {
              botToken: "${MM_BOT_TOKEN}",
              commands: { native: false },
            },
          },
        },
      },
    };
    const customizedDefault = {
      channels: {
        mattermost: {
          defaultAccount: "default",
          accounts: {
            default: {
              botToken: "${MM_BOT_TOKEN}",
              commands: { native: true },
            },
          },
        },
      },
    };

    expect(removeLegacyMacConfig(missingDefaultSelector, {})).toBe(false);
    expect(removeLegacyMacConfig(customizedDefault, {})).toBe(false);
    expect(extractLegacyMattermostAccountSecrets(missingDefaultSelector)).toEqual({});
    expect(extractLegacyMattermostAccountSecrets(customizedDefault)).toEqual({});
    expect(missingDefaultSelector.channels.mattermost.accounts.default.botToken)
      .toBe("${MM_BOT_TOKEN}");
    expect(customizedDefault.channels.mattermost.accounts.default.botToken)
      .toBe("${MM_BOT_TOKEN}");
  });

  // 2026.7.2 rewrites agents.list into keyed agents.entries at pre-boot, so a
  // list-only reader silently keeps the legacy Mac lane on every current pod.
  it("removes the shape-matched legacy Mac agent from the keyed roster", () => {
    const config: Record<string, unknown> = {
      agents: {
        entries: {
          "octogee-ops-walter": {
            identity: { name: "Mac" },
            workspace: "/home/node/.openclaw/workspace/ops",
          },
          "octogee-ceckert-coach": { model: "house" },
        },
      },
      bindings: [
        { agentId: "octogee-ops-walter", match: { channel: "mattermost" } },
        { agentId: "octogee-ceckert-coach", match: { channel: "mattermost" } },
      ],
    };

    expect(removeLegacyMacConfig(config, withUserClaim({
      GATEWAY_ID: "walter",
    }, "ceckert"))).toBe(true);
    expect(Object.keys((config.agents as { entries: object }).entries)).toEqual([
      "octogee-ceckert-coach",
    ]);
    expect(config.bindings).toEqual([
      expect.objectContaining({ agentId: "octogee-ceckert-coach" }),
    ]);
  });

  it("removes an exact-id legacy Mac agent from the keyed roster", () => {
    const config: Record<string, unknown> = {
      agents: {
        entries: {
          "octogee-ops-${GATEWAY_ID}": { model: "house" },
          "octogee-ceckert-coach": { model: "house" },
        },
      },
      bindings: [],
    };

    expect(removeLegacyMacConfig(config, { GATEWAY_ID: "walter" })).toBe(true);
    expect(Object.keys((config.agents as { entries: object }).entries)).toEqual([
      "octogee-ceckert-coach",
    ]);
  });

  it("leaves a keyed roster without a legacy Mac lane untouched", () => {
    const config: Record<string, unknown> = {
      agents: { entries: { "octogee-ceckert-coach": { model: "house" } } },
      bindings: [{ agentId: "octogee-ceckert-coach" }],
    };

    expect(removeLegacyMacConfig(config, { GATEWAY_ID: "walter" })).toBe(false);
    expect(Object.keys((config.agents as { entries: object }).entries)).toEqual([
      "octogee-ceckert-coach",
    ]);
  });

  it("one-time state cleanup deletes only exact Mac directories and memory files", () => {
    const removedAgentDir = path.join(openclawDir, "agents", "octogee-ops-ceckert");
    const keptAgentDir = path.join(openclawDir, "agents", "octogee-ceckert-coach");
    fs.mkdirSync(removedAgentDir, { recursive: true });
    fs.mkdirSync(keptAgentDir, { recursive: true });
    fs.mkdirSync(path.join(openclawDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "memory", "octogee-ops-ceckert.sqlite"), "legacy");
    fs.writeFileSync(path.join(openclawDir, "memory", "octogee-ceckert-coach.sqlite"), "user");

    removeLegacyMacState(openclawDir, withUserClaim({ GATEWAY_ID: "walter", }, "ceckert"));

    expect(fs.existsSync(removedAgentDir)).toBe(false);
    expect(fs.existsSync(path.join(openclawDir, "memory", "octogee-ops-ceckert.sqlite"))).toBe(false);
    expect(fs.existsSync(keptAgentDir)).toBe(true);
    expect(fs.existsSync(path.join(openclawDir, "memory", "octogee-ceckert-coach.sqlite"))).toBe(true);
  });

  it("restores an existing repo config without reseeding", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      channels: { mattermost: { baseUrl: "${MM_URL}", accounts: { default: {} } } },
    });

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: { MM_URL: "http://mm2" },
      log: () => {},
    });

    expect(result).toEqual({
      seeded: false,
      restored: true,
      configPath: path.join(repoDir, "openclaw.json"),
    });
    expect(gitExec).not.toHaveBeenCalledWith(repoDir, ["add", "openclaw.json", ".octogee.json", ".gitignore"]);
    const tracked = fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8");
    const mattermost = JSON.parse(tracked).channels.mattermost;
    expect(mattermost.accounts).toEqual({});
    expect(mattermost).not.toHaveProperty("baseUrl");
    expect(tracked).not.toContain("http://mm2");
  });

  it("leaves an invalid checked-out head for accepted-ancestor recovery instead of blocking restore", async () => {
    fs.writeFileSync(path.join(repoDir, "openclaw.json"), "{ invalid\n", "utf8");
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).resolves.toMatchObject({ restored: true, configPath: path.join(repoDir, "openclaw.json") });
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8")).toBe("{ invalid\n");
  });

  it("adopts legacy user Mattermost tokens into the untracked file provider", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: { list: [{ id: "octogee-acme-coach" }] },
      channels: {
        mattermost: {
          accounts: {
            "acme-coach": { botToken: "legacy-coach-pat", groupPolicy: "open" },
          },
        },
      },
    });

    await restoreSystemConfigForSlug("acme", { openclawDir, templatePath, log: () => {} });

    const tracked = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(tracked.channels.mattermost.accounts["acme-coach"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/acme-coach",
    });
    expect(JSON.parse(fs.readFileSync(path.join(openclawDir, "secrets", "mattermost-accounts.json"), "utf8"))).toEqual({
      "acme-coach": "legacy-coach-pat",
    });
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
      pendingStateCleanup: "legacy-mac",
    });
  });

  it("makes the isolated user agent default even when no Mac agent remains", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: {
        list: [{ id: "octogee-acme-coach" }],
      },
      channels: {
        mattermost: {
          accounts: { default: {} },
          defaultAccount: "default",
        },
      },
    });

    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: withUserClaim({ }, "acme"),
      log: () => {},
    });

    const tracked = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(tracked.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-acme-coach", default: true }),
    ]);
    expect(tracked.channels.mattermost.accounts).toEqual({});
    expect(tracked.channels.mattermost.defaultAccount).toBe("default");
  });

  it("does not silently adopt plaintext tokens after the one-time migration", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 1,
      lastMigration: "remove-mac-and-externalize-mattermost-tokens",
    });
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: { list: [{ id: "octogee-acme-coach" }] },
      channels: {
        mattermost: {
          accounts: {
            "acme-coach": { botToken: "must-be-rejected-by-audit" },
          },
        },
      },
    });

    await restoreSystemConfigForSlug("acme", { openclawDir, templatePath, log: () => {} });

    const tracked = fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8");
    expect(JSON.parse(tracked).channels.mattermost.accounts["acme-coach"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/acme-coach",
    });
    expect(tracked).not.toContain("must-be-rejected-by-audit");
    expect(fs.existsSync(path.join(openclawDir, "secrets", "mattermost-accounts.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
    });
  });

  it("lifts only the exact platform host-code lockdown from a v1 user config and keeps user edits", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 1,
      lastMigration: "remove-mac-and-externalize-mattermost-tokens",
    });
    writeJson(path.join(repoDir, "openclaw.json"), {
      gateway: { terminal: { enabled: false } },
      commands: { native: "auto", bash: false, config: false, mcp: false, plugins: false, debug: false },
      cron: { triggers: { enabled: false } },
      skills: {
        load: {},
        workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending", allowSymlinkTargetWrites: false },
      },
      tools: {
        profile: "coding",
        elevated: { enabled: false },
        fs: { workspaceOnly: true },
        deny: ["exec", "process", "subagents", "sessions_spawn", "terminal", "browser", "isolated-tool"],
        alsoAllow: ["octogee_project_create"],
        exec: { mode: "deny" },
        sessions: { visibility: "self" },
        subagents: { tools: { deny: ["exec", "process", "user-subagent-deny"] } },
      },
      plugins: {
        allow: ["mattermost"],
        entries: {
          codex: {
            enabled: false,
            config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
          },
        },
      },
      agents: {
        list: [
          {
            id: "octogee-acme-coach",
            default: true,
            tools: {
              profile: "coding",
              alsoAllow: ["octogee_project_create"],
              deny: ["exec", "process", "terminal", "browser"],
              fs: { workspaceOnly: true },
              toolsBySender: {},
            },
          },
          {
            id: "octogee-acme-proj-garden-coach",
            tools: { profile: "minimal", deny: ["exec", "process"], exec: { mode: "deny", host: "node" } },
          },
        ],
      },
    });

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated.gateway.terminal).toEqual({ enabled: true });
    expect(migrated.commands).toEqual({ native: "auto" });
    expect(migrated).not.toHaveProperty("cron");
    expect(migrated).not.toHaveProperty("skills");
    expect(migrated.tools).toEqual({
      profile: "coding",
      deny: ["isolated-tool"],
      alsoAllow: ["octogee_project_create", "browser"],
      subagents: { tools: { deny: ["user-subagent-deny"] } },
    });
    expect(migrated.plugins).toEqual({
      allow: ["mattermost", "codex", "browser"],
      entries: { codex: { enabled: true }, browser: { enabled: true } },
    });
    expect(migrated.agents.list).toEqual([
      {
        id: "octogee-acme-coach",
        default: true,
      },
      {
        id: "octogee-acme-proj-garden-coach",
      },
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
    });
    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(false);
  });

  it("drops the agent fence from a keyed agents.entries roster", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });
    writeJson(path.join(repoDir, "openclaw.json"), {
      skills: {
        workshop: { approvalPolicy: "pending", allowSymlinkTargetWrites: false, autonomous: { mode: "off" } },
      },
      agents: {
        entries: {
          "octogee-acme-coach": {
            default: true,
            tools: { profile: "coding", deny: ["exec", "process", "terminal", "browser"], fs: { workspaceOnly: true } },
          },
        },
      },
    });

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated).not.toHaveProperty("skills");
    expect(migrated.agents.entries["octogee-acme-coach"]).toEqual({ default: true });
  });

  it("leaves a User-authored codex or exec policy alone when lifting the lockdown", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });
    writeJson(path.join(repoDir, "openclaw.json"), {
      tools: { exec: { mode: "deny", host: "sandbox" }, deny: ["user-only"] },
      plugins: {
        allow: ["mattermost", "codex"],
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { sandbox: "danger-full-access", approvalPolicy: "never" } },
          },
        },
      },
      agents: { list: [{ id: "octogee-acme-coach" }] },
    });

    await reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"));

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated.tools).toEqual({
      exec: { mode: "deny", host: "sandbox" },
      deny: ["user-only"],
      alsoAllow: ["browser"],
    });
    expect(migrated.plugins.entries.codex).toEqual({
      enabled: true,
      config: { appServer: { sandbox: "danger-full-access", approvalPolicy: "never" } },
    });
    expect(migrated.plugins.entries.browser).toEqual({ enabled: true });
    expect(migrated.plugins.allow).toEqual(["mattermost", "codex", "browser"]);
  });

  it("adds managed browser defaults to a v2 user config without replacing user settings", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 2,
      lastMigration: "lift-platform-host-code-lockdown",
    });
    writeJson(path.join(repoDir, "openclaw.json"), {
      tools: { profile: "coding", alsoAllow: ["isolated-tool"] },
      plugins: { allow: ["mattermost"], entries: {} },
      agents: { list: [{ id: "octogee-acme-coach", default: true }] },
    });

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated.tools).toEqual({
      profile: "coding",
      alsoAllow: ["isolated-tool", "browser"],
    });
    expect(migrated.plugins).toEqual({
      allow: ["mattermost", "browser"],
      entries: { browser: { enabled: true } },
    });
    expect(migrated.browser).toEqual({
      enabled: true,
      defaultProfile: "openclaw",
      headless: true,
      noSandbox: true,
      evaluateEnabled: true,
      executablePath: "/usr/bin/chromium",
    });
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
    });
    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(false);
  });

  it("lifts the platform project-agent fence from a v3 user config", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 3,
      lastMigration: "enable-isolated-browser",
    });
    const [platformProjectAgent] = buildProjectAgents({
      slug: "acme",
      customerDir: "/customers/acme",
      agentsDir: "/agents",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
      projectAgents: [{ projectId: "garden", enabled: true, token: "pat", mmUserId: "bot" }],
    });
    const builderTools = { profile: "full", deny: ["browser"] };
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: {
        list: [
          platformProjectAgent,
          { id: "octogee-acme-proj-custom-coach", tools: builderTools },
        ],
      },
    });

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated.agents.list[0]).not.toHaveProperty("tools");
    expect(migrated.agents.list[1].tools).toEqual(builderTools);
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
    });
  });

  it("lifts drifted shared host-code fences from the owner's agent and project agents in a v4 user config", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 4,
      lastMigration: "lift-user-project-agent-host-code-lockdown",
    });
    const builderTools = { profile: "full", deny: ["browser"] };
    const foreignFence = { deny: ["exec", "process"], fs: { workspaceOnly: true } };
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: {
        entries: {
          "octogee-acme-coach": {
            tools: {
              profile: "full",
              alsoAllow: ["browser", "computer", "message"],
              deny: ["exec", "process", "subagents", "terminal", "automations"],
              toolsBySender: {},
              fs: { workspaceOnly: true },
            },
          },
          "octogee-acme-proj-garden-coach": {
            tools: {
              deny: ["exec", "process", "terminal", "computer", "nodes", "file-transfer", "ollama"],
              profile: "minimal",
              exec: { mode: "deny", host: "node" },
            },
          },
          "octogee-acme-proj-custom-coach": { tools: builderTools },
          "octogee-other-coach": { tools: foreignFence },
        },
      },
    });

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated.agents.entries["octogee-acme-coach"]).not.toHaveProperty("tools");
    expect(migrated.agents.entries["octogee-acme-proj-garden-coach"]).not.toHaveProperty("tools");
    expect(migrated.agents.entries["octogee-acme-proj-custom-coach"].tools).toEqual(builderTools);
    expect(migrated.agents.entries["octogee-other-coach"].tools).toEqual(foreignFence);
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
    });
  });

  it("drops a drifted shared agent fence whole when migrating a pre-v2 user config", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 1,
      lastMigration: "remove-mac-and-externalize-mattermost-tokens",
    });
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: {
        entries: {
          "octogee-acme-coach": {
            tools: {
              profile: "full",
              alsoAllow: ["browser", "computer", "message"],
              deny: ["exec", "process", "subagents", "terminal", "automations"],
              toolsBySender: {},
              fs: { workspaceOnly: true },
            },
          },
        },
      },
    });

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    const migrated = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(migrated.agents.entries["octogee-acme-coach"]).not.toHaveProperty("tools");
  });

  it("preserves an explicit user browser opt-out during the v3 migration", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 2,
      lastMigration: "lift-platform-host-code-lockdown",
    });
    const disabled = {
      browser: { enabled: false, headless: false },
      tools: { profile: "coding", deny: ["browser"], alsoAllow: ["isolated-tool"] },
      plugins: {
        allow: ["mattermost"],
        entries: { browser: { enabled: false } },
      },
    };
    writeJson(path.join(repoDir, "openclaw.json"), disabled);

    await expect(reconcileSystemConfigSchema(openclawDir, withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "acme"))).resolves.toBe(true);

    expect(JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8")))
      .toEqual(disabled);
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 5,
      lastMigration: "lift-builder-agent-shared-host-code-fence",
    });
  });

  it("fails closed when tracked migration metadata is malformed", async () => {
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), "{ invalid", "utf-8");
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: { list: [{ id: "octogee-acme-coach" }] },
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).resolves.toEqual({
      skipped: "accepted-head-unavailable",
      seeded: false,
      restored: false,
    });

    expect(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf-8")).toBe("{ invalid");
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8")).toContain(
      "octogee-acme-coach",
    );
  });

  it("rejects and restores malformed dirty metadata", () => {
    const durableEnv = {
      GATEWAY_CLASS: "isolated",
      GATEWAY_ID: "walter",
      API_PUBLIC_URL: "https://api.example.test",
    };
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, durableEnv);
    writeJson(path.join(repoDir, "openclaw.json"), config);
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), "{ invalid");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    const head = "a".repeat(40);
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "rev-parse HEAD") return head;
      if (args === "ls-remote origin refs/heads/main") return `${head}\trefs/heads/main`;
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") {
        return " M .octogee.json";
      }
      if (args === "show HEAD:.octogee.json") return '{"schemaVersion":1}\n';
      if (args === "show HEAD:.gitignore") return "*.bak\n*.tmp\n";
      return "ok";
    });

    expect(syncSystemConfigForSlug("acme", {
      openclawDir,
      env: durableEnv,
      durablePolicy: true,
      validateConfig: () => {
        throw new Error("validation failed");
      },
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
      log: () => {},
    })).toMatchObject({ rejected: true, errorCode: "validation-failed" });
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8")))
      .toEqual({ schemaVersion: 1 });
    expect(git).not.toHaveBeenCalledWith(
      repoDir,
      "add openclaw.json .octogee.json .gitignore",
      "/tmp/key",
    );
  });

  it("uses the tracked repository file as the active config without expanding secrets", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: { list: [{ id: "octogee-acme-coach" }] },
      channels: {
        mattermost: {
          baseUrl: "${MM_URL}",
          accounts: { "acme-coach": { botToken: "${MM_BOT_TOKEN}" } },
        },
      },
    });

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: { MM_URL: "http://mm", MM_BOT_TOKEN: "must-not-enter-git" },
      log: () => {},
    });

    expect(result).toMatchObject({ restored: true, configPath: systemConfigPath(openclawDir) });
    const tracked = fs.readFileSync(systemConfigPath(openclawDir), "utf-8");
    const mattermost = JSON.parse(tracked).channels.mattermost;
    expect(mattermost.accounts).toEqual({
      "acme-coach": {
        baseUrl: "${MM_URL}",
        botToken: { source: "file", provider: "octogee-mattermost", id: "/acme-coach" },
        dmPolicy: "disabled",
      },
    });
    expect(mattermost).not.toHaveProperty("baseUrl");
    expect(tracked).not.toContain("http://mm");
    expect(tracked).not.toContain("must-not-enter-git");
    expect(fs.existsSync(path.join(openclawDir, "openclaw.json"))).toBe(false);
  });

  it("restores user account endpoints and secret references without resolving owner placeholders", async () => {
    const accounts = {
      "acme-coach": {
        baseUrl: "${OWNER_MM_URL}",
        botToken: { source: "file", provider: "octogee-mattermost", id: "/acme-coach" },
      },
      "acme-proj-orbit": {
        baseUrl: "https://owner-project.example",
        botToken: { source: "file", provider: "octogee-mattermost", id: "/acme-proj-orbit" },
      },
    };
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: { list: [{ id: "octogee-acme-coach" }, { id: "octogee-acme-proj-orbit-coach" }] },
      channels: { mattermost: { accounts } },
    });

    await restoreSystemConfigForSlug("acme", {
      openclawDir, templatePath,
      env: withUserClaim({
        GATEWAY_CLASS: "isolated", GATEWAY_ID: "acme-xs-12345678", 
        API_PUBLIC_URL: "https://api.example.test",
        MM_URL: "http://runtime-mattermost", OWNER_MM_URL: "https://runtime-owner.example",
        MM_BOT_TOKEN: "must-not-enter-git",
      }, "acme"),
      log: () => {},
    });

    const tracked = fs.readFileSync(systemConfigPath(openclawDir), "utf8");
    const mattermost = JSON.parse(tracked).channels.mattermost;
    for (const [accountId, account] of Object.entries(accounts)) {
      expect(mattermost.accounts[accountId]).toEqual({ ...account, dmPolicy: "disabled" });
    }
    expect(tracked).not.toContain("http://runtime-mattermost");
    expect(tracked).not.toContain("https://runtime-owner.example");
    expect(tracked).not.toContain("must-not-enter-git");
  });

  it("preStop sync commits and pushes only dirty system_config openclaw.json", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const calls: Array<{ cwd: string; args: string; sshKeyPath?: string }> = [];
    const logs: string[] = [];
    const result = pushDirtySystemConfigForSlug("acme", {
      openclawDir,
      now: () => new Date("2026-06-20T14:00:00.000Z"),
      log: (msg) => logs.push(msg),
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: vi.fn((cwd: string, argsArgv: string[], sshKeyPath?: string) => {
        const args = argsArgv.join(" ");
        calls.push({ cwd, args, sshKeyPath });
        if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
        return "ok";
      }),
    });

    expect(result).toEqual({ committed: true, pushed: true });
    expect(calls.map((call) => call.args)).toEqual([
      "status --porcelain -- openclaw.json .octogee.json .gitignore",
      "add openclaw.json .octogee.json .gitignore",
      expect.stringContaining("Octogee-Config-Source: auto-watch"),
      "push origin main",
      "rev-parse HEAD",
    ]);
    expect(logs.join("\n")).toMatch(/auto-watch pushed/);
  });

  it("preStop sync skips a clean system_config checkout", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const git = vi.fn((cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      return "unexpected";
    });

    const result = pushDirtySystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toEqual({ committed: false, pushed: false });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it("preStop sync treats git status failure as skipped, not clean", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const logs: string[] = [];

    const result = pushDirtySystemConfigForSlug("acme", {
      openclawDir,
      log: (msg) => logs.push(msg),
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: vi.fn(() => null),
    });

    expect(result).toEqual({ skipped: "status-failed", committed: false, pushed: false });
    expect(logs.join("\n")).toMatch(/status check failed/);
  });

  it("watcher sync retries a previously committed change even when the worktree is clean", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      if (args === "push origin main") return "ok";
      return null;
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ committed: false, pushed: true, pending: false });
    expect(git).toHaveBeenCalledWith(repoDir, ["push", "origin", "main"], "/tmp/key");
  });

  it("watcher sync marks a local commit pending when push fails", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "push origin main") return null;
      return "ok";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ committed: true, pushed: false, pending: true });
  });

  it("reports the staged fingerprint so an edit racing the commit receives another pass", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    const stagedFingerprint = systemConfigFingerprint(configPath);
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args.startsWith("commit -m ")) {
        writeJson(configPath, { version: 2 });
      }
      return "ok";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result.processedFingerprint).toBe(stagedFingerprint);
    expect(systemConfigFingerprint(configPath)).not.toBe(result.processedFingerprint);
  });

  it("backs off and retries a transient staging failure instead of spinning", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    const git = vi.fn((_cwd: string, argv: string[]) =>
      argv.join(" ") === "status --porcelain -- openclaw.json .octogee.json .gitignore" ? " M openclaw.json" : null
    );

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({
      skipped: "stage-failed",
      pending: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    });
  });

  it("defers when another config-sync process owns the gateway lock", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);
    const git = vi.fn(() => "unexpected");

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({
      skipped: "sync-locked",
      pending: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    });
    expect(git).not.toHaveBeenCalled();
  });

  it("uses an already-held writer lock without racing itself", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "rev-parse HEAD") return "a".repeat(40);
      return "ok";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      lockHeld: true,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ pushed: true, acceptedCommit: "a".repeat(40) });
    expect(fs.existsSync(path.join(openclawDir, "system_config.sync.lock"))).toBe(true);
  });

  it("adopts the pinned remote commit under the config writer lock before checkpointing", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    const sourceCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const lockPath = path.join(openclawDir, "system_config.sync.lock");
    const convergeRemoteCommit = vi.fn(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return { outcome: "adopted" as const, adoptedCommit: sourceCommit };
    });
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      if (args === "push origin main") return "";
      if (args === "rev-parse HEAD") return targetCommit;
      return null;
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      expectedRemoteCommit: sourceCommit,
      convergeRemoteCommit,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(convergeRemoteCommit).toHaveBeenCalledWith(expect.objectContaining({
      slug: "acme",
      expectedCommit: sourceCommit,
      repoDir,
      configPath,
    }));
    expect(result).toMatchObject({ pushed: true, acceptedCommit: targetCommit });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps the default text git executor out of exact remote blob recovery", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    const sourceCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const convergeRemoteCommit = vi.fn((options) => {
      expect(options.gitExec).toBeUndefined();
      return { outcome: "adopted" as const, adoptedCommit: sourceCommit };
    });
    vi.mocked(gitExec).mockImplementation((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      if (args === "push origin main") return "";
      if (args === "rev-parse HEAD") return targetCommit;
      return null;
    });

    expect(syncSystemConfigForSlug("acme", {
      openclawDir,
      expectedRemoteCommit: sourceCommit,
      convergeRemoteCommit,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
    })).toMatchObject({ pushed: true, acceptedCommit: targetCommit });
  });

  it("fails the checkpoint without pushing when pinned remote adoption is unavailable", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { version: 1 });
    const git = vi.fn();

    expect(syncSystemConfigForSlug("acme", {
      openclawDir,
      expectedRemoteCommit: "a".repeat(40),
      convergeRemoteCommit: () => ({
        outcome: "unavailable",
        errorCode: "remote-commit-mismatch",
      }),
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    })).toMatchObject({
      committed: false,
      pushed: false,
      pending: true,
      errorCode: "remote-commit-mismatch",
    });
    expect(git).not.toHaveBeenCalled();
  });

  it("attributes a target normalization commit to the exact source checkpoint", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { version: 1 });
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    const sourceCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const commands: string[] = [];
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const command = argsArgv.join(" ");
      commands.push(command);
      if (command === "status --porcelain -- openclaw.json .octogee.json .gitignore") {
        return " M openclaw.json";
      }
      if (command === "rev-parse HEAD") return targetCommit;
      return "";
    });

    expect(syncSystemConfigForSlug("acme", {
      openclawDir,
      expectedRemoteCommit: sourceCommit,
      source: "migration-checkpoint",
      convergeRemoteCommit: () => ({
        outcome: "adopted",
        adoptedCommit: sourceCommit,
      }),
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    })).toMatchObject({ pushed: true, acceptedCommit: targetCommit });
    const commit = commands.find((command) => command.startsWith("commit "));
    expect(commit).toContain("Octogee-Config-Source: migration-checkpoint");
    expect(commit).toContain(`Octogee-Migration-Source: ${sourceCommit}`);
  });

  it("syncs through a leftover roll-era freeze marker — the freeze plane is retired", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(openclawDir, "system_config.freeze.json"), JSON.stringify({
      migrationId: "migration-1",
      slug: "acme",
      directoryMode: 0o700,
      configMode: 0o600,
    }));
    const git = vi.fn((_cwd: string, argv: string[]) =>
      argv.join(" ") === "status --porcelain -- openclaw.json .octogee.json .gitignore" ? "" : "ok"
    );

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ pushed: true, pending: false });
    expect(git).toHaveBeenCalled();
  });

  it("reclaims a stale incomplete config-sync lock after a crashed writer", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { version: 1 });
    const lockPath = path.join(openclawDir, "system_config.sync.lock");
    fs.writeFileSync(lockPath, "");
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    const git = vi.fn((_cwd: string, argv: string[]) =>
      argv.join(" ") === "status --porcelain -- openclaw.json .octogee.json .gitignore" ? "" : "ok"
    );

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ pushed: true, pending: false });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects and restores a config that fails validation before staging", () => {
    fs.writeFileSync(path.join(repoDir, "openclaw.json"), "{ invalid", "utf-8");
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "show HEAD:openclaw.json") return "{\"accepted\":true}\n";
      return "unexpected";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      now: () => new Date("2026-07-14T17:00:00.000Z"),
      validateConfig: () => {
        throw new Error("config invalid");
      },
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
      readCommitBlob: () => Buffer.from("{\"accepted\":true}\n"),
    });

    expect(result).toMatchObject({
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: "validation-failed",
    });
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8")).toBe(
      "{\"accepted\":true}\n",
    );
    const rejected = path.join(
      openclawDir,
      "rejected_config",
      "openclaw.2026-07-14T17-00-00-000Z.json",
    );
    expect(fs.readFileSync(rejected, "utf-8")).toBe("{ invalid");
    expect(fs.statSync(rejected).mode & 0o777).toBe(0o600);
    expect(git).not.toHaveBeenCalledWith(repoDir, ["add", "openclaw.json", ".octogee.json", ".gitignore"], "/tmp/key");
  });

  it("restores rejected config from Git bytes without newline-only follow-up churn", () => {
    fs.rmSync(path.join(repoDir, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init", "-q", repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Octogee Test"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@octogee.invalid"]);
    const configPath = path.join(repoDir, "openclaw.json");
    const acceptedBytes = Buffer.from("{\"accepted\":true}\n");
    fs.writeFileSync(configPath, acceptedBytes);
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
    execFileSync("git", ["-C", repoDir, "add", "openclaw.json", ".octogee.json", ".gitignore"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "accepted"]);
    const head = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(configPath, "{ invalid");
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") {
        return execFileSync("git", ["-C", repoDir, "status", "--porcelain", "--", "openclaw.json"], {
          encoding: "utf8",
        }).trim();
      }
      if (args === "rev-parse HEAD") return head;
      if (args === "rev-parse HEAD^{tree}" || args === "write-tree") return tree;
      if (args === "ls-remote origin refs/heads/main") return `${head}\trefs/heads/main`;
      if (args === "push origin main") return "ok";
      return null;
    });

    const rejected = syncSystemConfigForSlug("acme", {
      openclawDir,
      now: () => new Date("2026-07-14T17:00:00.000Z"),
      validateConfig: () => {
        throw new Error("config invalid");
      },
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
      readCommitBlob: readSystemConfigCommitBlob,
    });

    expect(rejected).toMatchObject({ rejected: true, errorCode: "validation-failed" });
    expect(fs.readFileSync(configPath)).toEqual(acceptedBytes);
    expect(auditSystemConfigForSlug("acme", {
      openclawDir,
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    })).toMatchObject({ state: "clean", needsSync: false, worktreeDirty: false });
    const followUp = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });
    expect(followUp).toMatchObject({ committed: false, pushed: true });
    expect(git.mock.calls.map(([, argv]) => argv.join(" ")).filter((args) =>
      args.startsWith("add ") || args.startsWith("commit ")
    )).toEqual([]);
  });

  it("preserves a newer edit when validation rejects the preceding candidate", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    const candidate = '{"candidate":"invalid"}\n';
    const newer = '{"candidate":"newer-valid"}\n';
    fs.writeFileSync(configPath, candidate, "utf-8");
    const candidateFingerprint = systemConfigFingerprint(configPath);
    const git = vi.fn((_cwd: string, argsArgv: string[]) => {
      const args = argsArgv.join(" ");
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "show HEAD:openclaw.json") return '{"accepted":true}\n';
      return "unexpected";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      now: () => new Date("2026-07-14T18:00:00.000Z"),
      validateConfig: () => {
        fs.writeFileSync(configPath, newer, "utf-8");
        throw new Error("candidate invalid");
      },
      log: () => {},
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({
      committed: false,
      pushed: false,
      rejected: true,
      pending: true,
      errorCode: "validation-failed",
      processedFingerprint: candidateFingerprint,
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe(newer);
    const rejected = path.join(
      openclawDir,
      "rejected_config",
      "openclaw.2026-07-14T18-00-00-000Z.json",
    );
    expect(fs.readFileSync(rejected, "utf-8")).toBe(candidate);
    expect(git).not.toHaveBeenCalledWith(repoDir, ["show", "HEAD:openclaw.json"], "/tmp/key");
  });
});


describe("Isolated prelaunch config", () => {
  it.each([false, true])("boots only the gateway-local agent and preserves accepted config (already detached=%s)", async detached => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-prelaunch-config-"));
    const repo = path.join(root, "system_config");
    fs.mkdirSync(repo);
    const env = withUserClaim({ OPENCLAW_DIR: root, GATEWAY_CLASS: "isolated", API_PUBLIC_URL: "https://api.example.test" }, "alice");
    const config = { agents: { entries: { "octogee-alice-coach": { workspace: path.join(root, "customers/alice"), model: "custom/model" } } },
      channels: { mattermost: { enabled: true, baseUrl: "${MM_URL}", accounts: { "alice-coach": {} } } },
      bindings: [{ agentId: "octogee-alice-coach" }], cron: { enabled: true },
      meta: { lastTouchedVersion: "2026.11.1", migrations: { modelPolicyAllowlist: true } } };
    writeJson(path.join(repo, "openclaw.json"), config);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["add", "openclaw.json"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo });
    if (detached) writeJson(path.join(repo, "openclaw.json"), { ...config, agents: { entries: {} }, bindings: [] });
    const nativeWrite = vi.fn(async (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args.slice(0, 2)).toEqual(["config", "patch"]);
      expect(args).toContain("--allow-size-drop");
      expect(options.env.OPENCLAW_CONFIG_PATH).toBe(path.join(repo, "openclaw.json"));
      expect(options.env.OPENCLAW_STATE_DIR).toBe(root);
      const patchFile = args[args.indexOf("--file") + 1];
      const fd = fs.openSync(patchFile, "r");
      let patch;
      try {
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
        patch = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally { fs.closeSync(fd); }
      expect(patch).not.toHaveProperty("meta");
      expect(args).not.toContain("meta");
      if (nativeWrite.mock.calls.length === 1) expect(patch.agents.entries["octogee-alice-coach"]).toBeNull();
      for (const id of Object.keys(patch.agents.entries)) if (patch.agents.entries[id] === null) delete patch.agents.entries[id];
      writeJson(path.join(repo, "openclaw.json"), { ...patch, meta: config.meta });
      return { code: 0, stdout: "" };
    });
    try {
      const before = fs.readFileSync(path.join(repo, "openclaw.json"), "utf8");
      await expect(prepareIsolatedPrelaunchConfig(root, "alice", env, async () => ({ code: 1, stdout: "" }))).rejects.toThrow("Native isolated prelaunch config write failed");
      await expect(prepareIsolatedPrelaunchConfig(root, "alice", env, async () => ({ code: 1, stdout: "", stderr: "Gateway holder namespace is unknown; password=example-secret" })))
        .rejects.toThrow("Gateway holder namespace is unknown; password=[redacted]");
      expect(fs.readFileSync(path.join(repo, "openclaw.json"), "utf8")).toBe(before);
      await prepareIsolatedPrelaunchConfig(root, "alice", env, nativeWrite);
      const live = JSON.parse(fs.readFileSync(path.join(repo, "openclaw.json"), "utf8"));
      expect(Object.keys(live.agents.entries)).toEqual(["octogee-unmatched-route"]);
      expect(live.channels.mattermost.enabled).toBe(false);
      expect(live.bindings).toEqual([]);
      expect(live.cron.enabled).toBe(false);
      expect(live.database).toMatchObject({ engine: "postgres", postgres: { connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" } } });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      const sync = vi.fn();
      await disableSystemConfigWatch(root, "alice");
      expect(checkpointDurableSystemConfigForSlug("alice", { openclawDir: root, gitExec: () => `${head}\trefs/heads/main` }, sync)).toMatchObject({ acceptedCommit: head, committed: false });
      expect(sync).not.toHaveBeenCalled();
      const accepted = readAcceptedUserConfig(root, env);
      expect(accepted.agents).toMatchObject({ entries: config.agents.entries });
      expect(accepted.cron).toEqual({ enabled: true });
      expect(accepted.channels).toMatchObject({ mattermost: { enabled: true } });
      await prepareIsolatedPrelaunchConfig(root, "alice", env, nativeWrite);
      expect(readAcceptedUserConfig(root, env).agents).toMatchObject({ entries: config.agents.entries });
      expect(nativeWrite).toHaveBeenCalledTimes(2);
      writeJson(path.join(repo, "openclaw.json"), { ...config, database: { engine: "sqlite" } });
      execFileSync("git", ["add", "openclaw.json"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "retained sqlite"], { cwd: repo });
      await expect(prepareIsolatedPrelaunchConfig(root, "alice", env, nativeWrite)).rejects.toThrow("Retained SQLite-configured Gateway stores cannot start");
      expect(nativeWrite).toHaveBeenCalledTimes(2);
      expect(fs.readdirSync(root).filter(name => name.startsWith(".prelaunch-config-"))).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
