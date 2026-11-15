import { isDeepStrictEqual } from "node:util";
import type { Operation } from "@octogee/shared/types/glm";
import { AgentStoreErasureRetainedLoginError, type AgentStoreErasureCustody, type AgentStoreErasureTarget } from "@octogee/core/agent-store-credentials";
import type {
  AgentStoreRecord,
  PlatformUserRecord,
  UserDeletionJob,
  GatewayRoot,
  MigrationTransferTask,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";
import type { UserCleanupContext } from "../../handlers/deprovision-user.js";
import { assertActiveOperationClaim } from "../../operation-context.js";
import type { UserGatewayRetirementProof } from "./user-gateway-retirement.js";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import type { AgentStoreUnmountCoverage } from "@octogee/shared/types/fleet-controller";
import { isSharedPoolSlotId } from "@octogee/shared/types/shared-gateway-pool";

export class UserErasureBlockedError extends Error {
  override readonly name: string = "UserErasureBlockedError";
}

export interface SharedAgentErasureSource {
  gatewayId: string;
  podUid: string;
  startedAt: number;
  status: string;
  customers: string[];
  migratingIn: string[];
}

export interface UserAgentStoreErasureDeps {
  store: PlatformStateStore;
  now(): number;
  eraseStores(cleanup: UserCleanupContext, custody: AgentStoreErasureCustody): Promise<void>;
  sharedGatewayRetired(gatewayId: string): Promise<boolean>;
  runtimeAbsent(gatewayId: string, runtime: "cluster" | "gce-vm"): Promise<boolean>;
  ownerHomeAbsent?: (uid: string) => Promise<boolean>;
  eraseVm?: (uid: string) => Promise<unknown>;
  readSharedSource(gatewayId: string): Promise<SharedAgentErasureSource | null>;
  unmountSharedUser(gatewayId: string, cleanup: UserCleanupContext, coverage: AgentStoreUnmountCoverage, operation: Operation): Promise<void>;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRetirementProof(value: unknown): value is UserGatewayRetirementProof {
  return isMap(value) && typeof value.gatewayId === "string" && typeof value.operationId === "string" &&
    Number.isSafeInteger(value.version) && (value.version as number) > 0 &&
    typeof value.completedAt === "number" && Number.isFinite(value.completedAt) &&
    (value.runtime === "cluster" || value.runtime === "gce-vm");
}

function retirementProofs(job: UserDeletionJob): UserGatewayRetirementProof[] {
  const values: unknown[] = Object.values(job.retiredGatewayProofs ?? {});
  if (!values.every(validRetirementProof)) {
    throw new Error("User deletion retirement proof is malformed");
  }
  return values;
}

export async function preserveUserGatewayRetirement(
  store: PlatformStateStore,
  uid: string,
  deletionId: string,
  proof: UserGatewayRetirementProof,
): Promise<void> {
  await store.transaction({ label: "customer-deletion.preserve-gateway-retirement" }, async (transaction) => {
    const job = await transaction.jobs.deletions.get(deletionId);
    if (job === null || job.uid !== uid || !["suspending", "hibernating"].includes(job.status) ||
        typeof job.requestedBy !== "string" || !validRetirementProof(proof)) {
      throw new Error("User deletion does not own the gateway retirement proof");
    }
    const prior = job.retiredGatewayProofs?.[proof.gatewayId];
    if (prior && !isDeepStrictEqual(prior, proof)) throw new Error("User deletion gateway retirement changed");
    await transaction.jobs.deletions.recordRetiredGatewayProof(deletionId, proof.gatewayId, { ...proof });
  });
}

function userAuthorityMatches(user: PlatformUserRecord | null, cleanup: UserCleanupContext, deletionId: string, eraseAfter: number): boolean {
  if (user === null) return true;
  const lifecycle = user.accountLifecycle;
  return user.slug === cleanup.slug && lifecycle?.deletionId === deletionId &&
    lifecycle.eraseAfter === eraseAfter && ["deletion_scheduled", "erasing"].includes(lifecycle.status) &&
    user.gateway === null && user.fences.migration === undefined &&
    user.fences.restoreFence === undefined && user.fences.sourceTransferFence === undefined;
}

function operationConflicts(operation: OperationRecord, uid: string, gateways: Set<string>): boolean {
  const input = operation.input as Record<string, unknown> | undefined;
  return operation.inputUid === uid || input?.uid === uid ||
    [operation.gatewayId, input?.gatewayId, input?.fromGatewayId, input?.toGatewayId]
      .some(id => typeof id === "string" && gateways.has(id));
}

function transferConflicts(task: MigrationTransferTask, slug: string, gateways: Set<string>): boolean {
  return task.slug === slug || gateways.has(task.sourceGatewayId) || gateways.has(task.targetGatewayId);
}

function deletionIdentityMatches(job: UserDeletionJob, cleanup: UserCleanupContext, operation: Operation): boolean {
  return job.version === 1 && job.uid === cleanup.uid && job.slug === cleanup.slug &&
    (cleanup.currentGatewayId === null || job.currentGatewayId === cleanup.currentGatewayId) && job.erasureOperationId === operation.id &&
    job.status === "hibernating" && isDeepStrictEqual(job.cleanupContext, cleanup);
}

function deletionConsentIsDue(job: UserDeletionJob, now: number): boolean {
  return typeof job.requestedBy === "string" && job.requestedBy.length > 0 &&
    Number.isFinite(job.requestedAt) && Number.isFinite(job.eraseAfter) && now >= job.eraseAfter;
}

async function assertDeletionAuthority(
  deps: UserAgentStoreErasureDeps,
  transaction: PlatformStateTransaction,
  cleanup: UserCleanupContext,
  deletionId: string,
  operation: Operation,
): Promise<Stored<UserDeletionJob>> {
  const [job, user, currentOperation, assignments, operations, roots, transfers] = await Promise.all([
    transaction.jobs.deletions.get(deletionId),
    transaction.users.records.get(cleanup.uid),
    transaction.journal.operations.get(operation.id),
    transaction.gateways.assignments.listForUid(cleanup.uid),
    transaction.journal.operations.listByStatus(["pending", "running"]),
    transaction.gateways.roots.list({ ownerUid: cleanup.uid }),
    transaction.migrationTasks.listByStatus(["running"]),
  ]);
  assertActiveOperationClaim(operation, currentOperation);
  if (operation.kind !== "erase-user" || operation.input.uid !== cleanup.uid || operation.input.deletionId !== deletionId ||
      job === null || !deletionIdentityMatches(job, cleanup, operation) || !deletionConsentIsDue(job, deps.now()) ||
      currentOperation?.input.deletionId !== deletionId ||
      !userAuthorityMatches(user, cleanup, deletionId, job.eraseAfter) || assignments.length > 0) {
    throw new Error("User PostgreSQL erasure no longer owns its due deletion job");
  }
  const gateways = new Set([job.currentGatewayId, ...retirementProofs(job).map(proof => proof.gatewayId)].filter((id): id is string => typeof id === "string"));
  if (operations.some(candidate => candidate.id !== operation.id && operationConflicts(candidate, cleanup.uid, gateways)) ||
      transfers.some(task => transferConflicts(task, cleanup.slug, gateways)) ||
      roots.some(root => root.desiredStatus !== "retired" || root.runtimeRestartFence != null)) {
    throw new Error("User PostgreSQL erasure has conflicting runtime work");
  }
  return job;
}

function retiredRootMatches(root: GatewayRoot | null, proof: UserGatewayRetirementProof, uid: string): boolean {
  return root === null || (root.ownerUid === uid && root.gatewayClass === "isolated" && root.desiredStatus === "retired" &&
    root.retirementVersion === proof.version && root.retirementClaim?.operationId === proof.operationId);
}

async function assertUserRetirementAbsent(deps: UserAgentStoreErasureDeps, cleanup: UserCleanupContext, proof: UserGatewayRetirementProof): Promise<void> {
  const [root, runtime, assignmentsEmpty, users, operations] = await Promise.all([
    deps.store.gateways.roots.get(proof.gatewayId),
    deps.store.fleetRegistry.get(proof.gatewayId),
    deps.store.gateways.assignments.isEmpty(proof.gatewayId),
    deps.store.users.records.listByGateway(proof.gatewayId, { limit: 1 }),
    deps.store.journal.operations.listByGateway(proof.gatewayId),
  ]);
  if (!retiredRootMatches(root, proof, cleanup.uid) || runtime !== null || !assignmentsEmpty || users.length > 0 ||
      operations.some(candidate => candidate.kind === "add-gateway" &&
        (typeof candidate.createdAt !== "number" || candidate.createdAt >= proof.completedAt)) ||
      !await deps.runtimeAbsent(proof.gatewayId, proof.runtime)) {
    throw new Error("User PostgreSQL erasure retained a gateway runtime or changed retirement");
  }
}

function custodySourceGateway(records: readonly AgentStoreRecord[], slug: string): string {
  const custodians = [...new Set(records.flatMap(record =>
    record.kind === "agent" && agentIdBelongsToSlug(record.agentId, slug) ? [record.gatewayId] : []))];
  const [gatewayId] = custodians;
  if (custodians.length !== 1 || !isSharedPoolSlotId(gatewayId)) {
    throw new UserErasureBlockedError(
      "User PostgreSQL erasure has no source gateway: the user was unassigned before deletion and agent-store custody names " +
      `${custodians.length === 0 ? "no gateway" : custodians.join(", ")}, not one shared gateway`);
  }
  return gatewayId;
}

async function recordCustodySourceGateway(
  deps: UserAgentStoreErasureDeps, cleanup: UserCleanupContext, deletionId: string, operation: Operation,
): Promise<string> {
  return deps.store.transaction({ label: "customer-deletion.agent-store-erasure.record-source" }, async (transaction) => {
    const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
    if (typeof job.currentGatewayId === "string") return job.currentGatewayId;
    const currentGatewayId = custodySourceGateway(await transaction.users.agentStores.list(cleanup.uid), cleanup.slug);
    await transaction.jobs.deletions.patch(deletionId, { currentGatewayId }, { revision: job.revision });
    return currentGatewayId;
  });
}

async function assertRetiredUserWriters(deps: UserAgentStoreErasureDeps, cleanup: UserCleanupContext, sourceGatewayId: string, job: UserDeletionJob): Promise<void> {
  const proofs = retirementProofs(job);
  if (!sourceGatewayId.startsWith("shared-") && !proofs.some(proof => proof.gatewayId === sourceGatewayId)) {
    throw new Error("User PostgreSQL erasure lacks its captured user retirement proof");
  }
  for (const proof of proofs) await assertUserRetirementAbsent(deps, cleanup, proof);
}

function sharedSourceAvailable(source: SharedAgentErasureSource | null, gatewayId: string): source is SharedAgentErasureSource {
  return source?.gatewayId === gatewayId && source.status === "ready" && typeof source.podUid === "string" &&
    source.podUid.length > 0 && typeof source.startedAt === "number" && Number.isFinite(source.startedAt) && source.startedAt > 0 &&
    Array.isArray(source.customers) && source.customers.every(id => typeof id === "string") &&
    Array.isArray(source.migratingIn) && source.migratingIn.every(id => typeof id === "string");
}

async function assertSharedUserStopped(
  deps: UserAgentStoreErasureDeps, cleanup: UserCleanupContext,
  input: { gatewayId: string; deletionId: string; operation: Operation; targets: readonly AgentStoreErasureTarget[]; assertCurrent(): Promise<void> },
): Promise<void> {
  const { gatewayId, deletionId, operation, targets, assertCurrent } = input;
  if (await deps.sharedGatewayRetired(gatewayId)) return;
  const source = await deps.readSharedSource(gatewayId);
  if (!sharedSourceAvailable(source, gatewayId) || source.migratingIn.includes(cleanup.slug)) {
    throw new Error("User PostgreSQL erasure awaits captured Shared retirement or confirmed Native user cleanup");
  }
  const agentIds = [...new Set(targets.flatMap(target => target.family === "agent" && agentIdBelongsToSlug(target.agentId, cleanup.slug) ? [target.agentId] : []))].sort();
  const identity = { gatewayId, podUid: source.podUid, startedAt: source.startedAt, agentIds, operationId: operation.id };
  const complete = await deps.store.transaction({ label: "customer-deletion.shared-agent-store-cleanup.claim" }, async (transaction) => {
    const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
    const suspensionId = job.suspensionOperationId;
    if (suspensionId === undefined) throw new Error("User PostgreSQL erasure lacks completed suspension cleanup");
    const suspension = await transaction.journal.operations.get(suspensionId);
    if (!suspensionCleanupMatches(suspension, cleanup, deletionId)) {
      throw new Error("User PostgreSQL erasure lacks completed suspension cleanup");
    }
    const prior = job.sharedAgentStoreCleanup;
    if (prior !== undefined) {
      if (typeof prior.complete !== "boolean" || !Number.isFinite(prior.claimStartedAt) ||
          !isDeepStrictEqual(prior, { ...identity, complete: prior.complete, claimStartedAt: prior.claimStartedAt })) {
        throw new Error("User PostgreSQL erasure Shared source or agent coverage changed");
      }
      if (!prior.complete) {
        await transaction.jobs.deletions.patch(deletionId,
          { sharedAgentStoreCleanup: { ...prior, claimStartedAt: operation.startedAt } }, { revision: job.revision });
      }
      return prior.complete;
    }
    await transaction.jobs.deletions.patch(deletionId,
      { sharedAgentStoreCleanup: { ...identity, complete: false, claimStartedAt: operation.startedAt } }, { revision: job.revision });
    return false;
  });
  if (!complete) {
    await assertCurrent();
    await deps.unmountSharedUser(gatewayId, cleanup, { podUid: source.podUid, agentIds }, operation);
    await assertCurrent();
  }
  const current = complete ? source : await deps.readSharedSource(gatewayId);
  if (!sharedSourceAvailable(current, gatewayId) || current.podUid !== source.podUid || current.startedAt !== source.startedAt ||
      current.customers.includes(cleanup.slug) || current.migratingIn.includes(cleanup.slug)) {
    throw new Error("User PostgreSQL erasure Shared runtime changed or retained the user");
  }
  if (!complete) {
    await deps.store.transaction({ label: "customer-deletion.shared-agent-store-cleanup.complete" }, async (transaction) => {
      const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
      const claimed = { ...identity, complete: false, claimStartedAt: operation.startedAt };
      if (!isDeepStrictEqual(job.sharedAgentStoreCleanup, claimed)) {
        throw new Error("User PostgreSQL erasure Shared cleanup admission changed");
      }
      await transaction.jobs.deletions.patch(deletionId,
        { sharedAgentStoreCleanup: { ...claimed, complete: true } }, { revision: job.revision });
    });
  }
}

function suspensionCleanupMatches(suspension: OperationRecord | null, cleanup: UserCleanupContext, deletionId: string): boolean {
  const unmounted = cleanup.currentGatewayId === null ? "skipped" : "done";
  return suspension?.kind === "suspend-user" && suspension.status === "succeeded" &&
    suspension.input?.uid === cleanup.uid && suspension.input?.deletionId === deletionId &&
    Array.isArray(suspension.steps) && suspension.steps.some(step => step.name === "unmount-gateway" && step.status === unmounted);
}

async function eraseStoresOrBlock(deps: UserAgentStoreErasureDeps, cleanup: UserCleanupContext, custody: AgentStoreErasureCustody): Promise<void> {
  try {
    await deps.eraseStores(cleanup, custody);
  } catch (error) {
    if (error instanceof AgentStoreErasureRetainedLoginError) throw new UserErasureBlockedError(error.message, { cause: error });
    throw error;
  }
}

export function createUserAgentStoreErasure(deps: UserAgentStoreErasureDeps) {
  return async (cleanup: UserCleanupContext, deletionId: string, operation: Operation, assertActiveClaim: (() => Promise<void>) | undefined): Promise<void> => {
    if (!assertActiveClaim) throw new Error("User PostgreSQL erasure requires its active operation claim");
    const readAuthority = () => deps.store.transaction(
      { label: "customer-deletion.agent-store-erasure.authority", readOnly: true },
      transaction => assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation),
    );
    const readSourcedAuthority = async () => {
      const job = await readAuthority();
      if (typeof job.currentGatewayId === "string") return { job, sourceGatewayId: job.currentGatewayId };
      const sourceGatewayId = await recordCustodySourceGateway(deps, cleanup, deletionId, operation);
      return { job: await readAuthority(), sourceGatewayId };
    };
    const assertCurrent = async () => { await assertActiveClaim(); await readAuthority(); };
    await assertCurrent();
    await eraseStoresOrBlock(deps, cleanup, {
      assertCurrent,
      assertWritersStopped: async targets => {
        const { job, sourceGatewayId } = await readSourcedAuthority();
        await assertRetiredUserWriters(deps, cleanup, sourceGatewayId, job);
        if (sourceGatewayId.startsWith("shared-")) {
          await assertSharedUserStopped(deps, cleanup, { gatewayId: sourceGatewayId, deletionId, operation, targets, assertCurrent });
        }
        const ownerHomeAbsent = deps.ownerHomeAbsent;
        if (ownerHomeAbsent && !await ownerHomeAbsent(cleanup.uid)) {
          await assertCurrent();
          if (!deps.eraseVm) throw new Error("User PostgreSQL erasure retained a gateway VM or home");
          await deps.eraseVm(cleanup.uid);
          await assertCurrent();
          if (!await ownerHomeAbsent(cleanup.uid)) throw new Error("User PostgreSQL erasure retained a gateway VM or home");
        }
        await assertCurrent();
        return [sourceGatewayId, ...retirementProofs(job).map(proof => proof.gatewayId)];
      },
      bindTargets: targets => deps.store.transaction({ label: "customer-deletion.agent-store-erasure.bind-targets" }, async (transaction) => {
        const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
        if (job.postgresAgentStoreTargets !== undefined) {
          return job.postgresAgentStoreTargets as unknown as readonly AgentStoreErasureTarget[];
        }
        await transaction.jobs.deletions.patch(deletionId,
          { postgresAgentStoreTargets: targets.map(target => ({ ...target })) }, { revision: job.revision });
        return targets;
      }),
    });
  };
}
