import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { exportAgentStoreSnapshots, prepareAgentStoreSnapshots, findPortableAgentStores, installPreparedAgentStores, planPostgresAgentExport } from "../lib/agent-store-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(agentId = "octogee-alice-coach") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "postgres-agent-handoff-")));
  roots.push(root);
  const relative = `agents/${agentId}/agent`;
  await fs.mkdir(path.join(root, relative), { recursive: true });
  const file = path.join(root, relative, "openclaw-agent.sqlite");
  const identity = { store_id: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_1514f00045404f4e" };
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(identity.store_id, identity.schema);
  db.close();
  return { root, agentId, file, identity };
}

it("detaches before carrying a PostgreSQL anchor and adopts it without a SQLite backup or restore", async () => {
  const { root, agentId, file, identity } = await fixture();
  const detachAgents = vi.fn(async () => undefined);
  const stageDir = path.join(root, "stage");
  await exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir, detachAgents });
  expect(detachAgents).toHaveBeenCalledExactlyOnceWith([agentId]);
  const prepared = await prepareAgentStoreSnapshots({ stageDir, importDir: path.join(root, "target"), migrationId: "m1" });
  expect(prepared.stores).toHaveLength(1);
  const adopted = new DatabaseSync(prepared.stores[0]!.restoredPath, { readOnly: true });
  try {
    expect({ ...adopted.prepare("SELECT store_id, schema FROM openclaw_engine_anchor").get() }).toEqual(identity);
  } finally { adopted.close(); }
  expect(await fs.readFile(file)).toEqual(await fs.readFile(prepared.stores[0]!.restoredPath));
});

