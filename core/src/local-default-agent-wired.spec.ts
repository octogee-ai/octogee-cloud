import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const lstatHook = vi.hoisted(() => ({ beforeLstat: null as ((target: string) => void) | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      lstatHook.beforeLstat?.(String(target));
      return actual.lstatSync(target, options);
    }) as typeof actual.lstatSync,
  };
});

import {
  _resetMigratingInProcessPinsForTests,
  defaultAgentWiredInParsedConfig,
  userDefaultAgentWiredInOpenclawConfig,
  hasMountedMarker,
  clearMountedMarker,
  assertConfiguredUserPortableStatePlanOnDisk,
  configuredUserPortableStatePlan,
  configuredUserPortableStatePlanFromConfig,
  configuredUserStatePlanAllowsEntry,
  configuredSafeAgentIdsFromConfig,
  isMigratingInPinned,
  listLocalDefaultAgentWiredSlugs,
  listLocalUserDirs,
  listMigratingInSlugs,
  readOpenclawConfig,
  writeMigratingInPin,
  writeMountedMarker,
} from "./local-default-agent-wired.js";

const tmp: string[] = [];
function writeConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-"));
  tmp.push(dir);
  const p = path.join(dir, "openclaw.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
function wiredConfig(slugs: string[]) {
  return {
    agents: { list: slugs.map((s) => ({ id: `octogee-${s}-coach` })) },
    channels: { mattermost: { accounts: Object.fromEntries(slugs.map((s) => [`${s}-coach`, {}])) } },
    bindings: slugs.map((s) => ({
      agentId: `octogee-${s}-coach`,
      match: { channel: "mattermost", accountId: `${s}-coach`, peer: { kind: "group", id: `ch-${s}` } },
    })),
  };
}
afterEach(() => _resetMigratingInProcessPinsForTests());
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("userDefaultAgentWiredInOpenclawConfig", () => {
  it("true when the agent agent + MM account + binding are all present", () => {
    expect(userDefaultAgentWiredInOpenclawConfig(writeConfig(wiredConfig(["alice"])), "alice")).toBe(true);
  });

  it("recognizes a beta keyed agent entry after Doctor migrates agents.list", () => {
    const config = wiredConfig(["alice"]);
    config.agents = {
      list: [],
      entries: { "octogee-alice-coach": {} },
    } as typeof config.agents;
    expect(userDefaultAgentWiredInOpenclawConfig(writeConfig(config), "alice")).toBe(true);
  });

  it("false when the binding is missing", () => {
    const c = wiredConfig(["alice"]);
    c.bindings = [];
    expect(userDefaultAgentWiredInOpenclawConfig(writeConfig(c), "alice")).toBe(false);
  });

  it("false when the Mattermost account is missing", () => {
    const c = wiredConfig(["alice"]);
    c.channels.mattermost.accounts = {};
    expect(userDefaultAgentWiredInOpenclawConfig(writeConfig(c), "alice")).toBe(false);
  });

  it("false when the agent agent is missing from agents.list", () => {
    const c = wiredConfig(["alice"]);
    c.agents.list = [];
    expect(userDefaultAgentWiredInOpenclawConfig(writeConfig(c), "alice")).toBe(false);
  });

  it("false when the config is unreadable / missing (no throw)", () => {
    expect(userDefaultAgentWiredInOpenclawConfig("/no/such/openclaw.json", "alice")).toBe(false);
  });
});

describe("readOpenclawConfig", () => {
  it("parses a present config", () => {
    expect(readOpenclawConfig(writeConfig(wiredConfig(["alice"])))).toMatchObject({ agents: { list: [{ id: "octogee-alice-coach" }] } });
  });

  it("returns null when the config is missing / unparseable (no throw)", () => {
    expect(readOpenclawConfig("/no/such/openclaw.json")).toBeNull();
  });
});

describe("configuredSafeAgentIdsFromConfig", () => {
  it("returns only safe configured agent IDs from list and keyed entries", () => {
    expect(configuredSafeAgentIdsFromConfig({
      agents: {
        list: [
          { id: "discord-helper" },
          { id: "octogee-alice-coach" },
          { id: "../outside" },
          { id: "" },
        ],
        entries: {
          "discord-helper": {},
          "project.bot": {},
          "../outside": {},
        },
      },
    })).toEqual(["discord-helper", "octogee-alice-coach", "project.bot"]);
  });
});

describe("configuredUserPortableStatePlanFromConfig", () => {
  const stateDir = "/home/node/.openclaw";

  it("includes default workspaces, explicit in-root paths, and per-agent session stores", () => {
    const plan = configuredUserPortableStatePlanFromConfig({
      agents: {
        list: [
          { id: "discord-helper" },
          {
            id: "operator",
            default: true,
            agentDir: `${stateDir}/agents/operator/runtime`,
            workspace: `${stateDir}/workspaces/operator`,
          },
        ],
      },
      session: { store: `${stateDir}/agents/{agentId}/sessions/sessions.json` },
    }, stateDir);

    expect(plan.agentIds).toEqual(["discord-helper", "operator"]);
    expect(plan.agentDirs).toEqual([
      "agents/discord-helper/agent",
      "agents/operator/runtime",
    ]);
    expect(plan.sessionStorePaths).toEqual([
      "agents/discord-helper/sessions/sessions.json",
      "agents/operator/sessions/sessions.json",
    ]);
    expect(plan.paths).toEqual(expect.arrayContaining([
      { relativePath: "agents/discord-helper", kind: "directory" },
      { relativePath: "agents/operator", kind: "directory" },
      { relativePath: "workspace-discord-helper", kind: "directory" },
      { relativePath: "workspaces/operator", kind: "directory" },
      { relativePath: "memory/discord-helper.sqlite", kind: "file" },
      { relativePath: "memory/operator.sqlite", kind: "file" },
    ]));
    expect(configuredUserStatePlanAllowsEntry("workspace-discord-helper/MEMORY.md", plan)).toBe(true);
    expect(configuredUserStatePlanAllowsEntry("agents/discord-helper/sessions/", plan)).toBe(true);
    expect(configuredUserStatePlanAllowsEntry("outside/secret", plan)).toBe(false);
  });

  it("uses the upstream default workspace for the configured default agent", () => {
    const plan = configuredUserPortableStatePlanFromConfig({
      agents: { list: [{ id: "main", default: true }] },
    }, stateDir);

    expect(plan.paths).toContainEqual({ relativePath: "workspace", kind: "directory" });
    expect(plan.sessionStorePaths).toEqual(["agents/main/sessions/sessions.json"]);
  });

  it("carries OpenClaw's implicit main agent for a missing or empty roster (load-time materialization)", () => {
    const implicit = configuredUserPortableStatePlanFromConfig({}, stateDir);
    const declaredEmpty = configuredUserPortableStatePlanFromConfig({
      agents: { list: [] },
    }, stateDir);
    const emptyEntries = configuredUserPortableStatePlanFromConfig({
      agents: { entries: {} },
    }, stateDir);

    expect(implicit.agentIds).toEqual(["main"]);
    expect(implicit.paths).toContainEqual({ relativePath: "workspace", kind: "directory" });
    expect(declaredEmpty.agentIds).toEqual(["main"]);
    expect(emptyEntries.agentIds).toEqual(["main"]);
  });

  it("carries explicit workspaces when a main agent and project agent have no default marker", () => {
    const plan = configuredUserPortableStatePlanFromConfig({
      agents: {
        defaults: { workspace: `${stateDir}/workspace` },
        entries: {
          main: { workspace: `${stateDir}/workspace` },
          "octogee-aug292-proj-oglist-coach": { workspace: `${stateDir}/customers/aug292/projects/oglist` },
        },
      },
    }, stateDir);
    expect(plan.agentIds).toEqual(["main", "octogee-aug292-proj-oglist-coach"]);
    expect(plan.paths).toContainEqual({ relativePath: "workspace", kind: "directory" });
    expect(plan.paths).toContainEqual({ relativePath: "customers/aug292/projects/oglist", kind: "directory" });
  });

  it("accepts the shipped user seed (empty roster + agents.defaults.workspace)", () => {
    const seed = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "../../gateway/openclaw.isolated.template.json"),
      "utf8",
    )) as Parameters<typeof configuredUserPortableStatePlanFromConfig>[0];

    const plan = configuredUserPortableStatePlanFromConfig(seed, stateDir);

    expect(plan.agentIds).toEqual(["main"]);
    expect(plan.paths).toContainEqual({ relativePath: "workspace", kind: "directory" });
  });

  it("accepts the platform-managed agent and project-agent workspaces under customers/<slug>", () => {
    const plan = configuredUserPortableStatePlanFromConfig({
      agents: {
        list: [
          { id: "octogee-ceckert-coach", default: true, workspace: `${stateDir}/customers/ceckert` },
          { id: "octogee-ceckert-proj-site-coach", workspace: `${stateDir}/customers/ceckert/projects/site` },
        ],
      },
    }, stateDir);

    expect(plan.paths).toContainEqual({ relativePath: "customers/ceckert", kind: "directory" });
    expect(configuredUserStatePlanAllowsEntry("customers/ceckert/projects/site/README.md", plan)).toBe(true);
    expect(() => configuredUserPortableStatePlanFromConfig({
      agents: { list: [{ id: "octogee-ceckert-coach", workspace: `${stateDir}/customers/other` }] },
    }, stateDir)).toThrow(/canonical workspace root/);
  });

  it.each(["list", "entries"])("reads the exact private project workspace from a configured user %s roster", (shape) => {
    const id = "octogee-ceckert-proj-site-coach";
    const relativePath = "customers/ceckert/.system/project-coaches/site";
    const agent = { workspace: `${stateDir}/${relativePath}`, agentDir: `${stateDir}/agents/${id}/agent` };
    const configPath = writeConfig({ agents: shape === "list" ? { list: [{ id, ...agent }] } : { entries: { [id]: agent } } });

    const plan = configuredUserPortableStatePlan(configPath, stateDir);

    expect(plan.agentIds).toEqual([id]);
    expect(plan.agentDirs).toEqual([`agents/${id}/agent`]);
    expect(plan.sessionStorePaths).toEqual([`agents/${id}/sessions/sessions.json`]);
    expect(plan.paths).toContainEqual({ relativePath, kind: "directory" });
    expect(configuredUserStatePlanAllowsEntry(`${relativePath}/IDENTITY.md`, plan)).toBe(true);
    expect(configuredUserStatePlanAllowsEntry("customers/ceckert/.system/project-coaches/other/IDENTITY.md", plan)).toBe(false);
  });

  it.each([
    "customers/other/.system/project-coaches/site",
    "customers/ceckert/.system/project-coaches/other",
    "customers/ceckert/.system/project-coaches",
    "customers/ceckert/.system/project-coaches/site/nested",
    "customers/ceckert/.system/other/site",
    "customers/ceckert/.system/project-coaches/site/../other",
  ])("refuses private project workspace outside the exact owner and project: %s", (workspace) => {
    expect(() => configuredUserPortableStatePlan(writeConfig({ agents: { entries: {
      "octogee-ceckert-proj-site-coach": { workspace: `${stateDir}/${workspace}` },
    } } }), stateDir)).toThrow();
  });

  it.each(["octogee-ceckert-coach", "custom-agent"])("does not grant %s a private project workspace", (id) => {
    expect(() => configuredUserPortableStatePlan(writeConfig({ agents: { entries: {
      [id]: { workspace: `${stateDir}/customers/ceckert/.system/project-coaches/site` },
    } } }), stateDir)).toThrow(/canonical workspace root/);
  });

  it("uses keyed entries as the active roster when a stale list is also present", () => {
    const plan = configuredUserPortableStatePlanFromConfig({
      agents: {
        list: [
          { id: "stale-coach" },
          { id: "discord-helper", workspace: "/tmp/not-the-active-config" },
        ],
        entries: {
          "discord-helper": {
            agentDir: `${stateDir}/agents/discord-helper/runtime`,
            workspace: `${stateDir}/workspaces/discord-helper`,
          },
        },
      },
      session: { store: `${stateDir}/agents/{agentId}/sessions/sessions.json` },
    }, stateDir);

    expect(plan.agentIds).toEqual(["discord-helper"]);
    expect(plan.paths).toEqual(expect.arrayContaining([
      { relativePath: "agents/discord-helper", kind: "directory" },
      { relativePath: "workspaces/discord-helper", kind: "directory" },
    ]));
    expect(plan.paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "agents/stale-coach" }),
    ]));
  });

  it.each([
    { agents: { list: [{ id: "discord-helper", workspace: "relative/workspace" }] } },
    { agents: { list: [{ id: "discord-helper", agentDir: "~/agent" }] } },
    { agents: { list: [{ id: "discord-helper", workspace: "/tmp/outside" }] } },
    { agents: { list: [{ id: "discord-helper", agentDir: `${stateDir}/secrets/discord-helper` }] } },
    { agents: { list: [{ id: "discord-helper", workspace: `${stateDir}/custom/discord-helper` }] } },
    { agents: { list: [{ id: "discord-helper" }] }, session: { store: `${stateDir}/sessions.json` } },
    { agents: { list: [{ id: "discord-helper" }] }, session: { store: `${stateDir}/sessions/{unknown}.json` } },
    { agents: { list: [{ id: "Discord.Helper" }] } },
  ])("rejects a nonportable user path %#", (config) => {
    expect(() => configuredUserPortableStatePlanFromConfig(config, stateDir)).toThrow(
      /portable user state path|outside the user OpenClaw state root|absolute \{agentId\}|canonical/,
    );
  });
});

