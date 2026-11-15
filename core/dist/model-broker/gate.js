import { readPlatformSpendState } from "./usage-allowance.js";
export async function spendWindowGate(ctx, spendWindowUsd, spendWeekUsd) {
    const state = await readPlatformSpendState({
        usageStore: ctx.usageStore,
        gatewayId: ctx.gatewayId,
        ownerUid: ctx.ownerUid,
        now: ctx.now(),
        spendWindowUsd,
        spendWeekUsd,
    });
    if (!state.available) {
        return { allowed: false, status: 503, error: "model broker spend gate unavailable" };
    }
    return {
        degrade: state.exhausted,
        windowCostUsd: state.windowChargeUsd,
        weekCostUsd: state.weekChargeUsd,
    };
}
