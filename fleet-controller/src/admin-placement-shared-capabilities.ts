import type { AdminPlacementSharedCapabilities } from "@octogee/core/admin-placement-shared-router";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import type { Operation } from "@octogee/shared/types/glm";
import { gatewayKubernetesStatus, type GatewayPodDiagnostics } from "./gateway-kubernetes-observation.js";
import { sourceRecoveryForwardRetryable } from "./legacy-migration-recovery.js";
import { classifyOperationFailure, isGatewayStartupUnavailable, OPERATION_JOURNAL_RETENTION_MS } from "./operation-retry.js";

export interface AdminPlacementSharedCapabilityDeps {
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  platformArtifact?: GatewayArtifact;
  now?: () => number;
}

export function adminPlacementSharedCapabilities(
  deps: AdminPlacementSharedCapabilityDeps,
): AdminPlacementSharedCapabilities | undefined {
  const readGatewayPodDiagnostics = deps.readGatewayPodDiagnostics;
  if (readGatewayPodDiagnostics === undefined) return undefined;
  const now = deps.now ?? Date.now;
  return {
    observeGatewayKubernetes: async (gatewayId) => {
      const diagnostics = await readGatewayPodDiagnostics(gatewayId);
      return {
        status: gatewayKubernetesStatus(diagnostics),
        totalPods: diagnostics.totalPods,
        readyPods: diagnostics.readyPods,
        observedAt: now(),
      };
    },
    platformArtifact: deps.platformArtifact ?? null,
    operationJournalRetentionMs: OPERATION_JOURNAL_RETENTION_MS,
    operationFailureIsTransient: (error) => classifyOperationFailure(error) === "transient",
    gatewayStartupUnavailable: isGatewayStartupUnavailable,
    sourceRecoveryForwardRetryable: (operation) => sourceRecoveryForwardRetryable(operation as unknown as Partial<Operation>),
  };
}
