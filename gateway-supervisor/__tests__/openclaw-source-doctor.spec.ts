import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { repairSourceDoctorAgentStores, verifyPostgresSourceDoctorAgentStores } from "../lib/openclaw-source-doctor.js";
import { createOpenClawBootWatcher } from "../lib/openclaw-boot-watcher.js";
import { OpenClawCommandError, type OpenClawCommand } from "../lib/openclaw-cli.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(version = 25) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "source-doctor-stores-"))); roots.push(root);
  const agentIds = ["alice", "bob", "charlie", "delta", "echo", "foxtrot"].map((slug) => `octogee-${slug}-coach`);
  for (const agentId of agentIds) {
    const file = path.join(root, "agents", agentId, "agent/openclaw-agent.sqlite"); await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file); db.exec(`PRAGMA user_version=${version}; CREATE TABLE history(body TEXT); INSERT INTO history VALUES ('preserved')`); db.close();
  }
  const run = vi.fn<OpenClawCommand>(async (args, { env }) => {
    expect(env.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_READONLY).toBe("1");
    const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8"));
    expect(config.plugins).toEqual({ enabled: false });
    if (args[0] === "backup") {
      const agentId = args[args.indexOf("--agent") + 1]!;
      expect(config.agents.entries[agentId].agentDir).toBe(path.join(root, "agents", agentId, "agent"));
      const snapshotPath = path.join(args[args.indexOf("--repository") + 1]!, "snapshot");
      await fs.mkdir(snapshotPath);
      await fs.copyFile(path.join(root, "agents", agentId, "agent/openclaw-agent.sqlite"), path.join(snapshotPath, "database.sqlite"));
      return { code: 0, stdout: JSON.stringify({ ok: true, snapshotPath }) };
    }
    expect(args.slice(0, 2)).toEqual(["database", "preflight-agent"]);
    expect(args[2]).not.toContain(root);
    expect(config.agents?.entries?.[args[4]!]).toBeUndefined();
    const db = new DatabaseSync(args[2]!, { readOnly: true }); const foundVersion = db.prepare("PRAGMA user_version").get()?.user_version; db.close();
    return { code: foundVersion === 25 ? 0 : 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: args[4], databasePath: args[2], foundVersion, targetVersion: 25, status: foundVersion === 25 ? "exact" : "incompatible" }) };
  });
  return { root, agentIds, run, env: { OPENCLAW_STATE_DIR: root } };
}
async function postgresFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "source-doctor-pg-"))); roots.push(root);
  const ids = ["octogee-livefixture-coach", "octogee-livefixture-proj-launch-coach", "octogee-foreign-coach"];
  const expectedAnchors = ids.map((agentId, index) => ({ agentId, storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `agent_${index}` }));
  for (const anchor of expectedAnchors) {
    const file = path.join(root, "agents", anchor.agentId, "agent/openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(anchor.storeId, anchor.schema); db.close();
  }
  const metadata = new Map(expectedAnchors.map(anchor => [anchor.schema, { store_id: anchor.storeId, version: 31, role: "agent", agent_id: anchor.agentId, schema_version: 31, history: ["original turn"] }]));
  const selected = expectedAnchors.slice(0, 2), agentIds = selected.map(store => store.agentId);
  const assertCurrent = vi.fn(async () => {});
  const query = vi.fn(async (anchor: { schema: string }) => [metadata.get(anchor.schema)!]);
  const run = vi.fn<OpenClawCommand>(async (args, { env }) => {
    expect(env.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    if (args[0] === "database") return { code: 1, stdout: JSON.stringify({
      schema: "openclaw.agent-schema-preflight.v1", databasePath: args[2], agentId: args[4],
      targetVersion: 33, foundVersion: null, status: "indeterminate", requiresWrite: false,
    }) };
    expect(env.OPENCLAW_AGENT_STORE_DSN).toBe("postgresql://synthetic/private");
    const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8"));
    expect(config.database.engine).toBe("sqlite");
    if (config.agents.entries["octogee-source-doctor-bootstrap"]) {
      expect(args).toEqual(["setup", "--baseline", "--skip-bootstrap", "--json"]);
      expect(env.HOME).toBe(env.OPENCLAW_STATE_DIR);
      expect(config.database.families).toBeUndefined();
      return { code: 0, stdout: "" };
    }
    expect(args).toEqual(["doctor", "--fix", "--non-interactive"]);
    expect(config.database.families).toEqual({ agent: { engine: "postgres" } });
    expect(config.plugins).toEqual({ enabled: false });
    expect(config.agents.ownership).toBe("explicit");
    expect(Object.keys(config.agents.entries).sort()).toEqual(agentIds.toSorted());
    expect((await fs.readdir(path.join(env.OPENCLAW_STATE_DIR!, "agents"))).sort()).toEqual(agentIds.toSorted());
    for (const anchor of selected) { const row = metadata.get(anchor.schema)!; row.version = 33; row.schema_version = 33; }
    return { code: 0, stdout: "" };
  });
  await fs.writeFile(path.join(root, "openclaw.json"), JSON.stringify({ agents: { ownership: "explicit", entries: Object.fromEntries(ids.map(id => [id, { workspace: id }])) } }));
  const input = { env: { OPENCLAW_STATE_DIR: root, OPENCLAW_AGENT_STORE_DSN: "postgresql://synthetic/private", OPENCLAW_GATEWAY_TOKEN: "excluded" },
    run, query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore, assertCurrent, expectedAnchors: selected };
  return { root, expectedAnchors, metadata, agentIds, input, run, query, assertCurrent };
}

it("isolates PostgreSQL Doctor from original shared state and foreign agents, preserving anchor UUIDs and history", async () => {
  const f = await postgresFixture();
  const originals = await Promise.all(f.expectedAnchors.map(anchor => fs.readFile(path.join(f.root, "agents", anchor.agentId, "agent/openclaw-agent.sqlite"))));
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  expect(f.metadata.get("agent_2")).toMatchObject({ version: 31, schema_version: 31, history: ["original turn"] });
  for (let index = 0; index < f.expectedAnchors.length; index++) {
    expect(await fs.readFile(path.join(f.root, "agents", f.expectedAnchors[index]!.agentId, "agent/openclaw-agent.sqlite"))).toEqual(originals[index]);
    expect(f.metadata.get(f.expectedAnchors[index]!.schema)!.history).toEqual(["original turn"]);
  }
  expect(f.run.mock.calls.map(([args]) => args[0])).toEqual(["database", "setup", "doctor"]);
  expect(f.run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([180_000, undefined, 300_000]);
  expect(f.assertCurrent).toHaveBeenCalled();
  for (const [, { env }] of f.run.mock.calls) await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains Native-initialized config metadata while replacing the private bootstrap roster for PostgreSQL repair", async () => {
  const f = await postgresFixture(), original = f.run.getMockImplementation()!;
  const meta = { lastTouchedVersion: "2026.10.7", migrations: { modelPolicyAllowlist: true } };
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "database") return original(args, options);
    const configPath = options.env.OPENCLAW_CONFIG_PATH!;
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (config.agents.entries["octogee-source-doctor-bootstrap"]) {
      const result = await original(args, options);
      await fs.writeFile(configPath, JSON.stringify({ ...config, meta,
        agents: { ...config.agents, defaults: { workspace: "bootstrap-only" } } }));
      return result;
    }
    expect(config.meta).toEqual(meta);
    expect(config.gateway).toEqual({ mode: "local" });
    expect(config.agents.defaults).toBeUndefined();
    expect(config.agents.entries["octogee-source-doctor-bootstrap"]).toBeUndefined();
    expect(config.database.postgres).toEqual({ connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" }, schemaPrefix: "octogee" });
    for (const agentId of f.agentIds) expect(config.agents.entries[agentId].workspace).toBe(path.join(options.env.OPENCLAW_STATE_DIR!, "workspaces", agentId));
    return original(args, options);
  });
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  expect(f.run.mock.calls.map(([args]) => args[0])).toEqual(["database", "setup", "doctor"]);
});

it.each(["owner", "store", "version", "coherence", "duplicate", "anchor-roster", "newer", "sidecar", "claim", "descriptor", "doctor"])("refuses PostgreSQL source repair with %s mismatch", async change => {
  const f = await postgresFixture(), row = f.metadata.get("agent_0")!;
  if (change === "owner") row.agent_id = "octogee-foreign-coach";
  if (change === "store") row.store_id = "00000000-0000-4000-8000-999999999999";
  if (change === "version") row.version = 0;
  if (change === "coherence") row.schema_version = 30;
  if (change === "duplicate") f.query.mockImplementation(async () => [row, row]);
  if (change === "anchor-roster") f.input.expectedAnchors = f.expectedAnchors.slice(1);
  if (change === "newer") { row.version = 34; row.schema_version = 34; }
  if (change === "sidecar") await fs.writeFile(path.join(f.root, "agents", f.agentIds[0]!, "agent/openclaw-agent.sqlite-wal"), "pending");
  if (change === "claim") f.assertCurrent.mockRejectedValue(new Error("claim changed"));
  if (change === "descriptor") f.run.mockResolvedValue({ code: 0, stdout: "{}" });
  if (change === "doctor") { const original = f.run.getMockImplementation()!; f.run.mockImplementation(async (args, options) => args[0] === "doctor" ? { code: 1, stdout: "" } : original(args, options)); }
  await expect(repairSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow();
  expect(f.metadata.get("agent_2")!.version).toBe(31);
});

it("refuses a successful Doctor that did not advance PostgreSQL metadata to the installed Native version", async () => {
  const f = await postgresFixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => args[0] === "doctor" ? { code: 0, stdout: "" } : original(args, options));
  await expect(repairSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow("identity/version metadata mismatch");
});

it("verifies PostgreSQL metadata without treating SQLite schema descriptor as a PostgreSQL check", async () => {
  const f = await postgresFixture();
  await expect(verifyPostgresSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow("identity/version metadata mismatch");
  expect(f.run.mock.calls.map(([args]) => args[0])).toEqual(["database"]);
});


it("requires and upgrades only the fixed reserved service anchor referenced by the original source config", async () => {
  const f = await postgresFixture();
  const service = { agentId: "octogee-unmatched-route", storeId: "00000000-0000-4000-8000-000000000099", schema: "agent_service" };
  const file = path.join(f.root, "agents", service.agentId, "agent/openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(service.storeId, service.schema); db.close();
  await fs.writeFile(path.join(f.root, "openclaw.json"), JSON.stringify({ agents: { ownership: "explicit", entries: Object.fromEntries([...f.agentIds, service.agentId, "octogee-foreign-coach"].map(id => [id, { workspace: id }])) } }));
  f.metadata.set(service.schema, { store_id: service.storeId, version: 31, role: "agent", agent_id: service.agentId, schema_version: 31, history: ["service history"] });
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "database") return original(args, options);
    const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
    if (config.agents.entries["octogee-source-doctor-bootstrap"]) return { code: 0, stdout: "" };
    expect(Object.keys(config.agents.entries).sort()).toEqual([...f.agentIds, service.agentId].sort());
    for (const id of [...f.agentIds, service.agentId]) { const row = [...f.metadata.values()].find(row => row.agent_id === id)!; row.version = 33; row.schema_version = 33; }
    return { code: 0, stdout: "" };
  });
  const before = await fs.readFile(file);
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  expect(await fs.readFile(file)).toEqual(before);
  expect(f.metadata.get(service.schema)).toMatchObject({ version: 33, history: ["service history"] });
  expect(f.metadata.get("agent_2")!.version).toBe(31);
});

it("refuses a missing configured reserved service anchor before Native mutation", async () => {
  const f = await postgresFixture();
  await fs.writeFile(path.join(f.root, "openclaw.json"), JSON.stringify({ agents: { ownership: "explicit", entries: { "octogee-unmatched-route": {} } } }));
  await expect(repairSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});


it("filters only serving agent entries and bindings while retaining config, history, files, and private mode", async () => {
  const f = await postgresFixture(), configPath = path.join(f.root, "openclaw.json");
  const config = { gateway: { mode: "local", auth: { mode: "token", token: "retained" } }, channels: { retained: { enabled: true } },
    agents: { ownership: "explicit", defaults: { model: "retained/model" }, entries: { [f.agentIds[0]!]: { workspace: "owner" }, "octogee-foreign-coach": { workspace: "foreign" } } },
    bindings: [{ agentId: f.agentIds[0], match: { channel: "owner" } }, { agentId: "octogee-foreign-coach", match: { channel: "foreign" } }] };
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await fs.chmod(configPath, 0o600);
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  const after = JSON.parse(await fs.readFile(configPath, "utf8"));
  expect(after).toEqual({ ...config, agents: { ...config.agents, entries: { [f.agentIds[0]!]: config.agents.entries[f.agentIds[0]!] } }, bindings: [config.bindings[0]] });
  expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  expect(f.metadata.get("agent_2")!.version).toBe(31);
});

it("refuses serving config changes made while Doctor was running", async () => {
  const f = await postgresFixture(), original = f.run.getMockImplementation()!, configPath = path.join(f.root, "openclaw.json");
  f.run.mockImplementation(async (args, options) => {
    const result = await original(args, options);
    if (args[0] === "doctor") await fs.appendFile(configPath, "\n");
    return result;
  });
  await expect(repairSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow("serving config changed");
  const after = JSON.parse(await fs.readFile(configPath, "utf8"));
  expect(after.agents.entries["octogee-foreign-coach"]).toBeDefined();
});

it("accepts canonical PostgreSQL BIGINT strings and refuses unsafe numeric versions", async () => {
  const f = await postgresFixture();
  f.query.mockImplementation(async anchor => {
    const row = f.metadata.get(anchor.schema)!;
    return [{ ...row, version: String(row.version), schema_version: String(row.schema_version) }] as any;
  });
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  f.query.mockResolvedValue([{ ...f.metadata.get("agent_0")!, version: "9007199254740993", schema_version: "9007199254740993" }] as any);
  await expect(verifyPostgresSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow("identity/version metadata mismatch");
});


async function sqliteDriftFixture() {
  const f = await fixture(), legacy = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => args[0] === "doctor" ? { code: 0, stdout: "" } : legacy(args, options));
  const expectedAnchors = f.agentIds.map((agentId, index) => ({ agentId, storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `captured_agent_${index}` }));
  const configPath = path.join(f.root, "openclaw.json"), originalConfig = JSON.stringify({ agents: { ownership: "explicit", entries: {} }, retained: "unchanged" });
  await fs.writeFile(configPath, originalConfig, { mode: 0o600 });
  return { ...f, env: { ...f.env, OPENCLAW_AGENT_STORE_DSN: "postgresql://synthetic/private" }, expectedAnchors, configPath, originalConfig };
}

it.each([false, true])("refuses SQLite drift under captured PostgreSQL authority before Native effects (%s)", async emptyRoster => {
  const f = await sqliteDriftFixture();
  await expect(repairSourceDoctorAgentStores(f.agentIds, { env: f.env, run: f.run,
    expectedAnchors: emptyRoster ? [] : f.expectedAnchors, assertCurrent: async () => {} })).rejects.toThrow("requires a PostgreSQL anchor");
  expect(f.run).not.toHaveBeenCalled();
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.originalConfig);
});

it("cannot acknowledge captured PostgreSQL repair when every local anchor has drifted to SQLite", async () => {
  const f = await sqliteDriftFixture();
  const completeOpenClawDoctor = vi.fn(async () => {});
  const watcher = createOpenClawBootWatcher({ releaseKey: "pinned-native-build", log: () => {},
    client: { claimOpenClawBoot: async () => ({ action: "doctor", sourceDoctor: { requestId: "repair", agentIds: f.agentIds, postgresAgentStores: f.expectedAnchors } }),
      assertOpenClawDoctor: async () => {}, completeOpenClawDoctor, completeOpenClawBoot: async () => {} },
    repairSourceDoctor: (agentIds, options) => repairSourceDoctorAgentStores(agentIds, { ...options, env: f.env, run: f.run }),
  });
  await expect(watcher.beforeStart()).rejects.toThrow("requires a PostgreSQL anchor");
  expect(f.run).not.toHaveBeenCalled(); expect(completeOpenClawDoctor).not.toHaveBeenCalled();
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.originalConfig);
});

it("refuses legacy SQLite stores even without captured PostgreSQL authority", async () => {
  const f = await sqliteDriftFixture();
  await expect(repairSourceDoctorAgentStores(f.agentIds, { env: f.env, run: f.run, assertCurrent: async () => {} })).rejects.toThrow("PostgreSQL anchor");
  expect(f.run).not.toHaveBeenCalled();
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.originalConfig);
});

