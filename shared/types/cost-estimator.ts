import {
  EPHEMERAL_HOME_SCRATCH_GIB,
  GATEWAY_EDGE_RESOURCES,
  TIER_PRESETS,
  type SizingTier,
} from "./sizing.js";

// GKE Autopilot general-purpose Pod request rates, us-central1, read from the
// Cloud Billing catalog on 2026-11-27 (SKUs 3194-8714-B3AD, C097-3083-F510,
// B19B-620C-1023; Spot C44C-2ABF-4CF9, C95A-9145-553A). Spot CPU and memory are
// 0.3 of the regular rate; ephemeral storage has one rate whatever the capacity.
// Excludes egress, LB, GCS and the cluster fee.
export const AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR = 0.0445;
export const AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR = 0.0049225;
export const AUTOPILOT_EPHEMERAL_STORAGE_GIB_USD_PER_HR = 0.0000548;
export const HOURS_PER_MONTH = 730;
export const SPOT_PRICE_MULTIPLIER = 0.3;

// Published Compute Engine rates for us-central1: E2 machines are billed per
// vCPU and per GB, shared-core E2 types at a fraction of a vCPU. Spot E2 was
// 40% off the regular rate when these were read (2026-11).
export const GCE_RATE_REGION = "us-central1";
export const GCE_E2_VCPU_USD_PER_HR = 0.021811;
export const GCE_E2_GB_USD_PER_HR = 0.002923;
export const GCE_E2_SPOT_PRICE_MULTIPLIER = 0.6;
export const GCE_DISK_USD_PER_GB_MONTH: Readonly<Record<string, number>> = {
  "pd-standard": 0.04,
  "pd-balanced": 0.1,
  "pd-ssd": 0.17,
};

const E2_SHARED_CORE_SHAPES: Readonly<Record<string, { vcpu: number; gb: number }>> = {
  "e2-micro": { vcpu: 0.25, gb: 1 },
  "e2-small": { vcpu: 0.5, gb: 2 },
  "e2-medium": { vcpu: 1, gb: 4 },
};
const E2_GB_PER_VCPU: Readonly<Record<string, number>> = { standard: 4, highmem: 8, highcpu: 1 };

export type GatewayPricingMode = "on-demand" | "spot";

export interface VmGatewayCostInput {
  zones: readonly string[];
  machineType: string;
  provisioningModel: "SPOT" | "STANDARD";
  disks: ReadonlyArray<{ type: string; sizeGb: number }>;
  running: boolean;
}

export interface VmGatewayMonthlyCost {
  computeUsd: number;
  onDemandComputeUsd: number;
  savingsUsd: number;
  storageUsd: number;
  totalUsd: number;
  onDemandTotalUsd: number;
  pricingMode: GatewayPricingMode;
}

export interface GatewayPodRequests {
  vcpu: number;
  memoryGiB: number;
  ephemeralStorageGiB: number;
}

export interface GatewayMonthlyCost {
  computeUsd: number;
  onDemandComputeUsd: number;
  savingsUsd: number;
  storageUsd: number;
  totalUsd: number;
  onDemandTotalUsd: number;
  pricingMode: GatewayPricingMode;
  perUserAtTarget: number;
  perUserAtTypical: number;
}

export interface FleetMonthlyCost {
  totalUsd: number;
  onDemandTotalUsd: number;
  savingsUsd: number;
  byTier: Partial<Record<SizingTier, {
    count: number;
    subtotalUsd: number;
    onDemandSubtotalUsd: number;
    spotCount: number;
    onDemandCount: number;
  }>>;
}

export function gatewayPodRequests(
  tier: SizingTier,
  opts: { ephemeralHomeGiB?: number } = {},
): GatewayPodRequests {
  const gateway = TIER_PRESETS[tier].resources.requests;
  const edge = GATEWAY_EDGE_RESOURCES.requests;
  const gatewayEphemeralGiB = opts.ephemeralHomeGiB === undefined
    ? parseGiB(requiredEphemeralStorage(gateway, `tier ${tier}`))
    : opts.ephemeralHomeGiB + EPHEMERAL_HOME_SCRATCH_GIB.builderCache + EPHEMERAL_HOME_SCRATCH_GIB.tmp;
  return {
    vcpu: (parseMillicores(gateway.cpu) + parseMillicores(edge.cpu)) / 1000,
    memoryGiB: parseGiB(gateway.memory) + parseGiB(edge.memory),
    ephemeralStorageGiB: gatewayEphemeralGiB + parseGiB(requiredEphemeralStorage(edge, "gateway edge")),
  };
}

