import { afterEach, expect, it, vi } from "vitest";
import { createBrokeredExportAssets } from "./agent-export-blob.js";

const broker = vi.hoisted(() => ({
  manifestUrl: vi.fn(),
  blobUrl: vi.fn(),
  workspaceManifestReadUrl: vi.fn(),
  blobMaterializationReadUrl: vi.fn(),
}));
vi.mock("@octogee/core/workspace/project-blob-upload", () => ({
  workspaceBlobReadClient: () => broker,
  projectBlobHydrationClient: () => broker,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const endpoint = "https://files.test";
const workspace = "customers/alice";
const manifestKey = workspace + "/.files/manifest.json";
const entry = { type: "blob" as const, gcsPath: workspace + "/photo.png", size: 3, mimeType: "image/png", uploadedAt: "2026-11-01" };

function signed(key: string) {
  return { gcsPath: key, method: "GET", storage: "s3", url: endpoint + "/" + key };
}

function reader(project: string | null) {
  return createBrokeredExportAssets({
    baseUrl: "http://octogee-api:3001", endpoint,
    prefix: project ? workspace + "/projects/" + project : workspace,
    source: { slug: "alice", project }, signal: new AbortController().signal,
  });
}

it("loads the selected workspace manifest and attachment through scoped signed URLs", async () => {
  const manifest = { "photo.png": entry };
  broker.manifestUrl.mockResolvedValue(signed(manifestKey));
  broker.blobUrl.mockResolvedValue(signed(entry.gcsPath));
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response("png"));
  vi.stubGlobal("fetch", fetchMock);
  const assets = reader(null);

  await expect(assets.readManifest()).resolves.toEqual(manifest);
  await expect(assets.readBlob(entry)).resolves.toEqual(Buffer.from("png"));
  expect(broker.manifestUrl).toHaveBeenCalledWith("alice");
  expect(broker.blobUrl).toHaveBeenCalledWith("alice", "photo.png");
  expect(fetchMock).toHaveBeenLastCalledWith(new URL(signed(entry.gcsPath).url), expect.objectContaining({ redirect: "error" }));
});

it("rejects a project attachment when its signed version differs from the downloaded version", async () => {
  const sha256 = "a".repeat(64);
  const attachment = { ...entry, sha256, gcsPath: workspace + "/projects/orbit/.objects/" + sha256 };
  broker.blobMaterializationReadUrl.mockResolvedValue({ download: signed(attachment.gcsPath), generation: "pinned", size: 3 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("png", { headers: { "x-amz-version-id": "different" } })));

  await expect(reader("orbit").readBlob(attachment)).rejects.toThrow(/version changed/);
  expect(broker.blobMaterializationReadUrl).toHaveBeenCalledWith({
    slug: "alice", path: "projects/orbit/asset", size: 3, sha256,
  });
});
