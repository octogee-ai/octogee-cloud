import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { isSafeAgentId } from "@octogee/core/byosub-restore";

export interface ResolvedGateway {
  slug: string;
  gatewayId: string;
  agentIds: string[];
}

export function rosteredAgentIdsForSlug(userData: unknown, slug: string): string[] {
  const defaultAgent = `octogee-${slug}-coach`;
  const openclaw = (userData as { provisioning?: { openclaw?: { agentIds?: unknown } | null } | null } | null)
    ?.provisioning?.openclaw;
  const listed = Array.isArray(openclaw?.agentIds) ? openclaw.agentIds : [];
  const own = listed.filter(
    (id): id is string =>
      typeof id === "string" && isSafeAgentId(id) && id.startsWith(`octogee-${slug}-`),
  );
  return [defaultAgent, ...own.filter((id) => id !== defaultAgent)];
}

export async function resolveUserGateway(uid: string): Promise<ResolvedGateway | null> {
  const user = await platformStateStore.users.records.get(uid);
  const slug = user?.slug;
  const gatewayId = user?.gateway?.gatewayId;
  if (!slug || !gatewayId) return null;
  return {
    slug,
    gatewayId,
    agentIds: rosteredAgentIdsForSlug({ provisioning: { openclaw: { agentIds: user.agents.agentIds } } }, slug),
  };
}