async function mattermostSourceFixture() {
  const f = await postgresFixture();
  const stale = ["octogee-ceckert-test-coach", "octogee-ceckert-test-proj-hedgeherd-coach", "octogee-ceckert-test-proj-moonlitruins-coach"];
  const pairs = [[f.agentIds[0]!, "livefixture-coach"], [f.agentIds[1]!, "livefixture-proj-launch"],
    [stale[0]!, "ceckert-test-coach"], [stale[1]!, "ceckert-test-proj-hedgeherd"], [stale[2]!, "ceckert-test-proj-moonlitruins"]];
  const config = { agents: { ownership: "explicit", entries: Object.fromEntries([...f.agentIds, ...stale].map(id => [id, { workspace: id }])) },
    channels: { mattermost: { enabled: true, defaultAccount: "ceckert-test-coach", streaming: { mode: "block" },
      accounts: Object.fromEntries(pairs.map(([, accountId]) => [accountId!, { enabled: true, botToken: { source: "file", provider: "octogee-mattermost", id: "/" + accountId }, baseUrl: "retained-url" }])) } },
    bindings: pairs.map(([agentId, accountId]) => ({ agentId, match: { channel: "mattermost", accountId } })) };
  const configPath = path.join(f.root, "openclaw.json"); await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return { ...f, stale, pairs, config, configPath };
}

