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

export type FundedBudgetStanding =
  | { state: "funded" }
  | { state: "awaiting_increase"; increaseAtMs: number }
  | { state: "exhausted" };

export type FundedBudgetInterruptionHandler = (input: {
  uid: string;
  reason: FundedBudgetInterruption;
}) => void | Promise<void>;

function nonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseFundedBudgetLedger(
  value: unknown,
  ref: FundedBudgetLedgerRef,
): FundedBudgetLedger | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const bound = raw.ownerUid === ref.ownerUid &&
    Object.entries(ref.ledgerBinding).every(([field, expected]) => raw[field] === expected);
  if (
    !bound ||
    !nonNegativeFiniteNumber(raw.chargeUsd) ||
    !nonNegativeSafeInteger(raw.requestCount) ||
    !nonNegativeSafeInteger(raw.totalTokens) ||
    !nonNegativeFiniteNumber(raw.updatedAt)
  ) {
    return null;
  }
  return {
    chargeUsd: raw.chargeUsd,
    requestCount: raw.requestCount,
    totalTokens: raw.totalTokens,
    updatedAt: raw.updatedAt,
  };
}

export function fundedBudgetStanding(
  budget: FundedBudget,
  ledger: FundedBudgetLedger,
  nowMs: number,
): FundedBudgetStanding {
  if (nowMs >= budget.expiresAtMs) return { state: "exhausted" };
  if (ledger.chargeUsd < Math.min(budget.capUsd, budget.hardCapUsd)) return { state: "funded" };
  return budget.nextCapIncreaseAtMs !== null && ledger.chargeUsd < budget.hardCapUsd
    ? { state: "awaiting_increase", increaseAtMs: budget.nextCapIncreaseAtMs }
    : { state: "exhausted" };
}
