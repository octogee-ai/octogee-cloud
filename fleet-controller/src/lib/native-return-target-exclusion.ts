import { isDeepStrictEqual } from "node:util";
import { createHeldReturnStoreCustodyVerifier } from "@octogee/core/agent-store-credentials";
import { NATIVE_RETURN_TARGET_EXCLUSION, nativeReturnTargetExclusionId, readHeldNativeReturnForTargetExclusion, readNativeOldTargetRetirement,
  type HeldNativeReturnSelection } from "@octogee/core/fleet-state";
import { buildOperationAuditIntent } from "@octogee/core/operation-audit";
import type { PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
import type { CompensatingNativeReturnAuthority, RetiredNativeTarget } from "./compensating-native-return.js";
import type { SurgeKubectl } from "../surge-user-handoff-runtime.js";
import { createHeldNativeReturnDestinationVerifier } from "./held-native-return-destination.js";

export type NativeOldTargetScope = HeldNativeReturnSelection & { uid: string; slug: string; exclusionId: string };

export interface VerifiedRetainedSharedRoles {
  gatewayId: string;
  podUid: string;
  release: number;
  payloadHash: string;
  artifactSetId: string;
  images: { gateway: string; "gateway-edge": string };
  verifiedCommonArchiveSha256: string;
}

type Reservation = { scope: NativeOldTargetScope; podUid: string };
type Audit = NonNullable<Awaited<ReturnType<PlatformStateTransaction["journal"]["audits"]["get"]>>>;
type Providers = {
  readRetainedCompletion?(reservation: Reservation): Promise<VerifiedRetainedSharedRoles>;
  verifyPod(reservation: Reservation, assertCurrent: () => Promise<void>): Promise<void>;
  verifyStores(scope: NativeOldTargetScope, assertCurrent: () => Promise<void>): Promise<void>;
  verifyRetiredRoutes?(reservation: Reservation, assertCurrent: () => Promise<void>): Promise<boolean>;
  verifyWholeRetirement?(gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
};

function requireExclusion(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Native old target exclusion: ${reason}`);
}

const DIGEST = /^[a-f0-9]{64}$/;

async function selectedOriginal(tx: PlatformStateTransaction, selection: HeldNativeReturnSelection) {
  const authority = await readHeldNativeReturnForTargetExclusion(tx, selection);
  const runtime = await tx.fleetRegistry.get(selection.targetGatewayId);
  const kube = runtime?.kubernetes;
  const pod = kube?.pods?.[0];
  requireExclusion(pod && kube && kube.totalPods === 1 && kube.readyPods === 1 && kube.pods?.length === 1,
    "exact ready old Shared Pod required");
  return { scope: { ...selection, uid: authority.uid, slug: authority.slug, exclusionId: nativeReturnTargetExclusionId(authority.uid) },
    podUid: pod.uid };
}

function readBinding(audit: Audit | null, scope: NativeOldTargetScope): Reservation | null {
  if (!audit || audit.id !== nativeReturnTargetExclusionId(scope.uid) || audit.id !== scope.exclusionId ||
      audit.mutation.kind !== NATIVE_RETURN_TARGET_EXCLUSION || audit.mutation.operationId !== scope.operationId ||
      audit.target.uid !== scope.uid || audit.target.targetGatewayId !== scope.targetGatewayId) return null;
  const reservation = audit.target.reservation as Reservation | undefined;
  return reservation && isDeepStrictEqual(reservation.scope, scope) && typeof reservation.podUid === "string" ? reservation : null;
}

function readDrainPod(audit: Audit | null, scope: NativeOldTargetScope) {
  if (!audit) return null;
  const { uid, slug: _slug, exclusionId, ...selection } = scope;
  const { target, mutation } = audit;
  const reservation = target.reservation as { selection?: unknown; oldPodUid?: string } | undefined;
  const drain = target.drain as { operationId?: string } | undefined;
  const qualifiedStatus = audit.status === "in-progress" || (audit.status === "completed" && audit.outcome === "completed");
  if (!qualifiedStatus || ![audit.id === exclusionId, exclusionId === nativeReturnTargetExclusionId(uid),
    mutation.kind === NATIVE_RETURN_TARGET_EXCLUSION, mutation.operationId === scope.operationId, target.uid === uid,
    target.targetGatewayId === scope.targetGatewayId, drain?.operationId === scope.operationId,
    isDeepStrictEqual(reservation?.selection, selection), Number.isSafeInteger(audit.actionStartedAt),
    audit.actionClaimId === exclusionId].every(Boolean)) return null;
  const podUid = reservation?.oldPodUid;
  return typeof podUid === "string" && podUid ? podUid : null;
}

export async function readRetiredTargetOperatorScope(tx: PlatformStateTransaction, actor: string, operationId: string): Promise<NativeOldTargetScope> {
  const operation = await tx.journal.operations.get(operationId);
  const uid = operation?.input.uid;
  const slug = operation?.input.userSlug;
  const handoff = operation?.schedulerHandoff;
  const sourceEpoch = handoff?.forwardRecovery?.sourceEpoch;
  requireExclusion(typeof uid === "string" && typeof slug === "string" && handoff && typeof sourceEpoch === "number" &&
    operation?.kind === "migrate-user", "exact Native return journal is required");
  const scope = { uid, slug, exclusionId: nativeReturnTargetExclusionId(uid), operationId, sourceEpoch,
    sourceGatewayId: handoff.fromGatewayId, targetGatewayId: handoff.toGatewayId, schedulerMigrationId: handoff.migrationId };
  const audit = await tx.journal.audits.get(scope.exclusionId);
  requireExclusion(audit?.actor === actor && readDrainPod(audit, scope), "operator does not own the exact protected drain");
  return scope;
}

async function readRetirementBinding(tx: PlatformStateTransaction, scope: NativeOldTargetScope) {
  const [audit, retirement] = await Promise.all([
    tx.journal.audits.get(scope.exclusionId), readNativeOldTargetRetirement(tx, scope.targetGatewayId),
  ]);
  const podUid = readDrainPod(audit, scope);
  if (!audit || !retirement || !podUid || retirement.createdAt <= (audit.actionStartedAt ?? Infinity) ||
      retirement.createdAt <= audit.createdAt) return null;
  return { audit, retirement, podUid };
}

export function createNativeReturnTargetExclusion(deps: {
  store: PlatformStateStore; now: () => number; provider?: Providers;
  verifyRestoredSource?(authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>): Promise<void>;
}) {
  const { store, now, provider } = deps;

  async function reserve(environment: "test" | "prod", actor: string, selection: HeldNativeReturnSelection) {
    requireExclusion(environment === "test" && actor && provider?.readRetainedCompletion, "protected TEST and independent physical provider required");
    return store.transaction({ label: "native-old-target-exclusion.reserve" }, async tx => {
      const reservation = await selectedOriginal(tx, selection);
      const { scope } = reservation;
      const existing = await tx.journal.audits.get(scope.exclusionId);
      if (existing) {
        requireExclusion(existing.actor === actor && isDeepStrictEqual(readBinding(existing, scope), reservation),
          "a different owner exclusion already exists");
        return reservation;
      }
      const audit = buildOperationAuditIntent({
        actor, forced: false, what: "Exclude a held Native return from its old Shared member",
        why: "Keep the old destination unable to receive this owner across rollback and worker replacement",
        mutation: { kind: NATIVE_RETURN_TARGET_EXCLUSION, operationId: scope.operationId },
        target: { uid: scope.uid, targetGatewayId: scope.targetGatewayId, reservation },
        preActionStatus: { assignment: "quiescing" },
        idempotencyKey: `${NATIVE_RETURN_TARGET_EXCLUSION}:${scope.uid}`, now,
      });
      await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "in-progress", lifecycleStage: "action-started",
        actionClaimId: scope.exclusionId, actionStartedAt: now(), actionRecoveryCount: 0 });
      return reservation;
    });
  }

  async function readOldTargetExclusion(tx: PlatformStateTransaction, scope: NativeOldTargetScope): Promise<boolean> {
    const audit = await tx.journal.audits.get(nativeReturnTargetExclusionId(scope.uid));
    const binding = readBinding(audit, scope);
    return !!binding && audit?.status === "completed" && audit.outcome === "completed" &&
      matchesRetainedRoles(binding, audit.target.retainedCompletion as VerifiedRetainedSharedRoles);
  }

  async function observePhysical(reservation: Reservation, assertCurrent: () => Promise<void>) {
    requireExclusion(provider?.readRetainedCompletion, "independent retained target provider unavailable");
    await assertCurrent();
    const witness = await provider.readRetainedCompletion(reservation);
    requireExclusion(matchesRetainedRoles(reservation, witness), "accepted retained role completion mismatch");
    await assertPublishedRelease(store, reservation, witness);
    await provider.verifyPod(reservation, assertCurrent);
    await provider.verifyStores(reservation.scope, assertCurrent);
    requireExclusion(isDeepStrictEqual(await provider.readRetainedCompletion(reservation), witness),
      "retained runtime changed during exclusion proof");
    await assertPublishedRelease(store, reservation, witness);
    await assertCurrent();
    return witness;
  }

  async function verifyReserved(actor: string, { scope, podUid }: Reservation) {
    const reservation = { scope, podUid };
    const read = async (tx: PlatformStateTransaction) => {
      const audit = await tx.journal.audits.get(nativeReturnTargetExclusionId(scope.uid));
      requireExclusion(audit?.actor === actor && isDeepStrictEqual(readBinding(audit, scope), reservation),
        "exclusion reservation changed");
      requireExclusion(isDeepStrictEqual(await selectedOriginal(tx, scope), reservation), "original pending return changed");
      return audit;
    };
    const evidence = await observePhysical(reservation, async () => {
      await store.transaction({ label: "native-old-target-exclusion.read-reserved", readOnly: true }, read);
    });
    await store.transaction({ label: "native-old-target-exclusion.verify" }, async tx => {
      const audit = await read(tx);
      if (audit.status === "completed") {
        requireExclusion(isDeepStrictEqual(audit.target.retainedCompletion, evidence), "verified retained role binding changed");
        return;
      }
      requireExclusion(audit.status === "in-progress", "exclusion reservation is unavailable");
      await tx.journal.audits.patch(audit.id, { status: "completed", lifecycleStage: "action-completed", outcome: "completed",
        completedAt: now(), target: { ...audit.target, retainedCompletion: evidence } }, { revision: audit.revision });
    });
  }

  async function verifyOldTargetExclusion(scope: NativeOldTargetScope) {
    const current = () => store.transaction({ label: "native-old-target-exclusion.read-verified", readOnly: true }, async tx => {
      requireExclusion(await readOldTargetExclusion(tx, scope), "durable verified exclusion missing");
      const audit = (await tx.journal.audits.get(scope.exclusionId))!;
      return { reservation: readBinding(audit, scope)!, completion: audit.target.retainedCompletion };
    });
    const before = await current();
    const live = await observePhysical(before.reservation, async () => {
      requireExclusion(isDeepStrictEqual(await current(), before), "durable exclusion changed during verification");
    });
    requireExclusion(isDeepStrictEqual(live, before.completion), "verified old target build changed");
  }

  async function readRetiredTargetExclusion(tx: PlatformStateTransaction, scope: NativeOldTargetScope) {
    const held = await readRetirementBinding(tx, scope);
    return held ? { ...held.retirement, oldPodUid: held.podUid } : null;
  }

  async function verifyRetiredTargetExclusion(scope: NativeOldTargetScope, { oldPodUid, ...retirement }: RetiredNativeTarget) {
    requireExclusion(provider?.verifyWholeRetirement && provider.verifyRetiredRoutes, "whole retirement and route observers required");
    const read = () => store.transaction({ label: "native-old-target-exclusion.read-retired", readOnly: true },
      tx => readRetirementBinding(tx, scope));
    const before = await read();
    requireExclusion(before?.podUid === oldPodUid && isDeepStrictEqual(before.retirement, retirement), "retirement no longer matches protected drain");
    const assertCurrent = async () => {
      const current = await read();
      requireExclusion(current?.podUid === oldPodUid && current.audit.revision === before.audit.revision &&
        isDeepStrictEqual(current.retirement, retirement), "retirement changed during physical observation");
    };
    await assertCurrent();
    requireExclusion(await provider.verifyRetiredRoutes({ scope, podUid: before.podUid }, assertCurrent) &&
      await provider.verifyWholeRetirement(scope.targetGatewayId, assertCurrent) &&
      await provider.verifyRetiredRoutes({ scope, podUid: before.podUid }, assertCurrent),
    "old Shared runtime, credentials or routes still exist");
    await assertCurrent();
  }

  async function releaseSharedHandoff(environment: "test" | "prod", actor: string, scope: NativeOldTargetScope) {
    requireExclusion(environment === "test" && actor && provider?.verifyWholeRetirement,
      "protected TEST whole retirement verifier required");
    const read = async (tx: PlatformStateTransaction) => {
      const current = await readReleaseAuthority(tx, scope);
      requireExclusion(!current.retiredMode || current.audit.actor === actor, "operator does not own the exact protected drain");
      return { ...current, restore: current.retiredMode ? await readRetiredLeaseRestoration(tx, scope, current) : null };
    };
    const before = await store.transaction({ label: "native-old-target-exclusion.retirement-read", readOnly: true }, read);
    const assertCurrent = async () => {
      const current = await store.transaction({ label: "native-old-target-exclusion.retirement-recheck", readOnly: true }, read);
      requireExclusion(isDeepStrictEqual(current.retirement, before.retirement) && current.audit.revision === before.audit.revision &&
        isDeepStrictEqual(current.restore, before.restore), "whole retirement, exclusion or original lease changed");
    };
    if (before.retiredMode) {
      await verifyRetiredTargetExclusion(scope, { ...before.retirement, oldPodUid: before.retiredMode });
    } else {
      requireExclusion(await provider.verifyWholeRetirement(scope.targetGatewayId, assertCurrent),
        "old Shared runtime or credential still exists");
    }
    if (before.restore) {
      requireExclusion(deps.verifyRestoredSource, "independent original serving verifier required");
      await deps.verifyRestoredSource(before.restore.authority, assertCurrent);
    }
    await store.transaction({ label: "native-old-target-exclusion.release-shared-handoff" }, async tx => {
      const { audit, retirement, restore } = await read(tx);
      requireExclusion(isDeepStrictEqual(retirement, before.retirement) && audit.revision === before.audit.revision &&
        isDeepStrictEqual(restore, before.restore), "whole retirement or original lease changed before publication");
      const prior = audit.target.sharedHandoffRelease as { retirement?: unknown; actor?: string } | undefined;
      if (prior) {
        requireExclusion(prior.actor === actor && isDeepStrictEqual(prior.retirement, retirement), "existing release proof changed");
        if (!restore) return;
      }
      const at = now();
      const restored = restore ? await restoreCompensatedLease(tx, scope.uid, restore, at) : {};
      await tx.journal.audits.patch(audit.id, { ...(before.retiredMode && !prior ? { status: "completed", lifecycleStage: "action-completed",
        outcome: "completed", completedAt: at } as const : {}), target: { ...audit.target, ...restored,
        sharedHandoffRelease: prior ?? { retirement, actor, verifiedAt: at } } }, { revision: audit.revision });
    });
  }

  async function releaseRetiredSharedHandoff(input: { environment: "test"; actor: string; operationId: string }) {
    requireExclusion(input.environment === "test" && input.actor, "protected TEST operator required");
    const scope = await store.transaction({ label: "native-old-target-exclusion.retired-release-scope", readOnly: true },
      tx => readRetiredTargetOperatorScope(tx, input.actor, input.operationId));
    return releaseSharedHandoff(input.environment, input.actor, scope);
  }

  return { reserve, verifyReserved, readOldTargetExclusion, verifyOldTargetExclusion, readRetiredTargetExclusion, verifyRetiredTargetExclusion, releaseSharedHandoff, releaseRetiredSharedHandoff };
}

async function readReleaseAuthority(tx: PlatformStateTransaction, scope: NativeOldTargetScope) {
  const [audit, operation, owner, assignments, retirement] = await Promise.all([
    tx.journal.audits.get(scope.exclusionId), tx.journal.operations.get(scope.operationId),
    tx.users.records.get(scope.uid), tx.gateways.assignments.listForUid(scope.uid),
    readNativeOldTargetRetirement(tx, scope.targetGatewayId),
  ]);
  const binding = readBinding(audit, scope);
  const retiredMode = readDrainPod(audit, scope);
  requireExclusion(audit && (retiredMode || verifiedRetainedBinding(audit, binding)), "verified old target exclusion missing");
  requireExclusion(operation && retirement && typeof operation.completedAt === "number" &&
    (retiredMode ? retirement.completedAt <= operation.completedAt : retirement.createdAt >= operation.completedAt),
    "exact whole retirement missing at the required rollback stage");
  const stored = operation.input.compensatingNativeReturn as Record<string, unknown> | undefined;
  requireExclusion([operation.status === "failed", operation.rolledBack === true, operation.schedulerHandoffReleased === true,
    !retiredMode || isDeepStrictEqual(stored?.retiredTarget, { ...retirement, oldPodUid: retiredMode }),
    operation.cutoverCommittedAt === undefined, Object.entries(scope).every(([key, value]) => stored?.[key] === value),
    owner?.gateway?.gatewayId === scope.sourceGatewayId, !owner?.fences.migration, assignments.length === 1,
    assignments[0]?.gatewayId === scope.sourceGatewayId, assignments[0]?.epoch === scope.sourceEpoch,
    assignments[0]?.state === "serving"].every(Boolean), "original source rollback is not complete");
  return { audit, retirement, retiredMode, operation, owner };
}

async function readRetiredLeaseRestoration(
  tx: PlatformStateTransaction, scope: NativeOldTargetScope, current: Awaited<ReturnType<typeof readReleaseAuthority>>,
) {
  const { operation, owner } = current;
  const stored = operation.input.compensatingNativeReturn as CompensatingNativeReturnAuthority;
  const prior = current.audit.target.retiredLeaseRestoration as Record<string, unknown> | undefined;
  if (prior !== undefined) {
    requireExclusion(prior && current.audit.target.sharedHandoffRelease && prior.operationId === scope.operationId &&
      prior.sourceEpoch === scope.sourceEpoch && prior.compensationAuditId === stored.auditId &&
      typeof prior.restoredAt === "number", "compensated lease restoration receipt changed");
    return null;
  }
  const lease = owner?.activationLease;
  const root = await tx.gateways.roots.get(scope.sourceGatewayId);
  requireExclusion(owner && lease && root?.allocation?.kind === "disposable-builder" && typeof root.liveRelease === "number",
    "original compensated lease or allocation missing");
  const { allocation } = root;
  requireExclusion([owner.slug === scope.slug, Object.keys(owner.fences).length === 0, lease.status === "returning",
    lease.targetGatewayId === scope.sourceGatewayId, lease.returnOperationId === scope.operationId, lease.operatorTerminateRequestedAt == null,
    root.gatewayClass === "isolated", root.ownerUid === scope.uid, root.builderSlug === scope.slug,
    root.desiredStatus === "running", root.liveRelease === root.desiredRelease, !root.runtimeRestartFence, !root.retirementClaim,
    allocation.claimedByUid === scope.uid, allocation.leaseId === lease.leaseId, allocation.generation === lease.generation].every(Boolean),
  "original compensated lease or allocation changed");
  await assertCompletedCompensationAudit(tx, operation, stored);
  const active = await tx.journal.operations.listForUid(scope.uid, { statuses: ["pending", "running"] });
  requireExclusion(active.length === 0, "competing owner operation prevents compensation finalization");
  return { lease, authority: { ...stored, sourceRelease: root.liveRelease } };
}

async function assertCompletedCompensationAudit(
  tx: PlatformStateTransaction, operation: Awaited<ReturnType<typeof readReleaseAuthority>>["operation"],
  authority: CompensatingNativeReturnAuthority,
) {
  requireExclusion(typeof authority.auditId === "string" && typeof authority.attemptId === "string" && authority.source,
    "completed compensation identity missing");
  const audit = await tx.journal.audits.get(authority.auditId);
  const history = audit?.target.archivedReturn as { handoff?: unknown } | undefined;
  requireExclusion(audit?.status === "completed" && audit.outcome === "completed" && audit.actionClaimId === authority.attemptId &&
    isDeepStrictEqual(audit.target.original, authority.source) && isDeepStrictEqual(history?.handoff, operation.schedulerHandoff),
    "completed compensation audit changed");
}

async function restoreCompensatedLease(
  tx: PlatformStateTransaction, uid: string, restore: NonNullable<Awaited<ReturnType<typeof readRetiredLeaseRestoration>>>, at: number,
) {
  const { lease, authority } = restore;
  const { returnOperationId: _operation, returningAt: _returning, returnRequestedAt: _requested, returnRequestedBy: _actor, returnReason: _reason, ...retained } = lease;
  await tx.users.records.setActivationLease(uid, { ...retained, status: "active", activeAt: at }, {
    leaseId: lease.leaseId, generation: lease.generation, status: ["returning"],
  });
  return { retiredLeaseRestoration: { leaseId: lease.leaseId, generation: lease.generation, operationId: authority.operationId,
    compensationAuditId: authority.auditId, sourceEpoch: authority.sourceEpoch, restoredAt: at } };
}

function verifiedRetainedBinding(audit: Audit, binding: Reservation | null) {
  return binding && audit.status === "completed" && audit.outcome === "completed" &&
    matchesRetainedRoles(binding, audit.target.retainedCompletion as VerifiedRetainedSharedRoles);
}

function validEvidence(value: unknown): value is VerifiedRetainedSharedRoles {
  const witness = value as Partial<VerifiedRetainedSharedRoles> | null;
  return !!witness && Number.isSafeInteger(witness.release) && Number(witness.release) > 0 &&
    DIGEST.test(witness.payloadHash ?? "") && DIGEST.test(witness.verifiedCommonArchiveSha256 ?? "") && !!witness.artifactSetId &&
    immutableDigest(witness.images?.gateway) && immutableDigest(witness.images?.["gateway-edge"]) &&
    witness.images?.gateway !== witness.images?.["gateway-edge"];
}

function immutableDigest(value?: string): boolean {
  return !!value && /^sha256:[a-f0-9]{64}$/.test(value);
}

function matchesRetainedRoles(reservation: Reservation, proof: VerifiedRetainedSharedRoles): boolean {
  return validEvidence(proof) && proof.gatewayId === reservation.scope.targetGatewayId && proof.podUid === reservation.podUid;
}

async function assertPublishedRelease(store: PlatformStateStore, reservation: Reservation, proof: VerifiedRetainedSharedRoles) {
  const id = reservation.scope.targetGatewayId;
  await store.transaction({ label: "native-old-target-exclusion.read-published-release", readOnly: true }, async tx => {
    const root = await tx.gateways.roots.get(id);
    const runtime = await tx.fleetRegistry.get(id);
    const artifact = await tx.gateways.releases.get(id, proof.release);
    const kube = runtime?.kubernetes;
    requireExclusion(root && runtime && kube && artifact, "current Shared release is unavailable");
    requireExclusion([root.gatewayClass === "shared", root.desiredStatus === "running", !root.retirementClaim,
      root.desiredRelease === proof.release, root.liveRelease === proof.release,
      artifact.payloadHash === proof.payloadHash, artifact.payload.imageTag.split("@").at(-1) === proof.images.gateway,
      artifact.payload.gatewayEdgeImage?.imageTag.split("@").at(-1) === proof.images["gateway-edge"], runtime.release === proof.release,
      kube.pods?.length === 1, kube.totalPods === 1, kube.readyPods === 1, kube.pods?.[0]?.uid === proof.podUid].every(Boolean),
    "current published Shared release does not match the accepted roles");
  });
}

export function createNativeOldTargetPhysicalProvider(deps: {
  namespace: string;
  privateKey: string;
  runKubectl: SurgeKubectl;
  store: PlatformStateStore;
  agentStoreAdminDsn: string;
  readRetainedCompletion: Providers["readRetainedCompletion"];
  verifyWholeRetirement?: Providers["verifyWholeRetirement"];
}): Providers {
  const verifyStores = createHeldReturnStoreCustodyVerifier(deps.agentStoreAdminDsn, { serializeCredentialChanges: true });
  return {
    readRetainedCompletion: deps.readRetainedCompletion,
    verifyWholeRetirement: deps.verifyWholeRetirement,
    verifyRetiredRoutes: ({ scope, podUid }, assertCurrent) => retiredTargetRoutesAbsent(deps, scope.targetGatewayId, podUid, assertCurrent),
    verifyPod: ({ scope, podUid }, assertCurrent) =>
      createHeldNativeReturnDestinationVerifier({ ...deps, loopbackPodUid: podUid })(scope, assertCurrent),
    async verifyStores(scope, assertCurrent) {
      await assertCurrent();
      const read = () => deps.store.users.agentStores.list(scope.uid);
      const before = await read();
      await verifyStores({ ...scope, schemas: before.map(item => item.schema) });
      requireExclusion(isDeepStrictEqual(await read(), before), "owner PostgreSQL inventory changed");
      await assertCurrent();
    },
  };
}

function isKubeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function endpointTargetUid(endpoint: unknown): string | undefined {
  requireExclusion(isKubeRecord(endpoint) && Array.isArray(endpoint.addresses) && endpoint.addresses.length > 0 &&
    endpoint.addresses.every(address => typeof address === "string" && address.length > 0), "invalid retired target EndpointSlice endpoint");
  const target = endpoint.targetRef;
  if (target == null) return undefined;
  requireExclusion(isKubeRecord(target) && (target.uid === undefined || typeof target.uid === "string"),
    "invalid retired target EndpointSlice reference");
  return target.uid;
}

function readEndpointSlice(slice: unknown) {
  requireExclusion(isKubeRecord(slice) && isKubeRecord(slice.metadata) && typeof slice.metadata.name === "string" &&
    slice.metadata.name.length > 0 && (slice.endpoints === null || Array.isArray(slice.endpoints)),
  "invalid retired target EndpointSlice");
  const labels = slice.metadata.labels;
  requireExclusion(labels == null || isKubeRecord(labels), "invalid retired target EndpointSlice labels");
  const service = labels?.["kubernetes.io/service-name"];
  requireExclusion(service === undefined || typeof service === "string", "invalid retired target EndpointSlice service");
  return { service, targetUids: (slice.endpoints ?? []).map(endpointTargetUid) };
}

export async function retiredTargetRoutesAbsent(
  deps: { namespace: string; runKubectl: SurgeKubectl }, gatewayId: string, podUid: string, assertCurrent: () => Promise<void>,
) {
  const services = new Set([`octogee-gateway-${gatewayId}`, `gateway-edge-${gatewayId}`]);
  const prefix = ["-n", deps.namespace, "get"];
  for (const name of services) {
    await assertCurrent();
    const service = await deps.runKubectl([...prefix, `service/${name}`, "--ignore-not-found=true", "-o", "name"]);
    requireExclusion(service.code === 0, "could not read retired target Service");
    if (service.stdout.trim()) return false;
  }
  await assertCurrent();
  const endpoints = await deps.runKubectl([...prefix, "endpointslices", "-o", "json"]);
  requireExclusion(endpoints.code === 0, "could not read retired target EndpointSlices");
  const census: unknown = JSON.parse(endpoints.stdout);
  requireExclusion(isKubeRecord(census) && Array.isArray(census.items), "invalid retired target EndpointSlice census");
  const absent = !census.items.map(readEndpointSlice).some(slice => services.has(slice.service ?? "") ||
    slice.targetUids.includes(podUid));
  await assertCurrent();
  return absent;
}