describe("assertConfiguredUserPortableStatePlanOnDisk", () => {
  function seededStateDir(): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-state-"));
    tmp.push(stateDir);
    fs.mkdirSync(path.join(stateDir, "customers/ceckert/workspace/node_modules/.bin"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents/octogee-ceckert-coach/agent"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents/octogee-ceckert-coach/sessions"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "memory/octogee-ceckert-coach.sqlite"), "");
    fs.writeFileSync(path.join(stateDir, "agents/octogee-ceckert-coach/sessions/sessions.json"), "{}");
    return stateDir;
  }
  const plan = configuredUserPortableStatePlanFromConfig({
    agents: { list: [{ id: "octogee-ceckert-coach", default: true, workspace: "/home/node/.openclaw/customers/ceckert" }] },
  }, "/home/node/.openclaw");

  it("tolerates symlinks inside user content (npm .bin shims, cloned repos)", () => {
    const stateDir = seededStateDir();
    fs.writeFileSync(path.join(stateDir, "customers/ceckert/workspace/node_modules/tsc.js"), "");
    fs.symlinkSync("../tsc.js", path.join(stateDir, "customers/ceckert/workspace/node_modules/.bin/tsc"));
    fs.symlinkSync("/nonexistent/target", path.join(stateDir, "customers/ceckert/workspace/dangling"));

    expect(() => assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan)).not.toThrow();
  });

  it("still rejects a plan directory that is a file and a plan file that is a directory", () => {
    const stateDir = seededStateDir();
    fs.rmSync(path.join(stateDir, "memory/octogee-ceckert-coach.sqlite"));
    fs.mkdirSync(path.join(stateDir, "memory/octogee-ceckert-coach.sqlite"));

    expect(() => assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan)).toThrow(/is not a file/);
  });

  describe("an entry removed between listing its directory and reading it", () => {
    afterEach(() => { lstatHook.beforeLstat = null; });

    function removeBeforeLstat(stateDir: string, relativePath: string): void {
      const absolutePath = path.join(stateDir, relativePath);
      fs.writeFileSync(absolutePath, "");
      lstatHook.beforeLstat = (target) => {
        if (target === absolutePath) fs.rmSync(absolutePath, { force: true });
      };
    }

    it.each([
      "agents/octogee-ceckert-coach/agent/openclaw-agent.sqlite.plugin-model-catalog.lock",
      "agents/octogee-ceckert-coach/agent/openclaw-agent.sqlite-journal",
      "agents/octogee-ceckert-coach/agent/openclaw-agent.sqlite.tmp-0f8fad5b-d9cb-469f-a165-70867728950e",
    ])("passes when the removed entry is a lock or SQLite volatile file: %s", (relativePath) => {
      const stateDir = seededStateDir();
      removeBeforeLstat(stateDir, relativePath);

      expect(() => assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan)).not.toThrow();
    });

    it.each([
      "agents/octogee-ceckert-coach/agent/models.json",
      "agents/octogee-ceckert-coach/sessions/session-1.jsonl",
      "customers/ceckert/workspace/notes.md",
    ])("still fails when the removed entry is user data: %s", (relativePath) => {
      const stateDir = seededStateDir();
      removeBeforeLstat(stateDir, relativePath);

      expect(() => assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan)).toThrow(/ENOENT/);
    });
  });
});