it("disables stale user and project Mattermost accounts while preserving authoritative channels and selectors", async () => {
  const f = await mattermostSourceFixture();
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  const after = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  for (const [agentId, accountId] of f.pairs) {
    const before = f.config.channels.mattermost.accounts[accountId!]!;
    expect(after.channels.mattermost.accounts[accountId!]).toEqual(f.agentIds.includes(agentId!) ? before : { ...before, enabled: false });
  }
  expect(after.channels.mattermost.defaultAccount).toBe("ceckert-test-coach");
  expect(after.channels.mattermost.streaming).toEqual(f.config.channels.mattermost.streaming);
  expect(after.bindings).toEqual(f.config.bindings.slice(0, 2));
  expect(f.metadata.get("agent_2")!.version).toBe(31);
});

it.each(["conflicting-binding", "multiple-owners", "unknown-enabled-account", "implicit-default"])("refuses ambiguous Mattermost %s before Doctor or source config mutation", async change => {
  const f = await mattermostSourceFixture(), mattermost: any = f.config.channels.mattermost;
  if (change === "conflicting-binding") f.config.bindings[0]!.agentId = f.stale[0]!;
  if (change === "multiple-owners") f.config.bindings.push({ agentId: f.stale[0]!, match: { channel: "mattermost", accountId: "livefixture-coach" } });
  if (change === "unknown-enabled-account") mattermost.accounts.unowned = { enabled: true, botToken: "unknown-owner" };
  if (change === "implicit-default") { mattermost.baseUrl = "retained-url"; mattermost.botToken = "unowned-default"; }
  const original = JSON.stringify(f.config); await fs.writeFile(f.configPath, original);
  await expect(repairSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow("Mattermost account ownership");
  expect(f.run).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
});

it("preserves disabled unowned Mattermost accounts without enabling them", async () => {
  const f = await mattermostSourceFixture();
  const accounts: any = f.config.channels.mattermost.accounts;
  accounts.default = { enabled: false, botToken: "retained-disabled-default" };
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  const after = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  expect(after.channels.mattermost.accounts.default).toEqual(accounts.default);
});


it("preserves an enabled shared default only when explicitly owned by the retained reserved service", async () => {
  const f = await mattermostSourceFixture(), service = { agentId: "octogee-unmatched-route", storeId: "00000000-0000-4000-8000-000000000099", schema: "service_owned" };
  const file = path.join(f.root, "agents", service.agentId, "agent/openclaw-agent.sqlite"); await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(service.storeId, service.schema); db.close();
  f.metadata.set(service.schema, { store_id: service.storeId, version: 31, role: "agent", agent_id: service.agentId, schema_version: 31, history: ["service history"] });
  f.config.agents.entries[service.agentId] = { workspace: "service" };
  const mattermost: any = f.config.channels.mattermost;
  mattermost.accounts.default = { enabled: true, botToken: "retained-shared-default" }; mattermost.defaultAccount = "default";
  f.config.bindings.push({ agentId: service.agentId, match: { channel: "mattermost", accountId: "default" } });
  f.config.bindings.push({ agentId: service.agentId, match: { channel: "mattermost", accountId: "*" } });
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "database") return original(args, options);
    const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
    if (config.agents.entries["octogee-source-doctor-bootstrap"]) return { code: 0, stdout: "" };
    for (const id of [...f.agentIds, service.agentId]) { const row = [...f.metadata.values()].find(row => row.agent_id === id)!; row.version = 33; row.schema_version = 33; }
    return { code: 0, stdout: "" };
  });
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  const after = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  expect(after.channels.mattermost.accounts.default).toEqual(mattermost.accounts.default);
  expect(after.channels.mattermost.defaultAccount).toBe("default");
  expect(after.bindings).toContainEqual(f.config.bindings.at(-1));
  expect(after.channels.mattermost.accounts["ceckert-test-coach"].enabled).toBe(false);
});

