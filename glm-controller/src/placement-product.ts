import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { SizingKeyReader } from "@octogee/core/sizing-key";
import type { FleetInformer } from "./fleet-informer.js";
import {
  startGatewayKubernetesObserver,
  type ReadGatewayPodDiagnosticsBatch,
} from "./gateway-kubernetes-observation.js";
import { logPlatformPlacementNotices } from "./platform-placement-notices.js";
import type { UserHomeMigrationDeps } from "./user-home-migration.js";
import type { UserPolicyInputsSource } from "./user-placement-document.js";

export interface PlacementProductDeps {
  store: PlatformStateStore;
  informer: FleetInformer;
  policyInputs: UserPolicyInputsSource;
  readSizingKey: SizingKeyReader;
  namespace: string;
  platformArtifact: GatewayArtifact;
  now(): number;
  log(message: string): void;
  debug(message: string): void;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
  readGatewayPodDiagnostics(input: { namespace: string; gatewayId: string }): Promise<{
    status: string;
    totalPods: number;
    error?: string;
  }>;
  readGatewayPodDiagnosticsBatch: ReadGatewayPodDiagnosticsBatch;
  userHome?: Omit<UserHomeMigrationDeps, "store" | "readSizingKey" | "now" | "log">;
}

export type PlacementProductFactory = (deps: PlacementProductDeps) => () => void;

export function startPlacement(
  product: PlacementProductFactory | undefined,
  deps: PlacementProductDeps,
  startObserver: (deps: PlacementProductDeps) => () => void = startPlatformObserver,
): () => void {
  if (product) {
    deps.log("[glm-controller] placement: product automation installed");
    return product(deps);
  }
  deps.log(
    "[glm-controller] placement: platform only; no user is placed, moved, woken or idled automatically, " +
      "and no isolated gateway is allocated or retired by a lease; gateway Kubernetes state is still observed",
  );
  return startObserver(deps);
}

function startPlatformObserver(deps: PlacementProductDeps): () => void {
  const { store, informer } = deps;
  return startGatewayKubernetesObserver({
    store,
    namespace: deps.namespace,
    now: deps.now,
    log: deps.log,
    readGatewayPodDiagnosticsBatch: deps.readGatewayPodDiagnosticsBatch,
    listGatewayIds: async () => (informer.gateways() ?? await store.gateways.roots.list()).map((root) => root.gatewayId),
    listRuntimes: async () => informer.fleetRegistry() ?? store.fleetRegistry.list(),
    afterObservation: async () => {
      const [users, roots, assignments] = await Promise.all([
        informer.usersWithoutMalformed()?.records ?? store.users.records.listAll(),
        informer.gateways() ?? store.gateways.roots.list(),
        informer.assignments() ?? store.gateways.assignments.listAll(),
      ]);
      logPlatformPlacementNotices({ users, roots, assignments, log: deps.log });
    },
  });
}
