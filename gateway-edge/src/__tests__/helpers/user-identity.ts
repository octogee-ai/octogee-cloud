import type { UserIdentity } from "@octogee/shared/types/builder-identity";
import { installUserIdentityStore } from "@octogee/core/identity/user-identity";

export function installTestUserIdentity(identity: UserIdentity | null): void {
  installUserIdentityStore({ current: () => identity, start: () => () => undefined });
}

export function claimedTestUser(builderSlug: string, gatewayId = "walter"): UserIdentity {
  return { gatewayId, state: "claimed", ownerUid: `uid-${builderSlug}`, builderSlug, leaseId: null, generation: null };
}
