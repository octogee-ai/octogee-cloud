import { isDeepStrictEqual } from "node:util";
import { isolatedGatewayId } from "@octogee/shared/types/isolated-gateway-id";
import { ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT, isolatedGatewayServiceAccountName, } from "@octogee/shared/types/glm";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { isolatedSizingTier } from "@octogee/shared/types/sizing-profile";
import { isPlatformStateError } from "../platform-state/errors.js";
import { readSharedGatewayPoolConfigInStore } from "../shared-gateway-pool-read.js";
import { assertGatewayRuntimeMutationUnfencedInStore, isolatedRuntimeMutationFenced, } from "../gateway-retirement-claim.js";
import { withCurrentSizingKey } from "../sizing-key.js";
import { readGatewayArtifactInStore, writeInitialGatewayReleaseInTransaction, } from "../gateway-live-release.js";
import { ISOLATED_GATEWAY_ALLOCATION_KIND, ISOLATED_GATEWAY_LIFECYCLE_ACTOR, IsolatedGatewayFenceError, checkPlacementOwner, } from "./inputs.js";
import { exactLeaseFence, userAllowsInteractiveAccess } from "./lease.js";
import { retireOwnedIsolatedGateway } from "./retirement.js";
import { parkedPrewarmInput, readActiveParkedPrewarm } from "./prewarm.js";
function isolatedRuntimeConfig(gatewayId, sizingTier) {
    return {
        configSchemaVersion: 1,
        profile: null,
        gatewayClass: "isolated",
        imageProfile: "isolated",
        sizingTier,
        gcpProject: null,
        gatewayContainerSecurityContext: null,
        serviceAccountName: isolatedGatewayServiceAccountName(gatewayId),
        serviceAccount: ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT,
        builderAccess: {
            controlUiEnabled: true,
            controlIdentity: "per-user",
            kubeApiServerEgressCidrs: [],
            reason: "disposable-builder-runtime",
        },
        ownerUid: null,
        builderSlug: null,
        modelBrokerLimits: null,
    };
}
export function buildIsolatedGatewayConfig(gatewayId, request) {
    return {
        ...isolatedRuntimeConfig(gatewayId, request.sizingTier),
        sizingProfile: request.sizingKey,
        ownerUid: request.uid,
        builderSlug: request.builderSlug,
        allocation: {
            kind: ISOLATED_GATEWAY_ALLOCATION_KIND,
            schemaVersion: 1,
            leaseId: request.leaseId,
            generation: request.generation,
            claimedByUid: request.uid,
        },
    };
}
export function allocatedIsolatedGatewayId(request) {
    return isolatedGatewayId(request.builderSlug, request.generation, request.leaseId, request.sizingTier);
}
function allocationSourceMatches(input) {
    const { request, user } = input;
    return userAllowsInteractiveAccess(user) &&
        input.configuredSharedGatewayIds.includes(request.sourceGatewayId) &&
        user.gateway?.gatewayId === request.sourceGatewayId &&
        user.slug === request.builderSlug;
}
function allocationLeaseMatches(request, lease) {
    return lease.leaseId === request.leaseId &&
        lease.generation === request.generation &&
        lease.status === "requested" &&
        lease.targetGatewayId === undefined &&
        lease.sourceGatewayId === request.sourceGatewayId &&
        lease.sourceAssignmentEpoch === request.sourceAssignmentEpoch;
}
function allocationSizingKeyMatches(request, lease, sizingKey, sizingProfile) {
    return lease.entitlementTier === request.sizingKey &&
        lease.sizingTier === request.sizingTier &&
        sizingKey === request.sizingKey &&
        isolatedSizingTier(sizingProfile) === request.sizingTier;
}
function allocationAssignmentMatches(request, assignment) {
    return assignment.uid === request.uid &&
        assignment.gatewayId === request.sourceGatewayId &&
        assignment.state === "serving" &&
        assignment.epoch === request.sourceAssignmentEpoch;
}
export function isolatedAllocationFenceAllows(input) {
    const { request, user, assignment } = input;
    const lease = user.activationLease;
    if (!lease || !assignment)
        return false;
    return allocationSourceMatches({
        request,
        configuredSharedGatewayIds: input.configuredSharedGatewayIds,
        user,
    }) &&
        allocationLeaseMatches(request, lease) &&
        allocationSizingKeyMatches(request, lease, input.sizingKey, input.sizingProfile) &&
        allocationAssignmentMatches(request, assignment);
}
function exactExistingIsolatedGateway(value, gatewayId, request) {
    const root = projectGatewayDesiredRootForGateway(value, gatewayId);
    const allocation = root?.allocation;
    return root !== null &&
        root.gatewayClass === "isolated" &&
        root.ownerUid === request.uid &&
        root.builderSlug === request.builderSlug &&
        allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND &&
        allocation.claimedByUid === request.uid &&
        allocation.leaseId === request.leaseId &&
        allocation.generation === request.generation;
}
function existingAllocationCanReplay(input) {
    const lease = input.user.activationLease;
    return [
        input.gatewayExists,
        input.releaseExists,
        exactExistingIsolatedGateway(input.gatewayData, input.gatewayId, input.request),
        lease?.leaseId === input.request.leaseId,
        lease?.generation === input.request.generation,
        lease?.status === "provisioning",
        lease?.targetGatewayId === input.gatewayId,
    ].every(Boolean);
}
export function sharedSourceRelease(value, gatewayId) {
    const root = projectGatewayDesiredRootForGateway(value, gatewayId);
    return root &&
        root.gatewayClass === "shared" &&
        (root.desiredStatus === "running" || root.desiredStatus === "draining") &&
        root.liveRelease !== null &&
        root.desiredRelease === root.liveRelease
        ? root.liveRelease
        : null;
}
function parkedRootMatches(root, request, parked) {
    const allocation = root?.allocation;
    return root !== null &&
        root.gatewayClass === "isolated" &&
        root.desiredStatus === "paused" &&
        root.ownerUid === request.uid &&
        root.builderSlug === request.builderSlug &&
        root.sizingTier === request.sizingTier &&
        allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND &&
        allocation.claimedByUid === request.uid &&
        allocation.generation === parked.generation &&
        parked.generation < request.generation;
}
function rootOnLiveRelease(root) {
    return root.liveRelease !== null && root.desiredRelease === root.liveRelease;
}
async function readParkedRoot(store, request, parked) {
    const root = projectGatewayDesiredRootForGateway(await store.gateways.roots.get(parked.gatewayId), parked.gatewayId);
    if (!parkedRootMatches(root, request, parked)) {
        throw new IsolatedGatewayFenceError(`parked gateway ${parked.gatewayId} no longer matches ${request.uid}'s ${request.sizingTier} VM`);
    }
    return root;
}
export async function gatewayRunsArtifact(store, root, artifact) {
    if (!rootOnLiveRelease(root))
        return false;
    const liveArtifact = await readGatewayArtifactInStore(store, root.gatewayId, root.liveRelease);
    if (!liveArtifact) {
        throw new Error(`gateway ${root.gatewayId} release ${root.liveRelease} is unreadable`);
    }
    return isDeepStrictEqual(liveArtifact, artifact);
}
async function assertParkedGatewayRuntimeUnfenced(transaction, gatewayId, owner) {
    try {
        if (owner && isolatedRuntimeMutationFenced(owner))
            throw new Error("owner restore or source transfer is unresolved");
        await assertGatewayRuntimeMutationUnfencedInStore(transaction, gatewayId);
    }
    catch (error) {
        if (isPlatformStateError(error))
            throw error;
        throw new IsolatedGatewayFenceError(`parked gateway ${gatewayId} runtime mutation outcome is unresolved: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function provisioningLease(lease, targetGatewayId, now) {
    return { ...lease, status: "provisioning", targetGatewayId, provisionedAt: now };
}
function assertParkedRootResumable(input) {
    const { parked } = input;
    const root = projectGatewayDesiredRootForGateway(input.stored, parked.gatewayId);
    const resumable = input.handoff && root?.desiredStatus === "running"
        ? { ...root, desiredStatus: "paused" } : root;
    if (!input.stored || !parkedRootMatches(resumable, input.request, parked) || root.liveRelease !== input.liveRelease ||
        !rootOnLiveRelease(root)) {
        throw new IsolatedGatewayFenceError(`parked gateway ${parked.gatewayId} changed before resuming`);
    }
    if (input.runtime?.runtime !== "gce-vm") {
        throw new IsolatedGatewayFenceError(`parked gateway ${parked.gatewayId} is not a VM runtime`);
    }
    return root;
}
async function verifyPrewarmHandoff(transaction, request, parked, expected) {
    const prewarm = await readActiveParkedPrewarm(transaction, request.uid);
    if (prewarm && prewarm.output?.prewarmState !== "handoff") {
        throw new IsolatedGatewayFenceError("Owner computer prewarm has not released the allocation");
    }
    const handoff = prewarm?.gatewayId === parked.gatewayId ? prewarm : null;
    if ((handoff?.id ?? undefined) !== expected)
        throw new IsolatedGatewayFenceError("Owner computer prewarm handoff changed");
    return handoff !== null;
}
async function resumeParkedIsolatedGateway(input, request, parked, source, mode) {
    const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now: input.now() };
    const resume = () => withCurrentSizingKey(sizingKeyRead, ({ sizingKey, profile: sizingProfile, assertCurrent }) => input.store.transaction({ label: "disposable-gateway.resume-parked", readOnly: mode === "plan" }, async (transaction) => {
        await input.requireOwner(transaction);
        const [roots, runtime, user, assignment, pool] = await Promise.all([
            transaction.gateways.roots.getMany([parked.gatewayId, request.sourceGatewayId]),
            transaction.fleetRegistry.get(parked.gatewayId),
            transaction.users.records.get(request.uid),
            transaction.gateways.assignments.get(request.sourceGatewayId, request.uid),
            readSharedGatewayPoolConfigInStore(transaction),
        ]);
        assertCurrent(user);
        const stored = roots.get(parked.gatewayId) ?? null;
        const handoff = await verifyPrewarmHandoff(transaction, request, parked, source.handoffOperationId);
        const root = assertParkedRootResumable({ stored, runtime, request, parked, liveRelease: source.liveRelease, handoff });
        if (sharedSourceRelease(roots.get(request.sourceGatewayId), request.sourceGatewayId) !== source.release) {
            throw new IsolatedGatewayFenceError(`isolated gateway source ${request.sourceGatewayId} changed`);
        }
        await assertParkedGatewayRuntimeUnfenced(transaction, parked.gatewayId, user);
        const lease = user?.activationLease;
        if (!user || !lease || !isolatedAllocationFenceAllows({
            request,
            configuredSharedGatewayIds: pool?.sharedGatewayIds ?? [],
            user,
            sizingKey,
            sizingProfile,
            assignment,
        })) {
            throw new IsolatedGatewayFenceError(`isolated gateway demand fence changed for ${request.uid}`);
        }
        input.requireHomeReady({ user, request, sizingProfile });
        if (mode === "plan")
            return;
        const now = input.now();
        await transaction.gateways.roots.patch(parked.gatewayId, {
            desiredStatus: "running",
            allocation: { ...root.allocation, leaseId: request.leaseId, generation: request.generation },
            updatedAt: now,
            updatedBy: ISOLATED_GATEWAY_LIFECYCLE_ACTOR,
        }, { revision: stored.revision });
        await transaction.users.records.setActivationLease(request.uid, provisioningLease(lease, parked.gatewayId, now), exactLeaseFence(lease, ["requested"]));
    }));
    if (mode === "plan") {
        await resume();
        return;
    }
    await input.mutations({
        actor: ISOLATED_GATEWAY_LIFECYCLE_ACTOR,
        forced: false,
        what: "resume-parked-builder-gateway",
        why: "Reuse the owner's suspended VM for the next activation lease",
        target: { uid: request.uid, gatewayId: parked.gatewayId },
        preActionStatus: { desiredStatus: "paused", generation: parked.generation },
        mutation: { desiredStatus: "running", leaseId: request.leaseId, generation: request.generation },
        action: resume,
    });
}
async function resumeOrRetireParkedGateway(input, request, parked, source, mode) {
    const root = await readParkedRoot(input.store, request, parked);
    const sameProfile = root.sizingProfile === request.sizingKey;
    if (sameProfile && await gatewayRunsArtifact(input.store, root, source.artifact)) {
        await resumeParkedIsolatedGateway(input, request, parked, { release: source.release, liveRelease: root.liveRelease }, mode);
        return parked.gatewayId;
    }
    const retirement = await retireOwnedIsolatedGateway(input, {
        uid: request.uid,
        builderSlug: request.builderSlug,
        gatewayId: parked.gatewayId,
        generation: parked.generation,
        reason: "parked-computer-replaced",
    }, mode);
    if (!retirement.retired) {
        const obsolete = sameProfile ? "runs another release" : `was not created from sizing profile ${request.sizingKey}`;
        throw new IsolatedGatewayFenceError(`parked gateway ${parked.gatewayId} ${obsolete} and could not be retired`);
    }
    return null;
}
async function matchingParkedGateway(state, request, artifact) {
    const roots = await state.gateways.roots.list({ gatewayClass: "isolated", ownerUid: request.uid });
    const matches = [];
    for (const root of roots) {
        if (!root.allocation || root.sizingProfile !== request.sizingKey)
            continue;
        const parked = { gatewayId: root.gatewayId, generation: root.allocation.generation };
        const projected = projectGatewayDesiredRootForGateway(root, root.gatewayId);
        if (projected && parkedRootMatches(projected, request, parked) &&
            (await state.fleetRegistry.get(root.gatewayId))?.runtime === "gce-vm" &&
            await gatewayRunsArtifact(state, projected, artifact)) {
            matches.push(parked);
        }
    }
    if (matches.length > 1)
        throw new IsolatedGatewayFenceError("More than one parked computer matches the current Shared release");
    return matches[0];
}
async function readAllocationSource(store, request) {
    const poolConfig = await readSharedGatewayPoolConfigInStore(store);
    if (!poolConfig?.sharedGatewayIds.includes(request.sourceGatewayId)) {
        throw new IsolatedGatewayFenceError(`isolated gateway source ${request.sourceGatewayId} is not a shared pool member`);
    }
    const release = sharedSourceRelease(await store.gateways.roots.get(request.sourceGatewayId), request.sourceGatewayId);
    if (release === null) {
        throw new IsolatedGatewayFenceError(`isolated gateway source ${request.sourceGatewayId} is unavailable`);
    }
    const artifact = await readGatewayArtifactInStore(store, request.sourceGatewayId, release);
    if (!artifact) {
        throw new Error(`isolated gateway source ${request.sourceGatewayId} release ${release} is unreadable`);
    }
    return { release, artifact };
}
async function checkHomeReadiness(input, request, gatewayId) {
    const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now: input.now() };
    await withCurrentSizingKey(sizingKeyRead, ({ profile: sizingProfile }) => input.store.transaction({ label: "isolated-gateway.home-readiness", readOnly: true }, async (transaction) => {
        const [existingGateway, existingRelease, user] = await Promise.all([
            transaction.gateways.roots.get(gatewayId),
            transaction.gateways.releases.get(gatewayId, 1),
            transaction.users.records.get(request.uid),
        ]);
        if (!user)
            throw new IsolatedGatewayFenceError(`isolated gateway owner ${request.uid} is missing`);
        if (existingAllocationCanReplay({
            gatewayExists: existingGateway !== null,
            gatewayData: existingGateway,
            releaseExists: existingRelease !== null,
            gatewayId,
            request,
            user,
        }))
            return;
        input.requireHomeReady({ user, request, sizingProfile });
    }));
}
export async function allocateIsolatedGateway(input, request, mode = "apply") {
    await checkPlacementOwner(input);
    const gatewayId = allocatedIsolatedGatewayId(request);
    await checkHomeReadiness(input, request, gatewayId);
    const prewarm = await readActiveParkedPrewarm(input.store, request.uid);
    if (prewarm && prewarm.output?.prewarmState !== "handoff")
        throw new IsolatedGatewayFenceError("Owner computer prewarm has not released the allocation");
    const source = await readAllocationSource(input.store, request);
    if (prewarm?.output?.prewarmState === "handoff") {
        const { gatewayId: warmingGatewayId, generation } = parkedPrewarmInput(prewarm);
        const root = projectGatewayDesiredRootForGateway(await input.store.gateways.roots.get(warmingGatewayId), warmingGatewayId);
        if (!root || root.sizingProfile !== request.sizingKey || !(await gatewayRunsArtifact(input.store, root, source.artifact))) {
            throw new IsolatedGatewayFenceError("Owner computer prewarm handoff no longer matches the current Shared release");
        }
        await resumeParkedIsolatedGateway(input, request, { gatewayId: warmingGatewayId, generation }, {
            release: source.release, liveRelease: root.liveRelease, handoffOperationId: prewarm.id,
        }, mode);
        return { gatewayId: warmingGatewayId, outcome: "resumed" };
    }
    const parked = request.parkedGateway ?? await matchingParkedGateway(input.store, request, source.artifact);
    if (parked) {
        const resumed = await resumeOrRetireParkedGateway(input, request, parked, source, mode);
        if (resumed)
            return { gatewayId: resumed, outcome: "resumed" };
    }
    if (mode === "apply")
        await input.ensureAuthSecret({ namespace: input.namespace, gatewayId });
    const now = input.now();
    const config = buildIsolatedGatewayConfig(gatewayId, request);
    const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now };
    await withCurrentSizingKey(sizingKeyRead, ({ sizingKey, profile: sizingProfile, assertCurrent }) => input.store.transaction({ label: "disposable-gateway.allocate", readOnly: mode === "plan" }, async (transaction) => {
        await input.requireOwner(transaction);
        const [existingGateway, existingRelease, user, assignment, currentSource, currentPool,] = await Promise.all([
            transaction.gateways.roots.get(gatewayId),
            transaction.gateways.releases.get(gatewayId, 1),
            transaction.users.records.get(request.uid),
            transaction.gateways.assignments.get(request.sourceGatewayId, request.uid),
            transaction.gateways.roots.get(request.sourceGatewayId),
            readSharedGatewayPoolConfigInStore(transaction),
        ]);
        assertCurrent(user);
        if (!user) {
            throw new IsolatedGatewayFenceError(`isolated gateway owner ${request.uid} is missing`);
        }
        if (existingGateway || existingRelease) {
            if (existingAllocationCanReplay({
                gatewayExists: existingGateway !== null,
                gatewayData: existingGateway,
                releaseExists: existingRelease !== null,
                gatewayId,
                request,
                user,
            })) {
                return;
            }
            throw new IsolatedGatewayFenceError(`isolated gateway id collision at ${gatewayId}`);
        }
        if (sharedSourceRelease(currentSource, request.sourceGatewayId) !== source.release) {
            throw new IsolatedGatewayFenceError(`isolated gateway source ${request.sourceGatewayId} changed`);
        }
        const lease = user.activationLease;
        if (!lease || !isolatedAllocationFenceAllows({
            request,
            configuredSharedGatewayIds: currentPool?.sharedGatewayIds ?? [],
            user,
            sizingKey,
            sizingProfile,
            assignment,
        })) {
            throw new IsolatedGatewayFenceError(`isolated gateway demand fence changed for ${request.uid}`);
        }
        if (await readActiveParkedPrewarm(transaction, request.uid))
            throw new IsolatedGatewayFenceError("Owner computer prewarm changed before fresh allocation");
        if (await matchingParkedGateway(transaction, request, source.artifact))
            throw new IsolatedGatewayFenceError("A matching parked computer became available before allocation");
        input.requireHomeReady({ user, request, sizingProfile });
        if (mode === "plan")
            return;
        await writeInitialGatewayReleaseInTransaction(transaction, {
            gatewayId,
            config,
            artifact: source.artifact,
            createdBy: ISOLATED_GATEWAY_LIFECYCLE_ACTOR,
            now,
            desiredStatus: "running",
        });
        await transaction.users.records.setActivationLease(request.uid, provisioningLease(lease, gatewayId, now), exactLeaseFence(lease, ["requested"]));
    }));
    return { gatewayId, outcome: "allocated" };
}
function refreshFenceHolds(input) {
    const { current, request, sourceGatewayId } = input;
    return userAllowsInteractiveAccess(current) && allocationLeaseMatches(request, input.lease) &&
        current.gateway?.gatewayId === sourceGatewayId && current.fences.migration === undefined &&
        current.slug === request.builderSlug && sharedSourceRelease(input.root, sourceGatewayId) !== null &&
        refreshedSourceAssignmentMatches(input.assigned, request, sourceGatewayId);
}
function refreshedSourceAssignmentMatches(assigned, request, sourceGatewayId) {
    return assigned.uid === request.uid && assigned.slug === request.builderSlug &&
        assigned.gatewayId === sourceGatewayId && assigned.state === "serving" &&
        typeof assigned.epoch === "number" && Number.isSafeInteger(assigned.epoch) && assigned.epoch >= 0;
}
export async function refreshRequestedAllocation(input, request, mode = "apply") {
    await checkPlacementOwner(input);
    const initial = await input.store.users.records.get(request.uid);
    if (!initial)
        throw new IsolatedGatewayFenceError("User owner disappeared");
    const sizingKey = await input.readSizingKey(request.uid, input.now());
    const sizingProfile = sizingKey === null ? null : await input.store.config.orchestrator.getSizingProfile(sizingKey);
    if (sizingKey === null || sizingProfile?.isolation !== "isolated")
        throw new IsolatedGatewayFenceError("User tier no longer authorizes this allocation");
    const sourceGatewayId = initial.gateway?.gatewayId;
    if (!sourceGatewayId)
        throw new IsolatedGatewayFenceError("Isolated allocation has no current source");
    const sourceAssignmentEpoch = (await input.store.gateways.assignments.get(sourceGatewayId, request.uid))?.epoch;
    if (sizingKey === request.sizingKey && sizingProfile.sizingTier === request.sizingTier &&
        sourceGatewayId === request.sourceGatewayId && sourceAssignmentEpoch === request.sourceAssignmentEpoch)
        return false;
    const refresh = () => {
        const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now: input.now() };
        return withCurrentSizingKey(sizingKeyRead, ({ sizingKey: currentSizingKey, assertCurrent }) => input.store.transaction({ label: "disposable-gateway.refresh-allocation", readOnly: mode === "plan" }, async (transaction) => {
            await input.requireOwner(transaction);
            const [current, root, assigned] = await Promise.all([
                transaction.users.records.get(request.uid),
                transaction.gateways.roots.get(sourceGatewayId),
                transaction.gateways.assignments.get(sourceGatewayId, request.uid),
            ]);
            assertCurrent(current);
            const lease = current?.activationLease ?? null;
            if (!current || !lease || !assigned || currentSizingKey !== sizingKey ||
                !refreshFenceHolds({ current, lease, assigned, root, request, sourceGatewayId })) {
                throw new IsolatedGatewayFenceError("Isolated allocation changed before refreshing its source or tier");
            }
            if (mode === "plan")
                return;
            await transaction.users.records.setActivationLease(request.uid, {
                ...lease, entitlementTier: sizingKey, sizingTier: sizingProfile.sizingTier,
                sourceGatewayId, sourceAssignmentEpoch: assigned.epoch,
            }, exactLeaseFence(lease, ["requested"]));
        }));
    };
    if (mode === "plan") {
        await refresh();
        return true;
    }
    await input.mutations({
        actor: ISOLATED_GATEWAY_LIFECYCLE_ACTOR, forced: false, what: "refresh-builder-allocation", why: "Honor the current sizing profile and serving Shared assignment while storage is being prepared",
        target: { uid: request.uid }, preActionStatus: { leaseId: request.leaseId, generation: request.generation }, mutation: { tier: sizingKey, sourceGatewayId },
        action: refresh,
    });
    return true;
}
