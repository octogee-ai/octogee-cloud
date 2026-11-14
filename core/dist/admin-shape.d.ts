import { type ProductFields } from "@octogee/shared/types/user-entitlements";
import type { UserAccount } from "./user-account.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
export declare function toISODate(val: unknown): string | null;
export declare function isoMillis(value: number | null): string | null;
export interface BrokerUserUsage {
    windowCostUsd?: number;
    weekCostUsd?: number;
    totalCostUsd?: number;
    totalTokens?: number;
    now?: number;
}
export interface PlatformUserSummary {
    uid: string;
    displayName: string;
    email: string;
    username: string;
    byotActive: boolean;
    windowCostUsd: number;
    windowBudgetUsd: number;
    weekCostUsd: number;
    weekBudgetUsd: number;
    weekPercentUsed: number;
    weekResetAt: string | null;
    nextRefillAt: string | null;
    totalTokensUsed: number;
    brokerTotalTokens: number;
    costUsd: number;
    degraded: boolean;
    lastActive: string | null;
    mattermostConnected: boolean;
    mattermostUsername: string | null;
    agentCount: number;
    createdAt: string | null;
    percentUsed: number;
    provisioningStatus: string | null;
    accountLifecycleStatus: string;
}
export type UserSummary = PlatformUserSummary & ProductFields;
export declare function buildUserSummary(user: PlatformUserRecord, account: UserAccount, ownerCredentialActive: boolean, broker?: BrokerUserUsage): UserSummary;
