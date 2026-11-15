import * as path from "node:path";
import { parseAgentId } from "@octogee/shared/types/identity";
import type { DegradedSecretOwner } from "./gateway-rpc.js";
import { configuredUserManagedProjectIds } from "./configured-user-project-agents.js";
import { readMattermostAccountSecret } from "./mattermost-account-secrets.js";

const PROJECT_ACCOUNT_OWNER_PREFIX = "mattermost:";

export function unassignedConfiguredAgents(agentIds: string[], assignedSlugs: string[]): Set<string> {
  const assigned = new Set(assignedSlugs);
  return new Set(agentIds.filter((id) => {
    const parsed = parseAgentId(id);
    return parsed.kind !== "unknown" && !assigned.has(parsed.username);
  }));
}

function accountAgent(ownerId: string, agentsDir: string, excluded: Set<string>): string | null {
  let tuple: unknown;
  try { tuple = JSON.parse(ownerId); } catch { return null; }
  if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" ||
      typeof tuple[1] !== "string" || !["anthropic:default", "platform-openrouter:default", "platform-openai:default", "platform-vertex:default", "platform-meta:default"].includes(tuple[1])) return null;
  for (const id of excluded) {
    if (tuple[0] === path.join(agentsDir, id, "agent", "openclaw-agent.sqlite")) return id;
  }
  return null;
}

export async function unmaterializedProjectAccountIds(input: {
  config: unknown;
  assignedSlugs: readonly string[];
  openclawDir: string;
}): Promise<Set<string>> {
  const accountIds = new Set<string>();
  for (const slug of input.assignedSlugs) {
    for (const projectId of configuredUserManagedProjectIds(input.config, slug, [])) {
      const accountId = `${slug}-proj-${projectId}`;
      if (await readMattermostAccountSecret(input.openclawDir, accountId) === null) accountIds.add(accountId);
    }
  }
  return accountIds;
}

function unmaterializedProjectAccountOwner(owner: DegradedSecretOwner, accountIds: ReadonlySet<string> | undefined): boolean {
  return owner.ownerKind === "account" && owner.ownerId.startsWith(PROJECT_ACCOUNT_OWNER_PREFIX) &&
    accountIds?.has(owner.ownerId.slice(PROJECT_ACCOUNT_OWNER_PREFIX.length)) === true;
}

export function stagedSecretOwnersOnly(input: {
  owners: DegradedSecretOwner[];
  excluded: Set<string>;
  agentsDir: string;
  unmaterializedProjectAccountIds?: ReadonlySet<string>;
}): boolean {
  const identities = new Set<string>();
  for (const owner of input.owners) {
    const identity = JSON.stringify([owner.ownerKind, owner.ownerId]);
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (unmaterializedProjectAccountOwner(owner, input.unmaterializedProjectAccountIds)) continue;
    if (owner.state !== "unavailable" || owner.reason !== "secret provider failed") return false;
    let agent: string | null = null;
    if (owner.ownerKind === "account") agent = accountAgent(owner.ownerId, input.agentsDir, input.excluded);
    if (owner.ownerKind === "capability" && owner.ownerId.startsWith("memory-provider:")) {
      agent = owner.ownerId.slice("memory-provider:".length);
    }
    if (!agent || !input.excluded.has(agent)) return false;
  }
  return true;
}