describe("defaultAgentWiredInParsedConfig (pure — config parsed once, checked per slug)", () => {
  it("true for a wired slug, false for an absent one — same parsed config", () => {
    const config = wiredConfig(["alice", "bob"]);
    expect(defaultAgentWiredInParsedConfig(config, "alice")).toBe(true);
    expect(defaultAgentWiredInParsedConfig(config, "bob")).toBe(true);
    expect(defaultAgentWiredInParsedConfig(config, "carol")).toBe(false);
  });

  it("false when any of the three wiring parts is missing", () => {
    const noBinding = wiredConfig(["alice"]);
    noBinding.bindings = [];
    expect(defaultAgentWiredInParsedConfig(noBinding, "alice")).toBe(false);
  });

  it("false when the binding is not pinned to the slug's Mattermost account", () => {
    const wrongAccount = wiredConfig(["alice"]);
    wrongAccount.bindings = [
      {
        agentId: "octogee-alice-coach",
        match: { channel: "mattermost", accountId: "bob-coach", peer: { kind: "group", id: "ch-alice" } },
      },
    ];
    expect(defaultAgentWiredInParsedConfig(wrongAccount, "alice")).toBe(false);
  });
});

describe("listLocalDefaultAgentWiredSlugs", () => {
  it("returns default-agent-wired user dirs sorted, excluding non-wired and non-dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cust-"));
    tmp.push(root);
    for (const s of ["bob", "alice", "carol"]) fs.mkdirSync(path.join(root, s));
    fs.mkdirSync(path.join(root, "BadSlug"));
    fs.mkdirSync(path.join(root, "__proto__"));
    fs.writeFileSync(path.join(root, "not-a-dir"), "x");
    const wired = new Set(["alice", "BadSlug", "__proto__", "carol"]);
    expect(listLocalDefaultAgentWiredSlugs(root, (s) => wired.has(s))).toEqual(["alice", "carol"]);
  });

  it("returns [] when the users dir does not exist", () => {
    expect(listLocalDefaultAgentWiredSlugs("/no/such/dir-xyz", () => true)).toEqual([]);
  });
});

