import type { ConditionStatus, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import type { PlatformStateStore } from "./platform-state/store.js";
import { type ProvisioningServiceClient } from "./provisioning-service-client.js";
import { type ProvisioningMirrorOutcome, type UserAccountDocuments } from "./provisioning-mirror.js";
import type { ProvisioningProjection } from "./provisionSteps.js";
export declare const PROVISIONING_SPEC_BACKFILL_KEY = "provisioning-service-spec-backfill";
export declare const PROVISIONING_SYNC_CONCURRENCY = 4;
export declare const PROVISIONING_SYNC_RETRY: {
    readonly baseDelayMs: 5000;
    readonly maxDelayMs: 600000;
};
export declare const PROVISIONING_SYNC_RESYNC_MS: number;
export type SpecWriteOutcome = "created" | "changed" | "unchanged" | "not-admitted" | "being-erased";
export interface ProvisioningReadiness {
    readonly status: ConditionStatus;
    readonly reason: string;
}
export interface ProvisioningSyncCounters {
    specWrites: Record<SpecWriteOutcome | "failed", number>;
    deletes: Record<"deleted" | "kept" | "unreadable" | "unnameable" | "failed", number>;
    mirrors: Record<ProvisioningMirrorOutcome | "failed", number>;
    watchFailures: number;
    watchConnected: boolean;
}
export interface ProvisioningSyncDeps {
    readonly store: PlatformStateStore;
    readonly client: ProvisioningServiceClient;
    readonly documents: UserAccountDocuments;
    readonly projection: ProvisioningProjection;
    readonly proxyUrl: string | null;
    readonly log: (message: string) => void;
    readonly now?: () => number;
    readonly random?: () => number;
    readonly watchTimeoutSeconds?: number;
    readonly retry?: {
        readonly baseDelayMs: number;
        readonly maxDelayMs: number;
    };
    readonly resyncMs?: number;
}
export interface BackfillSummary {
    readonly users: number;
    readonly written: number;
    readonly unchanged: number;
    readonly failed: number;
}
export interface SpecWriteFailure {
    readonly uid: string;
    readonly reason: string;
    readonly attempts: number;
    readonly since: string;
}
export type MirrorRefusalOutcome = Extract<ProvisioningMirrorOutcome, "chat-id-mismatch" | "slug-mismatch">;
export interface MirrorRefusal {
    readonly uid: string;
    readonly outcome: MirrorRefusalOutcome;
    readonly reason: string;
    readonly since: string;
}
export interface ProvisioningSync {
    readonly counters: ProvisioningSyncCounters;
    readiness(uid: string): ProvisioningReadiness | null;
    observed(uid: string): UserProvisioning | undefined;
    markDirty(uid: string): void;
    specFailures(): readonly SpecWriteFailure[];
    mirrorRefusals(): readonly MirrorRefusal[];
    resync(): Promise<void>;
    writeSpec(uid: string): Promise<SpecWriteOutcome>;
    backfill(): Promise<BackfillSummary>;
    snapshotLoaded(): Promise<void>;
    start(): () => void;
}
export declare function runJournaledBackfill<T>(store: PlatformStateStore, run: () => Promise<T>, now?: () => number): Promise<{
    journaled: boolean;
    result: T;
}>;
export declare function markCloudTeardown(store: Pick<PlatformStateStore, "transaction">, uid: string): Promise<"marked" | "absent">;
export declare function createProvisioningSync(deps: ProvisioningSyncDeps): ProvisioningSync;
