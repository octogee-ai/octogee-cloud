import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform-state", () => ({ platformStateStore: {} }));
vi.mock("../lib/gcs-bucket", () => ({ gcsBucket: vi.fn() }));

vi.mock("../lib/manifest", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/manifest.js")>(),
  getManifest: vi.fn(async (prefix, bustCache, blobs) => {
    if (blobs) return (await importOriginal<typeof import("../lib/manifest.js")>()).getManifest(prefix, bustCache, blobs);
    return {};
  }),
}));

vi.mock("../lib/github", () => ({
  isOversizeFile: vi.fn(),
}));

vi.mock("../lib/fileTarget", () => ({
  withFileTarget: vi.fn((handler) => handler),
}));

vi.mock("../routes/workspace/helpers", () => ({
  HIDDEN: new Set([".git"]),
  giteaSudoUser: vi.fn(() => "ws-alice"),
  isCanvasDashboardDocumentPath: vi.fn((path: string) => path === ".octogee/canvas.json"),
  isTargetDirectoryEntryReadable: vi.fn((target: FileTarget, path: string, type: "dir" | "file") =>
    !target.workspaceMemberBrokered
    || (type === "dir" ? path === "notes" : path === "README.md" || /^notes\/[^/]+\.md$/.test(path))),
  isTargetDirectoryReadable: vi.fn((target: FileTarget, path: string) =>
    !target.workspaceMemberBrokered || path === "" || path === "notes"),
  isTargetPathReadable: vi.fn((target: FileTarget, path: string) =>
    !target.workspaceMemberBrokered || path === "README.md" || /^notes\/[^/]+\.md$/.test(path)),
  isTargetPathWritable: vi.fn(),
  pathHasReservedOrHiddenSegment: vi.fn((path: string) => path.startsWith(".") ? "Access denied" : null),
  repoContentsApi: vi.fn(),
  repoCommitsApi: vi.fn(),
  repoTreeApi: vi.fn(),
}));

import {
  blobFileEntries,
  clearWorkspaceFileResponseCache,
  workspaceFileIndexResponse,
  workspaceFileResponse,
  repoFileEntries,
  sortWorkspaceFiles,
  workspaceFilesResponse,
} from "../routes/workspace/files.js";
import { repoContentsApi, repoTreeApi } from "../routes/workspace/helpers.js";
import { getManifest } from "../lib/manifest.js";
import { gcsBucket } from "../lib/gcs-bucket.js";
import type { Manifest } from "../lib/manifest.js";
import type { BlobStore } from "../lib/blob-store.js";
import type { FileTarget } from "../lib/fileTarget.js";

const giteaTarget: FileTarget = {
  slug: "alice",
  projectSlug: null,
  provider: "gitea",
  org: "alice",
  repoName: "workspace",
  gcsPrefix: "customers/alice",
  sudoUser: "ws-alice",
  brokered: false,
};

const githubTarget: FileTarget = {
  slug: "bob",
  projectSlug: null,
  provider: "github",
  org: "bob",
  repoName: "site",
  gcsPrefix: "customers/bob",
  githubToken: "tok",
  brokered: true,
};

