import { describe, expect, it, vi } from "vitest";

import {
  meterExhausted,
  readPlatformSpendState,
} from "../lib/platform-usage-allowance.js";

describe("shared platform usage allowance reader", () => {
  it("gates on user charge while preserving old cost-only window documents", async () => {
    const store = {
      readWindowUsage: vi.fn(async () => ({ costUsd: 0.5, chargeUsd: 0.75 })),
      readWeekUsage: vi.fn(async () => ({ costUsd: 1.5 })),
    };
    await expect(
      readPlatformSpendState({
        usageStore: store as never,
        gatewayId: "shared-blue",
        ownerUid: "uid-a",
        now: 10_000,
        spendWindowUsd: 1,
        spendWeekUsd: 2,
      }),
    ).resolves.toEqual({
      available: true,
      windowChargeUsd: 0.75,
      weekChargeUsd: 1.5,
      exhausted: false,
    });
  });

  it("fails closed when a required reader is missing", async () => {
    await expect(
      readPlatformSpendState({
        usageStore: {} as never,
        gatewayId: "shared-blue",
        ownerUid: "uid-a",
        now: 10_000,
        spendWindowUsd: 1,
        spendWeekUsd: null,
      }),
    ).resolves.toEqual({ available: false });
  });

  it("treats equality as exhausted", () => {
    expect(meterExhausted(1, 1)).toBe(true);
    expect(meterExhausted(0.99, 1)).toBe(false);
    expect(meterExhausted(null, 1)).toBe(false);
  });
});
