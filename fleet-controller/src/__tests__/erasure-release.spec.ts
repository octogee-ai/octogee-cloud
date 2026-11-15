import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { markSuspendedAndReleaseErasure } from "../lib/user-ops/erasure-release.js";

const NOW = 1_000_000;

type Documents = Record<string, Record<string, unknown>>;

function deletion(eraseAfter: number, erasure: Record<string, unknown>): Documents {
  return {
    "customerDeletionJobs/delete-1": {
      version: 1,
      uid: "uid-1",
      status: "suspending",
      requestedAt: NOW - 60_000,
      eraseAfter,
      erasureOperationId: "erase-1",
    },
    "glmOperations/erase-1": { kind: "erase-user", input: { uid: "uid-1", deletionId: "delete-1" }, ...erasure },
  };
}

describe("markSuspendedAndReleaseErasure", () => {
  it("lets an immediate erasure run now instead of waiting out its retry backoff", async () => {
    const docs = deletion(NOW - 40_000, { status: "pending", nextAttemptAt: NOW + 120_000 });

    await markSuspendedAndReleaseErasure(createDocumentFixtureStore(docs), "delete-1", NOW);

    expect(docs["customerDeletionJobs/delete-1"]).toMatchObject({
      status: "hibernating",
      suspendedAt: NOW,
      updatedAt: NOW,
    });
    expect(docs["glmOperations/erase-1"].nextAttemptAt).toBe(NOW);
  });

  it("keeps a retained deletion waiting for its erase date", async () => {
    const eraseAfter = NOW + 90 * 24 * 60 * 60 * 1000;
    const docs = deletion(eraseAfter, { status: "pending", nextAttemptAt: eraseAfter });

    await markSuspendedAndReleaseErasure(createDocumentFixtureStore(docs), "delete-1", NOW);

    expect(docs["customerDeletionJobs/delete-1"].status).toBe("hibernating");
    expect(docs["glmOperations/erase-1"].nextAttemptAt).toBe(eraseAfter);
  });

  it("leaves an erasure attempt that is already running alone", async () => {
    const docs = deletion(NOW - 40_000, { status: "running", nextAttemptAt: NOW - 1 });

    await markSuspendedAndReleaseErasure(createDocumentFixtureStore(docs), "delete-1", NOW);

    expect(docs["customerDeletionJobs/delete-1"].status).toBe("hibernating");
    expect(docs["glmOperations/erase-1"]).toEqual({
      kind: "erase-user",
      input: { uid: "uid-1", deletionId: "delete-1" },
      status: "running",
      nextAttemptAt: NOW - 1,
    });
  });

  it("refuses a deletion job that names no erasure operation", async () => {
    const docs: Documents = {
      "customerDeletionJobs/delete-1": { version: 1, uid: "uid-1", status: "suspending", requestedAt: NOW, eraseAfter: NOW },
    };

    await expect(markSuspendedAndReleaseErasure(createDocumentFixtureStore(docs), "delete-1", NOW))
      .rejects.toThrow(/delete-1 has no erasure operation/);
    expect(docs["customerDeletionJobs/delete-1"].status).toBe("suspending");
  });

  it("refuses a missing deletion job", async () => {
    await expect(markSuspendedAndReleaseErasure(createDocumentFixtureStore({}), "delete-1", NOW))
      .rejects.toThrow(/delete-1 has no erasure operation/);
  });
});