describe("workspace file list helpers", () => {
  beforeEach(() => {
    clearWorkspaceFileResponseCache();
    vi.mocked(repoContentsApi).mockReset();
    vi.mocked(repoTreeApi).mockReset();
    vi.mocked(getManifest).mockReset();
    vi.mocked(gcsBucket).mockReset();
  });

  it("lists the requested project's committed asset revision without reviving deleted GCS entries", async () => {
    const target = { ...giteaTarget, projectSlug: "demo", repoName: "alice-demo", gcsPrefix: "customers/alice/projects/demo" };
    const oldAsset = { type: "blob", gcsPath: `${target.gcsPrefix}/.objects/${"a".repeat(64)}`, sha256: "a".repeat(64), size: 4, mimeType: "application/octet-stream", uploadedAt: "2026-10-08" };
    vi.mocked(getManifest).mockResolvedValue({ "deleted.bin": oldAsset } as Manifest);
    vi.mocked(repoContentsApi).mockImplementation(async (_target, name, ref) => name === ".files/manifest.json"
      ? { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(ref === "old-version" ? { "old.bin": oldAsset } : {})).toString("base64") }
      : []);
    expect(await workspaceFilesResponse(target, "", false, "old-version")).toMatchObject({ files: [{ path: "old.bin", source: "blob" }] });
    expect(await workspaceFilesResponse(target, "", false, "main")).toMatchObject({ files: [] });
    expect(getManifest).not.toHaveBeenCalled();
  });

  it("lists and signs workspace files using the selected blob store", async () => {
    const key = "customers/alice/photo.png";
    const manifest = { "photo.png": { type: "blob", gcsPath: key, size: 10, mimeType: "image/png", hasThumbnail: true, uploadedAt: "2026-01-01" } };
    const signedUrl = vi.fn<BlobStore["signedUrl"]>(async ({ gcsPath }) => ({
      url: `https://files.test/${gcsPath}`, method: "GET", gcsPath, expiresAt: "", storage: "s3",
    }));
    const download = vi.fn<BlobStore["download"]>(async () => ({
      bytes: Buffer.from(JSON.stringify(manifest)), revision: '"manifest"',
    }));
    const blobStore = { signedUrl, download } as unknown as BlobStore;
    const target: FileTarget = { ...giteaTarget, blobStore };
    vi.mocked(repoContentsApi).mockResolvedValue([]);
    await expect(workspaceFilesResponse(target, "", false)).resolves.toMatchObject({
      files: [{ path: "photo.png", source: "blob", thumbnailUrl: "https://files.test/customers/alice/.thumbs/photo.png.png" }],
    });
    await expect(workspaceFileResponse(target, "photo.png")).resolves.toMatchObject({
      path: "photo.png", source: "blob", downloadUrl: `https://files.test/${key}`,
    });
    expect(download).toHaveBeenCalledWith("customers/alice/.files/manifest.json");
    expect(gcsBucket).not.toHaveBeenCalled();
  });

  it("maps visible repo entries, including user-owned context files, and hides reserved or dot-prefixed names", () => {
    const files = repoFileEntries([
      { name: "src", path: "src", type: "dir" },
      { name: "README.md", path: "README.md", type: "file", size: 12 },
      { name: ".env", path: ".env", type: "file", size: 4 },
      { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 8 },
    ]);

    expect(files).toEqual([
      { name: "src", path: "src", type: "dir", size: 0, source: "git" },
      { name: "README.md", path: "README.md", type: "file", size: 12, source: "git" },
      { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 8, source: "git" },
    ]);
  });

  it("adds direct manifest blob children that are not already present in git", () => {
    const manifest: Manifest = {
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        size: 100,
        mimeType: "image/png",
        hasThumbnail: true,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/nested/photo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/nested/photo.png",
        size: 200,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/git-backed.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/git-backed.png",
        size: 300,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const entries = blobFileEntries(
      manifest,
      "assets",
      new Set(["assets/git-backed.png"]),
    );

    expect(entries).toEqual([
      {
        name: "logo.png",
        path: "assets/logo.png",
        type: "file",
        size: 100,
        source: "blob",
      },
      {
        name: "nested",
        path: "assets/nested",
        type: "dir",
        size: 0,
        source: "blob",
      },
    ]);
  });

  it("makes a blob-only nested directory browsable when Gitea has no corresponding path", async () => {
    const manifest: Manifest = {
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        size: 100,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    vi.mocked(repoContentsApi).mockRejectedValue(new Error("Gitea API 404"));
    vi.mocked(getManifest).mockResolvedValue(manifest);

    await expect(workspaceFilesResponse(giteaTarget, "", false)).resolves.toEqual({
      files: [{ name: "assets", path: "assets", type: "dir", size: 0, source: "blob" }],
      readOnly: false,
    });
    await expect(workspaceFilesResponse(giteaTarget, "assets", false)).resolves.toEqual({
      files: [{ name: "logo.png", path: "assets/logo.png", type: "file", size: 100, source: "blob" }],
      readOnly: false,
    });
  });

  it("prefers a direct blob file over a conflicting synthetic directory", () => {
    const manifest: Manifest = {
      assets: {
        type: "blob",
        gcsPath: "customers/alice/assets",
        size: 10,
        mimeType: "application/octet-stream",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        size: 100,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    expect(blobFileEntries(manifest, "", new Set())).toEqual([
      { name: "assets", path: "assets", type: "file", size: 10, source: "blob" },
    ]);
  });

  it("sorts directories before files and then by name", () => {
    expect(sortWorkspaceFiles([
      { name: "z.md", path: "z.md", type: "file", size: 1, source: "git" },
      { name: "beta", path: "beta", type: "dir", size: 0, source: "git" },
      { name: "a.md", path: "a.md", type: "file", size: 1, source: "blob" },
      { name: "alpha", path: "alpha", type: "dir", size: 0, source: "git" },
    ])).toEqual([
      { name: "alpha", path: "alpha", type: "dir", size: 0, source: "git" },
      { name: "beta", path: "beta", type: "dir", size: 0, source: "git" },
      { name: "a.md", path: "a.md", type: "file", size: 1, source: "blob" },
      { name: "z.md", path: "z.md", type: "file", size: 1, source: "git" },
    ]);
  });

  it("preserves the legacy repo-404 response shape without readOnly", async () => {
    vi.mocked(repoContentsApi).mockRejectedValueOnce(new Error("Gitea API 404"));
    vi.mocked(getManifest).mockResolvedValue({});

    await expect(workspaceFilesResponse(giteaTarget, "", false)).resolves.toEqual({ files: [] });
  });

  it("serves repeated directory listings from the gateway cache", async () => {
    vi.mocked(repoContentsApi).mockResolvedValue([{ name: "README.md", path: "README.md", type: "file", size: 12 }]);

    await workspaceFilesResponse(githubTarget, "", false);
    await workspaceFilesResponse(githubTarget, "", false);

    expect(repoContentsApi).toHaveBeenCalledTimes(1);
  });

  it("filters a brokered workspace member's listing to notes and canvas files", async () => {
    const memberTarget: FileTarget = {
      ...giteaTarget,
      brokered: true,
      workspaceMemberBrokered: true,
      canvasFile: "README.md",
    };
    vi.mocked(repoContentsApi).mockResolvedValue([
      { name: "README.md", path: "README.md", type: "file", size: 12 },
      { name: "notes", path: "notes", type: "dir" },
      { name: "src", path: "src", type: "dir" },
      { name: "secret.txt", path: "secret.txt", type: "file", size: 4 },
    ]);
    vi.mocked(getManifest).mockResolvedValue({});

    await expect(workspaceFilesResponse(memberTarget, "", false)).resolves.toEqual({
      files: [
        { name: "notes", path: "notes", type: "dir", size: 0, source: "git" },
        { name: "README.md", path: "README.md", type: "file", size: 12, source: "git" },
      ],
      readOnly: false,
    });
  });

  it("coalesces concurrent directory listing requests for the same repo path", async () => {
    let resolveListing: (value: unknown) => void = () => {};
    vi.mocked(repoContentsApi).mockReturnValue(new Promise((resolve) => {
      resolveListing = resolve;
    }));

    const first = workspaceFilesResponse(githubTarget, "", false);
    const second = workspaceFilesResponse(githubTarget, "", false);
    await Promise.resolve();
    expect(repoContentsApi).toHaveBeenCalledTimes(1);

    resolveListing([{ name: "README.md", path: "README.md", type: "file", size: 12 }]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { files: [{ name: "README.md", path: "README.md", type: "file", size: 12, source: "git" }], readOnly: true },
      { files: [{ name: "README.md", path: "README.md", type: "file", size: 12, source: "git" }], readOnly: true },
    ]);
  });

  it("builds the global file index from repo tree paths plus manifest-backed blobs", async () => {
    vi.mocked(repoTreeApi).mockResolvedValueOnce({
      paths: ["README.md", "src/index.ts", "assets/git-backed.png"],
      truncated: false,
    });
    vi.mocked(getManifest).mockResolvedValueOnce({
      "assets/git-backed.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/git-backed.png",
        size: 300,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        size: 100,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      ".files/hidden.png": {
        type: "blob",
        gcsPath: "customers/alice/.files/hidden.png",
        size: 100,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await expect(workspaceFileIndexResponse(giteaTarget, "main", false)).resolves.toEqual({
      files: [
        { path: "assets/git-backed.png", source: "git" },
        { path: "assets/logo.png", source: "blob" },
        { path: "README.md", source: "git" },
        { path: "src/index.ts", source: "git" },
      ],
      paths: ["assets/git-backed.png", "assets/logo.png", "README.md", "src/index.ts"],
      truncated: false,
    });
  });

  it("filters a brokered workspace member's global index", async () => {
    const memberTarget: FileTarget = {
      ...giteaTarget,
      brokered: true,
      workspaceMemberBrokered: true,
      canvasFile: "README.md",
    };
    vi.mocked(repoTreeApi).mockResolvedValueOnce({
      paths: ["README.md", "notes/idea.md", "src/index.ts", "owner-secret.txt"],
      truncated: false,
    });
    vi.mocked(getManifest).mockResolvedValueOnce({});

    await expect(workspaceFileIndexResponse(memberTarget, "main", false)).resolves.toEqual({
      files: [
        { path: "notes/idea.md", source: "git" },
        { path: "README.md", source: "git" },
      ],
      paths: ["notes/idea.md", "README.md"],
      truncated: false,
    });
  });

  it("caches the global file index by target and ref", async () => {
    vi.mocked(repoTreeApi).mockResolvedValue({
      paths: ["README.md"],
      truncated: false,
    });
    vi.mocked(getManifest).mockResolvedValue({});

    await workspaceFileIndexResponse(giteaTarget, "main", false);
    await workspaceFileIndexResponse(giteaTarget, "main", false);

    expect(repoTreeApi).toHaveBeenCalledTimes(1);
    expect(getManifest).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing git-backed file instead of throwing", async () => {
    vi.mocked(getManifest).mockResolvedValueOnce({});
    vi.mocked(repoContentsApi).mockRejectedValueOnce(new Error("Gitea API 404"));

    await expect(workspaceFileResponse(giteaTarget, "README.md")).resolves.toBeNull();
  });

  it("reloads a file when a caller bypasses the response cache", async () => {
    vi.mocked(repoContentsApi)
      .mockResolvedValueOnce({ content: Buffer.from("before").toString("base64"), sha: "one" })
      .mockResolvedValueOnce({ content: Buffer.from("after").toString("base64"), sha: "two" });

    await expect(workspaceFileResponse(githubTarget, ".octogee/canvas.json")).resolves.toMatchObject({
      content: "before",
      sha: "one",
    });
    await expect(workspaceFileResponse(githubTarget, ".octogee/canvas.json", undefined, true)).resolves.toMatchObject({
      content: "after",
      sha: "two",
    });

    expect(repoContentsApi).toHaveBeenCalledTimes(2);
  });

  it("serves manifest-backed blobs from GCS without asking the repo contents API", async () => {
    const getSignedUrl = vi.fn().mockResolvedValue(["https://signed.test/logo.png"]);
    const file = vi.fn(() => ({ getSignedUrl }));
    vi.mocked(gcsBucket).mockReturnValue({ file } as never);
    vi.mocked(getManifest).mockResolvedValueOnce({
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        mimeType: "image/png",
        size: 20,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await expect(workspaceFileResponse(giteaTarget, "assets/logo.png")).resolves.toEqual({
      content: null,
      downloadUrl: "https://signed.test/logo.png",
      mimeType: "image/png",
      size: 20,
      path: "assets/logo.png",
      source: "blob",
    });
    expect(file).toHaveBeenCalledWith("customers/alice/assets/logo.png");
    expect(repoContentsApi).not.toHaveBeenCalled();
  });
});
