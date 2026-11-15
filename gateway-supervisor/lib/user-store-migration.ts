import { assertUserStorePath } from "./postgres-anchor-file.js";
import { parseAgentId } from "@octogee/shared/types/identity";
import { applyPreBootPatches, writeConfigAtomically } from "../entrypoints/pre-boot-config.js";
import { agentIdsFromConfig } from "@octogee/core/byosub-restore";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { agentStorePath } from "./agent-anchor-record.js";
import { AUXILIARY_FAMILIES, auxiliaryStorePath } from "./user-auxiliary-anchors.js";
import { checkpointUserStoreAnchors } from "./user-store-anchor-checkpoint.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";
import { localStateStoreKind, localStateStorePath, openclawStateRoot } from "./openclaw-state-store.js";
import { checkpointDurableSystemConfigForSlug } from "./system-config.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const FAMILIES = ["state", "agent", ...AUXILIARY_FAMILIES] as const;
type Family = typeof FAMILIES[number];
const PENDING_FILE = ".builder-store-migration.json";

type Config = { database?: { engine?: unknown; families?: Record<string, { engine?: unknown }> } };

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function assertUserStoreMigrationComplete(stateDir: string): Promise<void> {
  if (await exists(path.join(stateDir, PENDING_FILE))) {
    throw new Error("User store migration is incomplete; rerun the held migration before starting OpenClaw");
  }
}

function engine(config: Config, family: string): "sqlite" | "postgres" {
  const selected = config.database?.families?.[family]?.engine ?? config.database?.engine ?? "sqlite";
  if (selected !== "sqlite" && selected !== "postgres") throw new Error(`Invalid database engine for ${family}`);
  return selected;
}

export async function assertUserPostgresSelection(env: NodeJS.ProcessEnv): Promise<void> {
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return;
  const stateDir = openclawStateRoot(env);
  const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "system_config", "openclaw.json"), "utf8")) as Config;
  if (localStateStoreKind(localStateStorePath(stateDir)) === "sqlite" ||
      FAMILIES.some(family => engine(config, family) !== "postgres")) {
    throw new Error("User stores require offline migration before startup");
  }
}

function migrationContext(env: NodeJS.ProcessEnv) {
  const slug = userClaimSlug(env);
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS) || !slug || !env.GATEWAY_ID || !env.POD_UID) {
    throw new Error("Store migration requires a claimed isolated allocation");
  }
  const stateDir = openclawStateRoot(env);
  const configPath = path.join(stateDir, "system_config", "openclaw.json");
  if (path.resolve(env.OPENCLAW_CONFIG_PATH ?? "") !== configPath) {
    throw new Error("Store migration requires the active durable user system_config");
  }
  return { slug, stateDir, configPath };
}

async function readPendingMigration(pending: string, identity: { gatewayId: string | undefined; slug: string; podUid: string | undefined }): Promise<boolean> {
  if (!await exists(pending)) return false;
  const saved = JSON.parse(await fs.readFile(pending, "utf8"));
  if (saved.gatewayId !== identity.gatewayId || saved.slug !== identity.slug || saved.podUid !== identity.podUid) throw new Error("Pending store migration belongs to another user");
  return true;
}

async function inspectFamily(command: (args: string[]) => Promise<string>, family: Family, allowed: Set<string>): Promise<string[]> {
  const inventory = JSON.parse(await command(["database", "port", "--family", family, "--to", "postgres", "--dry-run", "--json"]));
  if (inventory.phase !== "preflight" || inventory.family !== family || inventory.engine !== "sqlite" || inventory.to !== "postgres" ||
      !Array.isArray(inventory.stores) || !Array.isArray(inventory.migrations) || inventory.migrations.length) {
    throw new Error(`Invalid or unmigrated native inventory for ${family}; run native Doctor while held`);
  }
  if (inventory.stores.some((file: unknown) => typeof file !== "string" || !allowed.has(file)) || new Set(inventory.stores).size !== inventory.stores.length) {
    throw new Error(`${family} inventory contains a store without a supported durable anchor path`);
  }
  return inventory.stores;
}

function durablePaths(stateDir: string, family: Family, config: Config, slug: string): Set<string> {
  if (family === "state") return new Set([localStateStorePath(stateDir)]);
  if (family === "agent") return new Set(agentIdsFromConfig(config).filter(id => {
    const parsed = parseAgentId(id);
    return id === "octogee-unmatched-route" || parsed.kind !== "unknown" && parsed.username === slug;
  }).map(id => agentStorePath(stateDir, id)));
  return new Set([auxiliaryStorePath(stateDir, family)]);
}

async function assertMigrationPaths(stateDir: string, config: Config, slug: string): Promise<void> {
  const stores = FAMILIES.flatMap(family => [...durablePaths(stateDir, family, config, slug)]);
  for (const file of [...stores, path.join(stateDir, "system_config", "openclaw.json"), path.join(stateDir, PENDING_FILE), path.join(stateDir, "recovery", "database-port", "manifest.json")]) {
    await assertUserStorePath(stateDir, file);
  }
}

