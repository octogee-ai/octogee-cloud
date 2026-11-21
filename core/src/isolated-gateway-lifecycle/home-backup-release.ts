import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import type { OperationRecord } from "../platform-state/operations.js";
import type { PlatformStateTransaction } from "../platform-state/store.js";
import type { PlatformUserRecord, UserActivationLease } from "../platform-state/users.js";

export const RELEASE_RESTORED_HOME_BACKUP = "release-home-backup";

export function restoredHomeBackupReleaseId(archiveOperationId: string): string {
  return `${RELEASE_RESTORED_HOME_BACKUP}-${archiveOperationId}`;
}

export async function planRestoredHomeBackupRelease(
  tx: PlatformStateTransaction, user: PlatformUserRecord, lease: UserActivationLease, now: number,
): Promise<OperationRecord | null> {
  const { home, uid } = user;
  const archive = home.homeArchive;
  if (archive?.phase !== "restored" || archive.targetGatewayId !== lease.targetGatewayId ||
      archive.leaseId !== lease.leaseId || archive.generation !== lease.generation ||
      home.homeDisk?.id !== archive.restoredDisk.id || home.homeDisk?.source !== archive.restoredDisk.source) return null;
  const { targetGatewayId, operationId: archiveOperationId } = archive;
  if (lease.activationOperationId !== builderActivateOperationId(targetGatewayId, lease.generation)) return null;

  const id = restoredHomeBackupReleaseId(archiveOperationId);
  if (await tx.journal.operations.get(id)) return null;
  return {
    id, kind: "gateway-vm", status: "pending", origin: "automatic", createdBy: "glm-controller-placement-policy",
    createdAt: now, startedAt: null, completedAt: null, steps: [], inputUid: uid, gatewayId: targetGatewayId,
    input: { action: RELEASE_RESTORED_HOME_BACKUP, ownerUid: uid, uid, gatewayId: targetGatewayId, archiveOperationId, snapshotId: archive.snapshot.id,
      activationOperationId: lease.activationOperationId },
  };
}