it("does not reactivate accounts belonging to retained but unconfigured project history", async () => {
  const f = await mattermostSourceFixture(); delete f.config.agents.entries[f.agentIds[1]!];
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  const after = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  expect(after.channels.mattermost.accounts["livefixture-proj-launch"].enabled).toBe(false);
  expect(after.bindings).toEqual([f.config.bindings[0]]);
});

it("refuses an unowned implicit default supplied by the source environment before Doctor", async () => {
  const f = await mattermostSourceFixture();
  const config: any = f.config; config.channels.mattermost.baseUrl = "retained-url";
  await fs.writeFile(f.configPath, JSON.stringify(config));
  await expect(repairSourceDoctorAgentStores(f.agentIds, { ...f.input, env: { ...f.input.env, MATTERMOST_BOT_TOKEN: "unowned-default" } })).rejects.toThrow("Mattermost account ownership");
  expect(f.run).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
});


it("accepts actual Shared account defaults, duplicate peer routes, and the reserved wildcard without claiming foreign accounts", async () => {
  const f = await mattermostSourceFixture(), service = { agentId: "octogee-unmatched-route", storeId: "00000000-0000-4000-8000-000000000099", schema: "service_owned" };
  const file = path.join(f.root, "agents", service.agentId, "agent/openclaw-agent.sqlite"); await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(service.storeId, service.schema); db.close();
  f.metadata.set(service.schema, { store_id: service.storeId, version: 31, role: "agent", agent_id: service.agentId, schema_version: 31, history: ["service history"] });
  f.config.agents.entries[service.agentId] = { workspace: "service" }; delete f.config.agents.entries[f.agentIds[1]!];
  const mattermost: any = f.config.channels.mattermost; delete mattermost.defaultAccount; delete mattermost.accounts["livefixture-proj-launch"];
  for (const account of Object.values(mattermost.accounts) as any[]) delete account.enabled;
  f.config.bindings = f.config.bindings.filter(binding => binding.agentId !== f.agentIds[1]);
  const peerRoutes = f.config.bindings.map(binding => ({ ...binding, match: { ...binding.match, peer: { kind: "group", id: "synthetic-channel" } } }));
  f.config.bindings.push(...peerRoutes, { agentId: service.agentId, match: { channel: "mattermost", accountId: "*" } });
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "database") return original(args, options);
    const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
    if (config.agents.entries["octogee-source-doctor-bootstrap"]) return { code: 0, stdout: "" };
    for (const id of [...f.agentIds, service.agentId]) { const row = [...f.metadata.values()].find(row => row.agent_id === id)!; row.version = 33; row.schema_version = 33; }
    return { code: 0, stdout: "" };
  });
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  await repairSourceDoctorAgentStores(f.agentIds, f.input);
  const after = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  expect(after.channels.mattermost.accounts["livefixture-coach"]).toEqual(mattermost.accounts["livefixture-coach"]);
  for (const id of ["ceckert-test-coach", "ceckert-test-proj-hedgeherd", "ceckert-test-proj-moonlitruins"]) expect(after.channels.mattermost.accounts[id]).toEqual({ ...mattermost.accounts[id], enabled: false });
  expect(after.bindings).toEqual(f.config.bindings.filter(binding => [f.agentIds[0], service.agentId].includes(binding.agentId)));
  expect(after.channels.mattermost.defaultAccount).toBeUndefined();
});


