import type { PlatformStateStore, UserDeletionJobPatch } from "@octogee/core/platform-state";
import type { ProductContext } from "./user-lifecycle-product.js";

const CLEAR = { clear: true } as const;

const CLEARED_CLEANUP_FIELDS = {
  slug: CLEAR,
  requestedBy: CLEAR,
  currentGatewayId: CLEAR,
  cleanupContext: CLEAR,
  suspensionOperationId: CLEAR,
  postgresAgentStoreTargets: CLEAR,
  sharedAgentStoreCleanup: CLEAR,
  retiredGatewayProofs: CLEAR,
} satisfies UserDeletionJobPatch;

export function productVerificationJobPatch(
  verificationContext: ProductContext | null,
  archiveId: string,
  now: number,
): UserDeletionJobPatch {
  return {
    status: "product_verification_pending",
    archiveId,
    cloudErasedAt: now,
    updatedAt: now,
    ...CLEARED_CLEANUP_FIELDS,
    productContext: verificationContext ?? CLEAR,
  };
}

export function verifiedDeletionJobPatch(archiveId: string, now: number): UserDeletionJobPatch {
  return {
    status: "verified",
    archiveId,
    completedAt: now,
    ...CLEARED_CLEANUP_FIELDS,
    uid: CLEAR,
    erasureOperationId: CLEAR,
    productContext: CLEAR,
  };
}

export async function persistDeletionProductContext(
  store: PlatformStateStore,
  deletionId: string,
  fields: ProductContext,
): Promise<void> {
  await store.transaction({ label: "customer-deletion.persist-product-context" }, async (tx) => {
    const job = await tx.jobs.deletions.get(deletionId);
    if (job === null) throw new Error(`deletion job missing: ${deletionId}`);
    await tx.jobs.deletions.patch(deletionId, { productContext: { ...job.productContext, ...fields }, updatedAt: Date.now() });
  });
}
