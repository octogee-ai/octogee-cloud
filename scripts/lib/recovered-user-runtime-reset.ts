import { projectAgentWorkspace } from "@octogee/core/project-agent-workspaces";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNotHeldSync, matchFiles, PROC_ROOT, sqliteFamily } from "./held-files.js";

import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { parseAgentId, workspaceDefaultAgentId } from "@octogee/shared/types/identity";

const AGENT_DB_FILE = "openclaw-agent.sqlite";
const DB_SIDECARS = ["", "-wal", "-shm"] as const;
const DURABLE_CONTENT_TABLES = [
  "transcript_events",
  "trajectory_runtime_events",
  "session_nodes",
  "session_windows",
  "conversations",
  "memory_index_chunks",
  "memory_index_sources",
  "standing_intents",
  "board_tabs",
  "board_widgets",
] as const;

export interface RecoveredUserRuntimeResetResult {
  removedAgentRegistrations: string[];
  removedAgentStores: string[];
  clearedWorkspaceAttestations: string[];
}

function expectedAgentIds(slug: string, agentIds: readonly string[]): string[] {
  const exact = new Set([workspaceDefaultAgentId(slug)]);
  for (const agentId of agentIds) {
    if (!agentIdBelongsToSlug(agentId, slug)) {
      throw new Error(`runtime reset contains a foreign agent id: ${agentId}`);
    }
    exact.add(agentId);
  }
  return [...exact].sort();
}

function agentDatabasePath(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent", AGENT_DB_FILE);
}

function expectedWorkspacePath(openclawDir: string, slug: string, agentId: string, githubProjectIds: ReadonlySet<string> | undefined): string {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "coach" && parsed.username === slug) {
    return path.join(openclawDir, "customers", slug);
  }
  if (parsed.kind === "project" && parsed.username === slug) {
    const customerDir = path.join(openclawDir, "customers", slug);
    return githubProjectIds?.has(parsed.project) ? projectAgentWorkspace(customerDir, parsed.project) : path.join(customerDir, "projects", parsed.project);
  }
  throw new Error(`runtime reset cannot derive workspace for agent: ${agentId}`);
}

function userTables(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}

function contentRows(database: DatabaseSync, tables: ReadonlySet<string>): number {
  let count = 0;
  for (const table of DURABLE_CONTENT_TABLES) {
    if (!tables.has(table)) continue;
    const row = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as {
      count?: unknown;
    };
    if (typeof row.count !== "number") throw new Error(`invalid content count in ${table}`);
    count += row.count;
  }
  return count;
}

function agentStoreNeedsReset(databasePath: string): boolean {
  if (!fs.existsSync(databasePath)) return true;
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new Error(`user agent store is unreadable: ${databasePath}`, { cause: error });
  }
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: unknown;
    };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`user agent store failed integrity check: ${databasePath}`);
    }
    const tables = userTables(database);
    if (tables.has("auth_profile_store") || tables.has("openclaw_engine_anchor")) return false;
    if (contentRows(database, tables) > 0) {
      throw new Error(`user agent store has durable content but no auth_profile_store: ${databasePath}`);
    }
    return true;
  } finally {
    database.close();
  }
}

function staleWorkspaceAttestation(workspacePath: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  return entries.every((entry) => entry === ".git");
}

function assertStateTable(database: DatabaseSync, table: string): void {
  const row = database
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(table) as { type?: unknown } | undefined;
  if (row?.type !== "table") throw new Error(`OpenClaw state database is missing ${table}`);
}

function removeStoreFiles(databasePath: string): void {
  for (const suffix of DB_SIDECARS) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

function storedDatabasePath(openclawDir: string, storedPath: string): string {
  return path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(openclawDir, storedPath));
}

interface RemovableAgentRegistration {
  agentId: string;
  storedPath: string;
}

interface StaleWorkspaceSetupRow {
  workspaceKey: string;
  workspacePath: string;
}

function removableAgentRegistrations(input: {
  state: DatabaseSync;
  resetAgentIds: ReadonlySet<string>;
  databasePaths: ReadonlyMap<string, string>;
  openclawDir: string;
}): RemovableAgentRegistration[] {
  const rows = input.state
    .prepare("SELECT agent_id, path FROM agent_databases")
    .all() as Array<{ agent_id?: unknown; path?: unknown }>;
  const removable: RemovableAgentRegistration[] = [];
  for (const row of rows) {
    if (typeof row.agent_id !== "string" || !input.resetAgentIds.has(row.agent_id)) continue;
    if (typeof row.path !== "string" || !row.path) {
      throw new Error(`invalid agent database registration for ${row.agent_id}`);
    }
    const expectedPath = input.databasePaths.get(row.agent_id)!;
    if (storedDatabasePath(input.openclawDir, row.path) !== expectedPath) {
      throw new Error(`unexpected agent database path for ${row.agent_id}`);
    }
    removable.push({ agentId: row.agent_id, storedPath: row.path });
  }
  return removable;
}

function assertAgentStoresUnleased(state: DatabaseSync, resetAgentIds: readonly string[]): void {
  const findLease = state.prepare(
    "SELECT 1 FROM agent_database_leases WHERE agent_id = ? LIMIT 1",
  );
  for (const agentId of resetAgentIds) {
    if (findLease.get(agentId)) {
      throw new Error(`user agent database is actively leased: ${agentId}`);
    }
  }
}

