import { Readable } from "node:stream";
import {
  assertMattermostId,
  createMattermostInternalHttpClient,
  MattermostInternalHttpError,
} from "../../../gateway-edge/src/chat-proxy/openclaw/mattermost-http.js";
import {
  ArtifactAccessDeniedError,
  type ArtifactAccessAuthorizer,
  type ArtifactBlobStore,
  type ArtifactSourceReader,
} from "../routes/chat-artifacts.js";
import { parseArtifactRequest } from "./chat-artifacts.js";

type ParsedArtifactRequest = ReturnType<typeof parseArtifactRequest>;

interface MattermostAdapterOptions {
  mattermostBaseUrl: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
}

interface MattermostAccessOptions extends MattermostAdapterOptions {
  resolveWorkspaceSlugForTeamId: (teamId: string) => Promise<{
    workspaceSlug: string;
    workspaceOwnerUid: string;
  } | null>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function internalMattermostBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !/^mattermost\.[a-z0-9-]+\.svc\.cluster\.local$/.test(url.hostname) ||
    url.port !== "8065" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("invalid Mattermost artifact base URL");
  }
  return `${url.protocol}//${url.host}`;
}

function mattermostClient(options: MattermostAdapterOptions) {
  return createMattermostInternalHttpClient({
    baseUrl: options.mattermostBaseUrl,
    token: options.adminToken,
    requireToken: true,
    fetchImpl: options.fetchImpl,
  });
}

async function assertMember(
  client: ReturnType<typeof mattermostClient>,
  mattermostUserId: string,
  channelId: string,
): Promise<void> {
  let value: unknown;
  try {
    value = await client.requestJson("GET", [
        "channels",
        assertMattermostId(channelId, "channelId"),
        "members",
        assertMattermostId(mattermostUserId, "userId"),
      ]);
  } catch (error) {
    if (error instanceof MattermostInternalHttpError && error.status === 404) {
      throw new ArtifactAccessDeniedError("Mattermost channel membership required");
    }
    throw error;
  }
  const member = object(value, "Mattermost channel member");
  if (member.channel_id !== channelId || member.user_id !== mattermostUserId) {
    throw new ArtifactAccessDeniedError("Mattermost artifact channel membership mismatch");
  }
}

function assertAttachmentBinding(
  request: ParsedArtifactRequest,
  file: Record<string, unknown>,
  post: Record<string, unknown>,
): void {
  const fileIds = post.file_ids;
  if (
    file.id !== request.mattermostFileId ||
    file.post_id !== request.sourcePostId ||
    post.id !== request.sourcePostId ||
    post.channel_id !== request.channelId ||
    !Array.isArray(fileIds) ||
    !fileIds.includes(request.mattermostFileId)
  ) {
    throw new ArtifactAccessDeniedError("Mattermost artifact is not attached to the claimed source post");
  }
}

function octogeePostProps(post: Record<string, unknown>): Record<string, unknown> {
  return object(
    object(post.props ?? {}, "Mattermost post props").octogee ?? {},
    "Mattermost Octogee post props",
  );
}

function assertRunBinding(
  request: ParsedArtifactRequest,
  post: Record<string, unknown>,
  octogee: Record<string, unknown>,
): void {
  const rootIsBound =
    request.sourcePostId === request.runRootPostId ||
    post.root_id === request.runRootPostId ||
    octogee.mainRootPostId === request.runRootPostId;
  if (!rootIsBound) {
    throw new ArtifactAccessDeniedError("Mattermost artifact run root is not proven by the source post");
  }
  if (request.runId && typeof octogee.runId === "string" && octogee.runId !== request.runId) {
    throw new ArtifactAccessDeniedError("Mattermost artifact run id does not match the source post");
  }
}

function artifactFileMetadata(file: Record<string, unknown>): { filename: string; byteLength: number } {
  if (
    typeof file.name !== "string" ||
    file.name.length === 0 ||
    file.name.length > 512 ||
    file.mime_type !== "application/pdf" ||
    !Number.isSafeInteger(file.size) ||
    (file.size as number) < 1 ||
    (file.size as number) > 64 * 1024 * 1024
  ) {
    throw new Error("Mattermost artifact file metadata is invalid or unsupported");
  }
  return { filename: file.name, byteLength: file.size as number };
}

export function createMattermostArtifactAccess(
  options: MattermostAccessOptions,
): ArtifactAccessAuthorizer {
  const client = mattermostClient(options);
  return {
    async authorizeRequest(mattermostUserId, value) {
      const request = parseArtifactRequest(value);
      const [fileValue, postValue] = await Promise.all([
        client.requestJson("GET", ["files", request.mattermostFileId, "info"]),
        client.requestJson("GET", ["posts", request.sourcePostId]),
        assertMember(client, mattermostUserId, request.channelId),
      ]);
      const file = object(fileValue, "Mattermost file info");
      const post = object(postValue, "Mattermost source post");
      assertAttachmentBinding(request, file, post);
      const octogee = octogeePostProps(post);
      assertRunBinding(request, post, octogee);
      const metadata = artifactFileMetadata(file);
      const channelValue = await client.requestJson("GET", ["channels", request.channelId]);
      const channel = object(channelValue, "Mattermost artifact channel");
      if (channel.id !== request.channelId || typeof channel.team_id !== "string") {
        throw new ArtifactAccessDeniedError("Mattermost artifact channel is not workspace-bound");
      }
      const workspace = await options.resolveWorkspaceSlugForTeamId(channel.team_id);
      if (!workspace) {
        throw new ArtifactAccessDeniedError("Mattermost artifact workspace is not active");
      }
      return {
        request: {
          ...request,
          filename: metadata.filename,
          mediaType: "application/pdf",
          byteLength: metadata.byteLength,
          runId: typeof octogee.runId === "string" ? octogee.runId : undefined,
        },
        ...workspace,
      };
    },
    assertChannelMember(mattermostUserId, channelId) {
      return assertMember(client, mattermostUserId, channelId);
    },
  };
}

