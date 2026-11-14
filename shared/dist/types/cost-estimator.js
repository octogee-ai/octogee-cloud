import { TIER_PRESETS, } from "./sizing.js";
// Published GKE Autopilot Pod rates for the default general-purpose class
// (us-central1 list price), which is what every workload is billed at. Excludes
// egress, LB, GCS, Firestore - those are app-level metering territory (Phase 5a).
export const AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR = 0.0445;
export const AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR = 0.0049225;
export const HOURS_PER_MONTH = 730;
// Google publishes Spot Pods at 60-91% off the corresponding regular rate. Take
// the conservative end (70% off) so the dashboard never overstates savings.
export const SPOT_PRICE_MULTIPLIER = 0.3;
// Published Compute Engine rates for us-central1: E2 machines are billed per
// vCPU and per GB, shared-core E2 types at a fraction of a vCPU. Spot E2 was
// 40% off the regular rate when these were read (2026-11).
export const GCE_RATE_REGION = "us-central1";
export const GCE_E2_VCPU_USD_PER_HR = 0.021811;
export const GCE_E2_GB_USD_PER_HR = 0.002923;
export const GCE_E2_SPOT_PRICE_MULTIPLIER = 0.6;
export const GCE_DISK_USD_PER_GB_MONTH = {
    "pd-standard": 0.04,
    "pd-balanced": 0.1,
    "pd-ssd": 0.17,
};
const E2_SHARED_CORE_SHAPES = {
    "e2-micro": { vcpu: 0.25, gb: 1 },
    "e2-small": { vcpu: 0.5, gb: 2 },
    "e2-medium": { vcpu: 1, gb: 4 },
};
const E2_GB_PER_VCPU = { standard: 4, highmem: 8, highcpu: 1 };
export function estimateGatewayMonthlyCost(tier, opts = {}) {
    const preset = TIER_PRESETS[tier];
    const pricingMode = opts.pricingMode ?? "on-demand";
    const onDemandCompute = computeMonthlyUsd(preset);
    const compute = onDemandCompute * priceMultiplierFor(pricingMode);
    return {
        computeUsd: Math.round(compute),
        onDemandComputeUsd: Math.round(onDemandCompute),
        savingsUsd: Math.max(0, Math.round(onDemandCompute) - Math.round(compute)),
        pricingMode,
        perUserAtTarget: Math.round(compute / preset.capacity.targetActiveUsers),
        perUserAtTypical: Math.round(compute / preset.capacity.typicalUsers),
    };
}
export function estimateFleetMonthlyCost(inputs) {
    const byTier = {};
    let total = 0;
    let onDemandTotal = 0;
    for (const input of inputs) {
        const tier = typeof input === "string" ? input : input.tier;
        const pricingMode = typeof input === "string" ? "on-demand" : input.pricingMode;
        const cost = estimateGatewayMonthlyCost(tier, { pricingMode });
        total += cost.computeUsd;
        onDemandTotal += cost.onDemandComputeUsd;
        const entry = byTier[tier] ?? {
            count: 0,
            subtotalUsd: 0,
            onDemandSubtotalUsd: 0,
            spotCount: 0,
            onDemandCount: 0,
        };
        entry.count += 1;
        entry.subtotalUsd += cost.computeUsd;
        entry.onDemandSubtotalUsd += cost.onDemandComputeUsd;
        if (cost.pricingMode === "spot")
            entry.spotCount += 1;
        else
            entry.onDemandCount += 1;
        byTier[tier] = entry;
    }
    return {
        totalUsd: total,
        onDemandTotalUsd: onDemandTotal,
        savingsUsd: Math.max(0, onDemandTotal - total),
        byTier,
    };
}
function e2BilledShape(machineType) {
    if (Object.prototype.hasOwnProperty.call(E2_SHARED_CORE_SHAPES, machineType))
        return E2_SHARED_CORE_SHAPES[machineType];
    const predefined = /^e2-(standard|highmem|highcpu)-(\d+)$/.exec(machineType);
    if (!predefined)
        return null;
    const vcpu = parseInt(predefined[2], 10);
    return { vcpu, gb: vcpu * E2_GB_PER_VCPU[predefined[1]] };
}
export function estimateVmGatewayMonthlyCost(input) {
    const shape = e2BilledShape(input.machineType);
    const inRateRegion = input.zones.length > 0 && input.zones.every((zone) => zone.startsWith(`${GCE_RATE_REGION}-`));
    if (!inRateRegion || !shape || input.disks.some((disk) => !Object.prototype.hasOwnProperty.call(GCE_DISK_USD_PER_GB_MONTH, disk.type)))
        return null;
    const pricingMode = input.provisioningModel === "SPOT" ? "spot" : "on-demand";
    const onDemandCompute = input.running
        ? (shape.vcpu * GCE_E2_VCPU_USD_PER_HR + shape.gb * GCE_E2_GB_USD_PER_HR) * HOURS_PER_MONTH
        : 0;
    const compute = onDemandCompute * (pricingMode === "spot" ? GCE_E2_SPOT_PRICE_MULTIPLIER : 1);
    const storage = input.disks.reduce((sum, disk) => sum + disk.sizeGb * GCE_DISK_USD_PER_GB_MONTH[disk.type], 0);
    return {
        computeUsd: Math.round(compute),
        onDemandComputeUsd: Math.round(onDemandCompute),
        savingsUsd: Math.max(0, Math.round(onDemandCompute) - Math.round(compute)),
        storageUsd: Math.round(storage),
        totalUsd: Math.round(compute + storage),
        onDemandTotalUsd: Math.round(onDemandCompute + storage),
        pricingMode,
    };
}
function computeMonthlyUsd(preset) {
    const vcpu = parseMillicores(preset.resources.requests.cpu) / 1000;
    const gib = parseGiB(preset.resources.requests.memory);
    return (vcpu * AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR * HOURS_PER_MONTH +
        gib * AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR * HOURS_PER_MONTH);
}
function priceMultiplierFor(mode) {
    return mode === "spot" ? SPOT_PRICE_MULTIPLIER : 1;
}
function parseMillicores(s) {
    const m = /^(\d+)m$/.exec(s);
    if (!m)
        throw new Error(`cost-estimator: unexpected cpu format "${s}" — expected "<N>m"`);
    return parseInt(m[1], 10);
}
function parseGiB(s) {
    const m = /^(\d+)Gi$/.exec(s);
    if (!m)
        throw new Error(`cost-estimator: unexpected memory format "${s}" — expected "<N>Gi"`);
    return parseInt(m[1], 10);
}
