import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readHeldNativeReturnForRetiredTargetCompensation, readHeldNativeReturnForTargetMaintenance, type HeldNativeReturnSelection, type NativeOldTargetRetirement } from "@octogee/core/fleet-state";
import { buildOperationAuditIntent, operationAuditDocumentId } from "@octogee/core/operation-audit";
import type { GatewayRuntimeRestartFenceValue, OperationRecord, PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
import { readRetiredTargetOperatorScope } from "./native-return-target-exclusion.js";
import { COMPENSATED_NATIVE_RETURN_RESULT } from "./compensated-native-return-history.js";
import type { OperationHandler, OperationResult } from "../operation-router.js";

export const COMPENSATING_NATIVE_RETURN = "compensating-native-return";

export type OriginalNativeProviderIdentity = {
  instanceId: string; instanceName: string; zone: string; internalIp: string; bootDiskId: string; homeDiskId: string;
};
export type OldTargetExclusionScope = HeldNativeReturnSelection & { uid: string; slug: string; exclusionId: string };
export type RetiredNativeTarget = NativeOldTargetRetirement & { oldPodUid: string };
export type CompensatingNativeReturnAuthority = OldTargetExclusionScope & { attemptId: string; auditId: string; sourceRelease: number; targetRelease: number; retiredTarget?: RetiredNativeTarget; source: OriginalNativeProviderIdentity };
type Phase = "reserved" | "checkpoint-released" | "stores-prepared" | "scheduler-resumed" | "ingress-resumed";
type Guard = GatewayRuntimeRestartFenceValue & { phase: Phase; authority: CompensatingNativeReturnAuthority; archive: ArchivedReturn };
type ArchivedReturn = { handoff: NonNullable<OperationRecord["schedulerHandoff"]>; attempt: NonNullable<OperationRecord["attemptHistory"]>[number] };
export type CompensatingNativeReturnClaimGate = (tx: PlatformStateTransaction, operation: OperationRecord) => Promise<void>;
export type CompensatingNativeReturnActions = {
  prepareSourceStores(authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>): Promise<void>;
  resumeSourceScheduler(authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>): Promise<void>;
  resumeSourceIngress(authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>): Promise<void>;
  verifySourceServing(authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>): Promise<void>;
};
export type CompensatingNativeReturnProviders = {
  readOldTargetExclusion(tx: PlatformStateTransaction, scope: OldTargetExclusionScope): Promise<boolean>;
  verifyOldTargetExclusion(scope: OldTargetExclusionScope): Promise<void>;
  readRetiredTargetExclusion?(tx: PlatformStateTransaction, scope: OldTargetExclusionScope): Promise<RetiredNativeTarget | null>;
  verifyRetiredTargetExclusion?(scope: OldTargetExclusionScope, retirement: RetiredNativeTarget): Promise<void>;
  observeOriginalSource(scope: OldTargetExclusionScope): Promise<OriginalNativeProviderIdentity>;
};
type Dependencies = { store: PlatformStateStore; now: () => number; provider?: CompensatingNativeReturnProviders; actions: CompensatingNativeReturnActions };
type Request = { environment: "test" | "prod"; actor: string; attemptId: string; exclusionId: string; selection: HeldNativeReturnSelection; targetMode?: "retired" };

function requireRollback(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(`Compensating Native return: ${why}`);
}

function oldTargetScope({ operationId, sourceGatewayId, targetGatewayId, sourceEpoch, schedulerMigrationId,
  uid, slug, exclusionId }: OldTargetExclusionScope): OldTargetExclusionScope {
  return { operationId, sourceGatewayId, targetGatewayId, sourceEpoch, schedulerMigrationId, uid, slug, exclusionId };
}

function exactSource(source: OriginalNativeProviderIdentity, runtime: Awaited<ReturnType<PlatformStateTransaction["fleetRegistry"]["get"]>>) {
  return runtime?.runtime === "gce-vm" && runtime.vm?.status === "RUNNING" &&
    runtime.vm.internalIp === source.internalIp && runtime.vm.instanceId === source.instanceId && runtime.vm.instanceName === source.instanceName && runtime.vm.zone === source.zone &&
    [source.instanceId, source.bootDiskId, source.homeDiskId].every(id => /^[1-9]\d*$/.test(id)) &&
    source.bootDiskId !== source.homeDiskId;
}

function result(): OperationResult {
  return { steps: [], success: false, rolledBack: true, error: COMPENSATED_NATIVE_RETURN_RESULT };
}

function phaseAdvance(guard: Guard, phase: Phase): Guard {
  return { ...guard, phase };
}

async function requireNoTargetWork(tx: PlatformStateTransaction, authority: CompensatingNativeReturnAuthority) {
  const { operationId, sourceGatewayId, targetGatewayId, uid, slug } = authority;
  const [target, runtime, targetAssignment, transfers, active] = await Promise.all([
    tx.gateways.roots.get(targetGatewayId), tx.fleetRegistry.get(targetGatewayId), tx.gateways.assignments.get(targetGatewayId, uid),
    tx.migrationTasks.listByStatus(["running"]), tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
  ]);
  if (!authority.retiredTarget) requireRollback(target?.gatewayClass === "shared" && target.desiredStatus === "running" && !target.runtimeRestartFence &&
    !target.retirementClaim && runtime?.heartbeat.mountedCustomers.includes(slug) === false &&
    !runtime.heartbeat.migratingIn?.includes(slug) && !targetAssignment, "old target may hold this owner");
  const scopedIds = new Set([operationId, `mig-${operationId}`, authority.schedulerMigrationId]);
  requireRollback(!transfers.some(task => scopedIds.has(task.migrationId) || task.slug === slug &&
    (task.sourceGatewayId === sourceGatewayId || task.targetGatewayId === targetGatewayId)) &&
    active.length === 1 && active[0]?.id === operationId, "competing owner or transfer claim");
}

async function readTarget(tx: PlatformStateTransaction, provider: CompensatingNativeReturnProviders, authority: CompensatingNativeReturnAuthority) {
  const scope = oldTargetScope(authority);
  if (!authority.retiredTarget) return provider.readOldTargetExclusion(tx, scope);
  return isDeepStrictEqual(await provider.readRetiredTargetExclusion?.(tx, scope), authority.retiredTarget);
}

async function verifyTarget(provider: CompensatingNativeReturnProviders, scope: OldTargetExclusionScope, retirement?: RetiredNativeTarget) {
  if (!retirement) return provider.verifyOldTargetExclusion(scope);
  requireRollback(provider.verifyRetiredTargetExclusion, "independent retired target verifier unavailable");
  await provider.verifyRetiredTargetExclusion(scope, retirement);
}

async function reserveAdmission(tx: PlatformStateTransaction, request: Request) {
  const retired = request.targetMode === "retired"
    ? await readHeldNativeReturnForRetiredTargetCompensation(tx, request.selection) : null;
  if (retired) {
    const scope = await readRetiredTargetOperatorScope(tx, request.actor, request.selection.operationId);
    requireRollback(retired.exclusionId === request.exclusionId && scope.exclusionId === request.exclusionId,
      "old target retirement belongs to a different protected drain");
  }
  const enrolled = retired ?? await readHeldNativeReturnForTargetMaintenance(tx, request.selection);
  const operation = await tx.journal.operations.get(request.selection.operationId);
  requireRollback(operation?.schedulerHandoff && operation.attemptHistory?.length && !operation.input.compensatingNativeReturn,
    "original forward history unavailable");
  return { operation, releases: { sourceRelease: enrolled.sourceRelease, targetRelease: enrolled.targetRelease },
    retirement: retired ? { ...retired.retirement, oldPodUid: retired.oldPodUid } : null, archived: { handoff: operation.schedulerHandoff, attempt: operation.attemptHistory.at(-1)! },
    scope: { ...request.selection, uid: enrolled.uid, slug: enrolled.slug, exclusionId: request.exclusionId } };
}

async function readPriorReservation(tx: PlatformStateTransaction, request: Request): Promise<CompensatingNativeReturnAuthority | null> {
  const auditId = operationAuditDocumentId(`${COMPENSATING_NATIVE_RETURN}:${request.attemptId}`);
  const audit = await tx.journal.audits.get(auditId);
  if (!audit) return null;
  const op = await tx.journal.operations.get(request.selection.operationId);
  const prior = op?.input.compensatingNativeReturn as CompensatingNativeReturnAuthority | undefined;
  requireRollback(audit.actor === request.actor && prior?.auditId === auditId && prior.attemptId === request.attemptId &&
    prior.exclusionId === request.exclusionId && !!prior.retiredTarget === (request.targetMode === "retired") && Object.entries(request.selection).every(([field, value]) => prior[field as keyof CompensatingNativeReturnAuthority] === value),
  "prior reservation belongs to a different authority");
  return prior;
}

export function createCompensatingNativeReturn(deps: Dependencies) {
  const { store, actions, provider, now } = deps;

  async function request(request: Request) {
    requireRollback(request.environment === "test" && request.actor && /^[a-f0-9-]{36}$/.test(request.attemptId),
      "protected TEST operator required");
    requireRollback(provider, "independent old target exclusion provider is unavailable");
    requireRollback(request.targetMode === undefined || request.targetMode === "retired", "unsupported target compensation mode");
    const lookup = (tx: PlatformStateTransaction) => readPriorReservation(tx, request);
    const prior = await store.transaction({ label: "compensating-native-return.replay", readOnly: true }, lookup);
    if (prior) return prior;
    const admitted = await store.transaction({ label: "compensating-native-return.read", readOnly: true }, tx => reserveAdmission(tx, request));
    const source = await provider.observeOriginalSource(admitted.scope);
    const retiredTarget = admitted.retirement;
    requireRollback(request.targetMode !== "retired" || retiredTarget, "durable retired target exclusion missing");
    await verifyTarget(provider, admitted.scope, retiredTarget ?? undefined);
    const audit = buildOperationAuditIntent({
      actor: request.actor, forced: false, what: "Restore the original Native return source",
      why: "Independently exclude the held return target before resuming the original owner",
      mutation: { attemptId: request.attemptId, scope: admitted.scope, source },
      target: { ...admitted.scope, original: source, archivedReturn: admitted.archived },
      preActionStatus: { placement: "quiescing", operationStatus: "pending" },
      idempotencyKey: `${COMPENSATING_NATIVE_RETURN}:${request.attemptId}`, now,
    });
    const authority = { ...admitted.scope, ...admitted.releases, attemptId: request.attemptId, auditId: audit.id, source,
      ...(retiredTarget ? { retiredTarget } : {}) };
    return store.transaction({ label: "compensating-native-return.reserve" }, async tx => {
      const already = await lookup(tx);
      if (already) return already;
      const current = await reserveAdmission(tx, request);
      requireRollback(isDeepStrictEqual(current.scope, admitted.scope) && current.operation.revision === admitted.operation.revision &&
        isDeepStrictEqual(current.retirement, retiredTarget),
        "original return changed before reservation");
      requireRollback(await readTarget(tx, provider, authority), "durable old target exclusion missing");
      await requireNoTargetWork(tx, authority);
      requireRollback(exactSource(source, await tx.fleetRegistry.get(authority.sourceGatewayId)), "original VM provider identity changed");
      const guard: Guard = { kind: COMPENSATING_NATIVE_RETURN, phase: "reserved", gatewayId: authority.sourceGatewayId,
        startedAt: now(), attemptId: authority.attemptId, auditId: audit.id, authority, archive: current.archived };
      await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "in-progress",
        lifecycleStage: "action-started", actionClaimId: authority.attemptId, actionStartedAt: now(), actionRecoveryCount: 0 });
      await tx.gateways.roots.compareAndSetRuntimeRestartFence(authority.sourceGatewayId, null, guard);
      await tx.journal.operations.patch(authority.operationId, {
        input: { ...current.operation.input, compensatingNativeReturn: authority },
        nextAttemptAt: now(),
      }, { status: ["pending"], startedAt: null, revision: current.operation.revision });
      return authority;
    });
  }

  async function requestRetired(input: { environment: "test"; actor: string; operationId: string }) {
    requireRollback(input.environment === "test" && input.actor, "protected TEST operator required");
    const { exclusionId, uid: _uid, slug: _slug, ...selection } = await store.transaction(
      { label: "compensating-native-return.retired-operator-scope", readOnly: true },
      tx => readRetiredTargetOperatorScope(tx, input.actor, input.operationId),
    );
    const hex = createHash("sha256").update(JSON.stringify([COMPENSATING_NATIVE_RETURN, "retired", selection.operationId, exclusionId])).digest("hex");
    const attemptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return request({ environment: input.environment, actor: input.actor, attemptId, exclusionId, selection, targetMode: "retired" });
  }

  async function assertClaimable(tx: PlatformStateTransaction, operation: OperationRecord): Promise<void> {
    const authority = operation.input.compensatingNativeReturn as CompensatingNativeReturnAuthority | undefined;
    requireRollback(provider && authority?.operationId === operation.id && operation.startedAt === null && operation.status === "pending",
      "exact pending rollback and durable exclusion provider required");
    await readClaim(tx, provider, authority, null);
  }

  const recover: OperationHandler = async (operation, ctx) => {
    try {
      requireRollback(provider, "independent old target exclusion provider is unavailable");
      const authority = operation.input.compensatingNativeReturn as CompensatingNativeReturnAuthority | undefined;
      requireRollback(authority?.operationId === operation.id && operation.startedAt !== null && ctx.assertActiveClaim,
        "exact compensating worker claim required");
      const claim = operation.startedAt;
      const read = (tx: PlatformStateTransaction) => readClaim(tx, provider, authority, claim);
      const current = () => store.transaction({ label: "compensating-native-return.claim", readOnly: true }, read);
      const assertCurrent = async () => {
        await ctx.assertActiveClaim!();
        const before = await current();
        requireRollback(!before.done, "rollback already completed");
        const scope = oldTargetScope(authority);
        await verifyTarget(provider, scope, authority.retiredTarget);
        requireRollback(isDeepStrictEqual(await provider.observeOriginalSource(scope), authority.source),
          "original VM or attached disks changed");
        const after = await current();
        requireRollback(!after.done && isDeepStrictEqual(after.guard, before.guard) && after.operation.revision === before.operation.revision,
          "rollback authority changed during physical observation");
      };
      if ((await current()).done) return result();
      await advance("reserved", "checkpoint-released", async (tx, claimed) => releaseOriginalCheckpoint(tx, authority, claimed));
      await external("checkpoint-released", "stores-prepared", actions.prepareSourceStores);
      await external("stores-prepared", "scheduler-resumed", actions.resumeSourceScheduler);
      await external("scheduler-resumed", "ingress-resumed", actions.resumeSourceIngress);
      await assertCurrent();
      await actions.verifySourceServing(authority, assertCurrent);
      await assertCurrent();
      await store.transaction({ label: "compensating-native-return.complete" }, async tx => {
        const state = await read(tx);
        requireRollback(!state.done && state.guard.phase === "ingress-resumed", "ingress recovery is incomplete");
        await tx.gateways.assignments.patch(authority.sourceGatewayId, authority.uid, { state: "serving", updatedByOperationId: authority.operationId,
          updatedAt: now() }, { epoch: authority.sourceEpoch });
        await tx.users.records.setFence(authority.uid, "migration", { clear: true });
        await tx.journal.operations.patch(authority.operationId, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: now() },
          { status: ["running"], startedAt: claim, revision: state.operation.revision });
        await tx.journal.audits.patch(authority.auditId, { status: "completed", lifecycleStage: "action-completed",
          outcome: "completed", completedAt: now() }, { revision: state.audit.revision });
        await tx.gateways.roots.compareAndSetRuntimeRestartFence(authority.sourceGatewayId, state.guard, null);
      });
      return result();

      async function advance(from: Phase, to: Phase, mutation?: (tx: PlatformStateTransaction, claimed: ActiveClaim) => Promise<void>) {
        await assertCurrent();
        await store.transaction({ label: "compensating-native-return.advance" }, async tx => {
          const next = await read(tx);
          requireRollback(!next.done, "rollback already completed");
          if (next.guard.phase !== from) return;
          if (mutation) await mutation(tx, next);
          await tx.gateways.roots.compareAndSetRuntimeRestartFence(authority!.sourceGatewayId, next.guard, phaseAdvance(next.guard, to));
        });
      }

      async function external(from: Phase, to: Phase, action: CompensatingNativeReturnActions["prepareSourceStores"]) {
        await assertCurrent();
        const state = await current();
        if (state.done || state.guard.phase !== from) return;
        await action(authority!, assertCurrent);
        await advance(from, to);
      }
    } catch (error) {
      return { steps: [], success: false, rolledBack: false,
        error: `compensating Native return pending: status 503: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  return { request, requestRetired, recover, assertClaimable };
}

type ActiveClaim = Exclude<Awaited<ReturnType<typeof readClaim>>, { done: true }>;

async function readClaim(tx: PlatformStateTransaction, provider: CompensatingNativeReturnProviders, authority: CompensatingNativeReturnAuthority, startedAt: number | null) {
  const { sourceGatewayId, operationId, uid, auditId } = authority;
  const [operation, audit, root, user, assignments, runtime] = await Promise.all([
    tx.journal.operations.get(operationId), tx.journal.audits.get(auditId), tx.gateways.roots.get(sourceGatewayId),
    tx.users.records.get(uid), tx.gateways.assignments.listForUid(uid), tx.fleetRegistry.get(sourceGatewayId),
  ]);
  requireRollback(operation && audit && root && user && runtime, "rollback custody is unavailable");
  await assertWorkerClaim(tx, provider, authority, { startedAt, operation, audit });

  if (audit.status === "completed" && audit.outcome === "completed" && operation.schedulerHandoffReleased === true) return { done: true } as const;
  const guard = root?.runtimeRestartFence as Guard | undefined;
  requireRollback(guard && [audit.status === "in-progress", guard.kind === COMPENSATING_NATIVE_RETURN,
    isDeepStrictEqual(guard.authority, authority), isDeepStrictEqual(guard.archive.handoff, operation.schedulerHandoff),
    isDeepStrictEqual(audit.target.archivedReturn, guard.archive)].every(Boolean),
  "rollback fence or preserved scheduler changed");
  requireRollback([root.ownerUid === uid, root.builderSlug === authority.slug, root.desiredStatus === "running",
    root.liveRelease === authority.sourceRelease, root.desiredRelease === authority.sourceRelease,
    !root.retirementClaim, exactSource(authority.source, runtime)].every(Boolean), "source owner or provider runtime changed");
  assertSourceAssignment(user, assignments, authority);
  await requireNoTargetWork(tx, authority);
  if (!authority.retiredTarget) {
    const target = await tx.gateways.roots.get(authority.targetGatewayId);
    requireRollback(target?.liveRelease === authority.targetRelease && target?.desiredRelease === authority.targetRelease,
      "old target release changed");
  }
  return { done: false, guard, operation, audit, runtime } as const;
}

function assertSourceAssignment(
  user: NonNullable<Awaited<ReturnType<PlatformStateTransaction["users"]["records"]["get"]>>>,
  assignments: Awaited<ReturnType<PlatformStateTransaction["gateways"]["assignments"]["listForUid"]>>,
  { sourceGatewayId, operationId, sourceEpoch }: CompensatingNativeReturnAuthority,
) {
  const migration = user.fences.migration;
  requireRollback([user.gateway?.gatewayId === sourceGatewayId, migration?.operationId === operationId,
    migration?.phase === "transferring", migration?.state === "moving", Object.keys(user.fences).length === 1,
    user.activationLease?.returnOperationId === operationId, user.activationLease?.status === "returning",
    assignments.length === 1, assignments[0]?.gatewayId === sourceGatewayId,
    assignments[0]?.state === "quiescing", assignments[0]?.epoch === sourceEpoch].every(Boolean),
  "source placement or scheduler fence changed");
}

async function assertWorkerClaim(tx: PlatformStateTransaction, provider: CompensatingNativeReturnProviders,
  authority: CompensatingNativeReturnAuthority, claim: { startedAt: number | null; operation: OperationRecord;
    audit: NonNullable<Awaited<ReturnType<PlatformStateTransaction["journal"]["audits"]["get"]>>> }) {
  const { startedAt, operation, audit } = claim;
  const { uid, slug, sourceGatewayId, targetGatewayId, attemptId } = authority;
  const input = operation.input;
  requireRollback([operation.kind === "migrate-user", operation.status === (startedAt === null ? "pending" : "running"), operation.startedAt === startedAt,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined,
    operation.userMigrationV2 === undefined, operation.sourceTransferExecution === undefined, operation.restoreAttempt === undefined,
    input.uid === uid, input.userSlug === slug, input.fromGatewayId === sourceGatewayId, input.toGatewayId === targetGatewayId,
    isDeepStrictEqual(input.compensatingNativeReturn, authority), audit.actionClaimId === attemptId].every(Boolean),
  "worker claim changed");
  requireRollback(await readTarget(tx, provider, authority), "durable exclusion changed");
}

async function releaseOriginalCheckpoint(tx: PlatformStateTransaction, authority: CompensatingNativeReturnAuthority, state: ActiveClaim) {
  const home = state.runtime.vmHome;
  if (home?.returnOperationId == null && home?.checkpointRequestedAt == null && home?.parkRequestedAt == null) return;
  requireRollback(home?.returnOperationId === authority.operationId && typeof home.checkpointRequestedAt === "number" &&
    Number.isSafeInteger(home.checkpointRequestedAt) && home.checkpointRequestedAt > 0 &&
    home.parkRequestedAt === home.checkpointRequestedAt && home.checkpointAcknowledgedAt === home.checkpointRequestedAt,
  "original checkpoint no longer matches its request");
  const { returnOperationId: _, checkpointRequestedAt: _request, parkRequestedAt: _park, ...kept } = home;
  await tx.fleetRegistry.patch(authority.sourceGatewayId, { vmHome: kept }, { revision: state.runtime.revision });
}