export function createMattermostArtifactSourceReader(
  options: MattermostAdapterOptions,
): ArtifactSourceReader {
  const baseUrl = internalMattermostBaseUrl(options.mattermostBaseUrl);
  mattermostClient(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async open(mattermostFileId) {
      const fileId = assertMattermostId(mattermostFileId, "fileId");
      const response = await fetchImpl(`${baseUrl}/api/v4/files/${fileId}`, {
        headers: { authorization: `Bearer ${options.adminToken}`, accept: "application/pdf" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Mattermost artifact source failed: HTTP ${response.status}`);
      }
      const contentLengthValue = response.headers.get("content-length");
      const byteLength = contentLengthValue ? Number(contentLengthValue) : undefined;
      if (
        byteLength !== undefined &&
        (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 64 * 1024 * 1024)
      ) {
        throw new Error("Mattermost artifact source length is invalid or too large");
      }
      return {
        stream: Readable.fromWeb(response.body as never),
        byteLength,
        mediaType: "application/pdf",
      };
    },
  };
}

interface GcsFile {
  save(
    body: Buffer,
    options: {
      resumable: false;
      validation: "crc32c";
      metadata: Record<string, unknown>;
      preconditionOpts: { ifGenerationMatch: 0 };
    },
  ): Promise<unknown>;
  getMetadata(): Promise<unknown[]>;
  createReadStream(): Readable;
  delete(options: { ignoreNotFound: true }): Promise<unknown>;
}

interface GcsBucket {
  file(path: string): GcsFile;
}

function outputPath(input: {
  artifactId: string;
  attempt: number;
  kind: "markdown" | "page";
  pageNumber?: number;
}): { path: string; mediaType: "text/markdown; charset=utf-8" | "image/webp" } {
  if (!/^[a-f0-9]{64}$/.test(input.artifactId) || !Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("invalid artifact output identity");
  }
  const prefix = `chat-artifacts/${input.artifactId}/attempts/${input.attempt}`;
  if (input.kind === "markdown") {
    return { path: `${prefix}/markdown.md`, mediaType: "text/markdown; charset=utf-8" };
  }
  if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber! < 1 || input.pageNumber! > 500) {
    throw new Error("invalid artifact page number");
  }
  return { path: `${prefix}/pages/${input.pageNumber}.webp`, mediaType: "image/webp" };
}

export function createGcsArtifactBlobStore(bucket: GcsBucket): ArtifactBlobStore {
  return {
    async put(input) {
      if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Buffer.isBuffer(input.body) || input.body.byteLength < 1) {
        throw new Error("invalid artifact output payload");
      }
      const object = outputPath(input);
      await bucket.file(object.path).save(input.body, {
        resumable: false,
        validation: "crc32c",
        metadata: {
          contentType: object.mediaType,
          cacheControl: "private, max-age=300",
          metadata: { sha256: input.sha256 },
        },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      return input.kind === "markdown"
        ? {
            kind: "markdown",
            objectPath: object.path,
            mediaType: "text/markdown; charset=utf-8",
            byteLength: input.body.byteLength,
            sha256: input.sha256,
          }
        : {
            kind: "page",
            pageNumber: input.pageNumber!,
            objectPath: object.path,
            mediaType: "image/webp",
            byteLength: input.body.byteLength,
            sha256: input.sha256,
          };
    },
    async open(output) {
      const { objectPath } = output;
      const validPath = new RegExp(
        "^chat-artifacts/[a-f0-9]{64}/attempts/[1-9]\\d*/(markdown\\.md|pages/[1-9]\\d*\\.webp)$",
      );
      if (!validPath.test(objectPath)) {
        throw new Error("invalid artifact object path");
      }
      const file = bucket.file(objectPath);
      const [metadataValue] = await file.getMetadata();
      const metadata = object(metadataValue, "artifact object metadata");
      const byteLength = Number(metadata.size);
      const mediaType = metadata.contentType;
      const customMetadata = object(metadata.metadata ?? {}, "artifact object custom metadata");
      const expectedMediaType = output.kind === "markdown"
        ? new Set(["text/markdown; charset=utf-8", "text/markdown"])
        : new Set(["image/webp"]);
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength !== output.byteLength ||
        typeof mediaType !== "string" ||
        !expectedMediaType.has(mediaType) ||
        customMetadata.sha256 !== output.sha256
      ) {
        throw new Error("invalid artifact object metadata");
      }
      return { stream: file.createReadStream(), byteLength, mediaType: output.mediaType };
    },
    async delete(output) {
      const expected = outputPath({
        artifactId: output.objectPath.split("/")[1] ?? "",
        attempt: Number(output.objectPath.split("/")[3]),
        kind: output.kind,
        ...(output.kind === "page" ? { pageNumber: output.pageNumber } : {}),
      });
      if (expected.path !== output.objectPath) throw new Error("invalid artifact object path");
      await bucket.file(output.objectPath).delete({ ignoreNotFound: true });
    },
  };
}
