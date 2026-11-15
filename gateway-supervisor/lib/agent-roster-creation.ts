import { deleteRosterAgents } from "./agent-roster-deletion.js";
import { log as defaultLog } from "./config.js";
import {
  isAgentAlreadyExistsRpcError,
  isAgentDeletionPendingRpcError,
  type GatewayRpcClient,
} from "./gateway-rpc.js";

export interface RosterAgentSpec {
  agentId: string;
  workspace: string;
}

export type AgentCreationStatus = "created" | "already-exists";

export interface AgentCreationResult {
  agentId: string;
  status: AgentCreationStatus;
}

export interface CreateRosterAgentsOptions {
  rpc: Pick<GatewayRpcClient, "agentsCreate" | "agentsDelete" | "cronJobCount">;
  log?: (msg: string) => void;
  logPrefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The `{agentId, workspace}` pairs `agents.create` needs, read off the entries
 *  the config users produce. */
export function rosterAgentSpecsFromEntries(
  entries: readonly unknown[],
): RosterAgentSpec[] {
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("agent roster creation requires every agent entry to have a non-empty id");
    }
    if (typeof entry.workspace !== "string" || entry.workspace.length === 0) {
      throw new Error(
        `agent roster creation requires a workspace for ${entry.id} — agents.create cannot invent one`,
      );
    }
    return { agentId: entry.id, workspace: entry.workspace };
  });
}

export async function createRosterAgents(
  specs: readonly RosterAgentSpec[],
  opts: CreateRosterAgentsOptions,
): Promise<AgentCreationResult[]> {
  const log = opts.log ?? defaultLog;
  const prefix = opts.logPrefix ? `${opts.logPrefix} ` : "";
  const results: AgentCreationResult[] = [];
  const failures: string[] = [];

  for (const spec of specs) {
    try {
      const created = await createAfterPendingDeletion(spec, opts);
      if (created.agentId !== spec.agentId) {
        failures.push(
          `${spec.agentId} (gateway created ${created.agentId} instead)`,
        );
        continue;
      }
      log(`${prefix}agents.create ${spec.agentId} — rostered at ${spec.workspace}`);
      results.push({ agentId: spec.agentId, status: "created" });
    } catch (err) {
      if (isAgentAlreadyExistsRpcError(err)) {
        log(`${prefix}agents.create ${spec.agentId} — already rostered`);
        results.push({ agentId: spec.agentId, status: "already-exists" });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`⚠ ${prefix}agents.create ${spec.agentId} failed: ${message}`);
      failures.push(`${spec.agentId} (${message})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${prefix}agents.create failed for ${failures.join("; ")}`);
  }
  return results;
}

/** openclaw resumes a journaled, incomplete deletion on a fresh `agents.delete`;
 *  one resume and one retried create, then the refusal is the failure. The
 *  resumed delete also prunes the agent's cron rows, so it only runs while
 *  this gateway holds none for the agent (a staged migration snapshot would
 *  otherwise be lost). */
async function createAfterPendingDeletion(
  spec: RosterAgentSpec,
  opts: CreateRosterAgentsOptions,
) {
  const params = { name: spec.agentId, workspace: spec.workspace };
  try {
    return await opts.rpc.agentsCreate(params);
  } catch (err) {
    if (!isAgentDeletionPendingRpcError(err, spec.agentId)) throw err;
    const log = opts.log ?? defaultLog;
    const prefix = opts.logPrefix ? `${opts.logPrefix} ` : "";
    const cronJobs = await opts.rpc.cronJobCount(spec.agentId, { includeDisabled: true });
    if (cronJobs > 0) {
      throw new Error(
        `${(err as Error).message}; not resuming the deletion because ${cronJobs} cron job(s) for ${spec.agentId} are already on this gateway and would be pruned`,
      );
    }
    log(
      `${prefix}agents.create ${spec.agentId} refused: deletion cleanup pending — resuming that deletion before retrying`,
    );
    await deleteRosterAgents([spec.agentId], {
      rpc: opts.rpc,
      log: opts.log,
      logPrefix: opts.logPrefix,
    });
    return await opts.rpc.agentsCreate(params);
  }
}
