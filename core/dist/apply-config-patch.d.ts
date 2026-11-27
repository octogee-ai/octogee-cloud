import { OpenclawWireError, type GatewayRpcClient } from "./gateway-rpc.js";
export interface ApplyConfigPatchArgs {
    buildPatch: (current: unknown) => object;
    /** Paths to confirm against the gateway's destructive-array guard: config.patch rejects a
     *  patch whose merge would drop array entries unless each shrunk array's exact path is named
     *  in replacePaths. Recomputed per attempt against the freshly-fetched config (same contract
     *  as buildPatch, which it always accompanies on retry). */
    buildReplacePaths?: (current: unknown) => string[];
    logPrefix?: string;
    skipIfAlreadyApplied?: boolean;
    /** Runs after a failed attempt's backoff, before the next attempt. Returning false
     *  declines the retry and bubbles that attempt's failure. */
    beforeRetry?: () => Promise<boolean>;
}
export interface ConfigCache {
    current: unknown;
    hash: string;
}
export interface ApplyConfigPatchOptions {
    rpc?: GatewayRpcClient;
    log?: (msg: string) => void;
    retryBackoffInitialMs?: number;
    retryBackoffMaxMs?: number;
    maxRetries?: number;
    totalDeadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    cache?: ConfigCache;
    signal?: AbortSignal;
}
export interface ConfigPatchRetryPlan {
    delayMs: number;
    missingRetryAfterHint: boolean;
    source: "server retry-after" | "exp backoff";
}
export declare function configPatchRetryPlan(err: OpenclawWireError, currentBackoffMs: number, remainingMs: number): ConfigPatchRetryPlan;
export declare function mergePatchValueAlreadyApplied(current: unknown, patch: unknown): boolean;
export declare function isPermanentConfigPatchFailure(err: unknown): boolean;
export interface ApplyConfigPatchResult {
    mode: "rpc";
    attempts: number;
    noop?: boolean;
    superseded?: boolean;
}
export declare function applyConfigPatch(args: ApplyConfigPatchArgs, opts?: ApplyConfigPatchOptions): Promise<ApplyConfigPatchResult>;
export declare function upsertAgentInFullAgentList(current: unknown, agentId: string, agentEntry: unknown): unknown[];
export declare function replaceUserAgentsInFullAgentList(current: unknown, slug: string, agentEntries: readonly unknown[]): unknown[];
export declare function orderIsolatedGatewayRoster<T>(agents: readonly T[], userDefaultAgentId: string, anchorAgentId: string): T[];
/**
 * After the first mount, model authority belongs to the byot-sync pipeline
 * (BYOK overrides, house pins, picker selections) — the attach path re-ships
 * each user entry wholesale, so re-seeding a compiled default here would
 * revert that pipeline's write on every re-attach and the follow-up sync
 * would flip it back: two config writes and two agent restarts per converge
 * (observed live 2026-08-14 on shared-a). An agent whose current entry
 * carries a model keeps it verbatim; an entry without one (first mount, or
 * created-but-unseeded) keeps its seed — no pipeline path ever deletes a
 * model, so seeding on absence converges in one write and stays put.
 */
export declare function preserveMountedAgentModels(current: unknown, agentEntries: readonly unknown[]): unknown[];
/**
 * The user's slice of the agent roster, as a merge patch that only ever
 * ADDS or UPDATES. openclaw 2026.7.2 refuses any config write whose canonical
 * roster loses an entry unless the write carries `allowedAgentRosterRemovals`,
 * which only its own `agents.delete` supplies — so a retired project agent is
 * deleted by RPC before the patch, never nulled inside it.
 */
export declare function userAgentRosterPatch(current: unknown, slug: string, agentEntries: readonly unknown[]): {
    list: unknown[];
} | {
    entries: Record<string, Record<string, unknown>>;
};
/**
 * Drops the user's bindings. A binding on a channel other than Mattermost is
 * kept when its agent is in `retainedAgentIds`: the platform writes only
 * Mattermost bindings, so another channel's binding belongs to whatever added it.
 */
export declare function filterOutUserBindings<T>(bindings: readonly T[], slug: string, retainedAgentIds?: ReadonlySet<unknown>): T[];
export declare function mergeUserBindings<T extends {
    agentId?: unknown;
}>(current: readonly T[], slugs: readonly string[], nextUserBindings: readonly T[]): readonly T[];
export declare function staleProjectAgentAccountNulls(current: unknown, slug: string, keepAccountIds: readonly string[]): Record<string, null>;
/**
 * The replacePaths set for user config patches that rebuild non-id arrays:
 * `bindings` plus every array under the slug's MM accounts. Add/re-ensure patches
 * intentionally omit `agents.list` so a one-agent upsert stays an id-keyed merge
 * instead of becoming whole-list replacement.
 */
export declare function userConfigReplacePaths(current: unknown, slug: string): string[];
/**
 * The guard confirmation set for any patch that ships the full `agents.list`.
 * `agents.list` alone is NOT enough: the gateway's destructive-array guard
 * descends INTO id-keyed array entries and reports a shrunk nested array as its
 * own `agents.list[].<field>` path, filtered against replacePaths individually
 * (openclaw server-methods/config.ts, collectDestructiveIdKeyedArrayEntryPatchPaths).
 * The per-entry arrays the platform itself rewrites: `model.fallbacks` shrinks on
 * the BYOK-override → house-pin transition ({primary, fallbacks: [house]} →
 * {primary: house, fallbacks: []}) and whenever a string model replaces an object
 * one; `tools.alsoAllow` shrinks when the free-tier trim overwrites a different
 * existing block. Observed live 2026-07-09: every reconcile tick refused with
 * "would remove entries from array path(s): agents.list[].model.fallbacks".
 */
export declare function fullAgentListReplacePaths(): string[];
/**
 * The replacePaths set for user config patches that intentionally ship the full
 * post-filter `agents.list` from the current config. Only use this when the patch's
 * `agents.list` is a complete replacement candidate, not a single-agent upsert.
 */
export declare function userConfigFullAgentListReplacePaths(current: unknown, slug: string): string[];
export declare function userConfigAgentRosterReplacePaths(current: unknown, slug: string, additionalAgentIds?: readonly string[]): string[];
