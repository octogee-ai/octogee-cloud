import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("../lib/platform-state", () => ({ platformStateStore: {} }));
vi.mock("../lib/gcs-bucket", () => ({ gcsBucket: vi.fn() }));
vi.mock("../lib/manifest", () => ({ getManifest: vi.fn() }));
vi.mock("../lib/github", () => ({ isOversizeFile: vi.fn() }));
vi.mock("../lib/fileTarget", () => ({ withFileTarget: vi.fn((handler) => handler) }));
vi.mock("../middleware/logging", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../routes/workspace/helpers", () => ({
  HIDDEN: new Set([".git"]),
  giteaSudoUser: vi.fn(() => "ws-alice"),
  isTargetDirectoryEntryReadable: vi.fn(() => true),
  isTargetPathReadable: vi.fn(() => true),
  isTargetPathWritable: vi.fn(),
  pathHasReservedOrHiddenSegment: vi.fn(),
  repoContentsApi: vi.fn(),
  repoCommitsApi: vi.fn(),
}));

import {
  clearWorkspaceFileResponseCache,
  COMMIT_LOOKUP_ENTRY_LIMIT,
  workspaceFileCommitsResponse,
} from "../routes/workspace/files.js";
import { repoContentsApi, repoCommitsApi } from "../routes/workspace/helpers.js";
import { getManifest } from "../lib/manifest.js";
import { logger } from "../middleware/logging.js";
import type { FileTarget } from "../lib/fileTarget.js";

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

beforeEach(() => {
  clearWorkspaceFileResponseCache();
  (repoContentsApi as Mock).mockReset();
  (repoCommitsApi as Mock).mockReset();
  (getManifest as Mock).mockReset();
  (logger.warn as Mock).mockReset();
});

describe("workspaceFileCommitsResponse", () => {
  it("returns the last commit per git entry, keyed by entry name", async () => {
    (repoContentsApi as Mock).mockResolvedValue([
      { name: "src", path: "src", type: "dir" },
      { name: "README.md", path: "README.md", type: "file", size: 10 },
    ]);
    (repoCommitsApi as Mock).mockImplementation(async (_t: FileTarget, path: string) => ({
      message: `commit for ${path}`,
      date: "2026-01-01T00:00:00Z",
      authorName: "dev",
      sha: `sha-${path}`,
    }));

    const res = await workspaceFileCommitsResponse(githubTarget, "");

    expect(res.commits).toEqual({
      src: { message: "commit for src", date: "2026-01-01T00:00:00Z", authorName: "dev", sha: "sha-src" },
      "README.md": { message: "commit for README.md", date: "2026-01-01T00:00:00Z", authorName: "dev", sha: "sha-README.md" },
    });
  });

  it("skips one entry (and logs) when its commit lookup fails, keeping the rest", async () => {
    (repoContentsApi as Mock).mockResolvedValue([
      { name: "a.txt", path: "a.txt", type: "file", size: 1 },
      { name: "b.txt", path: "b.txt", type: "file", size: 1 },
    ]);
    (repoCommitsApi as Mock).mockImplementation(async (_t: FileTarget, path: string) => {
      if (path === "a.txt") throw new Error("host 500");
      return { message: "ok", date: "2026-01-01T00:00:00Z", authorName: "dev", sha: "b" };
    });

    const res = await workspaceFileCommitsResponse(githubTarget, "");

    expect(res.commits).toEqual({
      "b.txt": { message: "ok", date: "2026-01-01T00:00:00Z", authorName: "dev", sha: "b" },
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("skips blob-only (GCS-uploaded) entries that have no git history", async () => {
    (repoContentsApi as Mock).mockResolvedValue([
      { name: "README.md", path: "README.md", type: "file", size: 10 },
    ]);
    (getManifest as Mock).mockResolvedValue({
      "logo.png": { type: "blob", gcsPath: "customers/alice/logo.png", mimeType: "image/png", size: 20, uploadedAt: "x" },
    });
    (repoCommitsApi as Mock).mockResolvedValue({ message: "m", date: "d", authorName: "a", sha: "s" });

    const res = await workspaceFileCommitsResponse(giteaTarget, "");

    expect(Object.keys(res.commits)).toEqual(["README.md"]);
    expect(repoCommitsApi).toHaveBeenCalledTimes(1);
    expect(repoCommitsApi).toHaveBeenCalledWith(giteaTarget, "README.md", undefined);
  });

  it("uses caller-provided entries without re-listing the directory", async () => {
    (repoCommitsApi as Mock).mockResolvedValue({ message: "m", date: "d", authorName: "a", sha: "s" });

    const res = await workspaceFileCommitsResponse(githubTarget, "", [
      { path: "src/index.ts", source: "git" },
      { path: "assets/logo.png", source: "blob" },
    ]);

    expect(repoContentsApi).not.toHaveBeenCalled();
    expect(repoCommitsApi).toHaveBeenCalledTimes(1);
    expect(repoCommitsApi).toHaveBeenCalledWith(githubTarget, "src/index.ts", undefined);
    expect(res.commits).toEqual({
      "src/index.ts": { message: "m", date: "d", authorName: "a", sha: "s" },
    });
  });

  it("caps caller-provided commit entries so one request cannot fan out unbounded", async () => {
    (repoCommitsApi as Mock).mockResolvedValue({ message: "m", date: "d", authorName: "a", sha: "s" });
    const entries = Array.from({ length: COMMIT_LOOKUP_ENTRY_LIMIT + 5 }, (_v, i) => ({
      path: `file-${i}.txt`,
      source: "git" as const,
    }));

    const res = await workspaceFileCommitsResponse(githubTarget, "", entries);

    expect(repoCommitsApi).toHaveBeenCalledTimes(COMMIT_LOOKUP_ENTRY_LIMIT);
    expect(res.truncated).toBe(true);
  });
});
