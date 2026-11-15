import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";

export interface ModelBrokerOwnerAccessInput {
  gatewayId: string;
  ownerUid: string | null;
}

export type ModelBrokerOwnerAccessResolver = (
  input: ModelBrokerOwnerAccessInput,
) => Promise<boolean>;

export function createModelBrokerOwnerAccessResolver(
  state: Pick<PlatformStateRepositories, "gateways" | "users">,
): ModelBrokerOwnerAccessResolver {
  return async (input) => {
    const ownerUid = input.ownerUid || (await state.gateways.roots.get(input.gatewayId))?.ownerUid || null;
    if (!ownerUid) return false;
    const user = await state.users.records.get(ownerUid);
    return user !== null &&
      accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined });
  };
}
