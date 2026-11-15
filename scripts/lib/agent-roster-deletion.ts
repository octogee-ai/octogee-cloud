import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { agentIdsFromConfig } from "./byosub-restore.js";
import { log as defaultLog } from "./config.js";
import { isAgentNotFoundRpcError, type GatewayRpcClient } from "./gateway-rpc.js";

export type AgentDeletionStatus = "deleted" | "not-found";

export interface AgentDeletionResult {
  agentId: string;
  status: AgentDeletionStatus;
}

export interface DeleteRosterAgentsOptions {
  rpc: Pick<GatewayRpcClient, "agentsDelete"> & Partial<Pick<GatewayRpcClient, "agentsDetach">>;
  log?: (msg: string) => void;
  logPrefix?: string;
  preserveStore?: boolean;
}

const AGENT_DELETE_PROGRESS_INTERVAL_MS = 15_000;

export function userAgentIdsInRoster(current: unknown, slug: string): string[] {
  return agentIdsFromConfig(current).filter((agentId) => agentIdBelongsToSlug(agentId, slug));
}

export function schedulerHandoffAgentIds(
  current: unknown,
  slug: string,
  localAgentIds: readonly string[],
  partialHandoff: boolean,
): string[] {
  const handedOver = partialHandoff
    ? localAgentIds.filter((agentId) => agentIdBelongsToSlug(agentId, slug))
    : localAgentIds;
  return [...new Set([...handedOver, ...userAgentIdsInRoster(current, slug)])].sort();
}

async function removeRosterAgent(opts: DeleteRosterAgentsOptions, agentId: string) {
  if (!opts.preserveStore) return opts.rpc.agentsDelete({ agentId, deleteFiles: false });
  if (!opts.rpc.agentsDetach) throw new Error("Gateway does not support agents.detach; update OpenClaw before moving PostgreSQL agents");
  return opts.rpc.agentsDetach({ agentId });
}

export async function deleteRosterAgents(
  agentIds: readonly string[],
  opts: DeleteRosterAgentsOptions,
): Promise<AgentDeletionResult[]> {
  const log = opts.log ?? defaultLog;
  const prefix = opts.logPrefix ? `${opts.logPrefix} ` : "";
  const method = opts.preserveStore ? "agents.detach" : "agents.delete";
  const results: AgentDeletionResult[] = [];
  const failures: string[] = [];

  for (const agentId of agentIds) {
    const startedAt = Date.now();
    log(`${prefix}${method} started agentId=${agentId}`);
    const progressTimer = setInterval(() => {
      log(
        `${prefix}${method} pending agentId=${agentId} elapsedMs=${Date.now() - startedAt}`,
      );
    }, AGENT_DELETE_PROGRESS_INTERVAL_MS);
    try {
      const result = await removeRosterAgent(opts, agentId);
      if (result.purgeFailed === true || (result.failed?.length ?? 0) > 0) {
        throw new Error(
          `native cleanup incomplete: purgeFailed=${result.purgeFailed === true} failed=${JSON.stringify(result.failed ?? [])}`,
        );
      }
      log(
        `${prefix}${method} completed agentId=${agentId} elapsedMs=${Date.now() - startedAt}`,
      );
      results.push({ agentId, status: "deleted" });
    } catch (err) {
      if (isAgentNotFoundRpcError(err)) {
        log(`${prefix}${method} ${agentId} — already absent from the roster`);
        results.push({ agentId, status: "not-found" });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`⚠ ${prefix}${method} ${agentId} failed: ${message}`);
      failures.push(`${agentId} (${message})`);
    } finally {
      clearInterval(progressTimer);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${prefix}${method} failed for ${failures.join("; ")}`);
  }
  return results;
}
