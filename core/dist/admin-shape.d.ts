import { type ProductFields } from "@octogee/shared/types/user-entitlements";
import type { OwnerSpendStanding } from "./model-broker/owner-spend-standing.js";
import type { UserAccount } from "./user-account.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
export declare function toISODate(val: unknown): string | null;
export declare function isoMillis(value: number | null): string | null;
export interface BrokerUserUsage {
    spend: OwnerSpendStanding;
    rollup: Readonly<Record<string, unknown>> | undefined;
    now: number;
}
export interface PlatformUserSummary {
    uid: string;
    displayName: string;
    email: string;
    username: string;
    byotActive: boolean;
    spend: OwnerSpendStanding;
    brokerTotalTokens: number;
    requestCount: number;
    costUsd: number;
    lastActive: string | null;
    mattermostConnected: boolean;
    mattermostUsername: string | null;
    agentCount: number;
    createdAt: string | null;
    provisioningStatus: string | null;
    accountLifecycleStatus: string;
}
export type UserSummary = PlatformUserSummary & ProductFields;
export declare function buildUserSummary(user: PlatformUserRecord, account: UserAccount, ownerCredentialActive: boolean, broker: BrokerUserUsage): UserSummary;
