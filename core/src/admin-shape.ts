import { userEntitlements, type ProductFields } from "@octogee/shared/types/user-entitlements";
import {
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOW_MS,
  spendWindowPercentUsed,
  usageWindowStartMs,
  weekWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";
import type { UserAccount } from "./user-account.js";
import type { PlatformUserRecord } from "./platform-state/users.js";

export function toISODate(val: unknown): string | null {
  if (!val) return null;
  if (typeof (val as { toDate?: unknown }).toDate === "function") {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return null;
}

type UserDoc = Readonly<Record<string, unknown>>;

function numberAt(src: UserDoc, key: string, fallback = 0): number {
  const value = src[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isoMillis(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function displayNameFor(account: UserAccount): string {
  return account.displayName || account.username || (account.email ?? "").split("@")[0] || "(unknown)";
}

// Per-owner figures from the broker ledger (modelBrokerUsage*) — the only
// source that may render a USD amount on the admin surface. Legacy
// users/{uid}.usage carries openclaw-reported zero costs and survives as token
// telemetry only.
export interface BrokerUserUsage {
  windowCostUsd?: number;
  weekCostUsd?: number;
  totalCostUsd?: number;
  totalTokens?: number;
  now?: number;
}

export interface PlatformUserSummary {
  uid:                 string;
  displayName:         string;
  email:               string;
  username:            string;
  byotActive:          boolean;
  windowCostUsd:       number;
  windowBudgetUsd:     number;
  weekCostUsd:         number;
  weekBudgetUsd:       number;
  weekPercentUsed:     number;
  weekResetAt:         string | null;
  nextRefillAt:        string | null;
  totalTokensUsed:     number;
  brokerTotalTokens:   number;
  costUsd:             number;
  degraded:            boolean;
  lastActive:          string | null;
  mattermostConnected: boolean;
  mattermostUsername:  string | null;
  agentCount:          number;
  createdAt:           string | null;
  percentUsed:         number;

  provisioningStatus:  string | null;
  accountLifecycleStatus: string;
}

export type UserSummary = PlatformUserSummary & ProductFields;

function userSummaryFields(user: PlatformUserRecord) {
  return {
    mattermostConnected: (user.mattermostUserId ?? "").length > 0,
    agentCount: user.agents.agentIds.length,
    createdAt: isoMillis(user.createdAt),
    provisioningStatus: user.openclaw.status ?? user.provisioning.status ?? null,
    accountLifecycleStatus: user.accountLifecycle?.status ?? "active",
  };
}

export function buildUserSummary(
  user: PlatformUserRecord,
  account: UserAccount,
  ownerCredentialActive: boolean,
  broker: BrokerUserUsage = {},
): UserSummary {
  const now = broker.now ?? Date.now();
  const policy = userEntitlements().policy(account.planInputs, new Date(now));
  const usage = account.usage;
  const windowCostUsd = broker.windowCostUsd ?? 0;
  const weekCostUsd = broker.weekCostUsd ?? 0;
  const costUsd = broker.totalCostUsd ?? 0;
  // Owner-credential (BYOSUB/BYOT) traffic never lands in a spend window, so a
  // percentage against a zero budget would misleadingly read 100% — mirror the
  // user surfaces and show 0. The broker never throttles them either.
  const onOwnerCredential = ownerCredentialActive;
  const degraded = userEntitlements().spendThrottle(policy, {
    windowCostUsd,
    weekCostUsd,
    onOwnerCredential,
  }).degraded;

  return {
    ...userEntitlements().productProjection?.adminUserSummary(account.planInputs, {
      costUsd,
      now: new Date(now),
    }),
    uid: user.uid,
    displayName: displayNameFor(account),
    email: account.email ?? "",
    username: account.username ?? "",
    byotActive: ownerCredentialActive,
    windowCostUsd,
    windowBudgetUsd: policy.spendWindowUsd,
    weekCostUsd,
    weekBudgetUsd: policy.spendWeekUsd,
    weekPercentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(weekCostUsd, policy.spendWeekUsd),
    weekResetAt: new Date(weekWindowStartMs(now) + MODEL_BROKER_WEEK_WINDOW_MS).toISOString(),
    nextRefillAt: new Date(usageWindowStartMs(now) + MODEL_BROKER_USAGE_WINDOW_MS).toISOString(),
    totalTokensUsed: numberAt(usage, "totalTokensUsed", numberAt(usage, "tokensUsed")),
    brokerTotalTokens: broker.totalTokens ?? 0,
    costUsd,
    degraded,
    lastActive: toISODate(usage.lastUpdated),
    mattermostUsername: account.mattermostUsername,
    percentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(windowCostUsd, policy.spendWindowUsd),
    ...userSummaryFields(user),
  };
}
