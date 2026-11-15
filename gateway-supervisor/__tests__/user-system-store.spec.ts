import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { prepareUserSystemStore } from "../lib/user-system-store.js";
import type { upgradeImportedAgentStores } from "../lib/openclaw-import-upgrade.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "isolated-prelaunch-"))); roots.push(root);
  const file = path.join(root, "agents/octogee-unmatched-route/agent/openclaw-agent.sqlite");
  const procRoot = path.join(root, "proc"); await fs.mkdir(procRoot);
  return { root, file, procRoot, assertCurrent: vi.fn(async () => {}), upgrade: vi.fn<typeof upgradeImportedAgentStores>(async () => {}), log: vi.fn() };
}
async function anchor(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("14d620f0-129f-4a72-b1cd-55ad563db8dc", "octogee_agent_14d620f0129f4a72"); db.close();
}
it("leaves a fresh system agent for native setup", async () => {
  const f = await fixture(); await prepareUserSystemStore(f);
  expect(f.upgrade).not.toHaveBeenCalled(); expect(f.assertCurrent).toHaveBeenCalled();
});
it("upgrades the retained system agent under the stopped-writer check", async () => {
  const f = await fixture(); await anchor(f.file); await prepareUserSystemStore(f);
  expect(f.upgrade).toHaveBeenCalledWith(expect.objectContaining({ stores: [{ agentId: "octogee-unmatched-route", anchorPath: f.file, storeId: "14d620f0-129f-4a72-b1cd-55ad563db8dc", schema: "octogee_agent_14d620f0129f4a72" }], assertCurrent: f.assertCurrent }));
});
it("refuses a non-PostgreSQL retained system store", async () => {
  const f = await fixture(); await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.writeFile(f.file, "invalid");
  await expect(prepareUserSystemStore(f)).rejects.toThrow(); expect(f.upgrade).not.toHaveBeenCalled();
});
it("does not upgrade after prelaunch custody is lost", async () => {
  const f = await fixture(); await anchor(f.file); f.assertCurrent.mockRejectedValue(new Error("custody lost"));
  await expect(prepareUserSystemStore(f)).rejects.toThrow("custody lost"); expect(f.upgrade).not.toHaveBeenCalled();
});
it("refuses to upgrade an anchor held open by another process", async () => {
  const f = await fixture(); await anchor(f.file);
  const procRoot = path.join(f.root, "proc");
  await fs.mkdir(path.join(procRoot, "123", "fd"), { recursive: true });
  await fs.symlink(f.file, path.join(procRoot, "123", "fd", "3"));
  await expect(prepareUserSystemStore({ ...f, procRoot })).rejects.toThrow("still held open");
  expect(f.upgrade).not.toHaveBeenCalled();
});
it("accepts a new allocation on a later retained wake", async () => {
  const f = await fixture(); await anchor(f.file); let lease = "generation-1";
  const readAuthority = async () => lease;
  await prepareUserSystemStore({ ...f, readAuthority });
  lease = "generation-2";
  await prepareUserSystemStore({ ...f, readAuthority });
  expect(f.upgrade).toHaveBeenCalledTimes(2);
});
it("refuses allocation changes during native maintenance", async () => {
  const f = await fixture(); await anchor(f.file); let lease = "generation-1";
  f.upgrade.mockImplementation(async (input) => { lease = "generation-2"; await input.assertCurrent(); });
  await expect(prepareUserSystemStore({ ...f, readAuthority: async () => lease })).rejects.toThrow("allocation changed");
});
