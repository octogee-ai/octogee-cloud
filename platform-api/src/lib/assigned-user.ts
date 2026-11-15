import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { UserAccount, UserAccountReader } from "@octogee/core/user-account";
import type { PlatformUserRecord } from "@octogee/core/platform-state";

export function userAllowsInteractiveAccess(user: Pick<PlatformUserRecord, "accountLifecycle">): boolean {
  return accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined });
}

export function userAssignedToGateway(
  user: Pick<PlatformUserRecord, "gateway" | "slug">,
  gatewayId: string,
  slug: string | null,
): boolean {
  return !!slug && user.gateway?.gatewayId === gatewayId && user.slug === slug;
}

export async function requireUserAccount(accounts: UserAccountReader, uid: string): Promise<UserAccount> {
  const account = await accounts.get(uid);
  if (!account) throw new Error(`users/${uid} account document is missing for an assigned user`);
  return account;
}
