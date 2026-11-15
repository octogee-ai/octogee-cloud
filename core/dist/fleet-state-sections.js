import { isReleasePayload, releasePayloadHash, } from "@octogee/shared/types/gateway-releases";
import { isSharedPoolMemberRoot } from "@octogee/shared/types/shared-gateway-pool";
import { InvalidSharedGatewayAutoscalingConfigError, readSharedGatewayAutoscalingConfigInStore } from "./shared-gateway-pool-read.js";
export const FLEET_STATE_SECTIONS = [
    "config",
    "sharedPoolAutomation",
    "users",
    "gateways",
    "releases",
    "assignments",
    "runtimes",
    "operations",
    "migrations",
];
export const FLEET_STATE_SECTIONS_ERROR = `sections must be a comma-separated list of ${FLEET_STATE_SECTIONS.join(", ")}`;
const MIGRATE_USER = "migrate-user";
const ACTIVE_MIGRATION_STATUSES = ["pending", "running"];
export const UNKNOWN_GATEWAY_KUBERNETES = {
    kubernetes: { status: "unknown", totalPods: null, readyPods: null, ageMs: null },
    kubernetesObservedAt: null,
};
export function parseFleetStateSections(raw) {
    if (typeof raw !== "string")
        return null;
    const requested = raw.split(",").map((section) => section.trim());
    if (!requested.every((section) => FLEET_STATE_SECTIONS.includes(section))) {
        return null;
    }
    return FLEET_STATE_SECTIONS.filter((section) => requested.includes(section));
}
export function platformArtifactHash(artifact) {
    return artifact ? releasePayloadHash({ ...artifact }) : null;
}
export async function latestReleasePayloadHash(transaction, root) {
    if (typeof root.latestRelease !== "number" || !Number.isSafeInteger(root.latestRelease) || root.latestRelease < 0)
        return null;
    const release = await transaction.gateways.releases.get(root.gatewayId, root.latestRelease);
    return release !== null && isReleasePayload(release.payload) ? releasePayloadHash(release.payload) : null;
}
export function readSharedGatewayAutoscalingOrNull(transaction) {
    return readSharedGatewayAutoscalingConfigInStore(transaction).catch((error) => {
        if (error instanceof InvalidSharedGatewayAutoscalingConfigError)
            return null;
        throw error;
    });
}
function placementUser(user, base) {
    return {
        ...base,
        provisioning: {
            ...base.provisioning,
            ...(user.provisioning.startedAt === undefined ? {} : { startedAt: user.provisioning.startedAt }),
        },
        gateway: user.gateway,
        openclaw: { ...base.openclaw, ...(user.openclaw.status === undefined ? {} : { status: user.openclaw.status }) },
        activationLease: user.activationLease,
        fences: user.fences,
        home: user.home,
    };
}
function once(load) {
    let loaded;
    return () => {
        loaded ??= load();
        return loaded;
    };
}
export async function readFleetStateSections(store, input) {
    return store.transaction({ label: "admin.fleet.state", readOnly: true }, async (transaction) => {
        const roots = once(() => transaction.gateways.roots.list());
        const runtimes = once(() => transaction.fleetRegistry.list());
        const readKubernetes = input.readGatewayKubernetes ?? (() => UNKNOWN_GATEWAY_KUBERNETES);
        const loaders = {
            config: async () => {
                const [config, sharedGatewayAutoscaling] = await Promise.all([
                    transaction.config.orchestrator.get(),
                    readSharedGatewayAutoscalingOrNull(transaction),
                ]);
                return {
                    config: {
                        sharedGatewayAutoscaling,
                        sizingProfiles: config?.sizingProfiles ?? {},
                        disposableGatewayIdleMs: config?.disposableGatewayIdleMs ?? null,
                    },
                };
            },
            sharedPoolAutomation: async () => ({ sharedPoolAutomation: await transaction.controllerState.sharedPoolScaler.get() }),
            users: async () => {
                const users = await transaction.users.records.listAll();
                return { users: users.map((user) => placementUser(user, input.projectUser(user))) };
            },
            gateways: async () => {
                const [gateways, observed] = await Promise.all([roots(), runtimes()]);
                const runtimeById = new Map(observed.map((runtime) => [runtime.gatewayId, runtime]));
                return {
                    gateways: gateways.map((root) => ({ ...root, ...readKubernetes(runtimeById.get(root.gatewayId) ?? null, input.now) })),
                };
            },
            releases: async () => {
                const sharedGateways = (await roots()).filter(isSharedPoolMemberRoot);
                const hashes = await Promise.all(sharedGateways.map((root) => latestReleasePayloadHash(transaction, root)));
                const platformHash = platformArtifactHash(input.platformArtifact);
                return {
                    platformArtifactHash: platformHash,
                    latestReleasePayloadHashes: Object.fromEntries(sharedGateways.map((root, index) => [root.gatewayId, hashes[index] ?? null])),
                    platformCurrentSharedGatewayIds: platformHash === null
                        ? []
                        : sharedGateways.filter((_root, index) => hashes[index] === platformHash).map((root) => root.gatewayId),
                };
            },
            assignments: async () => ({ assignments: await transaction.gateways.assignments.listAll() }),
            runtimes: async () => ({ runtimes: await runtimes() }),
            operations: async () => ({ operations: await transaction.journal.operations.listByStatus(input.operationStatuses) }),
            migrations: async () => ({ migrations: await transaction.journal.operations.listByKind(MIGRATE_USER, ACTIVE_MIGRATION_STATUSES) }),
        };
        const answered = await Promise.all(input.sections.map((section) => loaders[section]()));
        return Object.assign({ generatedAt: input.now, fleetControllerStartedAt: input.controllerStartedAt ?? null, sections: input.sections }, ...answered);
    });
}