it("seals failed PostgreSQL command output on retained HOME before disposable cleanup and never logs it", async () => {
  const f = await postgresFixture(), home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-retained-home-")));
  roots.push(home);
  const log = vi.fn(), original = f.run.getMockImplementation()!;
  let commandRoot = "";
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "doctor") {
      const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
      if (!config.agents.entries["octogee-source-doctor-bootstrap"]) {
        commandRoot = options.env.OPENCLAW_STATE_DIR!;
        throw new OpenClawCommandError("sanitized timeout", "private-doctor-progress", "private-doctor-error");
      }
    }
    return original(args, options);
  });
  const remove = fs.rm.bind(fs), cleanup = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (file === commandRoot && commandRoot) {
      expect(await fs.readFile(path.join(home, ".octogee-source-doctor-diagnostics/slot-0/stdout.bin"), "utf8")).toBe("private-doctor-progress");
      expect(await fs.stat(commandRoot)).toBeDefined();
    }
    return remove(file, options);
  });
  try {
    await expect(repairSourceDoctorAgentStores(f.agentIds, { ...f.input,
      env: { ...f.input.env, HOME: home }, diagnostics: { requestId: "private-request", releaseKey: "private-release", log },
    })).rejects.toThrow("sanitized timeout");
    await expect(fs.stat(commandRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const metadata = JSON.parse(await fs.readFile(path.join(home, ".octogee-source-doctor-diagnostics/slot-0/metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ status: "failed", sealed: true });
    expect(metadata.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "postgres-doctor", status: "failed" }),
      expect.objectContaining({ phase: "private-cleanup", status: "passed" }),
    ]));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-doctor");
    expect(f.metadata.get("agent_0")!.version).toBe(31);
  } finally { cleanup.mockRestore(); }
});

