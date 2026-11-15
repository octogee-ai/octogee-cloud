export { isSqliteVolatileArtifactPath, isSqliteStorePath, listSqliteStores } from "@octogee/core/agent-store-inventory";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Makes agent sqlite stores safe to copy between gateway pods.
 *
 * A `-wal` sibling is only meaningful against the exact main file it was written
 * for. Carrying the pair separately — rsync walks them at different instants
 * while openclaw keeps writing — delivers a mismatched generation, and SQLite
 * then REPLAYS the stale WAL over the newer main file: same-lineage frames
 * silently roll the store back, foreign-lineage frames leave it unreadable, and
 * one unreadable store blocks every secrets.apply and config reload on the pod.
 *
 * So the main file is made self-sufficient (checkpoint) and the sidecars are
 * never carried — nor left behind on the destination, where they would replay
 * over the file that just landed.
 */

const SQLITE_SUFFIX = ".sqlite";

export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export const SQLITE_SIDECAR_EXCLUDE_ARGS = SQLITE_SIDECAR_SUFFIXES.map(
  (suffix) => `--exclude=*${SQLITE_SUFFIX}${suffix}`,
);

// openclaw's own backup filter (src/infra/backup-volatile-filter.ts) treats these
// as volatile: lock databases it holds exclusively during a reindex or
// generation swap, and temp copies it is still writing. They are recreated on
// the destination and cannot be checkpointed while held.
// Glob twins of the pattern above for tar/rsync, which see the whole copy set
// including the user's workspace checkout: the uuid stamp keeps a workspace
// file that merely resembles a temp copy in the transfer.
const UUID_GLOB = "????????-????-????-????-????????????";

export const SQLITE_VOLATILE_EXCLUDE_ARGS = [
  `--exclude=*${SQLITE_SUFFIX}.reindex-lock${SQLITE_SUFFIX}*`,
  `--exclude=*${SQLITE_SUFFIX}.generation-lock${SQLITE_SUFFIX}*`,
  `--exclude=*${SQLITE_SUFFIX}.generation-writer${SQLITE_SUFFIX}*`,
  `--exclude=*${SQLITE_SUFFIX}.memory-reindex-${UUID_GLOB}*`,
  `--exclude=*${SQLITE_SUFFIX}.backup-${UUID_GLOB}*`,
  `--exclude=*${SQLITE_SUFFIX}.tmp-${UUID_GLOB}*`,
  `--exclude=*${SQLITE_SUFFIX}.pre-startup-migration-${UUID_GLOB}*`,
];

export const SQLITE_CARRY_EXCLUDE_ARGS = [
  ...SQLITE_SIDECAR_EXCLUDE_ARGS,
  ...SQLITE_VOLATILE_EXCLUDE_ARGS,
];

export interface UnreadableCarriedStore { path: string; message: string }
const CHECKPOINT_BUSY_TIMEOUT_MS = 5_000;

export function checkpointSqliteStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: unknown }
      | undefined;
    if (typeof row?.busy === "number" && row.busy !== 0) {
      throw new Error(`wal_checkpoint(TRUNCATE) was blocked (busy=${row.busy})`);
    }
  } finally {
    db.close();
  }
}

export function probeSqliteStoreOpens(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("SELECT count(*) AS c FROM sqlite_master").get();
  } finally {
    db.close();
  }
}

export async function clearSqliteSidecars(
  storePaths: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const storePath of storePaths) {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${storePath}${suffix}`;
      const existed = await fs
        .rm(sidecar, { force: false })
        .then(() => true)
        .catch(() => false);
      if (existed) removed.push(sidecar);
    }
  }
  return removed;
}

export async function findUnreadableStore(input: {
  storePaths: readonly string[];
  relativeTo: string;
}): Promise<UnreadableCarriedStore | null> {
  for (const storePath of input.storePaths) {
    try {
      probeSqliteStoreOpens(storePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { path: path.relative(input.relativeTo, storePath), message };
    } finally {
      await clearSqliteSidecars([storePath]);
    }
  }
  return null;
}
