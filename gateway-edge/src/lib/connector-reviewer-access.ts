import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import type { SizingKeyReader } from "@octogee/core/sizing-key";
import type { PlatformUserRecord, PlatformStateStore } from "@octogee/core/platform-state";
import {
  perUserOwnerUid,
  principalAccess,
  withGatewayOwnerSizingKey,
  workspaceScopeFor,
} from "../routes/user/gateways.js";

export interface ConnectorReviewerAccessDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  now: () => number;
}

function interactive(user: PlatformUserRecord | null): boolean {
  return accountAllowsInteractiveAccess(user ? { accountLifecycle: user.accountLifecycle ?? undefined } : undefined);
}

export async function connectorReviewerHasWorkspaceAccess(
  deps: ConnectorReviewerAccessDeps,
  data: Record<string, unknown>,
  uid: string,
): Promise<boolean> {
  const { ownerUid, gatewayId } = data;
  if (typeof ownerUid !== "string" || typeof gatewayId !== "string") return false;
  const [owner, reviewer] = await Promise.all([deps.store.users.records.get(ownerUid), deps.store.users.records.get(uid)]);
  if (!interactive(owner) || !interactive(reviewer)) return false;
  if (uid === ownerUid) return true;
  const auth = await readGatewayAuthorizationInStore(deps.store, gatewayId);
  if (!auth) return false;
  return withGatewayOwnerSizingKey(
    { store: deps.store, readSizingKey: deps.readSizingKey, ownerUid: perUserOwnerUid(auth), now: deps.now() },
    async (ownerSizingKey) => {
      const scope = await workspaceScopeFor(auth, auth.config.builderSlug, deps.store, true);
      if (!scope || scope.ownerUid !== ownerUid || data.agentId !== `octogee-${scope.workspaceSlug}-coach`) return false;
      return (await principalAccess(scope, uid, deps.store, ownerSizingKey)).kind === "member";
    },
  );
}
