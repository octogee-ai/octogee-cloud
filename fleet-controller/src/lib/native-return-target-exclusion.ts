import { isDeepStrictEqual } from "node:util";
import { createHeldReturnStoreCustodyVerifier } from "@octogee/core/agent-store-credentials";
import { NATIVE_RETURN_TARGET_EXCLUSION, nativeReturnTargetExclusionId, readHeldNativeReturnForTargetExclusion, readNativeOldTargetRetirement,
  type HeldNativeReturnSelection } from "@octogee/core/fleet-state";
import { buildOperationAuditIntent } from "@octogee/core/operation-audit";
import type { PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
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
  readRetainedCompletion(reservation: Reservation): Promise<VerifiedRetainedSharedRoles>;
  verifyPod(reservation: Reservation, assertCurrent: () => Promise<void>): Promise<void>;
  verifyStores(scope: NativeOldTargetScope, assertCurrent: () => Promise<void>): Promise<void>;
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

export function createNativeReturnTargetExclusion(deps: { store: PlatformStateStore; now: () => number; provider?: Providers }) {
  const { store, now, provider } = deps;

  async function reserve(environment: "test" | "prod", actor: string, selection: HeldNativeReturnSelection) {
    requireExclusion(environment === "test" && actor && provider, "protected TEST and independent physical provider required");
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
    requireExclusion(provider, "independent physical provider unavailable");
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

  async function releaseSharedHandoff(environment: "test" | "prod", actor: string, scope: NativeOldTargetScope) {
    requireExclusion(environment === "test" && actor && provider?.verifyWholeRetirement,
      "protected TEST whole retirement verifier required");
    const read = (tx: PlatformStateTransaction) => readReleaseAuthority(tx, scope);
    const before = await store.transaction({ label: "native-old-target-exclusion.retirement-read", readOnly: true }, read);
    const assertCurrent = async () => {
      const current = await store.transaction({ label: "native-old-target-exclusion.retirement-recheck", readOnly: true }, read);
      requireExclusion(isDeepStrictEqual(current.retirement, before.retirement) && current.audit.revision === before.audit.revision,
        "whole retirement or exclusion changed");
    };
    requireExclusion(await provider.verifyWholeRetirement(scope.targetGatewayId, assertCurrent),
      "old Shared runtime or credential still exists");
    await store.transaction({ label: "native-old-target-exclusion.release-shared-handoff" }, async tx => {
      const { audit, retirement } = await read(tx);
      requireExclusion(isDeepStrictEqual(retirement, before.retirement) && audit.revision === before.audit.revision,
        "whole retirement changed before publication");
      const prior = audit.target.sharedHandoffRelease as { retirement?: unknown; actor?: string } | undefined;
      if (prior) {
        requireExclusion(prior.actor === actor && isDeepStrictEqual(prior.retirement, retirement), "existing release proof changed");
        return;
      }
      await tx.journal.audits.patch(audit.id, { target: { ...audit.target,
        sharedHandoffRelease: { retirement, actor, verifiedAt: now() } } }, { revision: audit.revision });
    });
  }

  return { reserve, verifyReserved, readOldTargetExclusion, verifyOldTargetExclusion, releaseSharedHandoff };
}

async function readReleaseAuthority(tx: PlatformStateTransaction, scope: NativeOldTargetScope) {
  const [audit, operation, owner, assignments, retirement] = await Promise.all([
    tx.journal.audits.get(scope.exclusionId), tx.journal.operations.get(scope.operationId),
    tx.users.records.get(scope.uid), tx.gateways.assignments.listForUid(scope.uid),
    readNativeOldTargetRetirement(tx, scope.targetGatewayId),
  ]);
  const binding = readBinding(audit, scope);
  requireExclusion(audit && binding && audit.status === "completed" && audit.outcome === "completed" &&
    matchesRetainedRoles(binding, audit.target.retainedCompletion as VerifiedRetainedSharedRoles), "verified old target exclusion missing");
  requireExclusion(operation && retirement && typeof operation.completedAt === "number" &&
    retirement.createdAt >= operation.completedAt, "exact whole retirement missing after rollback");
  const stored = operation.input.compensatingNativeReturn as Record<string, unknown> | undefined;
  requireExclusion([operation.status === "failed", operation.rolledBack === true, operation.schedulerHandoffReleased === true,
    operation.cutoverCommittedAt === undefined, Object.entries(scope).every(([key, value]) => stored?.[key] === value),
    owner?.gateway?.gatewayId === scope.sourceGatewayId, !owner?.fences.migration, assignments.length === 1,
    assignments[0]?.gatewayId === scope.sourceGatewayId, assignments[0]?.epoch === scope.sourceEpoch,
    assignments[0]?.state === "serving"].every(Boolean), "original source rollback is not complete");
  return { audit, retirement };
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
  namespace: "octogee-test";
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
