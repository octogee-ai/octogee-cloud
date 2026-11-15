import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
export function userAllowsInteractiveAccess(user) {
    return accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined });
}
export function userAssignedToGateway(user, gatewayId, slug) {
    return !!slug && user.gateway?.gatewayId === gatewayId && user.slug === slug;
}
export async function requireUserAccount(accounts, uid) {
    const account = await accounts.get(uid);
    if (!account)
        throw new Error(`users/${uid} account document is missing for an assigned user`);
    return account;
}
