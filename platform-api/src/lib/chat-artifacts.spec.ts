import { describe, expect, it } from "vitest";
import {
  artifactJobId,
  completeArtifactJob,
  parseArtifactRequest,
  type ArtifactJob,
} from "./chat-artifacts.js";

const FILE_ID = "f".repeat(26);
const CHANNEL_ID = "c".repeat(26);
const POST_ID = "p".repeat(26);
const ROOT_ID = "r".repeat(26);
function request(overrides: Record<string, unknown> = {}) {
  return {
    mattermostFileId: FILE_ID,
    channelId: CHANNEL_ID,
    sourcePostId: POST_ID,
    runRootPostId: ROOT_ID,
    runId: "run-17",
    filename: "Quarterly report.pdf",
    mediaType: "application/pdf",
    byteLength: 4096,
    ...overrides,
  };
}

describe("chat artifact request", () => {
  it("derives one stable id from the immutable Mattermost file and run linkage", () => {
    const parsed = parseArtifactRequest(request());
    expect(artifactJobId(parsed)).toBe(artifactJobId(parseArtifactRequest(request())));
    expect(artifactJobId(parseArtifactRequest(request({ runId: "run-18" })))).not.toBe(
      artifactJobId(parsed),
    );
  });

  it("does not trust or incorporate a client-supplied source checksum", () => {
    const first = parseArtifactRequest(request({ sha256: "a".repeat(64) }));
    const second = parseArtifactRequest(request({ sha256: "b".repeat(64) }));
    expect(first).not.toHaveProperty("sha256");
    expect(artifactJobId(first)).toBe(artifactJobId(second));
  });

  it.each([
    ["non-PDF media", { mediaType: "image/png" }],
    ["oversized source", { byteLength: 65 * 1024 * 1024 }],
    ["invalid Mattermost id", { channelId: "../channel" }],
    ["empty filename", { filename: "" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseArtifactRequest(request(override))).toThrow();
  });
});

describe("artifact completion", () => {
  const processingJob: ArtifactJob = {
    schemaVersion: 1,
    artifactId: "artifact-1",
    ownerUid: "uid-alice",
    workspaceSlug: "alice",
    workspaceOwnerUid: "uid-alice",
    request: parseArtifactRequest(request()),
    status: "processing",
    attempt: 1,
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:01:00.000Z",
    lease: {
      workerId: "pdf-worker-1",
      tokenHash: "token-hash",
      expiresAt: "2026-07-13T12:06:00.000Z",
    },
    staged: {
      markdown: {
        kind: "markdown",
        objectPath: "chat-artifacts/artifact-1/attempts/1/markdown.md",
        mediaType: "text/markdown; charset=utf-8",
        byteLength: 120,
        sha256: "b".repeat(64),
      },
      pages: [
        {
          kind: "page",
          pageNumber: 1,
          objectPath: "chat-artifacts/artifact-1/attempts/1/pages/1.webp",
          mediaType: "image/webp",
          byteLength: 2048,
          sha256: "c".repeat(64),
        },
      ],
    },
    source: {
      sha256: "a".repeat(64),
      byteLength: 4096,
      verifiedAt: "2026-07-13T12:01:30.000Z",
    },
  };

  it("publishes only a contiguous page set plus Markdown", () => {
    const ready = completeArtifactJob(processingJob, {
      outcome: "ready",
      pageCount: 1,
      converter: { name: "pdf-inspector+pdfium", version: "contract-v1" },
      completedAt: "2026-07-13T12:02:00.000Z",
    });
    expect(ready.status).toBe("ready");
    expect(ready.result?.pages).toHaveLength(1);
    expect(ready.lease).toBeUndefined();
    expect(ready.staged).toBeUndefined();
  });

  it("refuses to publish partial page output", () => {
    expect(() =>
      completeArtifactJob(processingJob, {
        outcome: "ready",
        pageCount: 2,
        converter: { name: "pdf-inspector+pdfium", version: "contract-v1" },
        completedAt: "2026-07-13T12:02:00.000Z",
      }),
    ).toThrow("contiguous");
  });

  it("refuses to publish before the trusted worker verifies the canonical source bytes", () => {
    expect(() => completeArtifactJob({ ...processingJob, source: undefined }, {
      outcome: "ready",
      pageCount: 1,
      converter: { name: "pdf-inspector+pdfium", version: "contract-v1" },
      completedAt: "2026-07-13T12:02:00.000Z",
    })).toThrow("source verification");
  });

  it("records unsupported and failed outcomes explicitly", () => {
    const unsupported = completeArtifactJob(processingJob, {
      outcome: "unsupported",
      code: "encrypted_pdf",
      message: "Encrypted PDFs are not supported",
      completedAt: "2026-07-13T12:02:00.000Z",
    });
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.failure?.code).toBe("encrypted_pdf");
  });
});
