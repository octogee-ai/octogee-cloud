import { type SizingTier } from "./sizing.js";
export declare const AUTOPILOT_GENERAL_PURPOSE_VCPU_USD_PER_HR = 0.0445;
export declare const AUTOPILOT_GENERAL_PURPOSE_GIB_USD_PER_HR = 0.0049225;
export declare const AUTOPILOT_EPHEMERAL_STORAGE_GIB_USD_PER_HR = 0.0000548;
export declare const HOURS_PER_MONTH = 730;
export declare const SPOT_PRICE_MULTIPLIER = 0.3;
export declare const GCE_RATE_REGION = "us-central1";
export declare const GCE_E2_VCPU_USD_PER_HR = 0.021811;
export declare const GCE_E2_GB_USD_PER_HR = 0.002923;
export declare const GCE_E2_SPOT_PRICE_MULTIPLIER = 0.6;
export declare const GCE_DISK_USD_PER_GB_MONTH: Readonly<Record<string, number>>;
export type GatewayPricingMode = "on-demand" | "spot";
export interface VmGatewayCostInput {
    zones: readonly string[];
    machineType: string;
    provisioningModel: "SPOT" | "STANDARD";
    disks: ReadonlyArray<{
        type: string;
        sizeGb: number;
    }>;
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
export declare function gatewayPodRequests(tier: SizingTier, opts?: {
    ephemeralHomeGiB?: number;
}): GatewayPodRequests;
export declare function estimateGatewayMonthlyCost(tier: SizingTier, opts?: {
    pricingMode?: GatewayPricingMode;
    ephemeralHomeGiB?: number;
}): GatewayMonthlyCost;
export declare function estimateFleetMonthlyCost(inputs: Array<SizingTier | {
    tier: SizingTier;
    pricingMode?: GatewayPricingMode;
}>): FleetMonthlyCost;
export declare function estimateVmGatewayMonthlyCost(input: VmGatewayCostInput): VmGatewayMonthlyCost | null;
