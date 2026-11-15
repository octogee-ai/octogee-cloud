import { randomUUID } from "node:crypto";
import type { ConditionStatus, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import { createKeyedRetryQueue, type KeyedRetryQueue } from "./keyed-retry-queue.js";
import {
  operationAuditDocumentId,
  resumeOperationAuditAction,
  runWithOperationAuditIntent,
  type OperationAuditIntentInput,
} from "./operation-audit.js";
import type { PlatformStateStore, WatchSubscription } from "./platform-state/store.js";
import {
  backoffDelayMs,
  compareResourceVersions,
  startProvisioningWatch,
  type ProvisioningServiceClient,
} from "./provisioning-service-client.js";
import {
  mirrorUserProvisioning,
  type ProvisioningMirrorOutcome,
  type UserAccountDocuments,
} from "./provisioning-mirror.js";
import { desiredUserProvisioningSpec, sameProvisioningSpec } from "./provisioning-spec.js";
import type { ProvisioningProjection } from "./provisionSteps.js";

export const PROVISIONING_SPEC_BACKFILL_KEY = "provisioning-service-spec-backfill";
export const PROVISIONING_SYNC_CONCURRENCY = 4;
export const PROVISIONING_SYNC_RETRY = { baseDelayMs: 5_000, maxDelayMs: 600_000 } as const;
export const PROVISIONING_SYNC_RESYNC_MS = 10 * 60_000;
const FLEET_CONTROLLER_ACTOR = "fleet-controller";

export type SpecWriteOutcome = "created" | "changed" | "unchanged" | "not-admitted";

export interface ProvisioningReadiness {
  readonly status: ConditionStatus;
  readonly reason: string;
}

export interface ProvisioningSyncCounters {
  specWrites: Record<SpecWriteOutcome | "failed", number>;
  deletes: Record<"deleted" | "kept" | "unreadable" | "failed", number>;
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
  readonly retry?: { readonly baseDelayMs: number; readonly maxDelayMs: number };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class UnreadableUserError extends Error {
  constructor(readonly uid: string, readonly cause: unknown) {
    super(`the user record of ${uid} could not be read: ${errorMessage(cause)}`);
    this.name = "UnreadableUserError";
  }
}

function newer(candidate: UserProvisioning, current: UserProvisioning | undefined): boolean {
  return current === undefined || compareResourceVersions(candidate.resourceVersion, current.resourceVersion) >= 0;
}

function emptyCounters(): ProvisioningSyncCounters {
  return {
    specWrites: { created: 0, changed: 0, unchanged: 0, "not-admitted": 0, failed: 0 },
    deletes: { deleted: 0, kept: 0, unreadable: 0, failed: 0 },
    mirrors: {
      written: 0,
      unchanged: 0,
      "chat-not-ready": 0,
      "credentials-not-issued": 0,
      "agent-not-ready": 0,
      "chat-id-mismatch": 0,
      "user-missing": 0,
      "slug-mismatch": 0,
      failed: 0,
    },
    watchFailures: 0,
    watchConnected: false,
  };
}

const BACKFILL_INTENT: OperationAuditIntentInput = {
  actor: FLEET_CONTROLLER_ACTOR,
  forced: false,
  what: "write provisioning specs for admitted users",
  why: "the provisioning service's first start with this fleet controller",
  target: { users: "admitted" },
  preActionStatus: {},
  mutation: { kind: "provisioning-spec-backfill" },
  idempotencyKey: PROVISIONING_SPEC_BACKFILL_KEY,
};

export async function runJournaledBackfill<T>(
  store: PlatformStateStore,
  run: () => Promise<T>,
  now: () => number = Date.now,
): Promise<{ journaled: boolean; result: T }> {
  const auditId = operationAuditDocumentId(PROVISIONING_SPEC_BACKFILL_KEY);
  const existing = await store.journal.audits.get(auditId);
  if (existing !== null && existing.status !== "recorded" && existing.status !== "in-progress") {
    return { journaled: false, result: await run() };
  }
  if (existing?.status === "in-progress" && typeof existing.actionClaimId === "string") {
    const result = await resumeOperationAuditAction(store, {
      auditId,
      expectedClaimId: existing.actionClaimId,
      recoveryClaimId: randomUUID(),
      externalIdempotencyKey: auditId,
      staleAfterMs: 1,
      now,
    }, run);
    return { journaled: true, result };
  }
  const result = await runWithOperationAuditIntent(store, { ...BACKFILL_INTENT, now }, { claimId: randomUUID(), now }, run);
  return { journaled: true, result };
}

async function refusalReason(store: PlatformStateStore, resource: UserProvisioning, outcome: MirrorRefusalOutcome): Promise<string> {
  if (outcome === "slug-mismatch") return `its spec names slug ${resource.spec.slug}, which the user record does not carry`;
  const held = (await store.users.records.get(resource.uid))?.mattermostUserId;
  return `the user record holds chat user ${held}, the provisioning service reports chat user ${resource.status.outputs.chat?.userId}`;
}

interface DeleterInput {
  readonly deps: ProvisioningSyncDeps;
  readonly cache: Map<string, UserProvisioning>;
  readonly counters: ProvisioningSyncCounters;
  readonly specs: KeyedRetryQueue;
  readonly now: () => number;
  readonly retryDelayMs: (attempts: number) => number;
}

function createProvisioningDeleter({ deps, cache, counters, specs, now, retryDelayMs }: DeleterInput) {
  async function currentUser(uid: string) {
    try {
      return await deps.store.users.records.get(uid);
    } catch (error) {
      throw new UnreadableUserError(uid, error);
    }
  }

  async function deleteResource(uid: string): Promise<void> {
    const user = await currentUser(uid);
    if (user !== null) {
      counters.deletes.kept += 1;
      deps.log(`[provisioning] kept the provisioning of ${uid}: its user record exists`);
      if (user.admitted) specs.enqueue(uid);
      return;
    }
    await deps.client.deleteProvisioning(uid);
    cache.delete(uid);
    counters.deletes.deleted += 1;
    deps.log(`[provisioning] deleted the provisioning of ${uid}, whose user record is gone`);
  }

  const deletes: KeyedRetryQueue = createKeyedRetryQueue({
    concurrency: PROVISIONING_SYNC_CONCURRENCY,
    now,
    retryDelayMs,
    process: deleteResource,
    onError: (uid, error, attempts) => {
      if (error instanceof UnreadableUserError) {
        counters.deletes.unreadable += 1;
        deps.log(`[provisioning] ❌ not deleting the provisioning of ${uid} (check ${attempts}): ${error.message}; re-checking later`);
        return;
      }
      counters.deletes.failed += 1;
      deps.log(`[provisioning] ⚠ could not delete the provisioning of ${uid} (attempt ${attempts}): ${errorMessage(error)}; retrying`);
    },
  });

  async function deleteOrphans(): Promise<void> {
    const uids = [...cache.keys()];
    let users: ReadonlyMap<string, unknown>;
    try {
      users = await deps.store.users.records.getMany(uids);
    } catch (error) {
      deps.log(`[provisioning] ⚠ could not read the user records behind ${uids.length} provisionings: ${errorMessage(error)}; checking each one`);
      users = new Map();
    }
    for (const uid of uids) if (!users.has(uid)) deletes.enqueue(uid);
  }

  return { deletes, deleteOrphans };
}

export function createProvisioningSync(deps: ProvisioningSyncDeps): ProvisioningSync {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const retry = deps.retry ?? PROVISIONING_SYNC_RETRY;
  const retryDelayMs = (attempts: number) => backoffDelayMs(attempts, retry, random);
  const cache = new Map<string, UserProvisioning>();
  const counters = emptyCounters();
  let resolveSnapshot: () => void = () => undefined;
  const snapshot = new Promise<void>((resolve) => {
    resolveSnapshot = resolve;
  });

  function remember(resource: UserProvisioning): void {
    if (newer(resource, cache.get(resource.uid))) cache.set(resource.uid, resource);
  }

  function forget(uid: string, resourceVersion: string): void {
    const seen = cache.get(uid);
    if (seen === undefined || compareResourceVersions(seen.resourceVersion, resourceVersion) > 0) return;
    cache.delete(uid);
    specs.enqueue(uid);
  }

  async function writeSpec(uid: string): Promise<SpecWriteOutcome> {
    const user = await deps.store.users.records.get(uid);
    if (user === null || !user.admitted || !user.slug) return "not-admitted";
    const data = await deps.documents.account(uid);
    if (data === undefined) throw new Error(`admitted user ${uid} has no account document`);
    const spec = desiredUserProvisioningSpec(uid, data);
    const seen = cache.get(uid);
    if (seen !== undefined && sameProvisioningSpec(seen.spec, spec)) return "unchanged";
    const written = await deps.client.putProvisioning(uid, spec);
    remember(written.resource);
    if (written.outcome !== "unchanged") {
      deps.log(`[provisioning] ${written.outcome} the spec of ${uid} at generation ${written.resource.generation}`);
    }
    return written.outcome;
  }

  const lastWrite = new Map<string, SpecWriteOutcome | "failed">();
  const failures = new Map<string, SpecWriteFailure>();
  const specs: KeyedRetryQueue = createKeyedRetryQueue({
    concurrency: PROVISIONING_SYNC_CONCURRENCY,
    now,
    retryDelayMs,
    process: async (uid) => {
      const outcome = await writeSpec(uid);
      counters.specWrites[outcome] += 1;
      lastWrite.set(uid, outcome);
      failures.delete(uid);
    },
    onError: (uid, error, attempts) => {
      counters.specWrites.failed += 1;
      lastWrite.set(uid, "failed");
      failures.set(uid, { uid, reason: errorMessage(error), attempts, since: failures.get(uid)?.since ?? new Date(now()).toISOString() });
      deps.log(`[provisioning] ⚠ could not write the spec of ${uid} (attempt ${attempts}): ${errorMessage(error)}; retrying`);
    },
  });

  const refusals = new Map<string, MirrorRefusal>();

  async function recordMirror(resource: UserProvisioning, outcome: ProvisioningMirrorOutcome): Promise<void> {
    const uid = resource.uid;
    counters.mirrors[outcome] += 1;
    if (outcome === "written" || outcome === "unchanged") refusals.delete(uid);
    if (outcome === "written") deps.log(`[provisioning] mirrored chat and git results of ${uid}`);
    if (outcome === "credentials-not-issued") deps.log(`[provisioning] not mirroring ${uid} yet: its chat credentials are not issued`);
    if (outcome === "agent-not-ready") deps.log(`[provisioning] not mirroring ${uid} yet: its spec enables the default agent, which has no chat account`);
    if (outcome === "chat-id-mismatch" || outcome === "slug-mismatch") {
      const reason = await refusalReason(deps.store, resource, outcome);
      refusals.set(uid, { uid, outcome, reason, since: refusals.get(uid)?.since ?? new Date(now()).toISOString() });
      deps.log(`[provisioning] ❌ not mirroring ${uid}: ${reason}`);
    }
  }

  const mirrors: KeyedRetryQueue = createKeyedRetryQueue({
    concurrency: PROVISIONING_SYNC_CONCURRENCY,
    now,
    retryDelayMs,
    process: async (uid) => {
      const resource = cache.get(uid);
      if (resource === undefined) return;
      await recordMirror(resource, await mirrorUserProvisioning(deps, resource));
    },
    onError: (uid, error, attempts) => {
      counters.mirrors.failed += 1;
      deps.log(`[provisioning] ⚠ could not mirror ${uid} (attempt ${attempts}): ${errorMessage(error)}; retrying`);
    },
  });

  const { deletes, deleteOrphans } = createProvisioningDeleter({ deps, cache, counters, specs, now, retryDelayMs });

  async function backfill(): Promise<BackfillSummary> {
    await snapshot;
    const admitted = await deps.store.users.records.listAdmitted();
    const uids = admitted.map((user) => user.uid);
    for (const uid of uids) {
      lastWrite.delete(uid);
      specs.enqueue(uid);
    }
    await specs.attempted(uids);
    const outcomes = uids.map((uid) => lastWrite.get(uid));
    return {
      users: uids.length,
      written: outcomes.filter((outcome) => outcome === "created" || outcome === "changed").length,
      unchanged: outcomes.filter((outcome) => outcome === "unchanged").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
    };
  }

  async function resync(): Promise<void> {
    await snapshot;
    for (const user of await deps.store.users.records.listAdmitted()) specs.enqueue(user.uid);
    await deleteOrphans();
  }

  function needsSpec(uid: string, slug: string | null): boolean {
    const seen = cache.get(uid);
    return seen === undefined || seen.spec.slug !== slug;
  }

  function watchUsers(): WatchSubscription[] {
    const onError = (error: unknown) => deps.log(`[provisioning] ⚠ user watch error: ${errorMessage(error)}`);
    return [
      deps.store.watch({ aggregate: "builders", filter: {} }, {
        onEvent: (event) => {
          if (event.kind !== "changes") return;
          for (const { type, key, record } of event.changes) {
            if (type === "removed") deletes.enqueue(key);
            else if (record !== null && record.admitted && needsSpec(record.uid, record.slug)) specs.enqueue(record.uid);
          }
        },
        onError,
      }),
      deps.store.watch({ aggregate: "assignments", filter: {} }, {
        onEvent: (event) => {
          if (event.kind !== "changes") return;
          for (const { type, record } of event.changes) {
            if (type === "added" && record !== null && cache.get(record.uid) === undefined) specs.enqueue(record.uid);
          }
        },
        onError,
      }),
    ];
  }

  return {
    counters,
    readiness(uid) {
      const ready = cache.get(uid)?.status.conditions.find((condition) => condition.type === "Ready");
      return ready === undefined ? null : { status: ready.status, reason: ready.reason };
    },
    observed: (uid) => cache.get(uid),
    markDirty: (uid) => specs.enqueue(uid),
    specFailures: () => [...failures.values()],
    mirrorRefusals: () => [...refusals.values()],
    resync,
    writeSpec,
    backfill,
    snapshotLoaded: () => snapshot,
    start() {
      const watch = startProvisioningWatch(deps.client, {
        onSnapshot: async (items) => {
          cache.clear();
          for (const item of items) remember(item);
          counters.watchConnected = true;
          resolveSnapshot();
          specs.open();
          mirrors.open();
          deletes.open();
          for (const item of items) mirrors.enqueue(item.uid);
          await deleteOrphans();
        },
        onChanges: async (changes) => {
          counters.watchConnected = true;
          for (const change of changes) {
            if (change.kind === "deleted") {
              forget(change.uid, change.resourceVersion);
              continue;
            }
            remember(change.resource);
            mirrors.enqueue(change.resource.uid);
          }
        },
        onError: (error, consecutive) => {
          counters.watchFailures += 1;
          counters.watchConnected = false;
          deps.log(`[provisioning] ⚠ provisioning service watch failed (${consecutive} in a row): ${errorMessage(error)}; retrying with backoff`);
        },
      }, { ...(deps.watchTimeoutSeconds === undefined ? {} : { timeoutSeconds: deps.watchTimeoutSeconds }), random });
      const subscriptions = watchUsers();
      void runJournaledBackfill(deps.store, backfill, now).then(
        ({ journaled, result }) => deps.log(
          `[provisioning] spec backfill finished${journaled ? " and journaled" : ""}: ${result.users} admitted users, ${result.written} written, ${result.unchanged} unchanged, ${result.failed} failed and retrying`,
        ),
        (error: unknown) => deps.log(`[provisioning] ❌ spec backfill failed: ${errorMessage(error)}; the next start resumes it`),
      );
      const resyncTimer = setInterval(() => {
        resync().catch((error: unknown) => deps.log(`[provisioning] ⚠ periodic resync failed: ${errorMessage(error)}; the next one retries`));
      }, deps.resyncMs ?? PROVISIONING_SYNC_RESYNC_MS);
      resyncTimer.unref?.();
      return () => {
        clearInterval(resyncTimer);
        watch.stop();
        specs.stop();
        mirrors.stop();
        deletes.stop();
        for (const subscription of subscriptions) void subscription.close();
      };
    },
  };
}
