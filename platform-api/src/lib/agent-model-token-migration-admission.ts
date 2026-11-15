import type { PlatformUserRecord, PlatformStateRepositories, Stored } from "@octogee/core/platform-state";

import { hasRunningUserMigration } from "./running-user-migration.js";

const OUTBOUND_CANDIDATE_LIMIT = 10;

export async function findRunningOutboundMigrationUserByAgentId(
  store: Pick<PlatformStateRepositories, "users" | "journal">,
  gatewayId: string,
  agentId: string,
): Promise<Stored<PlatformUserRecord> | null> {
  for (const candidate of await store.users.records.listByAgentId(agentId, OUTBOUND_CANDIDATE_LIMIT)) {
    if (await hasRunningUserMigration(store, candidate.uid, gatewayId, "outbound")) return candidate;
  }
  return null;
}