function staleWorkspaceSetupRows(
  state: DatabaseSync,
  staleWorkspaces: ReadonlySet<string>,
): StaleWorkspaceSetupRow[] {
  const rows = state
    .prepare("SELECT workspace_key, workspace_path FROM workspace_setup_state")
    .all() as Array<{ workspace_key?: unknown; workspace_path?: unknown }>;
  return rows.flatMap((row) => {
    if (typeof row.workspace_key !== "string" || typeof row.workspace_path !== "string") return [];
    const resolvedPath = path.resolve(row.workspace_path);
    return staleWorkspaces.has(resolvedPath)
      ? [{ workspaceKey: row.workspace_key, workspacePath: resolvedPath }]
      : [];
  });
}

function deleteRecoveredRuntimeState(
  state: DatabaseSync,
  registrations: readonly RemovableAgentRegistration[],
  setupRows: readonly StaleWorkspaceSetupRow[],
): void {
  state.exec("BEGIN IMMEDIATE");
  try {
    const removeRegistration = state.prepare(
      "DELETE FROM agent_databases WHERE agent_id = ? AND path = ?",
    );
    for (const row of registrations) removeRegistration.run(row.agentId, row.storedPath);
    const removeHashes = state.prepare(
      "DELETE FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
    );
    const removeAliases = state.prepare(
      "DELETE FROM workspace_path_aliases WHERE workspace_key = ? OR workspace_path = ?",
    );
    const removeSetup = state.prepare(
      "DELETE FROM workspace_setup_state WHERE workspace_key = ? AND workspace_path = ?",
    );
    for (const row of setupRows) {
      removeHashes.run(row.workspaceKey);
      removeAliases.run(row.workspaceKey, row.workspacePath);
      removeSetup.run(row.workspaceKey, row.workspacePath);
    }
    state.exec("COMMIT");
  } catch (error) {
    state.exec("ROLLBACK");
    throw error;
  }
}

function resetRuntimeStateDatabase(input: {
  stateDatabasePath: string;
  openclawDir: string;
  resetAgentIds: readonly string[];
  databasePaths: ReadonlyMap<string, string>;
  staleWorkspaces: ReadonlySet<string>;
}): Pick<
  RecoveredUserRuntimeResetResult,
  "removedAgentRegistrations" | "clearedWorkspaceAttestations"
> {
  if (!fs.existsSync(input.stateDatabasePath)) {
    return { removedAgentRegistrations: [], clearedWorkspaceAttestations: [] };
  }
  const state = new DatabaseSync(input.stateDatabasePath);
  try {
    state.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    for (const table of [
      "agent_databases",
      "agent_database_leases",
      "workspace_setup_state",
      "workspace_path_aliases",
      "workspace_generated_bootstrap_hashes",
    ]) assertStateTable(state, table);
    const registrations = removableAgentRegistrations({
      state,
      resetAgentIds: new Set(input.resetAgentIds),
      databasePaths: input.databasePaths,
      openclawDir: input.openclawDir,
    });
    assertAgentStoresUnleased(state, input.resetAgentIds);
    const setupRows = staleWorkspaceSetupRows(state, input.staleWorkspaces);
    deleteRecoveredRuntimeState(state, registrations, setupRows);
    return {
      removedAgentRegistrations: registrations.map((row) => row.agentId).sort(),
      clearedWorkspaceAttestations: setupRows.map((row) => row.workspacePath).sort(),
    };
  } finally {
    state.close();
  }
}

export function resetRecoveredUserRuntime(options: {
  openclawDir: string;
  uid: string;
  slug: string;
  agentIds: readonly string[];
  githubProjectIds?: ReadonlySet<string>;
  log?: (message: string) => void;
  procRoot?: string;
}): RecoveredUserRuntimeResetResult {
  if (!options.uid || !options.slug) throw new Error("runtime reset user identity is required");
  const openclawDir = path.resolve(options.openclawDir);
  const agentIds = expectedAgentIds(options.slug, options.agentIds);
  const databasePaths = new Map(
    agentIds.map((agentId) => [agentId, path.resolve(agentDatabasePath(openclawDir, agentId))]),
  );
  const resetAgentIds = agentIds.filter((agentId) =>
    agentStoreNeedsReset(databasePaths.get(agentId)!),
  );
  if (resetAgentIds.length > 0) {
    assertNotHeldSync(
      matchFiles(resetAgentIds.flatMap((agentId) => sqliteFamily(databasePaths.get(agentId)!))),
      options.procRoot ?? PROC_ROOT,
    );
  }
  const workspacePaths = new Map(
    agentIds.map((agentId) => [
      agentId,
      path.resolve(expectedWorkspacePath(openclawDir, options.slug, agentId, options.githubProjectIds)),
    ]),
  );
  const staleWorkspaces = new Set(
    [...workspacePaths.values()].filter(staleWorkspaceAttestation),
  );
  const stateDatabasePath = path.join(openclawDir, "state", "openclaw.sqlite");
  const stateReset = resetRuntimeStateDatabase({
    stateDatabasePath,
    openclawDir,
    resetAgentIds,
    databasePaths,
    staleWorkspaces,
  });
  const result: RecoveredUserRuntimeResetResult = {
    removedAgentRegistrations: stateReset.removedAgentRegistrations,
    removedAgentStores: [],
    clearedWorkspaceAttestations: stateReset.clearedWorkspaceAttestations,
  };

  for (const agentId of resetAgentIds) {
    const databasePath = databasePaths.get(agentId)!;
    removeStoreFiles(databasePath);
    result.removedAgentStores.push(agentId);
  }
  result.removedAgentStores.sort();
  options.log?.(
    `[runtime-reset:${options.slug}] reset ${result.removedAgentStores.length} agent store(s), ` +
      `${result.removedAgentRegistrations.length} registration(s), and ` +
      `${result.clearedWorkspaceAttestations.length} stale workspace attestation(s)`,
  );
  return result;
}
