import { createHash } from "node:crypto";

const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const MAX_PDF_BYTES = 64 * 1024 * 1024;

export interface ArtifactRequest {
  mattermostFileId: string;
  channelId: string;
  sourcePostId: string;
  runRootPostId: string;
  runId?: string;
  filename: string;
  mediaType: "application/pdf";
  byteLength: number;
}

export interface ArtifactMarkdownObject {
  kind: "markdown";
  objectPath: string;
  mediaType: "text/markdown; charset=utf-8";
  byteLength: number;
  sha256: string;
}

export interface ArtifactPageObject {
  kind: "page";
  pageNumber: number;
  objectPath: string;
  mediaType: "image/webp";
  byteLength: number;
  sha256: string;
}

export type ArtifactOutputObject = ArtifactMarkdownObject | ArtifactPageObject;

export type ArtifactJobStatus =
  | "queued"
  | "processing"
  | "ready"
  | "unsupported"
  | "failed";

export interface ArtifactJob {
  schemaVersion: 1;
  artifactId: string;
  ownerUid: string;
  workspaceSlug: string;
  workspaceOwnerUid: string;
  request: ArtifactRequest;
  status: ArtifactJobStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  lease?: {
    workerId: string;
    tokenHash: string;
    expiresAt: string;
  };
  staged?: {
    markdown?: ArtifactMarkdownObject;
    pages: ArtifactPageObject[];
  };
  source?: {
    sha256: string;
    byteLength: number;
    verifiedAt: string;
  };
  result?: {
    markdown: ArtifactMarkdownObject;
    pages: ArtifactPageObject[];
    converter: { name: string; version: string };
    completedAt: string;
  };
  failure?: {
    code: string;
    message: string;
    completedAt: string;
  };
}

export type ArtifactCompletion =
  | {
      outcome: "ready";
      pageCount: number;
      converter: { name: string; version: string };
      completedAt: string;
    }
  | {
      outcome: "unsupported" | "failed";
      code: string;
      message: string;
      completedAt: string;
    };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact request must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`invalid artifact ${label}`);
  }
  return value;
}

function mmId(value: unknown, label: string): string {
  const parsed = string(value, label, 26);
  if (!MATTERMOST_ID.test(parsed)) throw new Error(`invalid artifact ${label}`);
  return parsed;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : string(value, label, maxLength);
}

export function parseArtifactRequest(value: unknown): ArtifactRequest {
  const input = record(value);
  const mediaType = string(input.mediaType, "mediaType", 128);
  if (mediaType !== "application/pdf") throw new Error("only PDF artifacts are supported");
  const byteLength = input.byteLength;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1 || (byteLength as number) > MAX_PDF_BYTES) {
    throw new Error("invalid artifact byteLength");
  }
  return {
    mattermostFileId: mmId(input.mattermostFileId, "mattermostFileId"),
    channelId: mmId(input.channelId, "channelId"),
    sourcePostId: mmId(input.sourcePostId, "sourcePostId"),
    runRootPostId: mmId(input.runRootPostId, "runRootPostId"),
    runId: optionalString(input.runId, "runId", 256),
    filename: string(input.filename, "filename", 512),
    mediaType,
    byteLength: byteLength as number,
  };
}

export function artifactJobId(request: ArtifactRequest): string {
  const key = [
    "octogee-chat-artifact-v1",
    request.mattermostFileId,
    request.channelId,
    request.sourcePostId,
    request.runRootPostId,
    request.runId ?? "",
  ].join("\n");
  return createHash("sha256").update(key).digest("hex");
}

function publishedPages(job: ArtifactJob, pageCount: number): ArtifactPageObject[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error("artifact page count must be positive");
  }
  const pages = [...(job.staged?.pages ?? [])].sort((left, right) => left.pageNumber - right.pageNumber);
  if (
    pages.length !== pageCount ||
    pages.some((page, index) => page.pageNumber !== index + 1)
  ) {
    throw new Error("artifact pages must be a contiguous complete set");
  }
  return pages;
}

export function completeArtifactJob(job: ArtifactJob, completion: ArtifactCompletion): ArtifactJob {
  if (job.status !== "processing" || !job.lease) {
    throw new Error("artifact job is not processing");
  }
  if (completion.outcome === "ready") {
    if (!job.source) throw new Error("artifact source verification is required");
    if (!job.staged?.markdown) throw new Error("artifact Markdown output is required");
    const pages = publishedPages(job, completion.pageCount);
    return {
      ...job,
      status: "ready",
      updatedAt: completion.completedAt,
      lease: undefined,
      staged: undefined,
      failure: undefined,
      result: {
        markdown: job.staged.markdown,
        pages,
        converter: completion.converter,
        completedAt: completion.completedAt,
      },
    };
  }
  return {
    ...job,
    status: completion.outcome,
    updatedAt: completion.completedAt,
    lease: undefined,
    staged: undefined,
    result: undefined,
    failure: {
      code: string(completion.code, "failure code", 128),
      message: string(completion.message, "failure message", 1024),
      completedAt: completion.completedAt,
    },
  };
}
