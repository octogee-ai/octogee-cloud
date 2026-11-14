import { afterEach, describe, expect, it } from "vitest";
import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
} from "@octogee/shared/types/user-entitlements";
import { buildUserSummary, type BrokerUserUsage } from "./admin-shape.js";
import { userAccountFromData } from "./user-account.js";
import { userRecordFromData } from "./platform-state/documents/users.js";

const NOW = Date.UTC(2026, 6, 2, 13, 30);
const LIVE_SIGNUP_OFFER = {
  schemaVersion: 3,
  offerId: "builder-signup",
  offerVersion: 1,
  personalTier: "personal",
  builderTier: "hobby",
  configHash: "config-a",
  claimedAt: new Date(NOW),
  endsAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000),
};

function summarize(uid: string, data: Record<string, unknown>, broker?: BrokerUserUsage) {
  return buildUserSummary(userRecordFromData(uid, data, 0, null), userAccountFromData(uid, data), data.byotActive === true, broker);
}

describe("buildUserSummary", () => {
  it("carries the account lifecycle so a list can mark users scheduled for deletion", () => {
    expect(summarize("u1", { email: "a@b.co" }).accountLifecycleStatus).toBe("active");
    expect(summarize("u1", {
      email: "a@b.co",
      accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 },
    }).accountLifecycleStatus).toBe("deletion_scheduled");
  });

  it("does not label an exhausted active trial as running on HOUSE", () => {
    const trial = { trialGrant: LIVE_SIGNUP_OFFER };
    expect(
      summarize("u", trial, { windowCostUsd: 9999, now: NOW }).degraded,
    ).toBe(false);
  });

  it("shows 0% (not a zero-budget 100%) for owner-credential users — mirrors the user surfaces", () => {
    // free/house-only tier + BYOT: weeklyBudgetUsd is 0, so an unguarded percentage
    // would read 100% despite the broker never metering or throttling this traffic.
    const summary = summarize(
      "u",
      { subscription: { tier: "free" }, byotActive: true },
      { windowCostUsd: 5, weekCostUsd: 40, now: NOW },
    );
    expect(summary.percentUsed).toBe(0);
    expect(summary.weekPercentUsed).toBe(0);
    expect(summary.degraded).toBe(false);
  });

  it("reports the epoch-aligned 4h window refill time", () => {
    const summary = summarize(
      "u",
      { trialGrant: LIVE_SIGNUP_OFFER },
      { windowCostUsd: 0, now: NOW },
    );
    // 13:30Z sits in the 12:00–16:00Z window → refill at 16:00Z
    expect(summary.nextRefillAt).toBe(new Date(Date.UTC(2026, 6, 2, 16)).toISOString());
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
