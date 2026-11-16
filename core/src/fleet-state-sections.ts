import {
  isReleasePayload,
  releasePayloadHash,
  type GatewayKubernetesReading,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import type { OperationKind, OperationStatus } from "@octogee/shared/types/glm";
import { isSharedPoolMemberRoot } from "@octogee/shared/types/shared-gateway-pool";
import type { GatewayArtifact } from "./gateway-live-release.js";
import { readPlacementAutomationOwnership } from "./placement-automation-owner.js";
import { placementAutomationState } from "./placement-automation-handoff.js";
import { InvalidSharedGatewayAutoscalingConfigError, readSharedGatewayAutoscalingConfigInStore } from "./shared-gateway-pool-read.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";

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
  "placementAutomation",
] as const;

export type FleetStateSection = (typeof FLEET_STATE_SECTIONS)[number];

export const FLEET_STATE_SECTIONS_ERROR = `sections must be a comma-separated list of ${FLEET_STATE_SECTIONS.join(", ")}`;

const MIGRATE_USER: OperationKind = "migrate-user";
const ACTIVE_MIGRATION_STATUSES = ["pending", "running"] as const satisfies readonly OperationStatus[];

export type GatewayKubernetesReader = (runtime: Stored<FleetRegistryRecord> | null, now: number) => GatewayKubernetesReading;

export const UNKNOWN_GATEWAY_KUBERNETES: GatewayKubernetesReading = {
  kubernetes: { status: "unknown", totalPods: null, readyPods: null, ageMs: null },
  kubernetesObservedAt: null,
};

export function parseFleetStateSections(raw: unknown): FleetStateSection[] | null {
  if (typeof raw !== "string") return null;
  const requested = raw.split(",").map((section) => section.trim());
  if (!requested.every((section): section is FleetStateSection => (FLEET_STATE_SECTIONS as readonly string[]).includes(section))) {
    return null;
  }
  return FLEET_STATE_SECTIONS.filter((section) => requested.includes(section));
}

export function platformArtifactHash(artifact: GatewayArtifact | undefined): string | null {
  return artifact ? releasePayloadHash({ ...artifact } as ReleasePayload) : null;
}

export async function latestReleasePayloadHash(transaction: PlatformStateTransaction, root: Stored<GatewayRoot>): Promise<string | null> {
  if (typeof root.latestRelease !== "number" || !Number.isSafeInteger(root.latestRelease) || root.latestRelease < 0) return null;
  const release = await transaction.gateways.releases.get(root.gatewayId, root.latestRelease);
  return release !== null && isReleasePayload(release.payload) ? releasePayloadHash(release.payload) : null;
}

export function readSharedGatewayAutoscalingOrNull(transaction: PlatformStateTransaction) {
  return readSharedGatewayAutoscalingConfigInStore(transaction).catch((error: unknown) => {
    if (error instanceof InvalidSharedGatewayAutoscalingConfigError) return null;
    throw error;
  });
}

function placementUser<Base extends { readonly provisioning: object; readonly openclaw: object }>(
  user: PlatformUserRecord,
  base: Base,
) {
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

export interface FleetStateSectionsInput<User extends { readonly provisioning: object; readonly openclaw: object }> {
  readonly sections: readonly FleetStateSection[];
  readonly operationStatuses: readonly OperationStatus[];
  readonly platformArtifact?: GatewayArtifact | undefined;
  readonly controllerStartedAt?: number | undefined;
  readonly now: number;
  readonly projectUser: (user: PlatformUserRecord) => User;
  readonly readGatewayKubernetes?: GatewayKubernetesReader | undefined;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load();
    return loaded;
  };
}

export async function readFleetStateSections<User extends { readonly provisioning: object; readonly openclaw: object }>(
  store: PlatformStateStore,
  input: FleetStateSectionsInput<User>,
) {
  return store.transaction({ label: "admin.fleet.state", readOnly: true }, async (transaction) => {
    const roots = once(() => transaction.gateways.roots.list());
    const runtimes = once(() => transaction.fleetRegistry.list());
    const readKubernetes = input.readGatewayKubernetes ?? (() => UNKNOWN_GATEWAY_KUBERNETES);

    const loaders: Record<FleetStateSection, () => Promise<Record<string, unknown>>> = {
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
      placementAutomation: async () => ({ placementAutomation: placementAutomationState(await readPlacementAutomationOwnership(transaction)) }),
    };

    const answered = await Promise.all(input.sections.map((section) => loaders[section]()));
    return Object.assign(
      { generatedAt: input.now, fleetControllerStartedAt: input.controllerStartedAt ?? null, sections: input.sections },
      ...answered,
    ) as Record<string, unknown>;
  });
}
