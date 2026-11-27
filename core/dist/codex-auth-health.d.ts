export type CodexAuthHealth = "ok" | "needs_reauth";
export declare function deriveCodexAuthHealth(authStateText: string | null | undefined, profileId: string, now: number): CodexAuthHealth;
export interface SubscriptionAuthTarget {
    agentId: string;
    provider: "openai" | "anthropic";
    profileId: string;
    readAuthState: () => Promise<string | null>;
}
export interface SubscriptionAuthRejection {
    agentId: string;
    provider: SubscriptionAuthTarget["provider"];
    observedAt: number;
}
export declare function checkSubscriptionAuthHealth(opts: {
    targets: readonly SubscriptionAuthTarget[];
    now: number;
    signalNeedsReauth: (rejection: SubscriptionAuthRejection) => Promise<void>;
    logFn?: (m: string) => void;
}): Promise<{
    checked: number;
    needsReauth: number;
    signalled: number;
}>;
