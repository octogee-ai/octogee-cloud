import type { GatewayDesiredStatus } from "@octogee/shared/types/glm";

export interface MigrationGatewayRoot {
  desiredStatus: GatewayDesiredStatus;
  desiredRelease: number;
  liveRelease: number | null;
}

function releaseIsConverged(root: MigrationGatewayRoot): boolean {
  return root.liveRelease !== null && root.desiredRelease === root.liveRelease;
}

export function migrationSourceRootIsStable(root: MigrationGatewayRoot): boolean {
  return (
    (root.desiredStatus === "running" || root.desiredStatus === "draining") &&
    releaseIsConverged(root)
  );
}

export function migrationTargetRootIsStable(root: MigrationGatewayRoot): boolean {
  return root.desiredStatus === "running" && releaseIsConverged(root);
}

export function migrationSourceReady(root: MigrationGatewayRoot & { gatewayClass?: string | null }, retainedNativeRelease?: number): boolean {
  if (retainedNativeRelease === undefined) return migrationSourceRootIsStable(root);
  return root.gatewayClass === "isolated" &&
    (root.desiredStatus === "running" || root.desiredStatus === "draining") &&
    Number.isSafeInteger(retainedNativeRelease) && retainedNativeRelease > 0 &&
    root.liveRelease === retainedNativeRelease;
}
