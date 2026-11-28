import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPostgresAgentAnchor, writeAgentStore } from "@octogee/core/agent-postgres";
import { isValidUsername } from "@octogee/shared/types/identity";
import { localStateStorePath } from "./openclaw-state-store.js";

type Rows = Array<Record<string, unknown>>;
type StateQuery = (sql: string, values: readonly string[]) => Promise<Rows>;

function withinWorkspace(root: string, candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function assertWorkspaceRemoved(workspace: string): Promise<void> {
  try {
    await fs.lstat(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`departed workspace is still present: ${workspace}`);
}

async function deleteWorkspaceStateUnder(workspace: string, query: StateQuery): Promise<string[]> {
  const setup = (await query("SELECT workspace_key, workspace_path FROM $schema.workspace_setup_state", []))
    .filter(row => typeof row.workspace_key === "string" && withinWorkspace(workspace, row.workspace_path));
  const aliases = (await query("SELECT alias_key, alias_path, workspace_path FROM $schema.workspace_path_aliases", []))
    .filter(row => typeof row.alias_key === "string" && (withinWorkspace(workspace, row.alias_path) || withinWorkspace(workspace, row.workspace_path)));
  for (const row of aliases) await query("DELETE FROM $schema.workspace_path_aliases WHERE alias_key = $1", [row.alias_key as string]);
  for (const row of setup) {
    await query("DELETE FROM $schema.workspace_generated_bootstrap_hashes WHERE workspace_key = $1", [row.workspace_key as string]);
    await query("DELETE FROM $schema.workspace_setup_state WHERE workspace_key = $1", [row.workspace_key as string]);
  }
  return setup.map(row => path.resolve(row.workspace_path as string)).sort();
}

async function withSqliteState<T>(file: string, use: (query: StateQuery) => Promise<T>): Promise<T> {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = await use(async (sql, values) => {
        const statement = database.prepare(sql.replaceAll("$schema.", "").replace(/\$(\d+)/gu, "?$1"));
        if (/^\s*SELECT/iu.test(sql)) return statement.all(...values) as Rows;
        statement.run(...values);
        return [];
      });
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function stateStoreExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function clearDepartedWorkspaceState(input: { root: string; slug: string; log: (message: string) => void }): Promise<string[]> {
  if (!isValidUsername(input.slug)) throw new Error("Invalid user slug");
  const workspace = path.resolve(input.root, "customers", input.slug);
  await assertWorkspaceRemoved(workspace);
  const stateFile = localStateStorePath(input.root);
  if (!(await stateStoreExists(stateFile))) return [];
  const anchor = readPostgresAgentAnchor(stateFile);
  const cleared = anchor
    ? await writeAgentStore(anchor, (client, schema) => deleteWorkspaceStateUnder(workspace, async (sql, values) =>
      (await client.query(sql.replaceAll("$schema", schema), [...values])).rows))
    : await withSqliteState(stateFile, query => deleteWorkspaceStateUnder(workspace, query));
  if (cleared.length > 0) input.log(`[remove:${input.slug}] cleared ${cleared.length} departed workspace attestation(s): ${cleared.join(", ")}`);
  return cleared;
}