describe("listLocalUserDirs (raw on-disk dirs — the evict-observed set)", () => {
  it("returns every safe-slug dir sorted, ignoring default-agent-wiring (so partial dirs are seen)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dirs-"));
    tmp.push(root);
    for (const s of ["bob", "alice", "partial"]) fs.mkdirSync(path.join(root, s));
    fs.mkdirSync(path.join(root, "BadSlug"));
    fs.writeFileSync(path.join(root, "not-a-dir"), "x");
    expect(listLocalUserDirs(root)).toEqual(["alice", "bob", "partial"]);
  });

  it("returns [] when the users dir does not exist", () => {
    expect(listLocalUserDirs("/no/such/dir-xyz")).toEqual([]);
  });

  it("includes valid 2-char slugs (the username contract is 2..24, not 3+)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dirs2-"));
    tmp.push(root);
    for (const s of ["jo", "x9", "ab"]) fs.mkdirSync(path.join(root, s));
    fs.mkdirSync(path.join(root, "a")); // 1 char — below the 2-char minimum
    fs.mkdirSync(path.join(root, "-bad")); // leading hyphen — rejected by USERNAME_RE
    expect(listLocalUserDirs(root)).toEqual(["ab", "jo", "x9"]);
    // ...and default-agent-wired observation sees them too (this is the regression: a 2-char user
    // was previously invisible → never mounted-reported, never evicted).
    expect(listLocalDefaultAgentWiredSlugs(root, () => true)).toEqual(["ab", "jo", "x9"]);
  });
});

