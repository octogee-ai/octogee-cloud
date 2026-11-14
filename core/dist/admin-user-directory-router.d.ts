import { Router } from "express";
import { type UserAccountReader } from "./user-account.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, UntypedRecord } from "./platform-state/store.js";
export interface BrokerLedgerRecords {
    window: UntypedRecord | undefined;
    week: UntypedRecord | undefined;
    rollup: UntypedRecord | undefined;
}
export interface AdminUserDirectoryRecord {
    id: string;
    record: UntypedRecord;
}
export interface AdminUserDirectorySource {
    brokerLedgers(uids: readonly string[], windowStartMs: number, weekStartMs: number): Promise<ReadonlyMap<string, BrokerLedgerRecords>>;
    brokerWindows(uid: string, windowStartsMs: readonly number[]): Promise<UntypedRecord[]>;
    brokerEvents(uid: string, sinceMs: number, limit: number): Promise<UntypedRecord[]>;
    brokerEventCosts(uid: string, sinceMs: number, limit: number): Promise<UntypedRecord[]>;
    brokerRollup(uid: string): Promise<UntypedRecord | undefined>;
    totalUsers(): Promise<number | null>;
    usageLogs(uid: string, sinceDate: string): Promise<UntypedRecord[]>;
    workspaces(uid: string): Promise<AdminUserDirectoryRecord[]>;
    workspaceModelUsage(slug: string): Promise<AdminUserDirectoryRecord[]>;
    adminActions(uid: string, limit: number): Promise<AdminUserDirectoryRecord[]>;
}
export declare const noAdminUserDirectorySource: AdminUserDirectorySource;
export interface BrokerDailyUsage {
    date: string;
    costUsd: number;
    totalTokens: number;
    requestCount: number;
}
export interface BrokerDiagnostics {
    windows: Array<{
        windowStartMs: number;
        totalTokens: number;
        requestCount: number;
        costUsd: number;
    }>;
    days: Array<{
        date: string;
        model: string;
        totalTokens: number;
        requestCount: number;
        costUsd: number;
        cacheWriteUsd: number;
    }>;
    decomposition: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    recentCalls: Array<{
        at: number;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheWriteTokens: number;
        cacheReadTokens: number;
        costUsd: number;
        degraded: boolean;
        brokerTokenSecretName: string | null;
    }>;
}
export declare function aggregateBrokerDiagnostics(events: Array<Record<string, unknown>>, recentLimit?: number): Pick<BrokerDiagnostics, "days" | "decomposition" | "recentCalls">;
export declare function mergeDailyUsage(legacyLogs: Array<Record<string, unknown>>, brokerDaily: Map<string, BrokerDailyUsage>): Array<Record<string, unknown>>;
export interface UserDirectoryRouterLogger {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
export type AdminUserProductDetail = (uid: string) => Promise<Readonly<Record<string, unknown>>>;
export interface AdminUserDirectoryRouterDeps {
    store: PlatformStateStore;
    accounts: UserAccountReader;
    source: AdminUserDirectorySource;
    logger: UserDirectoryRouterLogger;
    productUserDetail?: AdminUserProductDetail | undefined;
}
export interface AdminUserPlacementProjection {
    managedBy: "cowboy" | "operator";
    gatewayId: string | null;
    gatewayProfile: string | null;
}
export declare function projectUserPlacement(userRecord: PlatformUserRecord): AdminUserPlacementProjection;
export declare function addAdminUserDirectoryRoutes(router: Router, deps: AdminUserDirectoryRouterDeps): Router;
