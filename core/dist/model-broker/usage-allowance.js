export function meterExhausted(spendUsd, budgetUsd) {
    return spendUsd !== null && budgetUsd !== null && spendUsd >= budgetUsd;
}
function chargeUsd(value) {
    return typeof value.chargeUsd === "number" && Number.isFinite(value.chargeUsd)
        ? value.chargeUsd
        : value.costUsd;
}
export async function readPlatformSpendState(input) {
    if ((input.spendWindowUsd !== null && !input.usageStore?.readWindowUsage) ||
        (input.spendWeekUsd !== null && !input.usageStore?.readWeekUsage)) {
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
            : input.usageStore.readWindowUsage(readInput).then(chargeUsd),
        input.spendWeekUsd === null
            ? Promise.resolve(null)
            : input.usageStore.readWeekUsage(readInput).then(chargeUsd),
    ]);
    return {
        available: true,
        windowChargeUsd,
        weekChargeUsd,
        exhausted: meterExhausted(windowChargeUsd, input.spendWindowUsd) ||
            meterExhausted(weekChargeUsd, input.spendWeekUsd),
    };
}