describe("listMigratingInSlugs (the /health migrating-in signal for the fleet controller's poller)", () => {
  it("returns only on-disk slugs with a fresh pin, sorted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmig-"));
    tmp.push(root);
    for (const s of ["alice", "incoming", "stale"]) fs.mkdirSync(path.join(root, s));
    writeMigratingInPin(root, "incoming");
    writeMigratingInPin(root, "stale");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(root, "stale", ".system", ".migrating-in"), old, old);
    _resetMigratingInProcessPinsForTests();
    expect(listMigratingInSlugs(root, 5 * 60_000)).toEqual(["incoming"]);
  });

  it("reports a process pin even when restore replaces the user dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmig-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMigratingInPin(root, "incoming");
    fs.rmSync(path.join(root, "incoming"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "incoming"));

    expect(isMigratingInPinned(root, "incoming", 5 * 60_000)).toBe(true);
    expect(listMigratingInSlugs(root, 5 * 60_000)).toEqual(["incoming"]);
  });
});

describe("mounted marker (the post-config completion gate)", () => {
  it("hasMountedMarker is false until writeMountedMarker stamps it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "alice"));
    expect(hasMountedMarker(root, "alice")).toBe(false);
    writeMountedMarker(root, "alice");
    expect(hasMountedMarker(root, "alice")).toBe(true);
  });

  it("writeMountedMarker creates the .system dir if the slug dir is bare", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "bob"));
    writeMountedMarker(root, "bob");
    expect(hasMountedMarker(root, "bob")).toBe(true);
  });

  it("clearMountedMarker makes a completed mount observable as incomplete", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "alice"));
    writeMountedMarker(root, "alice");

    clearMountedMarker(root, "alice");

    expect(hasMountedMarker(root, "alice")).toBe(false);
  });

  it("stamps the marker under .system/ (gitignored — pod-local, never cloned back)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "carol"));
    writeMountedMarker(root, "carol");
    expect(fs.existsSync(path.join(root, "carol", ".system", ".mounted"))).toBe(true);
  });

  it("hasMountedMarker is false for an absent slug dir (no throw)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-"));
    tmp.push(root);
    expect(hasMountedMarker(root, "ghost")).toBe(false);
  });
});

