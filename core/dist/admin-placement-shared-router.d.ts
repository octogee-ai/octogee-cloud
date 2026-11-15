import type { Router } from "express";
import type { GatewayKubernetesObservation, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { type PlacementMigrationClassifier } from "./placement-migrations.js";
import type { PlatformStateStore } from "./platform-state/store.js";
export interface AdminPlacementSharedCapabilities extends PlacementMigrationClassifier {
    observeGatewayKubernetes(gatewayId: string): Promise<GatewayKubernetesObservation | null>;
    platformArtifact: ReleasePayload | null;
    operationJournalRetentionMs: number;
    kubernetesObservationMaxAgeMs: number;
}
export interface AdminPlacementSharedRouterDeps extends AdminPlacementSharedCapabilities {
    store: PlatformStateStore;
    journal: AdminFleetMutationRunner;
    now?: () => number;
}
export declare function addAdminPlacementSharedRoutes(router: Router, deps: AdminPlacementSharedRouterDeps): void;
