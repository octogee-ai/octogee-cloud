import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrateUserStores, assertUserStoreMigrationComplete, assertUserPostgresSelection } from "../lib/user-store-migration.js";
import { auxiliaryStorePath } from "../lib/user-auxiliary-anchors.js";
import { publishAnchor } from "../lib/postgres-anchor-file.js";
import { withUserClaim } from "./helpers/user-claim.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const families = ["state", "agent", "workboard", "logbook", "team-reports"];
async function fixture(retained = false) {
  const root = await mkdtemp(join(tmpdir(), "user-migration-")); roots.push(root);
  const configPath = join(root, "system_config", "openclaw.json");
  await mkdir(join(root, "system_config"));
  const config = { agents: { entries: { "octogee-alice-coach": {} } }, database: { engine: "sqlite", families: {} as Record<string, { engine: string }> } };
  await writeFile(configPath, JSON.stringify(config));
  const env = withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_ID: "alice-s-test", POD_UID: "source-pod", OPENCLAW_DIR: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath }, "alice");
  const stores = new Map(families.map(f => [f, f === "state" ? join(root, "state/openclaw.sqlite") : f === "agent" ? join(root, "agents/octogee-alice-coach/agent/openclaw-agent.sqlite") : auxiliaryStorePath(root, f as "workboard")]));
  const select = async (family: string) => { const cfg = JSON.parse(await readFile(configPath, "utf8")); cfg.database.families[family] = { engine: "postgres" }; await writeFile(configPath, JSON.stringify(cfg)); };
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "doctor") return { code: 0, stdout: "doctor complete" };
    if (args[0] === "database") {
      const family = args[3], dry = args.includes("--dry-run");
      if (!dry && retained) {
        await publishAnchor(stores.get(family)!, { storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: `store_${family.replaceAll("-", "_")}` });
        await select(family);
      }
      return { code: 0, stdout: JSON.stringify({ phase: dry ? "preflight" : "complete", engine: dry || !retained ? "sqlite" : "postgres", to: "postgres", family, stores: retained ? [stores.get(family)] : [], migrations: [] }) };
    }
    if (args[0] === "config") { await select(args[2].split(".")[2]); return { code: 0, stdout: "saved" }; }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  });
  const recordAnchors = vi.fn(async () => {}), checkpoint = vi.fn(async () => {}), assertHeld = vi.fn(async () => {});
  const input = { env, run, recordAnchors, checkpoint, assertHeld, log: vi.fn() };
  return { root, configPath, config, input, run, checkpoint, recordAnchors, assertHeld };
}

