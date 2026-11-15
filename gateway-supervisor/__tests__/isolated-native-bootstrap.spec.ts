import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeIsolatedNativeState } from "../lib/isolated-native-bootstrap.js";
import { isolatedNativeInitialStateMatches } from "../lib/isolated-native-initial-state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-bootstrap-test-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "state"));
  return root;
}
function database(root: string, journal: boolean) {
  const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
  try {
    if (journal) db.exec("CREATE TABLE agent_deletion_journal(agent_id TEXT)");
    else db.exec("CREATE TABLE retained_history(value TEXT)");
  } finally {
    db.close();
  }
}

it("initializes absent host state before accepting the native-created journal", async () => {
  const root = await directory();
  const boot = vi.fn(async () => { database(root, true); });
  await initializeIsolatedNativeState(root, boot);
  expect(boot).toHaveBeenCalledExactlyOnceWith(root);
});

it.each([false, true])("preserves existing state and recovery history, journal=%s", async (journal) => {
  const root = await directory();
  database(root, journal);
  const before = await fs.readFile(path.join(root, "state", "openclaw.sqlite"));
  const boot = vi.fn();
  await initializeIsolatedNativeState(root, boot);
  expect(boot).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, "state", "openclaw.sqlite"))).toEqual(before);
});

it("does not accept a healthy boot that refused to infer a journal from existing history", async () => {
  const root = await directory();
  const history = path.join(root, "agents", "existing", "agent");
  await fs.mkdir(history, { recursive: true });
  await fs.writeFile(path.join(history, "openclaw-agent.sqlite"), "retained identity");
  await expect(initializeIsolatedNativeState(root, async () => { database(root, false); }))
    .rejects.toThrow("explicit native Doctor recovery");
  expect(await fs.readFile(path.join(history, "openclaw-agent.sqlite"), "utf8")).toBe("retained identity");
});

it("propagates native initialization failure and leaves the destination unpublished", async () => {
  const root = await directory();
  await expect(initializeIsolatedNativeState(root, async () => { throw new Error("native refused"); }))
    .rejects.toThrow("native refused");
  await expect(fs.stat(path.join(root, "state", "openclaw.sqlite"))).rejects.toThrow();
});
it("removes the host state a failed native boot created so the next attempt initializes it", async () => {
  const root = await directory();
  await fs.writeFile(path.join(root, "state", "openclaw.sqlite-wal"), "retained WAL");
  await fs.mkdir(path.join(root, "agents", "existing"), { recursive: true });
  const failed = vi.fn(async () => {
    await fs.writeFile(path.join(root, "state", "openclaw.sqlite"), "");
    await fs.mkdir(path.join(root, "client"));
    await fs.writeFile(path.join(root, "client", "credentials.sqlite"), "");
    await fs.mkdir(path.join(root, "agents", "main", "agent"), { recursive: true });
    await fs.writeFile(path.join(root, "agents", "existing", "added"), "native-added");
    throw new Error("native refused");
  });
  await expect(initializeIsolatedNativeState(root, failed)).rejects.toThrow("native refused");
  expect((await fs.readdir(path.join(root, "state"))).sort()).toEqual(["openclaw.sqlite-wal"]);
  await expect(fs.stat(path.join(root, "client"))).rejects.toThrow();
  expect(await fs.readdir(path.join(root, "agents"))).toEqual(["existing"]);
  expect(await fs.readFile(path.join(root, "agents", "existing", "added"), "utf8")).toBe("native-added");

  const retry = vi.fn(async () => { database(root, true); });
  await initializeIsolatedNativeState(root, retry);
  expect(retry).toHaveBeenCalledExactlyOnceWith(root);
});

it('records a Native-created baseline only after fresh initialization and never refreshes changed state', async () => {
  const root = await directory();
  const env = { POD_UID: 'pod-one' };
  await initializeIsolatedNativeState(root, async () => { database(root, true); }, env);
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  const db = new DatabaseSync(path.join(root, 'state/openclaw.sqlite'));
  try { db.exec("INSERT INTO agent_deletion_journal VALUES ('retained-agent')"); }
  finally { db.close(); }
  await initializeIsolatedNativeState(root, vi.fn(), env);
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('never certifies a fresh host database when user state preceded the bootstrap', async () => {
  const root = await directory();
  const history = path.join(root, 'agents', 'existing', 'agent');
  await fs.mkdir(history, { recursive: true });
  await fs.writeFile(path.join(history, 'openclaw-agent.sqlite'), 'retained identity');
  await initializeIsolatedNativeState(root, async () => { database(root, true); }, { POD_UID: 'pod-one' });
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
  expect(await fs.readFile(path.join(history, 'openclaw-agent.sqlite'), 'utf8')).toBe('retained identity');
});
it('never certifies preexisting orphan database sidecars', async () => {
  const root = await directory();
  await fs.writeFile(path.join(root, 'state/openclaw.sqlite-wal'), 'retained WAL');
  await initializeIsolatedNativeState(root, async () => { await fs.unlink(path.join(root, 'state/openclaw.sqlite-wal')); database(root, true); }, { POD_UID: 'pod-one' });
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