it.each(["linked-root", "writable-home"])("refuses unsafe diagnostics before any Native source Doctor command: %s", async change => {
  const f = await postgresFixture(), home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-unsafe-home-")));
  roots.push(home);
  if (change === "linked-root") await fs.symlink(f.root, path.join(home, ".octogee-source-doctor-diagnostics"));
  else await fs.chmod(home, 0o777);
  await expect(repairSourceDoctorAgentStores(f.agentIds, { ...f.input, env: { ...f.input.env, HOME: home },
    diagnostics: { requestId: "request", releaseKey: "release", log: () => {} },
  })).rejects.toThrow("unsafe");
  expect(f.run).not.toHaveBeenCalled();
});


it.each(["bootstrap", "postgres-doctor"])("retains numeric Native refusal output privately in %s", async phase => {
  const f = await postgresFixture(), home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-refusal-home-")));
  roots.push(home);
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "setup" || args[0] === "doctor") {
      const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
      const bootstrap = Boolean(config.agents.entries["octogee-source-doctor-bootstrap"]);
      if (bootstrap === (phase === "bootstrap")) return { code: 141, stdout: "private-refusal", stderr: "private-stderr" };
    }
    return original(args, options);
  });
  const error = await repairSourceDoctorAgentStores(f.agentIds, { ...f.input, env: { ...f.input.env, HOME: home },
    diagnostics: { requestId: "request", releaseKey: "release", log: () => {} },
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("exit 141");
  expect((error as Error).message).not.toContain("private-refusal");
  expect(await fs.readFile(path.join(home, ".octogee-source-doctor-diagnostics/slot-0/stdout.bin"), "utf8")).toBe("private-refusal");
  expect(f.metadata.get("agent_0")!.version).toBe(31);
});

