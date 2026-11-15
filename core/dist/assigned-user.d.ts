import type { UserAccount, UserAccountReader } from "@octogee/core/user-account";
import type { PlatformUserRecord } from "@octogee/core/platform-state";
export declare function userAllowsInteractiveAccess(user: Pick<PlatformUserRecord, "accountLifecycle">): boolean;
export declare function userAssignedToGateway(user: Pick<PlatformUserRecord, "gateway" | "slug">, gatewayId: string, slug: string | null): boolean;
export declare function requireUserAccount(accounts: UserAccountReader, uid: string): Promise<UserAccount>;
