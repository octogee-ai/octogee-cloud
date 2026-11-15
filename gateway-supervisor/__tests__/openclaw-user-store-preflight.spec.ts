import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { inspectConfiguredUserAgentStores } from "../lib/openclaw-user-store-preflight.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "user-store-inspection-"))); roots.push(root);
  const ids = ["octogee-jefe-coach", "octogee-unmatched-route"];
  const configPath = path.join(root, "openclaw.json"), procRoot = path.join(root, "proc");
  await fs.mkdir(procRoot);
  await fs.writeFile(configPath, JSON.stringify({ agents: { list: ids.map(id => ({ id })) } }));
  for (const id of ids) {
    const file = path.join(root, "agents", id, "agent/openclaw-agent.sqlite"); await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture"); db.close();
  }
  return { root, stateDir: root, configPath, procRoot, ids };
}
it("admits PostgreSQL anchors without creating private SQLite copies or changing them", async () => {
  const f = await fixture();
  const files = f.ids.map(id => path.join(f.root, "agents", id, "agent/openclaw-agent.sqlite"));
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  await expect(inspectConfiguredUserAgentStores(f)).resolves.toBe("exact");
  expect(await Promise.all(files.map(file => fs.readFile(file)))).toEqual(before);
});
it("refuses SQLite user state after the fresh PostgreSQL cutover", async () => {
  const f = await fixture();
  const db = new DatabaseSync(path.join(f.root, "agents", f.ids[0]!, "agent/openclaw-agent.sqlite"));
  db.exec("DROP TABLE openclaw_engine_anchor"); db.close();
  await expect(inspectConfiguredUserAgentStores(f)).rejects.toThrow("use a fresh Gateway state root");
});
it("refuses malformed configured paths, corrupt state and linked anchors before startup", async () => {
  const f = await fixture(), anchor = path.join(f.root, "agents", f.ids[1]!, "agent/openclaw-agent.sqlite");
  await fs.writeFile(anchor, "corrupt database"); await expect(inspectConfiguredUserAgentStores(f)).rejects.toThrow();
  await fs.rename(anchor, anchor + ".original"); await fs.symlink(anchor + ".original", anchor); await expect(inspectConfiguredUserAgentStores(f)).rejects.toThrow(/canonical/);
  await fs.writeFile(f.configPath, JSON.stringify({ agents: { list: [{ id: "octogee-jefe-coach", agentDir: "../outside" }] } }));
  await expect(inspectConfiguredUserAgentStores(f)).rejects.toThrow();
});
it("refuses a configured anchor held by a writer", async () => {
  const f = await fixture(), directory = path.join(f.procRoot, "741"); await fs.mkdir(path.join(directory, "fd"), { recursive: true });
  await fs.mkdir(path.join(directory, "fdinfo")); await fs.symlink(path.join(f.root, "agents", f.ids[1]!, "agent/openclaw-agent.sqlite"), path.join(directory, "fd", "3"));
  await fs.writeFile(path.join(directory, "fdinfo", "3"), "flags: 02\n");
  await expect(inspectConfiguredUserAgentStores(f)).rejects.toThrow("still held open");
});
