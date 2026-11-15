import { describe, expect, it } from "vitest";
import { parseArtifactRequest, type ArtifactJob } from "./chat-artifacts.js";
import { ArtifactRegistry, type ArtifactJobStore } from "./chat-artifact-registry.js";

const REQUEST = parseArtifactRequest({
  mattermostFileId: "f".repeat(26),
  channelId: "c".repeat(26),
  sourcePostId: "p".repeat(26),
  runRootPostId: "r".repeat(26),
  runId: "run-17",
  filename: "report.pdf",
  mediaType: "application/pdf",
  byteLength: 4096,
});
const OWNERSHIP = {
  ownerUid: "uid-alice",
  workspaceSlug: "alice",
  workspaceOwnerUid: "uid-alice",
};

class MemoryStore implements ArtifactJobStore {
  readonly jobs = new Map<string, ArtifactJob>();

  async createIfAbsent(job: ArtifactJob): Promise<ArtifactJob> {
    const existing = this.jobs.get(job.artifactId);
    if (existing) return structuredClone(existing);
    this.jobs.set(job.artifactId, structuredClone(job));
    return structuredClone(job);
  }

  async get(artifactId: string): Promise<ArtifactJob | null> {
    const job = this.jobs.get(artifactId);
    return job ? structuredClone(job) : null;
  }

  async findClaimable(): Promise<string[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === "queued" || job.status === "processing")
      .map((job) => job.artifactId);
  }

  async transact(
    artifactId: string,
    update: (job: ArtifactJob | null) => ArtifactJob,
  ): Promise<ArtifactJob> {
    const next = update(await this.get(artifactId));
    this.jobs.set(artifactId, structuredClone(next));
    return structuredClone(next);
  }
}

function registry(store = new MemoryStore()) {
  let sequence = 0;
  return {
    store,
    registry: new ArtifactRegistry(store, {
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      leaseToken: () => `lease-${++sequence}-${"x".repeat(32)}`,
      leaseMs: 300_000,
      maxAttempts: 3,
    }),
  };
}

