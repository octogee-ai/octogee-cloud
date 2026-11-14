import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { runIsolatedRuntimeStateRestore } from "../entrypoints/isolated-runtime-state-restore.js";
import { localStateStorePath as isolatedRuntimeStatePath } from "../lib/openclaw-state-store.js";
import { withUserClaim } from "./helpers/user-claim.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const state = { storeId: "c8feb4c9-41a7-4be1-b863-fa07ef6d1bdd", schema: "octogee_state_c8feb4c941a74be1" };
async function fixture(runtime = "cluster", recorded = true) {
  const root = await mkdtemp(join(tmpdir(), "isolated-boot-state-"));
  roots.push(root);
  const env = withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: runtime, GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: root, OPENCLAW_DIR: root }, "alice");
  const broker = {
    readAgentAnchors: vi.fn(async () => ({ anchors: [], ...(recorded ? { state } : {}) })),
    isolatedRuntimeStateDownloadUrl: vi.fn(async () => ({ url: "https://storage.example/legacy", method: "GET" as const, gcsPath: "legacy", expiresAt: "later" })),
  };
  const dependencies = {
    broker,
    verifyState: vi.fn(async () => undefined),
  };
  return { root, env, dependencies, broker };
}
it("recovers the recorded PostgreSQL identity without consulting a legacy checkpoint", async () => {
  const f = await fixture();
  await runIsolatedRuntimeStateRestore(f.env, f.dependencies);
  expect(readPostgresAgentAnchor(isolatedRuntimeStatePath(f.root))).toEqual(state);
  expect(f.dependencies.verifyState).toHaveBeenCalledExactlyOnceWith(state);
  expect(f.broker.isolatedRuntimeStateDownloadUrl).not.toHaveBeenCalled();
});
it("refuses missing PostgreSQL state without falling back to an old checkpoint", async () => {
  const f = await fixture();
  f.dependencies.verifyState.mockRejectedValue(new Error("state schema missing"));
  await expect(runIsolatedRuntimeStateRestore(f.env, f.dependencies)).rejects.toThrow("state schema missing");
  await expect(stat(isolatedRuntimeStatePath(f.root))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["cluster", "gce-vm"])("leaves unrecorded %s PostgreSQL state to native fresh creation", async runtime => {
  const f = await fixture(runtime, false);
  await runIsolatedRuntimeStateRestore(f.env, f.dependencies);
  expect(f.broker.readAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "alice" });
  expect(f.broker.isolatedRuntimeStateDownloadUrl).not.toHaveBeenCalled();
  expect(f.dependencies.verifyState).not.toHaveBeenCalled();
  await expect(stat(isolatedRuntimeStatePath(f.root))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses existing SQLite state without changing or restoring it", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "state"));
  const db = new DatabaseSync(isolatedRuntimeStatePath(f.root));
  db.exec("CREATE TABLE local_state (value TEXT)");
  db.close();
  await expect(runIsolatedRuntimeStateRestore(f.env, f.dependencies)).rejects.toThrow("offline native database port");
  expect(f.broker.readAgentAnchors).not.toHaveBeenCalled();
  const preserved = new DatabaseSync(isolatedRuntimeStatePath(f.root), { readOnly: true });
  try { expect(preserved.prepare("SELECT name FROM sqlite_master WHERE name = 'local_state'").get()).toBeDefined(); } finally { preserved.close(); }
});

it("preserves retained SQLite when explicitly deferring migration to the held supervisor", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "state"));
  const file = isolatedRuntimeStatePath(f.root);
  const db = new DatabaseSync(file); db.exec("CREATE TABLE retained(value TEXT)"); db.close();
  const before = await readFile(file);
  await runIsolatedRuntimeStateRestore(f.env, { ...f.dependencies, deferMigration: true });
  expect(await readFile(file)).toEqual(before);
  expect(f.broker.readAgentAnchors).not.toHaveBeenCalled();
});

const runEntrypoint = (env: NodeJS.ProcessEnv) => promisify(execFile)(process.execPath, [
  "--import", "tsx", fileURLToPath(new URL("../entrypoints/isolated-runtime-state-restore.ts", import.meta.url)),
], { env: { ...process.env, ...env }, timeout: 15_000 });

it.each(["corrupt database", "invalid anchor"])("halts boot for retained %s instead of retrying forever", async kind => {
  const f = await fixture();
  await mkdir(join(f.root, "state"));
  const file = isolatedRuntimeStatePath(f.root);
  if (kind === "corrupt database") {
    await writeFile(file, "not a SQLite database");
  } else {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    db.exec("INSERT INTO openclaw_engine_anchor VALUES ('invalid', 'postgres', 'bad')");
    db.close();
  }
  const before = await readFile(file);

  await expect(runEntrypoint(f.env)).rejects.toMatchObject({
    code: 2, stderr: expect.stringContaining("Cannot inspect retained user state"),
  });
  expect(await readFile(file)).toEqual(before);
});

it("keeps broker unavailability retryable at the real boot entrypoint", async () => {
  const f = await fixture();
  const token = join(f.root, "gateway-token");
  await writeFile(token, "synthetic-credential");
  let requests = 0;
  const server = createServer((_req, response) => {
    requests++;
    response.writeHead(503).end("broker temporarily unavailable");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing broker fixture address");
    await expect(runEntrypoint({ ...f.env,
      FLEET_BROKER_URL: `http://127.0.0.1:${address.port}`,
      OCTOGEE_GATEWAY_CREDENTIAL_TOKEN_PATH: token,
      OCTOGEE_API_SA_TOKEN_PATH: join(f.root, "absent-service-token"),
      INTERNAL_SERVICE_KEY: "",
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("503") });
    expect(requests).toBe(1);
    await expect(stat(isolatedRuntimeStatePath(f.root))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