describe("migrating-in pin (guards a freshly-imported user from the evict direction)", () => {
  it("isMigratingInPinned is false until writeMigratingInPin stamps it, then true within TTL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "alice"));
    expect(isMigratingInPinned(root, "alice", 60_000)).toBe(false);
    writeMigratingInPin(root, "alice");
    expect(isMigratingInPinned(root, "alice", 60_000)).toBe(true);
  });

  it("self-expires: a pin older than the TTL is ignored (failed-migration orphan becomes evictable)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "bob"));
    writeMigratingInPin(root, "bob");
    const stale = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(root, "bob", ".system", ".migrating-in"), stale, stale);
    _resetMigratingInProcessPinsForTests();
    expect(isMigratingInPinned(root, "bob", 5 * 60_000)).toBe(false);
  });

  it("isMigratingInPinned is false for an absent pin (no throw)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    expect(isMigratingInPinned(root, "ghost", 60_000)).toBe(false);
  });

  it("clears an inherited .mounted marker (a migration import must re-earn its own marker)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migp-"));
    tmp.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMountedMarker(root, "incoming"); // simulate the source's marker arriving in the tarball
    writeMigratingInPin(root, "incoming");
    expect(hasMountedMarker(root, "incoming")).toBe(false);
    expect(isMigratingInPinned(root, "incoming", 60_000)).toBe(true);
  });
});
