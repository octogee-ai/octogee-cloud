import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR,
  AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR,
  HOURS_PER_MONTH,
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  estimateFleetMonthlyCost,
  estimateVmGatewayMonthlyCost,
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

describe("estimateVmGatewayMonthlyCost", () => {
  const hobbyDisks = [{ type: "pd-balanced", sizeGb: 80 }, { type: "pd-balanced", sizeGb: 10 }];
  const proDisks = [{ type: "pd-ssd", sizeGb: 80 }, { type: "pd-balanced", sizeGb: 50 }];
  const teamDisks = [{ type: "pd-ssd", sizeGb: 80 }, { type: "pd-balanced", sizeGb: 100 }];

  it("prices a running VM from its machine type plus its disks", () => {
    expect(estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType: "e2-medium", provisioningModel: "STANDARD", disks: hobbyDisks, running: true }))
      .toEqual({ computeUsd: 24, onDemandComputeUsd: 24, savingsUsd: 0, storageUsd: 9, totalUsd: 33, onDemandTotalUsd: 33, pricingMode: "on-demand" });
    expect(estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType: "e2-standard-2", provisioningModel: "STANDARD", disks: proDisks, running: true }))
      .toEqual({ computeUsd: 49, onDemandComputeUsd: 49, savingsUsd: 0, storageUsd: 19, totalUsd: 68, onDemandTotalUsd: 68, pricingMode: "on-demand" });
  });

  it("discounts a Spot VM's machine but not its disks", () => {
    expect(estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType: "e2-standard-4", provisioningModel: "SPOT", disks: teamDisks, running: true }))
      .toEqual({ computeUsd: 59, onDemandComputeUsd: 98, savingsUsd: 39, storageUsd: 24, totalUsd: 82, onDemandTotalUsd: 121, pricingMode: "spot" });
  });

  it("keeps charging a stopped VM for its disks", () => {
    expect(estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType: "e2-standard-2", provisioningModel: "STANDARD", disks: proDisks, running: false }))
      .toMatchObject({ computeUsd: 0, onDemandComputeUsd: 0, storageUsd: 19, totalUsd: 19, onDemandTotalUsd: 19 });
  });

  it("bills shared-core and predefined E2 shapes by their published vCPU and memory", () => {
    const hourly = (machineType: string) =>
      estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType, provisioningModel: "STANDARD", disks: [], running: true })!.computeUsd;
    expect(hourly("e2-small")).toBe(12);
    expect(hourly("e2-highmem-2")).toBe(66);
    expect(hourly("e2-highcpu-4")).toBe(72);
  });

  it("gives no price for a VM outside the region its rates are for", () => {
    const elsewhere = { machineType: "e2-medium", provisioningModel: "STANDARD" as const, disks: hobbyDisks, running: true };
    expect(estimateVmGatewayMonthlyCost({ ...elsewhere, zones: ["europe-west1-b"] })).toBeNull();
    expect(estimateVmGatewayMonthlyCost({ ...elsewhere, zones: ["us-central1-b", "us-east1-c"] })).toBeNull();
    expect(estimateVmGatewayMonthlyCost({ ...elsewhere, zones: [] })).toBeNull();
  });

  it("gives no price for a machine or disk type it has no rate for", () => {
    expect(estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType: "n2-standard-2", provisioningModel: "STANDARD", disks: proDisks, running: true })).toBeNull();
    expect(estimateVmGatewayMonthlyCost({ zones: ["us-central1-b"], machineType: "e2-medium", provisioningModel: "STANDARD", disks: [{ type: "hyperdisk-balanced", sizeGb: 10 }], running: true })).toBeNull();
  });
});
