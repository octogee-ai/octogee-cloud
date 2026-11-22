import type { GatewayRoot, PlatformStateTransaction } from "@octogee/core/platform-state";
import {
  readAssignedIsolatedAgentAnchorScope,
  type AssignedIsolatedAgentAnchorScope,
} from "./assigned-isolated-agent-anchor-scope.js";

export type AssignedPodInitialBootAuthority = (
  reader: PlatformStateTransaction,
  scope: AssignedIsolatedAgentAnchorScope & { release: number },
  now: number,
) => Promise<boolean>;

export async function assignedPodInitialBootAllowed(
  reader: PlatformStateTransaction,
  gateway: GatewayRoot,
  caller: { gatewayId: string; ownerUid?: string | undefined; podName?: string | undefined; podUid?: string | undefined },
  now: number,
  authorize: AssignedPodInitialBootAuthority,
): Promise<boolean> {
  const { builderSlug, desiredRelease } = gateway;
  if (!builderSlug || gateway.liveRelease !== null) return false;
  const scope = await readAssignedIsolatedAgentAnchorScope(reader, {
    ...caller,
    slug: builderSlug,
    boundOwnerUid: caller.ownerUid,
  }, now);
  return scope !== null && await authorize(reader, { ...scope, release: desiredRelease }, now);
}
