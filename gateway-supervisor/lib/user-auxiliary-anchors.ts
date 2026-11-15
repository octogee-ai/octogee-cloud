import * as fs from "node:fs/promises";
import * as path from "node:path";
import { queryAgentStore, readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import type { UserAuxiliaryFamily, FleetBrokerAuxiliaryAnchor } from "@octogee/shared/types/fleet-broker";
import { publishAnchor, assertUserStorePath } from "./postgres-anchor-file.js";

const STORE_PATHS: Record<UserAuxiliaryFamily, string> = {
  workboard: "plugins/workboard/workboard.sqlite",
  logbook: "logbook/logbook.sqlite",
  "team-reports": "plugins/team-reports/team-reports.sqlite",
};
export const AUXILIARY_FAMILIES = Object.keys(STORE_PATHS) as UserAuxiliaryFamily[];
export type AuxiliaryAnchorVerifier = (anchor: FleetBrokerAuxiliaryAnchor) => Promise<void>;

export function auxiliaryStorePath(stateDir: string, family: UserAuxiliaryFamily): string {
  if (!Object.hasOwn(STORE_PATHS, family)) throw new Error("invalid auxiliary family");
  return path.join(stateDir, STORE_PATHS[family]);
}

export async function readLocalAuxiliaryAnchors(stateDir: string): Promise<FleetBrokerAuxiliaryAnchor[]> {
  const anchors: FleetBrokerAuxiliaryAnchor[] = [];
  for (const family of AUXILIARY_FAMILIES) {
    const file = auxiliaryStorePath(stateDir, family);
    await assertUserStorePath(stateDir, file);
    const anchor = readPostgresAgentAnchor(file);
    if (anchor) anchors.push({ family, ...anchor });
  }
  return anchors;
}

export async function verifyAuxiliaryAnchorInPostgres(
  anchor: FleetBrokerAuxiliaryAnchor,
  query: (target: FleetBrokerAuxiliaryAnchor, sql: string) => Promise<Record<string, unknown>[]> = queryAgentStore,
): Promise<void> {
  validateAnchors([anchor]);
  let rows: Record<string, unknown>[];
  try {
    rows = await query(anchor, `SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = '${anchor.family}'`);
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
    rows = [];
  }
  if (!rows[0]) throw new Error(`PostgreSQL ${anchor.family} schema ${anchor.schema} is missing`);
  if (rows[0].store_id !== anchor.storeId) throw new Error(`PostgreSQL ${anchor.family} schema ${anchor.schema} holds a different store`);
}

function validateAnchors(anchors: readonly FleetBrokerAuxiliaryAnchor[]): void {
  const seen = new Set<string>();
  for (const anchor of anchors) {
    if (!anchor || !Object.hasOwn(STORE_PATHS, anchor.family) || seen.has(anchor.family) ||
        typeof anchor.storeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(anchor.storeId) ||
        typeof anchor.schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(anchor.schema)) throw new Error("invalid auxiliary anchor identity");
    seen.add(anchor.family);
  }
}

async function assertLocalIdentity(stateDir: string, anchor: FleetBrokerAuxiliaryAnchor, required = false): Promise<void> {
  const file = auxiliaryStorePath(stateDir, anchor.family);
  await assertUserStorePath(stateDir, file);
  try { await fs.lstat(file); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const local = readPostgresAgentAnchor(file);
  if (!local || local.storeId !== anchor.storeId || local.schema !== anchor.schema) {
    throw new Error(`Local ${anchor.family} has a different identity from its recorded PostgreSQL store`);
  }
}

export async function landAuxiliaryAnchors(
  stateDir: string,
  anchors: readonly FleetBrokerAuxiliaryAnchor[],
  verify: AuxiliaryAnchorVerifier = verifyAuxiliaryAnchorInPostgres,
): Promise<void> {
  validateAnchors(anchors);
  for (const anchor of anchors) {
    await assertLocalIdentity(stateDir, anchor);
    await verify(anchor);
  }
  for (const anchor of anchors) {
    await assertLocalIdentity(stateDir, anchor);
    await publishAnchor(auxiliaryStorePath(stateDir, anchor.family), anchor);
    await assertLocalIdentity(stateDir, anchor, true);
  }
}
