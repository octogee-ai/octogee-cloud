export interface FundedBudgetLedgerRef {
    ownerUid: string;
    ledgerCollection: string;
    ledgerKey: string;
    ledgerBinding: Readonly<Record<string, string | number>>;
    ledgerRetentionMs: number;
}
export interface FundedBudget extends FundedBudgetLedgerRef {
    expiresAtMs: number;
    capUsd: number;
    hardCapUsd: number;
    nextCapIncreaseAtMs: number | null;
    logFields: Readonly<Record<string, string | number>>;
}
export interface FundedBudgetLedger {
    chargeUsd: number;
    requestCount: number;
    totalTokens: number;
    updatedAt: number;
}
export type FundedBudgetInterruption = "awaiting_increase" | "exhausted";
export type FundedBudgetStanding = {
    state: "funded";
} | {
    state: "awaiting_increase";
    increaseAtMs: number;
} | {
    state: "exhausted";
};
export type FundedBudgetInterruptionHandler = (input: {
    uid: string;
    reason: FundedBudgetInterruption;
}) => void | Promise<void>;
export declare function parseFundedBudgetLedger(value: unknown, ref: FundedBudgetLedgerRef): FundedBudgetLedger | null;
export declare function fundedBudgetStanding(budget: FundedBudget, ledger: FundedBudgetLedger, nowMs: number): FundedBudgetStanding;
