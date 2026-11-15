import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  ActivityReceiptUnavailableError,
  InMemoryActivityWriteReceiptStore,
  PlatformStateActivityWriteReceiptStore,
  receiptDocumentId,
  type ActivityAttachmentReceiptV1,
} from "../activity-write-receipts.js";

const eventKey = "a".repeat(64);
const digest = "b".repeat(64);
const channelPath = "workspaces/acme/channels/build";
const receiptPath = `${channelPath}/activityWriteReceipts/${receiptDocumentId(eventKey)}`;
const channel = { scope: { workspaceSlug: "acme", projectSlug: null }, channelId: "build" };

function channelDocuments(receipt?: Record<string, unknown>) {
  const documents = new Map<string, Record<string, unknown>>([[channelPath, { id: "build", kind: "project" }]]);
  if (receipt) documents.set(receiptPath, receipt);
  return documents;
}

function platformStoreReturning(data: Record<string, unknown>) {
  return new PlatformStateActivityWriteReceiptStore(createDocumentFixtureStore(channelDocuments(data)), channel);
}

describe("Activity write receipts", () => {
  it("freezes the payload digest and returns committed duplicates", async () => {
    const store = new InMemoryActivityWriteReceiptStore();
    const claim = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-1",
      now: 100,
      leaseMs: 1_000,
    });
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("expected claim");

    await store.markPosted(eventKey, claim.receipt.leaseToken, "post-1", 110);
    await store.commit(eventKey, claim.receipt.leaseToken, 120);

    const duplicate = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "different-anchor-is-ignored",
      leaseOwner: "worker-2",
      now: 130,
      leaseMs: 1_000,
    });
    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      receipt: { state: "committed", postId: "post-1", historyAnchorPostId: "anchor-1" },
    });

    await expect(store.claim({
      eventKey,
      payloadDigest: "c".repeat(64),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-3",
      now: 140,
      leaseMs: 1_000,
    })).rejects.toBeInstanceOf(ActivityReceiptConflictError);
  });

  it("serializes concurrent replay and permits recovery only after lease expiry", async () => {
    const store = new InMemoryActivityWriteReceiptStore();
    const first = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-1",
      now: 1_000,
      leaseMs: 100,
    });
    expect(first.outcome).toBe("claimed");

    await expect(store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-2",
      now: 1_050,
      leaseMs: 100,
    })).rejects.toBeInstanceOf(ActivityReceiptLeaseError);

    const recovered = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "ignored",
      leaseOwner: "worker-2",
      now: 1_101,
      leaseMs: 100,
    });
    expect(recovered).toMatchObject({
      outcome: "claimed",
      receipt: { leaseOwner: "worker-2", historyAnchorPostId: "anchor-1" },
    });
  });

  it("persists every resumable attachment state without losing post state", async () => {
    const store = new InMemoryActivityWriteReceiptStore();
    const claim = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-1",
      now: 10,
      leaseMs: 1_000,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");

    const states: ActivityAttachmentReceiptV1[] = [
      { state: "session-created", uploadId: "upload-1", fileOffset: 0, filename: "tool.txt", sha256: digest, byteLength: 8 },
      { state: "uploading", uploadId: "upload-1", fileOffset: 4, filename: "tool.txt", sha256: digest, byteLength: 8 },
      { state: "uploaded", uploadId: "upload-1", fileId: "file-1", filename: "tool.txt", sha256: digest, byteLength: 8 },
      { state: "attached", fileId: "file-1", sha256: digest, byteLength: 8 },
    ];
    for (const [index, attachment] of states.entries()) {
      await store.updateAttachment(eventKey, claim.receipt.leaseToken, attachment, 20 + index);
    }
    expect(await store.read(eventKey)).toMatchObject({ attachment: states.at(-1) });
  });

  it("uses sha256(eventKey) as the receipt document id", () => {
    expect(receiptDocumentId(eventKey)).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });

  it("claims, posts and commits the channel's receipt through platform state transactions", async () => {
    const documents = channelDocuments();
    const labels: string[] = [];
    const store = new PlatformStateActivityWriteReceiptStore(
      createDocumentFixtureStore(documents, { beforeTransaction: (label) => labels.push(label) }),
      channel,
    );
    const claim = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      now: 1,
      leaseMs: 100,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    await store.markPosted(eventKey, claim.receipt.leaseToken, "post-1", 2);
    await store.commit(eventKey, claim.receipt.leaseToken, 3);

    expect(labels).toHaveLength(3);
    expect(documents.get(receiptPath)).toMatchObject({ state: "committed", postId: "post-1", updatedAt: 3 });
    expect(await store.read(eventKey)).toMatchObject({
      state: "committed",
      postId: "post-1",
      historyAnchorPostId: "anchor-1",
    });
    await expect(store.claim({
      eventKey,
      payloadDigest: "c".repeat(64),
      historyAnchorPostId: "other",
      leaseOwner: "pod-2",
      now: 4,
      leaseMs: 100,
    })).rejects.toBeInstanceOf(ActivityReceiptConflictError);
  });

  it("refuses to fence a receipt that was never claimed", async () => {
    const store = new PlatformStateActivityWriteReceiptStore(createDocumentFixtureStore(channelDocuments()), channel);

    await expect(store.commit(eventKey, "lease-1", 1)).rejects.toBeInstanceOf(ActivityReceiptUnavailableError);
    expect(await store.read(eventKey)).toBeNull();
  });

  it("rejects every malformed persisted attachment union state", async () => {
    const base = {
      eventKey,
      payloadDigest: digest,
      state: "claimed",
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 100,
      updatedAt: 1,
    };
    const malformedAttachments = [
      {
        state: "uploading",
        uploadId: "upload-1",
        fileOffset: Number.MAX_SAFE_INTEGER + 1,
        filename: "tool.txt",
        sha256: digest,
        byteLength: 8,
      },
      { state: "none", uploadId: "smuggled-upload" },
      {
        state: "uploaded",
        uploadId: "upload-1",
        fileId: "",
        filename: "tool.txt",
        sha256: digest,
        byteLength: 8,
      },
      {
        state: "upload-result-unknown",
        uploadId: "upload-1",
        filename: "tool.txt",
        sha256: digest,
        byteLength: 8,
        reason: "   ",
      },
    ];

    for (const attachment of malformedAttachments) {
      await expect(platformStoreReturning({ ...base, attachment }).read(eventKey))
        .rejects.toBeInstanceOf(ActivityReceiptUnavailableError);
    }
  });

  it("rejects a receipt whose stored event key does not match the requested document", async () => {
    const store = platformStoreReturning({
      eventKey: "c".repeat(64),
      payloadDigest: digest,
      state: "committed",
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 100,
      attachment: { state: "none" },
      updatedAt: 1,
    });

    await expect(store.read(eventKey)).rejects.toBeInstanceOf(ActivityReceiptUnavailableError);
  });
});
