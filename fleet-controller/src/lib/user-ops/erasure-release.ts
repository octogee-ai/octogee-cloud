import type { PlatformStateStore } from "@octogee/core/platform-state";

export async function markSuspendedAndReleaseErasure(
  store: PlatformStateStore,
  deletionId: string,
  now: number,
): Promise<void> {
  await store.transaction({ label: "customer-deletion.release-erasure" }, async (transaction) => {
    const job = await transaction.jobs.deletions.get(deletionId);
    const erasureOperationId = job?.erasureOperationId;
    if (job === null || erasureOperationId === undefined) {
      throw new Error(`deletion job ${deletionId} has no erasure operation to release`);
    }
    const erasure = await transaction.journal.operations.get(erasureOperationId);
    await transaction.jobs.deletions.patch(deletionId, { status: "hibernating", suspendedAt: now, updatedAt: now });
    if (erasure?.status === "pending") {
      await transaction.journal.operations.patch(
        erasureOperationId,
        { nextAttemptAt: Math.max(now, job.eraseAfter) },
        { status: ["pending"] },
      );
    }
  });
}
