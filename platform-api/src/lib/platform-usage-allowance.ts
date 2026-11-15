import type { ModelBrokerUsageStore } from "./model-broker-usage.js";

export function meterExhausted(spendUsd: number | null, budgetUsd: number | null): boolean {
  return spendUsd !== null && budgetUsd !== null && spendUsd >= budgetUsd;
}

function chargeUsd(value: { chargeUsd?: number; costUsd: number }): number {
  return typeof value.chargeUsd === "number" && Number.isFinite(value.chargeUsd)
    ? value.chargeUsd
    : value.costUsd;
}

export async function readPlatformSpendState(input: {
  usageStore?: ModelBrokerUsageStore;
  gatewayId: string;
  ownerUid: string | null;
  now: number;
  spendWindowUsd: number | null;
  spendWeekUsd: number | null;
}): Promise<
  | { available: false }
  | {
      available: true;
      windowChargeUsd: number | null;
      weekChargeUsd: number | null;
      exhausted: boolean;
    }
> {
  if (
    (input.spendWindowUsd !== null && !input.usageStore?.readWindowUsage) ||
    (input.spendWeekUsd !== null && !input.usageStore?.readWeekUsage)
  ) {
    return { available: false };
  }
  const readInput = {
    gatewayId: input.gatewayId,
    ownerUid: input.ownerUid,
    now: input.now,
  };
  const [windowChargeUsd, weekChargeUsd] = await Promise.all([
    input.spendWindowUsd === null
      ? Promise.resolve(null)
      : input.usageStore!.readWindowUsage!(readInput).then(chargeUsd),
    input.spendWeekUsd === null
      ? Promise.resolve(null)
      : input.usageStore!.readWeekUsage!(readInput).then(chargeUsd),
  ]);
  return {
    available: true,
    windowChargeUsd,
    weekChargeUsd,
    exhausted:
      meterExhausted(windowChargeUsd, input.spendWindowUsd) ||
      meterExhausted(weekChargeUsd, input.spendWeekUsd),
  };
}
