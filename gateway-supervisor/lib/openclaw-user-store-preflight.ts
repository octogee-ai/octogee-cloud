import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { configuredUserPortableStatePlan } from "@octogee/core/local-default-agent-wired";
import { assertNotHeld, matchFiles, PROC_ROOT, sqliteFamily } from "./held-files.js";

async function existingCanonicalFile(file: string) {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(file) !== file)) {
    throw new Error(`User store inspection requires a canonical regular file: ${file}`);
  }
  return stat;
}

async function configuredStores(stateDir: string, configPath: string) {
  const plan = configuredUserPortableStatePlan(configPath, stateDir);
  const stores: Array<{ agentId: string; file: string }> = [];
  for (const relative of plan.agentDirs) {
    let directory = stateDir;
    for (const part of relative.split("/")) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) break;
      if (!stat.isDirectory() || await fs.realpath(directory) !== directory) {
        throw new Error(`User store inspection requires a canonical directory: ${directory}`);
      }
    }
    const file = path.join(stateDir, relative, "openclaw-agent.sqlite");
    const family = await Promise.all(sqliteFamily(file).map(existingCanonicalFile));
    if (!family[0]) {
      if (family.some(Boolean)) throw new Error(`User store inspection found an orphaned SQLite sidecar: ${file}`);
      continue;
    }
    stores.push({ agentId: relative.split("/")[1]!, file });
  }
  return stores;
}

export async function inspectConfiguredUserAgentStores(input: {
  stateDir: string;
  configPath: string;
  procRoot?: string;
}): Promise<"exact"> {
  const stateDir = path.resolve(input.stateDir);
  if (await fs.realpath(stateDir) !== stateDir) throw new Error("User store state root is not canonical");
  const stores = await configuredStores(stateDir, input.configPath);
  await assertNotHeld(matchFiles(stores.flatMap(store => sqliteFamily(store.file))), input.procRoot ?? PROC_ROOT, { ignoreReadOnlyConnections: true });
  for (const store of stores) {
    if (!readPostgresAgentAnchor(store.file)) throw new Error("SQLite user agents are unsupported after the PostgreSQL cutover; use a fresh Gateway state root");
  }
  return "exact";
}