async function portFamily(command: (args: string[]) => Promise<string>, family: Family, stores: string[]): Promise<void> {
  const result = JSON.parse(await command(["database", "port", "--family", family, "--to", "postgres", "--json"]));
  if (result.phase !== "complete" || result.engine !== "postgres" || result.family !== family ||
      !Array.isArray(result.stores) || result.stores.length !== stores.length || stores.some(file => !result.stores.includes(file))) {
    throw new Error(`Native ${family} port did not complete the inventoried stores`);
  }
  for (const file of stores) if (!readPostgresAgentAnchor(file)) throw new Error(`Native ${family} port did not publish its PostgreSQL anchor`);
}

function expectedEngine(config: Config, family: string): string[] {
  return config.database?.families?.[family]?.engine === undefined
    ? ["--expect-current-absent"] : ["--expect-current-json", '"sqlite"'];
}

function heldCommand(run: OpenClawCommand, env: NodeJS.ProcessEnv, assertHeld: () => Promise<void>, signal?: AbortSignal) {
  return async (args: string[]): Promise<string> => {
    await assertHeld();
    const result = await run(args, { env, timeoutMs: 300_000, signal });
    if (result.code !== 0) throw new Error(`Native ${args[0]} ${args[1]} failed (exit ${result.code}); inspect native diagnostics before retrying`);
    await assertHeld();
    return result.stdout;
  };
}

export async function migrateUserStores(input: {
  env?: NodeJS.ProcessEnv;
  assertHeld: () => Promise<void>;
  log: (message: string) => void;
  run?: OpenClawCommand;
  checkpoint?: () => Promise<void>;
  recordAnchors?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const env = input.env ?? process.env;
  const { slug, stateDir, configPath } = migrationContext(env);
  await input.assertHeld();
  if (await exists(path.join(stateDir, "recovery", "database-port", "manifest.json"))) {
    throw new Error("Active native database port recovery requires native --resume or --rollback before retrying migration");
  }
  const readConfig = async (): Promise<Config> => JSON.parse(await fs.readFile(configPath, "utf8")) as Config;
  await assertUserStorePath(stateDir, configPath);
  const config = await readConfig();
  await assertMigrationPaths(stateDir, config, slug);
  const families = FAMILIES.filter(family => engine(config, family) === "sqlite");
  const pending = path.join(stateDir, PENDING_FILE);
  const identity = { gatewayId: env.GATEWAY_ID, slug, podUid: env.POD_UID };
  const resuming = await readPendingMigration(pending, identity);
  const command = heldCommand(input.run ?? runOpenClaw, { ...env, OPENCLAW_STATE_DIR: stateDir }, input.assertHeld, input.signal);
  if (!resuming) await fs.writeFile(pending, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
  if (families.length) {
    await command(["doctor", "--fix", "--non-interactive"]);
    const afterDoctor = await readConfig();
    if (FAMILIES.some(family => engine(afterDoctor, family) !== engine(config, family))) throw new Error("Doctor changed database engine selection; inspect before retrying");
    const configBefore = await fs.readFile(configPath, "utf8");
    const inventories = new Map<Family, string[]>();
    for (const family of families) inventories.set(family, await inspectFamily(command, family, durablePaths(stateDir, family, afterDoctor, slug)));
    if (await fs.readFile(configPath, "utf8") !== configBefore) throw new Error("User config changed during native inventory; retry while held");
    for (const [family, stores] of inventories) {
      await assertMigrationPaths(stateDir, afterDoctor, slug);
      if (stores.length) await portFamily(command, family, stores);
      else await command(["config", "set", `database.families.${family}.engine`, '"postgres"', "--strict-json", ...expectedEngine(afterDoctor, family)]);
      input.log(`[user-stores] migrated ${family} to PostgreSQL (${stores.length} retained stores)`);
    }
  }
  const repaired = await readConfig();
  if (FAMILIES.some(family => engine(repaired, family) !== "postgres")) {
    throw new Error("Native config writer did not leave every user family on PostgreSQL");
  }
  await input.assertHeld();
  await (input.recordAnchors ?? (() => checkpointUserStoreAnchors({ stateDir, slug, gatewayId: env.GATEWAY_ID!, config: repaired })))();
  await input.assertHeld();
  applyPreBootPatches(repaired, env, input.log, { stateStore: localStateStoreKind(localStateStorePath(stateDir)) });
  writeConfigAtomically(configPath, repaired);
  await (input.checkpoint ?? (async () => {
    checkpointDurableSystemConfigForSlug(slug, { openclawDir: stateDir, log: input.log });
  }))();
  await input.assertHeld();
  const persisted = await readConfig();
  if (FAMILIES.some(family => engine(persisted, family) !== "postgres")) {
    throw new Error("User store selection changed during durable checkpoint; migration remains incomplete");
  }
  await fs.unlink(pending);
  input.log("[user-stores] store anchors and PostgreSQL config durably recorded; user remains held");
}
