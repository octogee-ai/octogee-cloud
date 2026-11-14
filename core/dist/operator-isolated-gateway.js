import { randomUUID } from "node:crypto";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT, isolatedGatewayServiceAccountName, } from "@octogee/shared/types/glm";
import { isolatedGatewayId } from "@octogee/shared/types/isolated-gateway-id";
import { readGatewayArtifactInStore, writeInitialGatewayReleaseInTransaction, } from "./gateway-live-release.js";
import { fleetOperationLockResources } from "./fleet-operation-lock.js";
import { isolatedRuntimeMutationFenced, moveHasNotBegun } from "./gateway-retirement-claim.js";
export const OPERATOR_ISOLATED_GATEWAY_SOURCE = "operator-isolated-gateway";
const OPERATOR_ALLOCATION_ID_PREFIX = "operator-";
const MIGRATE_USER_KIND = "migrate-user";
const RETIRE_GATEWAY_KIND = "retire-gateway";
const CLEAR = { clear: true };
const ISOLATED_ALLOCATION_KIND = "disposable-builder";
export function operatorAllocationId() {
    return `${OPERATOR_ALLOCATION_ID_PREFIX}${randomUUID()}`;
}
export function isOperatorIssuedAllocation(allocation) {
    return typeof allocation?.leaseId === "string" && allocation.leaseId.startsWith(OPERATOR_ALLOCATION_ID_PREFIX);
}
function refusal(status, code, error, extra = {}) {
    return { refusal: { status, body: { code, error, ...extra } } };
}
export async function isolatedSizingProfileKeys(reader) {
    const profiles = (await reader.config.orchestrator.get())?.sizingProfiles ?? {};
    return Object.entries(profiles).filter(([, profile]) => profile.isolation === "isolated").map(([key]) => key).sort();
}
export function hasComputerShape(profile) {
    const { computer } = profile;
    return computer.runtime === "cluster" || (computer.machineType !== null &&
        computer.provisioningModel !== null && computer.bootDisk !== null);
}
export async function resolveIsolatedSizingProfile(reader, named) {
    const profiles = (await reader.config.orchestrator.get())?.sizingProfiles ?? {};
    const sizingProfiles = await isolatedSizingProfileKeys(reader);
    if (typeof named !== "string" || named.length === 0) {
        return refusal(400, "sizing-profile-invalid", "sizingProfile must name an isolated sizing profile", { sizingProfiles });
    }
    const profile = Object.hasOwn(profiles, named) ? profiles[named] : undefined;
    if (!profile)
        return refusal(400, "sizing-profile-unknown", `unknown sizing profile ${named}`, { sizingProfiles });
    if (profile.isolation !== "isolated") {
        return refusal(400, "sizing-profile-not-isolated", `sizing profile ${named} is not an isolated profile`, { sizingProfiles });
    }
    if (!hasComputerShape(profile)) {
        return refusal(400, "sizing-profile-no-vm", `sizing profile ${named} has no VM machine type, provisioning model or boot disk`, { sizingProfiles });
    }
    return { sizingKey: named, sizingTier: profile.sizingTier };
}
function userRefusal(uid, user) {
    if (!user)
        return refusal(404, "user-not-found", "user not found", { uid });
    if (!user.slug)
        return refusal(409, "user-not-provisioned", "user has no workspace yet", { uid });
    if (!accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined })) {
        return refusal(409, "user-not-active", "user account is suspended or being deleted", { uid });
    }
    if (isolatedRuntimeMutationFenced(user)) {
        return refusal(409, "user-recovery-unresolved", "user restore or source transfer is unresolved", { uid });
    }
    return null;
}
async function ownedGatewayRefusal(reader, uid) {
    const owned = await reader.gateways.roots.list({ gatewayClass: "isolated", ownerUid: uid });
    const current = owned.find((root) => root.desiredStatus !== "retired");
    if (current) {
        return refusal(409, "user-has-isolated-gateway", `user already has isolated gateway ${current.gatewayId}`, { uid, gatewayId: current.gatewayId });
    }
    const runtimes = await reader.fleetRegistry.getMany(owned.map((root) => root.gatewayId));
    const retiring = owned.find((root) => runtimes.has(root.gatewayId));
    return retiring
        ? refusal(409, "isolated-gateway-retiring", `isolated gateway ${retiring.gatewayId} is still retiring`, { uid, gatewayId: retiring.gatewayId })
        : null;
}
function settledSharedRelease(source) {
    return (source.desiredStatus === "running" || source.desiredStatus === "draining") &&
        source.liveRelease !== null && source.desiredRelease === source.liveRelease
        ? source.liveRelease
        : null;
}
async function sourceRefusalOrArtifact(reader, uid, sourceGatewayId) {
    const notShared = refusal(409, "user-not-on-shared-gateway", "user is not on a shared gateway", { uid, gatewayId: sourceGatewayId });
    if (!sourceGatewayId)
        return notShared;
    const [root, assignment, operations] = await Promise.all([
        reader.gateways.roots.get(sourceGatewayId),
        reader.gateways.assignments.get(sourceGatewayId, uid),
        reader.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
    ]);
    if (root?.gatewayClass !== "shared")
        return notShared;
    const migration = operations.find((operation) => operation.kind === MIGRATE_USER_KIND);
    if (migration) {
        return refusal(409, "user-migration-in-flight", "a migration for this user is already pending or running", { uid, operationId: migration.id });
    }
    if (assignment?.state !== "serving") {
        return refusal(409, "user-assignment-unsettled", `user roster state ${assignment?.state ?? "missing"} must settle first`, { uid, gatewayId: sourceGatewayId });
    }
    const release = settledSharedRelease(root);
    if (release === null) {
        return refusal(409, "source-gateway-rolling", `shared gateway ${sourceGatewayId} is between releases; retry when its roll finishes`, { uid, gatewayId: sourceGatewayId });
    }
    const artifact = await readGatewayArtifactInStore(reader, sourceGatewayId, release);
    return artifact
        ? { sourceGatewayId, artifact }
        : refusal(409, "source-release-unreadable", `shared gateway ${sourceGatewayId} release ${release} is unreadable`, { uid, gatewayId: sourceGatewayId });
}
export async function planOperatorIsolatedGateway(reader, input) {
    const named = await resolveIsolatedSizingProfile(reader, input.sizingProfile);
    if ("refusal" in named)
        return named;
    const user = await reader.users.records.get(input.uid);
    const refused = userRefusal(input.uid, user) ?? await ownedGatewayRefusal(reader, input.uid);
    if (refused)
        return refused;
    const source = await sourceRefusalOrArtifact(reader, input.uid, user.gateway?.gatewayId ?? null);
    if ("refusal" in source)
        return source;
    return { ...named, ...source, uid: input.uid, slug: user.slug };
}
export function operatorIsolatedGatewayConfig(input) {
    return {
        configSchemaVersion: 1,
        profile: null,
        gatewayClass: "isolated",
        imageProfile: "isolated",
        sizingTier: input.sizingTier,
        gcpProject: null,
        gatewayContainerSecurityContext: null,
        serviceAccountName: isolatedGatewayServiceAccountName(input.gatewayId),
        serviceAccount: ISOLATED_GATEWAY_LOCKED_SERVICE_ACCOUNT,
        builderAccess: {
            controlUiEnabled: true,
            controlIdentity: "per-user",
            kubeApiServerEgressCidrs: [],
            reason: "disposable-builder-runtime",
        },
        ownerUid: input.uid,
        builderSlug: input.slug,
        modelBrokerLimits: null,
        allocation: {
            kind: ISOLATED_ALLOCATION_KIND,
            schemaVersion: 1,
            leaseId: input.allocationId,
            generation: 1,
            claimedByUid: input.uid,
        },
    };
}
export async function giveOperatorIsolatedGateway(store, input) {
    return store.transaction({ label: "admin.fleet.giveIsolatedGateway" }, async (transaction) => {
        const plan = await planOperatorIsolatedGateway(transaction, input);
        if ("refusal" in plan)
            return plan.refusal;
        const gatewayId = isolatedGatewayId(plan.slug, 1, input.allocationId, plan.sizingTier);
        await writeInitialGatewayReleaseInTransaction(transaction, {
            gatewayId,
            config: operatorIsolatedGatewayConfig({ ...plan, gatewayId, allocationId: input.allocationId }),
            artifact: plan.artifact,
            createdBy: input.actor,
            now: input.now,
            desiredStatus: "running",
        });
        await transaction.users.records.patch(plan.uid, { openclaw: { managedBy: "operator" } });
        const operationId = await transaction.journal.operations.enqueue({
            kind: MIGRATE_USER_KIND,
            status: "pending",
            createdBy: input.actor,
            createdAt: input.now,
            startedAt: null,
            completedAt: null,
            input: {
                uid: plan.uid,
                userSlug: plan.slug,
                fromGatewayId: plan.sourceGatewayId,
                toGatewayId: gatewayId,
                source: OPERATOR_ISOLATED_GATEWAY_SOURCE,
            },
            steps: [],
            gatewayId,
            inputUid: plan.uid,
        });
        return {
            status: 202,
            body: { uid: plan.uid, gatewayId, operationId, sizingProfile: plan.sizingKey, fromGatewayId: plan.sourceGatewayId, managedBy: "operator" },
        };
    });
}
export async function ownIsolatedGatewayTargetRefusal(reader, uid, gatewayId) {
    const root = await reader.gateways.roots.get(gatewayId);
    const allocation = root?.allocation;
    if (root?.gatewayClass === "isolated" && root.ownerUid === uid &&
        allocation?.kind === ISOLATED_ALLOCATION_KIND && allocation.claimedByUid === uid)
        return null;
    return { status: 400, body: {
            code: "migration-target-not-own-isolated-gateway",
            error: "manual migration target must be a shared gateway or the user's own isolated gateway",
            gatewayId,
        } };
}
export async function isolatedGatewayRetireRefusal(reader, gatewayId, asked) {
    if (asked.deleteHome) {
        return {
            code: "isolated-gateway-home-delete-undecided",
            error: "retiring an isolated gateway keeps its VM and home disk; deleting them is not offered yet",
            gatewayId,
        };
    }
    if (asked.retainData) {
        return {
            code: "isolated-gateway-retain-data-unsupported",
            error: "an isolated gateway keeps its VM and home disk on retire; retainData applies to pod gateways and would block erasing the user later",
            gatewayId,
        };
    }
    const assignments = await reader.gateways.assignments.list(gatewayId);
    if (assignments.length === 0)
        return null;
    return asked.force
        ? {
            code: "isolated-gateway-forced-return-undecided",
            error: "a forced return is not offered yet; park the gateway, replace its VM, resume it, then return the user",
            gatewayId,
            assignedUsers: assignments.map((assignment) => assignment.slug),
        }
        : {
            code: "isolated-gateway-has-user",
            error: "return the user to a shared gateway first",
            gatewayId,
            assignedUsers: assignments.map((assignment) => assignment.slug),
        };
}
export async function movesTouchingGateway(reader, gatewayId) {
    const active = await reader.journal.operations.listByStatus(["pending", "running"]);
    const moves = active.filter((operation) => operation.kind === MIGRATE_USER_KIND &&
        fleetOperationLockResources({ id: operation.id, kind: operation.kind, input: operation.input, userMigrationV2: operation.userMigrationV2 }).has(gatewayId));
    const waiting = moves.filter((operation) => moveHasNotBegun(operation, gatewayId));
    const blocking = moves.find((operation) => !waiting.includes(operation));
    return { waiting: waiting.map((operation) => operation.id), blocking: blocking?.id ?? null };
}
export async function failedRetirementOf(reader, root) {
    const claim = root.retirementClaim;
    if (root.desiredStatus !== "retired" || typeof claim?.operationId !== "string")
        return null;
    const operation = await reader.journal.operations.get(claim.operationId);
    return operation?.kind === RETIRE_GATEWAY_KIND && operation.status === "failed" ? claim.operationId : null;
}
export async function rearmFailedRetirement(store, operationId) {
    await store.transaction({ label: "admin.fleet.rearmRetirement" }, async (transaction) => {
        await transaction.journal.operations.patch(operationId, {
            status: "pending",
            startedAt: null,
            completedAt: null,
            steps: [],
            error: CLEAR,
            lastProgressAt: CLEAR,
            expireAt: CLEAR,
            nextAttemptAt: CLEAR,
        }, { status: ["failed"] });
    });
}
