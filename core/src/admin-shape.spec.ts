import { afterEach, describe, expect, it } from "vitest";
import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
} from "@octogee/shared/types/user-entitlements";
import { buildUserSummary, type BrokerUserUsage } from "./admin-shape.js";
import type { OwnerSpendStanding } from "./model-broker/owner-spend-standing.js";
import { userAccountFromData } from "./user-account.js";
import { userRecordFromData } from "./platform-state/documents/users.js";

const NOW = Date.UTC(2026, 6, 2, 13, 30);

const unmetered: OwnerSpendStanding = {
  rail: "operator",
  meter: { kind: "unmetered" },
  balanceUsd: null,
  throttle: { degraded: false, blocked: false, reason: null },
  needsAttention: false,
};

function summarize(uid: string, data: Record<string, unknown>, broker: Partial<BrokerUserUsage> = {}) {
  return buildUserSummary(
    userRecordFromData(uid, data, 0, null),
    userAccountFromData(uid, data),
    data.byotActive === true,
    { spend: unmetered, rollup: undefined, now: NOW, ...broker },
  );
}

describe("buildUserSummary", () => {
  it("carries the account lifecycle so a list can mark users scheduled for deletion", () => {
    expect(summarize("u1", { email: "a@b.co" }).accountLifecycleStatus).toBe("active");
    expect(summarize("u1", {
      email: "a@b.co",
      accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 },
    }).accountLifecycleStatus).toBe("deletion_scheduled");
  });

  it("carries the spend standing it was given", () => {
    expect(summarize("u", {}).spend).toBe(unmetered);
  });

  it("reads tokens, requests and cost from the broker rollup", () => {
    const summary = summarize("u", {}, {
      rollup: { costUsd: 1.73, totalTokens: 1_000, requestCount: 12, updatedAt: NOW },
    });
    expect(summary).toMatchObject({ costUsd: 1.73, brokerTotalTokens: 1_000, requestCount: 12 });
  });

  it("dates last activity from the broker rollup when the self-reported counter is empty", () => {
    const summary = summarize("u", { usage: {} }, { rollup: { updatedAt: NOW } });
    expect(summary.lastActive).toBe(new Date(NOW).toISOString());
  });

  it("dates last activity from whichever of the rollup and the self-reported counter is later", () => {
    const later = new Date(NOW + 60_000);
    const summary = summarize("u", { usage: { lastUpdated: later } }, { rollup: { updatedAt: NOW } });
    expect(summary.lastActive).toBe(later.toISOString());
  });

  it("reports no last activity for a user with no recorded traffic", () => {
    expect(summarize("u", {}).lastActive).toBeNull();
  });
});

describe("buildUserSummary commercial fields", () => {
  const productResolver = userEntitlements();
  const paying = { email: "a@b.co", subscription: { tier: "personal", status: "active" } };

  afterEach(() => {
    installUserEntitlements(productResolver);
  });

  it("carries no commercial field on a bare platform", () => {
    installUserEntitlements(staticUserEntitlements);

    const summary = summarize("u1", paying);

    expect(summary).toMatchObject({ uid: "u1", email: "a@b.co" });
    for (const field of ["tier", "effectiveTier", "trialDaysRemaining", "subscriptionStatus", "revenueUsd", "marginUsd"]) {
      expect(summary).not.toHaveProperty(field);
    }
  });
});
