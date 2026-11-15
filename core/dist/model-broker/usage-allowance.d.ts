import type { ModelBrokerUsageStore } from "./usage.js";
export declare function meterExhausted(spendUsd: number | null, budgetUsd: number | null): boolean;
export declare function readPlatformSpendState(input: {
    usageStore?: ModelBrokerUsageStore;
    gatewayId: string;
    ownerUid: string | null;
    now: number;
    spendWindowUsd: number | null;
    spendWeekUsd: number | null;
}): Promise<{
    available: false;
} | {
    available: true;
    windowChargeUsd: number | null;
    weekChargeUsd: number | null;
    exhausted: boolean;
}>;
