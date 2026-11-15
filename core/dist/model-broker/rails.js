import { exhaustedSpendBudget, } from "@octogee/shared/types/model-broker-usage";
import { readPlatformSpendState } from "./usage-allowance.js";
import { WebResearchError } from "./web-research-error.js";
export const CHARGE_AT_COST = Object.freeze({ priceMultiplier: 1, balanceDebit: null });
export class UnknownModelBrokerRailError extends Error {
    railId;
    constructor(railId) {
        super(`model broker rail is not registered: ${JSON.stringify(railId)}`);
        this.railId = railId;
        this.name = "UnknownModelBrokerRailError";
    }
}
export function createModelBrokerRailRegistry(input) {
    const byId = new Map(input.rails.map((rail) => [rail.id, rail]));
    if (byId.size !== input.rails.length)
        throw new Error("model broker rail ids must be unique");
    if (!byId.has(input.defaultRailId)) {
        throw new Error(`default model broker rail is not registered: ${JSON.stringify(input.defaultRailId)}`);
    }
    return {
        defaultRailId: input.defaultRailId,
        railIds: input.rails.map((rail) => rail.id),
        rail(id) {
            const rail = byId.get(id);
            if (!rail)
                throw new UnknownModelBrokerRailError(id);
            return rail;
        },
        resolveOwnerProfile: input.resolveOwnerProfile ?? (() => null),
        budgetInspection: input.budgetInspection ?? (() => ({})),
        balanceLedger: input.balanceLedger ?? (() => null),
    };
}
export async function requireSpendWindowAllowance(input, onExhaustedWithoutHouse) {
    const state = await readPlatformSpendState({
        usageStore: input.usageStore,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid,
        now: input.now,
        spendWindowUsd: input.grant.limits.spendWindowUsd,
        spendWeekUsd: input.grant.limits.spendWeekUsd,
    });
    if (!state.available) {
        throw new WebResearchError("billing_unavailable", 503, "Platform allowance gate unavailable");
    }
    if (state.exhausted) {
        if (input.grant.policy.houseFallback === false)
            return onExhaustedWithoutHouse();
        throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
    }
    return { countsTowardSpendWindow: true, charge: CHARGE_AT_COST };
}
export const OPERATOR_RAIL_ID = "operator";
const PRODUCT_POLICY_REFUSED = {
    kind: "denied",
    decision: { allowed: false, status: 503, error: "free-tier policy needs a product model broker rail" },
};
export const operatorRail = {
    id: OPERATOR_RAIL_ID,
    requiresGate: (grant) => grant.policy.freeTier,
    gate: async (ctx) => (ctx.grant.policy.freeTier ? PRODUCT_POLICY_REFUSED : null),
    budgetExhausted: async () => ({
        kind: "denied",
        decision: {
            allowed: false,
            status: 402,
            error: "model budget exhausted for this window and no house model is configured",
        },
    }),
    meter: ({ gate }) => ({ countsTowardSpendWindow: !gate.degrade, charge: CHARGE_AT_COST }),
    allowance: (input) => requireSpendWindowAllowance(input, async () => {
        throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
    }),
    throttle: (observation) => {
        const exhausted = observation.onOwnerCredential ? null : exhaustedSpendBudget(observation);
        if (!exhausted)
            return { degraded: false, blocked: false, reason: null, balanceVisible: false };
        return {
            degraded: observation.houseFallback,
            blocked: !observation.houseFallback,
            reason: `${exhausted}_exhausted`,
            balanceVisible: false,
        };
    },
    logFields: () => ({}),
};
export function operatorRailRegistry() {
    return createModelBrokerRailRegistry({ rails: [operatorRail], defaultRailId: OPERATOR_RAIL_ID });
}
