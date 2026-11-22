import type { GatewayRoot, PlatformStateRepositories } from "@octogee/core/platform-state";
import {
  readAssignedIsolatedAgentAnchorScope,
  type AssignedIsolatedAgentAnchorScope,
} from "./assigned-isolated-agent-anchor-scope.js";

export type AssignedPodInitialBootAuthority = (
  reader: Pick<PlatformStateRepositories, "gateways" | "journal">,
  scope: AssignedIsolatedAgentAnchorScope & { release: number },
) => Promise<boolean>;

export async function assignedPodInitialBootAllowed(
  reader: PlatformStateRepositories,
  gateway: GatewayRoot,
  caller: { gatewayId: string; ownerUid?: string | undefined; podName?: string | undefined; podUid?: string | undefined },
  now: number,
  authorize: AssignedPodInitialBootAuthority,
): Promise<boolean> {
  const { builderSlug, desiredRelease } = gateway;
  if (!builderSlug || gateway.liveRelease !== null || desiredRelease !== gateway.latestRelease) return false;
  const scope = await readAssignedIsolatedAgentAnchorScope(reader, {
    ...caller,
    slug: builderSlug,
    boundOwnerUid: caller.ownerUid,
  }, now);
  return scope !== null && await authorize(reader, { ...scope, release: desiredRelease });
}