it("requires one native receipt for every agent before staging any anchor", async () => {
  const agents = await Promise.all(Array.from({ length: 5 }, (_, index) => fixture(`octogee-alice-project-${index}`)));
  const stageDir = path.join(agents[0]!.root, "stage");
  const detachAgents = vi.fn(async (_agentIds: readonly string[]) => {
    await expect(fs.stat(stageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  await exportAgentStoreSnapshots({
    sources: agents.map(agent => ({ cwd: agent.root, path: `agents/${agent.agentId}` })),
    exportRoot: stageDir,
    detachAgents,
  });
  expect(detachAgents).toHaveBeenCalledExactlyOnceWith(agents.map(agent => agent.agentId));
  const prepared = await prepareAgentStoreSnapshots({ stageDir, importDir: path.join(agents[0]!.root, "target"), migrationId: "multi-agent" });
  expect(prepared.stores).toHaveLength(agents.length);
  for (const agent of agents) {
    const carried = prepared.stores.find(store => store.agentId === agent.agentId)!;
    expect(await fs.readFile(carried.restoredPath)).toEqual(await fs.readFile(agent.file));
  }
});

it.each(["missing", "failed"])("does not carry an anchor when detach is %s", async mode => {
  const { root, agentId, file } = await fixture();
  const detachAgents = mode === "failed" ? vi.fn(async () => { throw new Error("detach unavailable"); }) : undefined;
  await expect(exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: path.join(root, "stage") , detachAgents })).rejects.toThrow(mode === "failed" ? "detach unavailable" : "must be detached");
  expect((await fs.stat(file)).size).toBeGreaterThan(0);
  await expect(fs.stat(path.join(root, "stage"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses an altered PostgreSQL anchor before installing it", async () => {
  const { root, agentId } = await fixture();
  const stageDir = path.join(root, "stage");
  await exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir, detachAgents: async () => undefined });
  const artifact = path.join(stageDir, `agents/${agentId}/agent/.octogee-snapshot/postgres-anchor/database.sqlite`);
  await fs.appendFile(artifact, "altered-anchor");
  await expect(prepareAgentStoreSnapshots({ stageDir, importDir: path.join(root, "target"), migrationId: "altered" })).rejects.toThrow("does not match its manifest");
});

it.each(["export", "import"])("refuses a SQLite agent %s after the fresh PostgreSQL cutover", async phase => {
  const { root, agentId, file } = await fixture();
  const stageDir = path.join(root, "stage");
  if (phase === "export") {
    const db = new DatabaseSync(file); db.exec("DROP TABLE openclaw_engine_anchor"); db.close();
    await expect(exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir })).rejects.toThrow("SQLite agent handoff is unsupported after the PostgreSQL cutover");
  } else {
    await exportAgentStoreSnapshots({ sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: stageDir, detachAgents: async () => undefined });
    const artifact = path.join(stageDir, `agents/${agentId}/agent/.octogee-snapshot/postgres-anchor/database.sqlite`);
    const db = new DatabaseSync(artifact); db.exec("DROP TABLE openclaw_engine_anchor"); db.close();
    await expect(prepareAgentStoreSnapshots({ stageDir, importDir: path.join(root, "target"), migrationId: "sqlite" })).rejects.toThrow("SQLite agent handoff is unsupported after the PostgreSQL cutover");
  }
});

it("refuses duplicate source roots for one agent before detaching either store", async () => {
  const first = await fixture(), second = await fixture();
  const detachAgents = vi.fn(async () => undefined);
  await expect(exportAgentStoreSnapshots({ sources: [first, second].map(item => ({ cwd: item.root, path: `agents/${item.agentId}` })), exportRoot: path.join(first.root, "stage"), detachAgents })).rejects.toThrow("more than one database");
  expect(detachAgents).not.toHaveBeenCalled();
});

it("does not recursively inventory the workspace or Git metadata for an agent anchor", async () => {
  const { root, agentId, file } = await fixture();
  const sourcePaths = [`agents/${agentId}`, "customers/alice", "git-metadata/alice"];
  for (const relative of sourcePaths.slice(1)) {
    await fs.mkdir(path.join(root, relative), { recursive: true });
    await fs.writeFile(path.join(root, relative, "user.sqlite"), "outside portable agent state");
  }
  const sources = sourcePaths.map(relative => ({ cwd: root, path: relative }));
  const readdir = vi.spyOn(fs, "readdir");
  syncBuiltinESMExports();
  try {
    expect((await findPortableAgentStores(sources)).map(store => store.sourceAgentDir)).toEqual([path.dirname(file)]);
    const visits = readdir.mock.calls.map(([dir]) => dir);
    expect(visits).not.toContain(path.join(root, "customers/alice"));
    expect(visits).not.toContain(path.join(root, "git-metadata/alice"));
  } finally {
    readdir.mockRestore();
    syncBuiltinESMExports();
  }
});

it("reuses the pre-detach inventory for the PostgreSQL export while leaving Codex independent", async () => {
  const { root, agentId } = await fixture();
  const source = `agents/${agentId}`;
  const sources = [{ cwd: root, path: source }];
  const postgres = await planPostgresAgentExport(sources);
  const readdir = vi.spyOn(fs, "readdir");
  syncBuiltinESMExports();
  try {
    const detachAgents = vi.fn(async () => undefined);
    const carried = await exportAgentStoreSnapshots({ sources, postgres, exportRoot: path.join(root, "stage"), detachAgents });
    expect(detachAgents).toHaveBeenCalledExactlyOnceWith([agentId]);
    expect(carried).toHaveLength(1);
    expect(readdir.mock.calls.filter(([dir]) => dir === path.join(root, source))).toHaveLength(1);
  } finally {
    readdir.mockRestore();
    syncBuiltinESMExports();
  }
});

it("rejects a different anchor copied after the source detach", async () => {
  const { root, agentId, file } = await fixture();
  const detachAgents = async () => {
    const db = new DatabaseSync(file);
    db.exec("UPDATE openclaw_engine_anchor SET schema = 'octogee_unexpected'");
    db.close();
  };
  await expect(exportAgentStoreSnapshots({
    sources: [{ cwd: root, path: `agents/${agentId}` }], exportRoot: path.join(root, "stage"), detachAgents,
  })).rejects.toThrow("anchor changed during handoff");
});

it.each([
  "pre-startup-migration-331ddc36-f8a4-4c66-bd6b-e0c626343f93.postgres.bak",
  "auth-profile-migration-331ddc36-f8a4-4c66-bd6b-e0c626343f93.bak",
])("carries the live anchor without consuming Native's retained %s archive", async backupName => {
  const { root, agentId, file } = await fixture();
  const backupDir = path.join(root, `agents/${agentId}/agent/openclaw-agent.sqlite.${backupName}`);
  await fs.mkdir(backupDir);
  await fs.copyFile(file, path.join(backupDir, "anchor.sqlite"));
  await fs.writeFile(path.join(backupDir, "database.sqlite"), "doctor-export-fixture");
  await fs.writeFile(path.join(backupDir, "manifest.json"), "{}");
  const sources = [{ cwd: root, path: `agents/${agentId}` }];
  expect((await findPortableAgentStores(sources)).map((store) => store.sourceAgentDir)).toEqual([path.dirname(file)]);
  const detachAgents = vi.fn(async () => undefined);
  await exportAgentStoreSnapshots({ sources, exportRoot: path.join(root, "stage"), detachAgents });
  expect(detachAgents).toHaveBeenCalledExactlyOnceWith([agentId]);
  expect(await fs.readFile(path.join(backupDir, "anchor.sqlite"))).toEqual(await fs.readFile(file));
  expect(await fs.readFile(path.join(backupDir, "database.sqlite"), "utf8")).toBe("doctor-export-fixture");
});

it.each([
  "auth-profile-migration-not-a-uuid.bak",
  "auth-profile-migration-331ddc36-f8a4-4c66-bd6b-e0c626343f93",
  "other-repair-331ddc36-f8a4-4c66-bd6b-e0c626343f93.bak",
])("refuses an unrecognized archive-shaped SQLite directory %s", async backupName => {
  const { root, agentId } = await fixture();
  const backupDir = path.join(root, `agents/${agentId}/agent/openclaw-agent.sqlite.${backupName}`);
  await fs.mkdir(backupDir);
  await fs.writeFile(path.join(backupDir, "database.sqlite"), "unexpected-fixture");
  await expect(findPortableAgentStores([{ cwd: root, path: `agents/${agentId}` }])).rejects.toThrow("unexpected OpenClaw SQLite store");
});

it("refuses an unexpected agent SQLite store while allowing Codex's separate SQLite family", async () => {
  const { root, agentId } = await fixture();
  await fs.mkdir(path.join(root, `agents/${agentId}/agent/codex-home`));
  await fs.writeFile(path.join(root, `agents/${agentId}/agent/codex-home/goals_1.sqlite`), "optional-fixture");
  const sources = [{ cwd: root, path: `agents/${agentId}` }];
  expect(await findPortableAgentStores(sources)).toHaveLength(1);
  await fs.writeFile(path.join(root, `agents/${agentId}/agent/stray.sqlite`), "unexpected-fixture");
  await expect(findPortableAgentStores(sources)).rejects.toThrow("unexpected OpenClaw SQLite store");
});


it.each(["same-readonly", "same-writable", "writable-sidecar", "different-store", "different-schema", "sqlite"])('protects an occupied destination during anchor replacement (%s)', async scenario => {
  const { root, agentId, file } = await fixture();
  const incoming = path.join(root, "incoming.sqlite");
  await fs.copyFile(file, incoming);
  if (scenario === "different-store" || scenario === "different-schema") {
    const db = new DatabaseSync(incoming);
    if (scenario === "different-store") db.exec("UPDATE openclaw_engine_anchor SET store_id='2514f000-4540-4f4e-92a1-831adeac3d5b'");
    else db.exec("UPDATE openclaw_engine_anchor SET schema='octogee_other'");
    db.close();
  }
  if (scenario === "sqlite") { const db = new DatabaseSync(file); db.exec("DROP TABLE openclaw_engine_anchor"); db.close(); }
  const proc = path.join(root, "proc"), fds = path.join(proc, "123", "fd"), info = path.join(proc, "123", "fdinfo");
  await fs.mkdir(fds, { recursive: true }); await fs.mkdir(info, { recursive: true });
  await fs.symlink(file, path.join(fds, "4"));
  await fs.writeFile(path.join(info, "4"), `flags:\t${scenario === "same-writable" ? "02100002" : "02100000"}\n`);
  if (scenario === "writable-sidecar") {
    await fs.symlink(`${file}-wal`, path.join(fds, "5"));
    await fs.writeFile(path.join(info, "5"), "flags:\t02100002\n");
  }
  const release = vi.fn(async () => undefined);
  const install = installPreparedAgentStores({ prepared: { landingRoot: null, stores: [{ agentId, restoredPath: incoming, destinationPath: file }] }, releaseAgent: release, procRoot: proc });
  if (scenario === "same-readonly") {
    await expect(install).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledExactlyOnceWith(agentId);
    expect(await fs.stat(file)).toBeDefined();
  } else {
    await expect(install).rejects.toThrow(/still held open/);
    expect(await fs.stat(incoming)).toBeDefined();
  }
});
