import { describe, expect, it } from "vitest";
import {
  productVerificationJobPatch,
  verifiedDeletionJobPatch,
} from "../lib/user-ops/deletion-job.js";

function clearedFields(patch: object): string[] {
  return Object.entries(patch)
    .filter(([, value]) => typeof value === "object" && value !== null && (value as { clear?: unknown }).clear === true)
    .map(([field]) => field)
    .sort();
}

const CLEANUP_FIELDS = [
  "cleanupContext",
  "currentGatewayId",
  "postgresAgentStoreTargets",
  "requestedBy",
  "retiredGatewayProofs",
  "sharedAgentStoreCleanup",
  "slug",
  "suspensionOperationId",
];

describe("deletion job updates", () => {
  it("trims an erased user's job to the context the product keeps while product verification is pending", () => {
    const patch = productVerificationJobPatch({ verificationRef: "ref-1" }, "archive-1", 500);

    expect(patch).toMatchObject({
      status: "product_verification_pending",
      archiveId: "archive-1",
      cloudErasedAt: 500,
      updatedAt: 500,
    });
    expect(clearedFields(patch)).toEqual(CLEANUP_FIELDS);
    expect(patch.productContext).toEqual({ verificationRef: "ref-1" });
    expect(patch).not.toHaveProperty("uid");
    expect(patch).not.toHaveProperty("erasureOperationId");
  });

  it("clears the product context when the product keeps nothing for verification", () => {
    const patch = productVerificationJobPatch(null, "archive-1", 500);

    expect(clearedFields(patch)).toEqual([...CLEANUP_FIELDS, "productContext"].sort());
  });

  it("destroys the uid and PostHog person mapping once erasure is verified", () => {
    const patch = verifiedDeletionJobPatch("archive-1", 900);

    expect(patch).toMatchObject({ status: "verified", archiveId: "archive-1", completedAt: 900 });
    expect(clearedFields(patch)).toEqual(
      [...CLEANUP_FIELDS, "erasureOperationId", "productContext", "uid"].sort(),
    );
  });
});
