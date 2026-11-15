import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { resetRecoveredUserRuntime } from "../lib/recovered-user-runtime-reset.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryOpenClawDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recovered-runtime-reset-"));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, "state"), { recursive: true });
  return directory;
}

function procRootHolding(files: readonly string[]): string {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recovered-runtime-proc-"));
  temporaryDirectories.push(procRoot);
  files.forEach((file, index) => {
    fs.mkdirSync(path.join(procRoot, "92", "fd"), { recursive: true });
    fs.symlinkSync(file, path.join(procRoot, "92", "fd", String(40 + index)));
  });
  return procRoot;
}

function stateDatabase(openclawDir: string): DatabaseSync {
  const database = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE agent_databases (
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      size_bytes INTEGER,
      PRIMARY KEY (agent_id, path)
    ) STRICT;
    CREATE TABLE agent_database_leases (
      lease_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_start_time INTEGER,
      opened_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE workspace_setup_state (
      workspace_key TEXT NOT NULL PRIMARY KEY,
      workspace_path TEXT,
      version INTEGER,
      bootstrap_seeded_at TEXT,
      setup_completed_at TEXT,
      updated_at INTEGER,
      attested_at_ms INTEGER,
      attestation_updated_at_ms INTEGER
    ) STRICT;
    CREATE TABLE workspace_path_aliases (
      alias_key TEXT NOT NULL PRIMARY KEY,
      alias_path TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE workspace_generated_bootstrap_hashes (
      workspace_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (workspace_key, filename),
      FOREIGN KEY (workspace_key) REFERENCES workspace_setup_state(workspace_key) ON DELETE CASCADE
    ) STRICT;
  `);
  return database;
}

function agentDatabasePath(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function createAgentDatabase(
  openclawDir: string,
  agentId: string,
  schema: "healthy" | "empty" | "populated-without-auth" | "postgres-anchor",
): string {
  const databasePath = agentDatabasePath(openclawDir, agentId);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  if (schema === "postgres-anchor") {
    database.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)");
    database.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("92c817cc-770f-466d-b4a6-4e9b02998363", "octogee_agent_92c817cc770f466d");
  } else if (schema === "healthy") {
    database.exec("CREATE TABLE auth_profile_store (profile_id TEXT PRIMARY KEY, payload TEXT)");
  } else if (schema === "populated-without-auth") {
    database.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY); INSERT INTO conversations VALUES ('live')");
  } else {
    database.exec("PRAGMA user_version = 0");
  }
  database.close();
  return databasePath;
}

function registerAgent(database: DatabaseSync, openclawDir: string, agentId: string): void {
  const relativePath = path.relative(openclawDir, agentDatabasePath(openclawDir, agentId));
  database.prepare(
    "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
  ).run(agentId, relativePath, 19, 1_000, null);
}

function attestWorkspace(database: DatabaseSync, key: string, workspacePath: string): void {
  database.prepare(
    "INSERT INTO workspace_setup_state VALUES(?,?,?,?,?,?,?,?)",
  ).run(key, workspacePath, 1, "recent", "recent", 1_000, 1_000, 1_000);
  database.prepare(
    "INSERT INTO workspace_path_aliases VALUES(?,?,?,?,?)",
  ).run(`alias-${key}`, workspacePath, key, workspacePath, 1_000);
  database.prepare(
    "INSERT INTO workspace_generated_bootstrap_hashes VALUES(?,?,?)",
  ).run(key, "AGENTS.md", "hash");
}

function userAgentIds(): string[] {
  return [
    "octogee-ceckert-test-coach",
    "octogee-ceckert-test-proj-cityscout-coach",
    "octogee-ceckert-test-proj-efoilmeet-coach",
    "octogee-ceckert-test-proj-hedgeherd-coach",
  ];
}

describe("recovered user runtime reset", () => {
  it("clears the exact missing/empty user stores and .git-only attestations without touching peers", () => {
    const openclawDir = temporaryOpenClawDir();
    const state = stateDatabase(openclawDir);
    const userIds = userAgentIds();
    const userRoot = path.join(openclawDir, "customers", "ceckert-test");
    fs.mkdirSync(userRoot, { recursive: true });
    fs.writeFileSync(path.join(userRoot, "AGENTS.md"), "user context");
    for (const project of ["cityscout", "efoilmeet", "hedgeherd"]) {
      fs.mkdirSync(path.join(userRoot, "projects", project, ".git"), { recursive: true });
    }
    createAgentDatabase(openclawDir, userIds[0]!, "empty");
    for (const agentId of userIds) registerAgent(state, openclawDir, agentId);

    const peers = ["octogee-aug292-coach", "octogee-jdog11-coach"];
    for (const peer of peers) {
      createAgentDatabase(openclawDir, peer, "healthy");
      registerAgent(state, openclawDir, peer);
    }
    attestWorkspace(state, "ceckert-root", userRoot);
    for (const project of ["cityscout", "efoilmeet", "hedgeherd"]) {
      attestWorkspace(state, `ceckert-${project}`, path.join(userRoot, "projects", project));
    }
    const peerWorkspace = path.join(openclawDir, "customers", "aug292");
    fs.mkdirSync(peerWorkspace, { recursive: true });
    fs.writeFileSync(path.join(peerWorkspace, "AGENTS.md"), "peer");
    attestWorkspace(state, "aug292-root", peerWorkspace);
    state.close();

    const result = resetRecoveredUserRuntime({
      openclawDir,
      uid: "uid-ceckert",
      slug: "ceckert-test",
      agentIds: userIds,
      procRoot: procRootHolding([agentDatabasePath(openclawDir, peers[0]!)]),
    });

    expect(result.removedAgentRegistrations).toEqual([...userIds].sort());
    expect(result.removedAgentStores).toEqual([...userIds].sort());
    expect(result.clearedWorkspaceAttestations).toEqual([
      path.join(userRoot, "projects", "cityscout"),
      path.join(userRoot, "projects", "efoilmeet"),
      path.join(userRoot, "projects", "hedgeherd"),
    ]);
    expect(fs.existsSync(agentDatabasePath(openclawDir, userIds[0]!))).toBe(false);

    const observed = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    expect(observed.prepare("SELECT agent_id FROM agent_databases ORDER BY agent_id").all())
      .toEqual(peers.map((agent_id) => ({ agent_id })));
    expect(observed.prepare("SELECT workspace_key FROM workspace_setup_state ORDER BY workspace_key").all())
      .toEqual([{ workspace_key: "aug292-root" }, { workspace_key: "ceckert-root" }]);
    expect(observed.prepare("SELECT workspace_key FROM workspace_path_aliases ORDER BY workspace_key").all())
      .toEqual([{ workspace_key: "aug292-root" }, { workspace_key: "ceckert-root" }]);
    expect(observed.prepare("SELECT workspace_key FROM workspace_generated_bootstrap_hashes ORDER BY workspace_key").all())
      .toEqual([{ workspace_key: "aug292-root" }, { workspace_key: "ceckert-root" }]);
    observed.close();
    expect(peers.every((peer) => fs.existsSync(agentDatabasePath(openclawDir, peer)))).toBe(true);
  });

  it("clears only the selected private workspace's stale setup state for a GitHub-backed agent", () => {
    const openclawDir = temporaryOpenClawDir();
    const state = stateDatabase(openclawDir);
    const customerDir = path.join(openclawDir, "customers", "ceckert-test");
    const checkout = path.join(customerDir, "projects", "orbit");
    const workspace = path.join(customerDir, ".system", "project-coaches", "orbit");
    attestWorkspace(state, "checkout", checkout);
    attestWorkspace(state, "private", workspace);
    state.close();
    const result = resetRecoveredUserRuntime({
      openclawDir, uid: "uid-ceckert", slug: "ceckert-test",
      agentIds: ["octogee-ceckert-test-proj-orbit-coach"], githubProjectIds: new Set(["orbit"]), procRoot: procRootHolding([]),
    });
    expect(result.clearedWorkspaceAttestations).toEqual([workspace]);
  });

  it("keeps a PostgreSQL agent anchor and its registration, since the agent's content lives in PostgreSQL", () => {
    const openclawDir = temporaryOpenClawDir();
    const state = stateDatabase(openclawDir);
    const agentId = "octogee-ceckert-test-coach";
    const databasePath = createAgentDatabase(openclawDir, agentId, "postgres-anchor");
    registerAgent(state, openclawDir, agentId);
    state.close();
    const anchorBytes = fs.readFileSync(databasePath);

    const result = resetRecoveredUserRuntime({
      openclawDir,
      uid: "uid-ceckert",
      slug: "ceckert-test",
      agentIds: [agentId],
    });

    expect(result.removedAgentStores).toEqual([]);
    expect(result.removedAgentRegistrations).toEqual([]);
    expect(fs.readFileSync(databasePath)).toEqual(anchorBytes);
    const observed = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"), { readOnly: true });
    expect(observed.prepare("SELECT agent_id FROM agent_databases").all()).toEqual([{ agent_id: agentId }]);
    observed.close();
  });

  it("fails closed instead of discarding a user store with durable content", () => {
    const openclawDir = temporaryOpenClawDir();
    const state = stateDatabase(openclawDir);
    const agentId = "octogee-ceckert-test-coach";
    createAgentDatabase(openclawDir, agentId, "populated-without-auth");
    registerAgent(state, openclawDir, agentId);
    state.close();

    expect(() => resetRecoveredUserRuntime({
      openclawDir,
      uid: "uid-ceckert",
      slug: "ceckert-test",
      agentIds: [agentId],
    })).toThrow(/durable content/u);
    expect(fs.existsSync(agentDatabasePath(openclawDir, agentId))).toBe(true);
  });

  it("does not reset an actively leased user database", () => {
    const openclawDir = temporaryOpenClawDir();
    const state = stateDatabase(openclawDir);
    const agentId = "octogee-ceckert-test-coach";
    createAgentDatabase(openclawDir, agentId, "empty");
    registerAgent(state, openclawDir, agentId);
    state.prepare(
      "INSERT INTO agent_database_leases VALUES(?,?,?,?,?,?)",
    ).run("active", agentId, path.relative(openclawDir, agentDatabasePath(openclawDir, agentId)), 22, 1, 1);
    state.close();

    expect(() => resetRecoveredUserRuntime({
      openclawDir,
      uid: "uid-ceckert",
      slug: "ceckert-test",
      agentIds: [agentId],
      procRoot: procRootHolding([]),
    })).toThrow(/actively leased/u);
    expect(fs.existsSync(agentDatabasePath(openclawDir, agentId))).toBe(true);
  });

  it("refuses to reset a store a process still holds open, before changing state", () => {
    const openclawDir = temporaryOpenClawDir();
    const state = stateDatabase(openclawDir);
    const agentId = "octogee-ceckert-test-coach";
    createAgentDatabase(openclawDir, agentId, "empty");
    registerAgent(state, openclawDir, agentId);
    state.close();
    const shm = `${agentDatabasePath(openclawDir, agentId)}-shm`;

    expect(() => resetRecoveredUserRuntime({
      openclawDir,
      uid: "uid-ceckert",
      slug: "ceckert-test",
      agentIds: [agentId],
      procRoot: procRootHolding([`${shm} (deleted)`]),
    })).toThrow(`agent database files are still held open: ${shm}`);
    expect(fs.existsSync(agentDatabasePath(openclawDir, agentId))).toBe(true);
    const observed = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"), { readOnly: true });
    expect(observed.prepare("SELECT agent_id FROM agent_databases").all()).toEqual([{ agent_id: agentId }]);
    observed.close();
  });

  it("rejects a foreign peer agent id before changing local state", () => {
    const openclawDir = temporaryOpenClawDir();
    expect(() => resetRecoveredUserRuntime({
      openclawDir,
      uid: "uid-ceckert",
      slug: "ceckert-test",
      agentIds: ["octogee-aug292-coach"],
    })).toThrow(/foreign agent/u);
  });
});
