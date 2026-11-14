import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR,
  AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR,
  HOURS_PER_MONTH,
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  estimateFleetMonthlyCost,
} from "./cost-estimator.js";
import { TIER_PRESETS, SIZING_TIERS } from "./sizing.js";

describe("estimateGatewayMonthlyCost", () => {
  it("anchors to the published Autopilot general-purpose Pod rates", () => {
    expect(AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR).toBe(0.0445);
    expect(AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR).toBe(0.0049225);
    expect(HOURS_PER_MONTH).toBe(730);
  });

  it("prices the s/m/l ladder on the default general-purpose class", () => {
    expect(SIZING_TIERS).toEqual(["s", "m", "l"]);
    expect(
      Object.fromEntries(
        SIZING_TIERS.map((tier) => [tier, estimateGatewayMonthlyCost(tier).computeUsd]),
      ),
    ).toEqual({ s: 47, m: 94, l: 187 });
  });

  it("computes compute cost from request CPU + memory at general-purpose Autopilot rates", () => {
    // l: 4 vCPU / 16 GiB
    const result = estimateGatewayMonthlyCost("l");
    const expected = Math.round(
      4 * AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR * HOURS_PER_MONTH +
        16 * AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR * HOURS_PER_MONTH,
    );
    expect(result.computeUsd).toBe(expected);
  });

  it("derives perUserAtTarget and perUserAtTypical from raw compute and tier capacity", () => {
    const preset = TIER_PRESETS["l"];
    const rawCompute =
      4 * AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR * HOURS_PER_MONTH +
      16 * AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR * HOURS_PER_MONTH;
    const result = estimateGatewayMonthlyCost("l");
    expect(result.perUserAtTarget).toBe(Math.round(rawCompute / preset.capacity.targetActiveUsers));
    expect(result.perUserAtTypical).toBe(Math.round(rawCompute / preset.capacity.typicalUsers));
  });

  it("applies the conservative Spot multiplier when pricingMode=spot", () => {
    const onDemand = estimateGatewayMonthlyCost("l", { pricingMode: "on-demand" });
    const spot = estimateGatewayMonthlyCost("l", { pricingMode: "spot" });
    expect(spot.pricingMode).toBe("spot");
    expect(spot.computeUsd).toBe(Math.round(onDemand.onDemandComputeUsd * SPOT_PRICE_MULTIPLIER));
    expect(spot.onDemandComputeUsd).toBe(onDemand.computeUsd);
    expect(spot.savingsUsd).toBe(onDemand.computeUsd - spot.computeUsd);
  });

  it("rounds to whole dollars", () => {
    for (const tier of SIZING_TIERS) {
      const result = estimateGatewayMonthlyCost(tier);
      expect(Number.isInteger(result.computeUsd)).toBe(true);
      expect(Number.isInteger(result.perUserAtTarget)).toBe(true);
      expect(Number.isInteger(result.perUserAtTypical)).toBe(true);
    }
  });

  it("returns monotonically non-decreasing compute cost across the tier ladder", () => {
    let prev = -Infinity;
    for (const tier of SIZING_TIERS) {
      const c = estimateGatewayMonthlyCost(tier).computeUsd;
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it("l is the most expensive tier", () => {
    const top = estimateGatewayMonthlyCost("l").computeUsd;
    for (const tier of SIZING_TIERS) {
      if (tier === "l") continue;
      expect(top).toBeGreaterThanOrEqual(estimateGatewayMonthlyCost(tier).computeUsd);
    }
  });

  it("l (the default tier) lands in a sane low range for F&F", () => {
    // l = 4 vCPU / 16 GiB, the default tier most gateways start on.
    // Anchor sanity: a cheap F&F floor, comfortably under $300/mo.
    const c = estimateGatewayMonthlyCost("l").computeUsd;
    expect(c).toBeGreaterThan(100);
    expect(c).toBeLessThan(300);
  });
});

describe("estimateFleetMonthlyCost", () => {
  it("sums per-pod compute across all input tiers", () => {
    const result = estimateFleetMonthlyCost(["m", "l"]);
    expect(result.totalUsd).toBe(
      estimateGatewayMonthlyCost("m").computeUsd +
        estimateGatewayMonthlyCost("l").computeUsd,
    );
  });

  it("returns per-tier breakdown counts and subtotals", () => {
    const result = estimateFleetMonthlyCost([
      { tier: "m", pricingMode: "spot" },
      "m",
      "l",
    ]);
    expect(result.byTier["m"]).toEqual({
      count: 2,
      subtotalUsd:
        estimateGatewayMonthlyCost("m", { pricingMode: "spot" }).computeUsd +
        estimateGatewayMonthlyCost("m").computeUsd,
      onDemandSubtotalUsd: 2 * estimateGatewayMonthlyCost("m").computeUsd,
      spotCount: 1,
      onDemandCount: 1,
    });
    expect(result.byTier.l).toEqual({
      count: 1,
      subtotalUsd: estimateGatewayMonthlyCost("l").computeUsd,
      onDemandSubtotalUsd: estimateGatewayMonthlyCost("l").computeUsd,
      spotCount: 0,
      onDemandCount: 1,
    });
    expect(result.onDemandTotalUsd).toBe(
      2 * estimateGatewayMonthlyCost("m").computeUsd +
        estimateGatewayMonthlyCost("l").computeUsd,
    );
    expect(result.savingsUsd).toBeGreaterThan(0);
  });

  it("empty fleet returns zero total and empty breakdown", () => {
    const result = estimateFleetMonthlyCost([]);
    expect(result.totalUsd).toBe(0);
    expect(result.onDemandTotalUsd).toBe(0);
    expect(result.savingsUsd).toBe(0);
    expect(result.byTier).toEqual({});
  });
});
