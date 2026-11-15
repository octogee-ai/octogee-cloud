import type { SchedulerMigrationRequest, SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import { schedulerHandoffAgentIds } from "./agent-roster-deletion.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { SchedulerRefusal } from "./scheduler-failure.js";

export async function setUserChannelsRunning(
  rpc: Pick<GatewayRpcClient, "configGet" | "channelsStop" | "channelsStart">,
  slug: string,
  running: boolean,
): Promise<void> {
  const snapshot = await rpc.configGet();
  const config = snapshot.config as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } };
  const accounts = config.channels?.mattermost?.accounts ?? {};
  for (const accountId of Object.keys(accounts)) {
    if (accountId !== `${slug}-coach` && !accountId.startsWith(`${slug}-proj-`)) continue;
    if (running) await rpc.channelsStart({ channel: "mattermost", accountId });
    else await rpc.channelsStop({ channel: "mattermost", accountId });
  }
}

export async function migrateUserScheduler(
  rpc: Pick<GatewayRpcClient, "configGet" | "schedulerMigration">,
  slug: string,
  localAgentIds: readonly string[],
  request: SchedulerMigrationRequest,
): Promise<SchedulerMigrationResult> {
  const { resolveAgentScope, ...native } = request;
  if (request.phase !== "hold" && resolveAgentScope !== true) return rpc.schedulerMigration(native);
  const { config } = await rpc.configGet();
  const agentIds = schedulerHandoffAgentIds(config, slug, localAgentIds, resolveAgentScope === true || request.retainNonportable === true);
  if (agentIds.length === 0) throw new SchedulerRefusal(`Cannot ${request.phase} scheduler for ${slug}: no user agents`);
  return rpc.schedulerMigration({ ...native, agentIds });
}