describe("ArtifactRegistry", () => {
  it("enqueues idempotently without replacing terminal state", async () => {
    const harness = registry();
    const first = await harness.registry.enqueue(REQUEST, OWNERSHIP);
    harness.store.jobs.set(first.artifactId, { ...first, status: "ready" });
    const again = await harness.registry.enqueue(REQUEST, OWNERSHIP);
    expect(again.status).toBe("ready");
    expect(harness.store.jobs).toHaveLength(1);
  });

  it("leases queued work and returns the plaintext token only to the claimant", async () => {
    const harness = registry();
    const queued = await harness.registry.enqueue(REQUEST, OWNERSHIP);
    const claimed = await harness.registry.claimNext("pdf-worker-1");
    expect(claimed?.job.artifactId).toBe(queued.artifactId);
    expect(claimed?.leaseToken).toMatch(/^lease-/);
    expect(claimed?.job.lease?.tokenHash).not.toContain("lease-");
    expect(await harness.registry.claimNext("pdf-worker-2")).toBeNull();
  });

  it("reclaims an expired processing lease", async () => {
    const harness = registry();
    const queued = await harness.registry.enqueue(REQUEST, OWNERSHIP);
    harness.store.jobs.set(queued.artifactId, {
      ...queued,
      status: "processing",
      attempt: 1,
      lease: {
        workerId: "dead-worker",
        tokenHash: "old",
        expiresAt: "2026-07-13T11:59:59.000Z",
      },
    });
    const reclaimed = await harness.registry.claimNext("pdf-worker-2");
    expect(reclaimed?.job.attempt).toBe(2);
    expect(reclaimed?.job.lease?.workerId).toBe("pdf-worker-2");
  });

  it("dead-letters work after the capped number of crashed attempts", async () => {
    const harness = registry();
    const queued = await harness.registry.enqueue(REQUEST, OWNERSHIP);
    harness.store.jobs.set(queued.artifactId, {
      ...queued,
      status: "processing",
      attempt: 3,
      lease: {
        workerId: "dead-worker",
        tokenHash: "a".repeat(64),
        expiresAt: "2026-07-13T11:59:59.000Z",
      },
    });

    await expect(harness.registry.claimNext("pdf-worker-2")).resolves.toBeNull();
    expect(await harness.registry.get(queued.artifactId)).toMatchObject({
      status: "failed",
      attempt: 3,
      failure: { code: "attempts_exhausted" },
    });
  });

  it("rejects missing and non-string worker identities before claiming work", async () => {
    const harness = registry();
    await harness.registry.enqueue(REQUEST, OWNERSHIP);

    await expect(harness.registry.claimNext(undefined as never)).rejects.toThrow("worker id");
    await expect(harness.registry.claimNext(123 as never)).rejects.toThrow("worker id");
    expect((await harness.registry.get((await harness.registry.enqueue(REQUEST, OWNERSHIP)).artifactId))?.status).toBe("queued");
  });

  it("renews only the active worker lease", async () => {
    const harness = registry();
    await harness.registry.enqueue(REQUEST, OWNERSHIP);
    const claimed = (await harness.registry.claimNext("pdf-worker-1"))!;
    const renewed = await harness.registry.renewLease(
      claimed.job.artifactId,
      "pdf-worker-1",
      claimed.leaseToken,
    );
    expect(renewed.lease?.expiresAt).toBe("2026-07-13T12:05:00.000Z");
    await expect(
      harness.registry.renewLease(claimed.job.artifactId, "pdf-worker-2", claimed.leaseToken),
    ).rejects.toThrow("lease");
  });

  it("rejects output from a different or expired lease", async () => {
    const harness = registry();
    await harness.registry.enqueue(REQUEST, OWNERSHIP);
    const claimed = (await harness.registry.claimNext("pdf-worker-1"))!;
    await expect(
      harness.registry.stageOutput(claimed.job.artifactId, "pdf-worker-1", "wrong-token", {
        kind: "markdown",
        objectPath: `chat-artifacts/${claimed.job.artifactId}/attempts/1/markdown.md`,
        mediaType: "text/markdown; charset=utf-8",
        byteLength: 42,
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow("lease");
  });

  it("records a trusted checksum only when the canonical source length matches Mattermost", async () => {
    const harness = registry();
    await harness.registry.enqueue(REQUEST, OWNERSHIP);
    const claimed = (await harness.registry.claimNext("pdf-worker-1"))!;
    await expect(harness.registry.verifySource(
      claimed.job.artifactId,
      "pdf-worker-1",
      claimed.leaseToken,
      { sha256: "a".repeat(64), byteLength: 4095 },
    )).rejects.toThrow("length");
    const verified = await harness.registry.verifySource(
      claimed.job.artifactId,
      "pdf-worker-1",
      claimed.leaseToken,
      { sha256: "a".repeat(64), byteLength: 4096 },
    );
    expect(verified.source).toMatchObject({ sha256: "a".repeat(64), byteLength: 4096 });
  });

  it("preserves the first canonical source digest across a reclaimed attempt", async () => {
    const harness = registry();
    await harness.registry.enqueue(REQUEST, OWNERSHIP);
    const first = (await harness.registry.claimNext("pdf-worker-1"))!;
    await harness.registry.verifySource(
      first.job.artifactId,
      "pdf-worker-1",
      first.leaseToken,
      { sha256: "a".repeat(64), byteLength: 4096 },
    );
    const current = (await harness.registry.get(first.job.artifactId))!;
    harness.store.jobs.set(first.job.artifactId, {
      ...current,
      lease: { ...current.lease!, expiresAt: "2026-07-13T11:59:59.000Z" },
    });

    const reclaimed = (await harness.registry.claimNext("pdf-worker-2"))!;
    expect(reclaimed.job.source?.sha256).toBe("a".repeat(64));
    await expect(harness.registry.verifySource(
      reclaimed.job.artifactId,
      "pdf-worker-2",
      reclaimed.leaseToken,
      { sha256: "b".repeat(64), byteLength: 4096 },
    )).rejects.toThrow("checksum changed");
  });

  it("publishes staged outputs under the active lease", async () => {
    const harness = registry();
    await harness.registry.enqueue(REQUEST, OWNERSHIP);
    const claimed = (await harness.registry.claimNext("pdf-worker-1"))!;
    const auth = [claimed.job.artifactId, "pdf-worker-1", claimed.leaseToken] as const;
    await harness.registry.verifySource(...auth, { sha256: "a".repeat(64), byteLength: 4096 });
    await harness.registry.stageOutput(...auth, {
      kind: "markdown",
      objectPath: `chat-artifacts/${claimed.job.artifactId}/attempts/1/markdown.md`,
      mediaType: "text/markdown; charset=utf-8",
      byteLength: 42,
      sha256: "b".repeat(64),
    });
    await harness.registry.stageOutput(...auth, {
      kind: "page",
      pageNumber: 1,
      objectPath: `chat-artifacts/${claimed.job.artifactId}/attempts/1/pages/1.webp`,
      mediaType: "image/webp",
      byteLength: 2048,
      sha256: "c".repeat(64),
    });
    const ready = await harness.registry.complete(...auth, {
      outcome: "ready",
      pageCount: 1,
      converter: { name: "pdf-inspector+pdfium", version: "contract-v1" },
    });
    expect(ready.status).toBe("ready");
    expect(ready.result?.pages[0].pageNumber).toBe(1);
  });
});