export function estimateGatewayMonthlyCost(
  tier: SizingTier,
  opts: { pricingMode?: GatewayPricingMode; ephemeralHomeGiB?: number } = {},
): GatewayMonthlyCost {
  const preset = TIER_PRESETS[tier];
  const pricingMode = opts.pricingMode ?? "on-demand";
  const requests = gatewayPodRequests(tier, { ephemeralHomeGiB: opts.ephemeralHomeGiB });
  const onDemandCompute =
    (requests.vcpu * AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR + requests.memoryGiB * AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR) *
    HOURS_PER_MONTH;
  const compute = onDemandCompute * priceMultiplierFor(pricingMode);
  const storage = requests.ephemeralStorageGiB * AUTOPILOT_EPHEMERAL_STORAGE_GIB_USD_PER_HR * HOURS_PER_MONTH;
  return {
    computeUsd: Math.round(compute),
    onDemandComputeUsd: Math.round(onDemandCompute),
    savingsUsd: Math.max(0, Math.round(onDemandCompute) - Math.round(compute)),
    storageUsd: Math.round(storage),
    totalUsd: Math.round(compute + storage),
    onDemandTotalUsd: Math.round(onDemandCompute + storage),
    pricingMode,
    perUserAtTarget: Math.round((compute + storage) / preset.capacity.targetActiveUsers),
    perUserAtTypical: Math.round((compute + storage) / preset.capacity.typicalUsers),
  };
}

export function estimateFleetMonthlyCost(
  inputs: Array<SizingTier | { tier: SizingTier; pricingMode?: GatewayPricingMode }>,
): FleetMonthlyCost {
  const byTier: FleetMonthlyCost["byTier"] = {};
  let total = 0;
  let onDemandTotal = 0;
  for (const input of inputs) {
    const tier = typeof input === "string" ? input : input.tier;
    const pricingMode = typeof input === "string" ? "on-demand" : input.pricingMode;
    const cost = estimateGatewayMonthlyCost(tier, { pricingMode });
    total += cost.totalUsd;
    onDemandTotal += cost.onDemandTotalUsd;
    const entry = byTier[tier] ?? {
      count: 0,
      subtotalUsd: 0,
      onDemandSubtotalUsd: 0,
      spotCount: 0,
      onDemandCount: 0,
    };
    entry.count += 1;
    entry.subtotalUsd += cost.totalUsd;
    entry.onDemandSubtotalUsd += cost.onDemandTotalUsd;
    if (cost.pricingMode === "spot") entry.spotCount += 1;
    else entry.onDemandCount += 1;
    byTier[tier] = entry;
  }
  return {
    totalUsd: total,
    onDemandTotalUsd: onDemandTotal,
    savingsUsd: Math.max(0, onDemandTotal - total),
    byTier,
  };
}

function e2BilledShape(machineType: string): { vcpu: number; gb: number } | null {
  if (Object.prototype.hasOwnProperty.call(E2_SHARED_CORE_SHAPES, machineType)) return E2_SHARED_CORE_SHAPES[machineType];
  const predefined = /^e2-(standard|highmem|highcpu)-(\d+)$/.exec(machineType);
  if (!predefined) return null;
  const vcpu = parseInt(predefined[2], 10);
  return { vcpu, gb: vcpu * E2_GB_PER_VCPU[predefined[1]] };
}

export function estimateVmGatewayMonthlyCost(input: VmGatewayCostInput): VmGatewayMonthlyCost | null {
  const shape = e2BilledShape(input.machineType);
  const inRateRegion = input.zones.length > 0 && input.zones.every((zone) => zone.startsWith(`${GCE_RATE_REGION}-`));
  if (!inRateRegion || !shape || input.disks.some((disk) => !Object.prototype.hasOwnProperty.call(GCE_DISK_USD_PER_GB_MONTH, disk.type))) return null;
  const pricingMode: GatewayPricingMode = input.provisioningModel === "SPOT" ? "spot" : "on-demand";
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

function requiredEphemeralStorage(requests: { "ephemeral-storage"?: string }, owner: string): string {
  const quantity = requests["ephemeral-storage"];
  if (!quantity) throw new Error(`cost-estimator: ${owner} has no ephemeral-storage request`);
  return quantity;
}

function priceMultiplierFor(mode: GatewayPricingMode): number {
  return mode === "spot" ? SPOT_PRICE_MULTIPLIER : 1;
}

function parseMillicores(s: string): number {
  const m = /^(\d+)m$/.exec(s);
  if (!m) throw new Error(`cost-estimator: unexpected cpu format "${s}" — expected "<N>m"`);
  return parseInt(m[1], 10);
}

function parseGiB(s: string): number {
  const m = /^(\d+)(Gi|Mi)$/.exec(s);
  if (!m) throw new Error(`cost-estimator: unexpected quantity "${s}" — expected "<N>Gi" or "<N>Mi"`);
  return m[2] === "Gi" ? parseInt(m[1], 10) : parseInt(m[1], 10) / 1024;
}
