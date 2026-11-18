import { userEntitlements, type ProductFields } from "@octogee/shared/types/user-entitlements";
import type { OwnerSpendStanding } from "./model-broker/owner-spend-standing.js";
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

export interface BrokerUserUsage {
  spend: OwnerSpendStanding;
  rollup: Readonly<Record<string, unknown>> | undefined;
  now: number;
}

export interface PlatformUserSummary {
  uid:                 string;
  displayName:         string;
  email:               string;
  username:            string;
  byotActive:          boolean;
  spend:               OwnerSpendStanding;
  brokerTotalTokens:   number;
  requestCount:        number;
  costUsd:             number;
  lastActive:          string | null;
  mattermostConnected: boolean;
  mattermostUsername:  string | null;
  agentCount:          number;
  createdAt:           string | null;

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

function lastActiveAt(
  rollup: Readonly<Record<string, unknown>> | undefined,
  usage: Readonly<Record<string, unknown>>,
): string | null {
  const brokerMs = numberAt(rollup ?? {}, "updatedAt", Number.NaN);
  const legacy = toISODate(usage.lastUpdated);
  const legacyMs = legacy === null ? Number.NaN : Date.parse(legacy);
  const latest = Math.max(...[brokerMs, legacyMs].filter((value) => Number.isFinite(value)));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

export function buildUserSummary(
  user: PlatformUserRecord,
  account: UserAccount,
  ownerCredentialActive: boolean,
  broker: BrokerUserUsage,
): UserSummary {
  const rollup = broker.rollup ?? {};
  const costUsd = numberAt(rollup, "costUsd");

  return {
    ...userEntitlements().productProjection?.adminUserSummary(account.planInputs, {
      costUsd,
      now: new Date(broker.now),
    }),
    uid: user.uid,
    displayName: displayNameFor(account),
    email: account.email ?? "",
    username: account.username ?? "",
    byotActive: ownerCredentialActive,
    spend: broker.spend,
    brokerTotalTokens: numberAt(rollup, "totalTokens"),
    requestCount: numberAt(rollup, "requestCount"),
    costUsd,
    lastActive: lastActiveAt(broker.rollup, account.usage),
    mattermostUsername: account.mattermostUsername,
    ...userSummaryFields(user),
  };
}