it("runs native Doctor, ports every populated family, records anchors, then checkpoints before unblocking", async () => {
  const f = await fixture(true);
  f.checkpoint.mockImplementation(async () => { expect(f.recordAnchors).toHaveBeenCalledOnce(); expect(JSON.parse(await readFile(f.configPath, "utf8")).database.engine).toBe("postgres"); await expect(assertUserStoreMigrationComplete(f.root)).rejects.toThrow("incomplete"); });
  await migrateUserStores(f.input);
  expect(f.run.mock.calls[0][0]).toEqual(["doctor", "--fix", "--non-interactive"]);
  expect(f.run.mock.calls.filter(([args]) => args[0] === "database" && !args.includes("--dry-run")).map(([args]) => args[3])).toEqual(families);
  expect(f.run.mock.calls.some(([args]) => args[0] === "config")).toBe(false);
  expect(f.checkpoint).toHaveBeenCalledOnce();
  await expect(assertUserStoreMigrationComplete(f.root)).resolves.toBeUndefined();
});
it("uses compare-and-set selection only after native inventory proves a family absent", async () => {
  const f = await fixture(); await migrateUserStores(f.input);
  expect(f.run.mock.calls.filter(([args]) => args[0] === "config").map(([args]) => args)).toEqual(families.map(f => ["config", "set", `database.families.${f}.engine`, '"postgres"', "--strict-json", "--expect-current-absent"]));
  expect(f.run.mock.calls.slice(1, 6).map(([args]) => args[3])).toEqual(families);
});
it.each(["doctor", "database"])("keeps startup blocked after a failed native %s", async stage => {
  const f = await fixture(true), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => args[0] === stage ? { code: 1, stdout: "failed" } : original(args));
  await expect(migrateUserStores(f.input)).rejects.toThrow("failed");
  expect(f.recordAnchors).not.toHaveBeenCalled();
  await expect(assertUserStoreMigrationComplete(f.root)).rejects.toThrow("incomplete");
});
it.each(["recordAnchors", "checkpoint"] as const)("retries failed %s without repeating ports", async stage => {
  const f = await fixture(true); f[stage].mockRejectedValueOnce(new Error("unavailable"));
  await expect(migrateUserStores(f.input)).rejects.toThrow("unavailable");
  await expect(assertUserStoreMigrationComplete(f.root)).rejects.toThrow("incomplete");
  f.run.mockClear(); await migrateUserStores(f.input);
  expect(f.run).not.toHaveBeenCalled();
  await expect(assertUserStoreMigrationComplete(f.root)).resolves.toBeUndefined();
});
it("refuses active native recovery and requires explicit native resume or rollback", async () => {
  const f = await fixture(); await mkdir(join(f.root, "recovery/database-port"), { recursive: true }); await writeFile(join(f.root, "recovery/database-port/manifest.json"), "{}");
  await expect(migrateUserStores(f.input)).rejects.toThrow("--resume"); expect(f.run).not.toHaveBeenCalled();
});
it("refuses unsupported discovered paths before porting any family", async () => {
  const f = await fixture(true), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => args[0] === "database" ? { code: 0, stdout: JSON.stringify({ phase: "preflight", family: args[3], engine: "sqlite", to: "postgres", stores: [join(f.root, "unknown.sqlite")], migrations: [] }) } : original(args));
  await expect(migrateUserStores(f.input)).rejects.toThrow("durable anchor"); expect(f.recordAnchors).not.toHaveBeenCalled();
  expect(f.run.mock.calls.some(([args]) => args[0] === "database" && !args.includes("--dry-run"))).toBe(false);
});
it("refuses a native port that fails to publish a PostgreSQL anchor", async () => {
  const f = await fixture(true), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => {
    const result = await original(args);
    if (args[0] === "database" && !args.includes("--dry-run")) await rm(join(f.root, "state/openclaw.sqlite"), { force: true });
    return result;
  });
  await expect(migrateUserStores(f.input)).rejects.toThrow("anchor"); expect(f.recordAnchors).not.toHaveBeenCalled();
});
it("never invokes native commands after losing the hold", async () => {
  const f = await fixture(); f.assertHeld.mockRejectedValue(new Error("hold lost")); await expect(migrateUserStores(f.input)).rejects.toThrow("hold lost"); expect(f.run).not.toHaveBeenCalled();
});
it("requires all PostgreSQL selectors before startup and does not modify an already migrated user", async () => {
  const f = await fixture(); await expect(assertUserPostgresSelection(f.input.env)).rejects.toThrow("before startup");
  await migrateUserStores(f.input); await expect(assertUserPostgresSelection(f.input.env)).resolves.toBeUndefined();
  f.run.mockClear(); await migrateUserStores(f.input); expect(f.run).not.toHaveBeenCalled();
});
it("preserves the startup block if checkpointing restores old config", async () => {
  const f = await fixture(); f.checkpoint.mockImplementation(async () => { await writeFile(f.configPath, JSON.stringify(f.config)); });
  await expect(migrateUserStores(f.input)).rejects.toThrow("changed during durable checkpoint"); await expect(assertUserStoreMigrationComplete(f.root)).rejects.toThrow("incomplete");
});

it.each(["plugins", "logbook", "agents", "state", "system_config"])("rejects a symlinked %s parent before Doctor or any port", async parent => {
  const f = await fixture(true), outside = await fixture();
  if (parent === "system_config") await rm(join(f.root, parent), { recursive: true });
  await symlink(parent === "system_config" ? join(outside.root, parent) : outside.root, join(f.root, parent));
  const before = await readFile(outside.configPath);
  await expect(migrateUserStores(f.input)).rejects.toThrow("symlink");
  expect(f.run).not.toHaveBeenCalled();
  expect(await readFile(outside.configPath)).toEqual(before);
});
it("rechecks inventory paths before porting after a parent changes during dry-run", async () => {
  const f = await fixture(true), outside = await fixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => {
    const result = await original(args);
    if (args[0] === "database" && args.includes("--dry-run") && args[3] === "team-reports") await symlink(outside.root, join(f.root, "plugins"));
    return result;
  });
  await expect(migrateUserStores(f.input)).rejects.toThrow("symlink");
  expect(f.run.mock.calls.some(([args]) => args[0] === "database" && !args.includes("--dry-run"))).toBe(false);
});
