import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createGcsArtifactBlobStore,
  createMattermostArtifactAccess,
  createMattermostArtifactSourceReader,
} from "./chat-artifact-adapters.js";

const FILE_ID = "f".repeat(26);
const CHANNEL_ID = "c".repeat(26);
const POST_ID = "p".repeat(26);
const ROOT_ID = "r".repeat(26);
const USER_ID = "u".repeat(26);
const MM_URL = "http://mattermost.octogee-test.svc.cluster.local:8065";
const MM_TOKEN = "t".repeat(26);

function request() {
  return {
    mattermostFileId: FILE_ID,
    channelId: CHANNEL_ID,
    sourcePostId: POST_ID,
    runRootPostId: ROOT_ID,
    runId: "run-17",
    filename: "client-name.pdf",
    mediaType: "application/pdf",
    byteLength: 4096,
  };
}

describe("Mattermost artifact access", () => {
  it("proves membership and binds the request to canonical file and post facts", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith(`/files/${FILE_ID}/info`)) {
        return new Response(JSON.stringify({
          id: FILE_ID,
          post_id: POST_ID,
          name: "canonical-report.pdf",
          mime_type: "application/pdf",
          size: 4096,
        }));
      }
      if (url.endsWith(`/posts/${POST_ID}`)) {
        return new Response(JSON.stringify({
          id: POST_ID,
          channel_id: CHANNEL_ID,
          file_ids: [FILE_ID],
          props: { octogee: { mainRootPostId: ROOT_ID, runId: "run-17" } },
        }));
      }
      if (url.endsWith(`/channels/${CHANNEL_ID}/members/${USER_ID}`)) {
        return new Response(JSON.stringify({ channel_id: CHANNEL_ID, user_id: USER_ID }));
      }
      if (url.endsWith(`/channels/${CHANNEL_ID}`)) {
        return new Response(JSON.stringify({ id: CHANNEL_ID, team_id: "team-1" }));
      }
      return new Response("missing", { status: 404 });
    });
    const access = createMattermostArtifactAccess({
      mattermostBaseUrl: MM_URL,
      adminToken: MM_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      resolveWorkspaceSlugForTeamId: async () => ({
        workspaceSlug: "channel-workspace",
        workspaceOwnerUid: "workspace-owner",
      }),
    });
    const authorized = await access.authorizeRequest(USER_ID, request());
    expect(authorized).toMatchObject({
      request: { filename: "canonical-report.pdf", byteLength: 4096 },
      workspaceSlug: "channel-workspace",
      workspaceOwnerUid: "workspace-owner",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects a file that is not attached to the claimed post", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/files/")) {
        return new Response(JSON.stringify({
          id: FILE_ID,
          post_id: "z".repeat(26),
          name: "report.pdf",
          mime_type: "application/pdf",
          size: 4096,
        }));
      }
      if (url.includes("/posts/")) {
        return new Response(JSON.stringify({ id: POST_ID, channel_id: CHANNEL_ID, file_ids: [FILE_ID] }));
      }
      return new Response(JSON.stringify({ channel_id: CHANNEL_ID, user_id: USER_ID }));
    });
    const access = createMattermostArtifactAccess({
      mattermostBaseUrl: MM_URL,
      adminToken: MM_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      resolveWorkspaceSlugForTeamId: async () => ({
        workspaceSlug: "channel-workspace",
        workspaceOwnerUid: "workspace-owner",
      }),
    });
    await expect(access.authorizeRequest(USER_ID, request())).rejects.toThrow("attached");
  });

  it("rejects unproven run linkage", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/files/")) {
        return new Response(JSON.stringify({
          id: FILE_ID,
          post_id: POST_ID,
          name: "report.pdf",
          mime_type: "application/pdf",
          size: 4096,
        }));
      }
      if (url.includes("/posts/")) {
        return new Response(JSON.stringify({
          id: POST_ID,
          channel_id: CHANNEL_ID,
          root_id: "q".repeat(26),
          file_ids: [FILE_ID],
          props: {},
        }));
      }
      return new Response(JSON.stringify({ channel_id: CHANNEL_ID, user_id: USER_ID }));
    });
    const access = createMattermostArtifactAccess({
      mattermostBaseUrl: MM_URL,
      adminToken: MM_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      resolveWorkspaceSlugForTeamId: async () => ({
        workspaceSlug: "channel-workspace",
        workspaceOwnerUid: "workspace-owner",
      }),
    });
    await expect(access.authorizeRequest(USER_ID, request())).rejects.toThrow("run root");
  });
});

describe("Mattermost artifact source", () => {
  it("streams the original without redirects through the fixed internal origin", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("%PDF-source"), {
      headers: { "content-type": "application/pdf", "content-length": "11" },
    }));
    const source = createMattermostArtifactSourceReader({
      mattermostBaseUrl: MM_URL,
      adminToken: MM_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const opened = await source.open(FILE_ID);
    expect(opened.byteLength).toBe(11);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${MM_URL}/api/v4/files/${FILE_ID}`,
      expect.objectContaining({ redirect: "error" }),
    );
  });
});

describe("GCS artifact outputs", () => {
  it("writes private attempt-fenced objects and reopens them", async () => {
    const saved = new Map<string, { body: Buffer; metadata: Record<string, unknown> }>();
    const saveOptions: unknown[] = [];
    const bucket = {
      file: (path: string) => ({
        save: async (body: Buffer, options: { metadata: Record<string, unknown> }) => {
          saveOptions.push(options);
          saved.set(path, { body, metadata: options.metadata });
        },
        getMetadata: async () => [{
          size: String(saved.get(path)?.body.byteLength),
          contentType: "image/webp",
          metadata: (saved.get(path)?.metadata.metadata as Record<string, unknown> | undefined),
        }],
        createReadStream: () => Readable.from(saved.get(path)?.body ?? Buffer.alloc(0)),
        delete: async () => { saved.delete(path); },
      }),
    };
    const blobs = createGcsArtifactBlobStore(bucket);
    const body = Buffer.from("page");
    const output = await blobs.put({
      artifactId: "a".repeat(64),
      attempt: 2,
      kind: "page",
      pageNumber: 1,
      body,
      sha256: "d".repeat(64),
    });
    expect(output.objectPath).toBe(`chat-artifacts/${"a".repeat(64)}/attempts/2/pages/1.webp`);
    expect(saved.get(output.objectPath)?.metadata).toMatchObject({
      contentType: "image/webp",
      cacheControl: "private, max-age=300",
    });
    expect(saveOptions[0]).toMatchObject({ preconditionOpts: { ifGenerationMatch: 0 } });
    expect((await blobs.open(output)).byteLength).toBe(4);
    await blobs.delete(output);
    expect(saved.has(output.objectPath)).toBe(false);
  });

  it("refuses to serve an object whose stored digest disagrees with the published result", async () => {
    const bucket = {
      file: () => ({
        save: vi.fn(),
        getMetadata: async () => [{
          size: "4",
          contentType: "image/webp",
          metadata: { sha256: "e".repeat(64) },
        }],
        createReadStream: () => Readable.from(Buffer.from("page")),
        delete: vi.fn(),
      }),
    };
    const blobs = createGcsArtifactBlobStore(bucket);

    await expect(blobs.open({
      kind: "page",
      pageNumber: 1,
      objectPath: `chat-artifacts/${"a".repeat(64)}/attempts/2/pages/1.webp`,
      mediaType: "image/webp",
      byteLength: 4,
      sha256: "d".repeat(64),
    })).rejects.toThrow("metadata");
  });
});
