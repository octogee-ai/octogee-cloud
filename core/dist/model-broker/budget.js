function nonNegativeFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function nonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
export function parseFundedBudgetLedger(value, ref) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    const bound = raw.ownerUid === ref.ownerUid &&
        Object.entries(ref.ledgerBinding).every(([field, expected]) => raw[field] === expected);
    if (!bound ||
        !nonNegativeFiniteNumber(raw.chargeUsd) ||
        !nonNegativeSafeInteger(raw.requestCount) ||
        !nonNegativeSafeInteger(raw.totalTokens) ||
        !nonNegativeFiniteNumber(raw.updatedAt)) {
        return null;
    }
    return {
        chargeUsd: raw.chargeUsd,
        requestCount: raw.requestCount,
        totalTokens: raw.totalTokens,
        updatedAt: raw.updatedAt,
    };
}
export function fundedBudgetStanding(budget, ledger, nowMs) {
    if (nowMs >= budget.expiresAtMs)
        return { state: "exhausted" };
    if (ledger.chargeUsd < Math.min(budget.capUsd, budget.hardCapUsd))
        return { state: "funded" };
    return budget.nextCapIncreaseAtMs !== null && ledger.chargeUsd < budget.hardCapUsd
        ? { state: "awaiting_increase", increaseAtMs: budget.nextCapIncreaseAtMs }
        : { state: "exhausted" };
}