it("keeps successful command evidence and refuses completion when private cleanup fails", async () => {
  const f = await postgresFixture(), home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-cleanup-home-")));
  roots.push(home);
  let commandRoot = "";
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    const result = await original(args, options);
    if (args[0] === "doctor") {
      const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
      if (!config.agents.entries["octogee-source-doctor-bootstrap"]) { commandRoot = options.env.OPENCLAW_STATE_DIR!; return { ...result, stdout: "private-success" }; }
    }
    return result;
  });
  const remove = fs.rm.bind(fs), cleanup = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (file === commandRoot && commandRoot) throw new Error("private-cleanup-error");
    return remove(file, options);
  });
  try {
    await expect(repairSourceDoctorAgentStores(f.agentIds, { ...f.input, env: { ...f.input.env, HOME: home },
      diagnostics: { requestId: "request", releaseKey: "release", log: () => {} },
    })).rejects.toThrow("source Doctor private cleanup failed");
    expect(await fs.readFile(path.join(home, ".octogee-source-doctor-diagnostics/slot-0/stdout.bin"), "utf8")).toBe("private-success");
    const metadata = JSON.parse(await fs.readFile(path.join(home, ".octogee-source-doctor-diagnostics/slot-0/metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ status: "failed", sealed: true });
    expect(metadata.phases.at(-1)).toMatchObject({ phase: "private-cleanup", status: "failed" });
  } finally { cleanup.mockRestore(); if (commandRoot) await fs.rm(commandRoot, { recursive: true, force: true }); }
});

async function schedulerSourceFixture() {
  const f = await postgresFixture();
  await fs.mkdir(path.join(f.root, 'state'));
  const global = new DatabaseSync(path.join(f.root, 'state/openclaw.sqlite'));
  global.exec('CREATE TABLE cron_jobs(agent_id TEXT, payload_kind TEXT)');
  for (const id of f.agentIds) global.prepare('INSERT INTO cron_jobs VALUES (?, ?)').run(id, 'heartbeat');
  global.close();
  return f;
}
it('repairs source scheduler state only under explicit authority after privately repairing its PostgreSQL stores', async () => {
  const f = await schedulerSourceFixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (options.env.OPENCLAW_STATE_DIR !== f.root) return original(args, options);
    expect(args).toEqual(['doctor', '--fix', '--non-interactive']);
    expect(options.timeoutMs).toBe(300_000);
    expect(f.metadata.get('agent_0')!.version).toBe(33);
    const config = JSON.parse(await fs.readFile(path.join(f.root, 'openclaw.json'), 'utf8'));
    expect(Object.keys(config.agents.entries).sort()).toEqual(f.agentIds.toSorted());
    const global = new DatabaseSync(path.join(f.root, 'state/openclaw.sqlite'));
    global.exec("UPDATE cron_jobs SET payload_kind='agentTurn'"); global.close();
    return { code: 0, stdout: 'native scheduler migration complete' };
  });
  await repairSourceDoctorAgentStores(f.agentIds, { ...f.input, schedulerStateRecovery: true });
  expect(f.run.mock.calls.filter(([, o]) => o.env.OPENCLAW_STATE_DIR === f.root)).toHaveLength(1);
  expect(f.metadata.get('agent_2')!.version).toBe(31);
  const global = new DatabaseSync(path.join(f.root, 'state/openclaw.sqlite'), { readOnly: true });
  try { expect(global.prepare('SELECT DISTINCT payload_kind FROM cron_jobs').all()).toEqual([{ payload_kind: 'agentTurn' }]); }
  finally { global.close(); }
});
it.each(['foreign-job','implicit-owner','missing-roster','linked-state'])(
  'refuses source scheduler maintenance before any native command with %s', async changed => {
    const f = await schedulerSourceFixture(), file = path.join(f.root, 'state/openclaw.sqlite');
    if (changed === 'foreign-job' || changed === 'implicit-owner') {
      const global = new DatabaseSync(file);
      global.prepare('INSERT INTO cron_jobs VALUES (?, ?)').run(changed === 'foreign-job' ? 'octogee-foreign-coach' : null, 'heartbeat'); global.close();
    }
    if (changed === 'linked-state') { await fs.rename(file, file + '.retained'); await fs.symlink(file + '.retained', file); }
    const input = { ...f.input, schedulerStateRecovery: true as const };
    if (changed === 'missing-roster') delete (input as any).expectedAnchors;
    await expect(repairSourceDoctorAgentStores(f.agentIds, input)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.metadata.get('agent_0')!.version).toBe(31);
  });


it.each(["refused", "timeout", "custody"])("keeps the source fenced when private setup is %s", async failure => {
  const f = await postgresFixture(), original = f.run.getMockImplementation()!;
  const before = await fs.readFile(path.join(f.root, "openclaw.json"));
  f.run.mockImplementation(async (args, options) => {
    if (args[0] !== "setup") return original(args, options);
    if (failure === "timeout") throw new Error("setup timeout");
    if (failure === "custody") f.assertCurrent.mockRejectedValue(new Error("setup custody lost"));
    return { code: failure === "refused" ? 2 : 0, stdout: "" };
  });
  await expect(repairSourceDoctorAgentStores(f.agentIds, f.input)).rejects.toThrow(failure === "refused" ? /private initialization failed/ : /setup (timeout|custody lost)/);
  expect(f.run.mock.calls.some(([args]) => args[0] === "doctor")).toBe(false);
  expect(await fs.readFile(path.join(f.root, "openclaw.json"))).toEqual(before);
});
