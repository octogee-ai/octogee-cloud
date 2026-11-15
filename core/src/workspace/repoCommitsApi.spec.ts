import { describe, expect, it, vi, beforeEach } from "vitest";

const giteaApiAsUser = vi.fn();
const githubCommitsApi = vi.fn();

vi.mock("../git-host/gitea-client", () => ({
  giteaApiAsUser: (...args: unknown[]) => giteaApiAsUser(...args),
}));
vi.mock("../git-host/github", () => ({
  githubCommitsApi: (...args: unknown[]) => githubCommitsApi(...args),
  githubContentsApi: vi.fn(),
}));

import { repoCommitsApi } from "./route-helpers.js";
import type { FileTarget } from "./fileTarget.js";

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

// Both hosts return a commit-list whose element shares this shape.
const rawCommit = {
  sha: "abc123",
  commit: {
    message: "Fix the thing\n\nlonger body ignored",
    author: { name: "Alice", date: "2026-06-30T12:00:00Z" },
  },
  author: { login: "alice-gh" },
};

beforeEach(() => {
  giteaApiAsUser.mockReset();
  githubCommitsApi.mockReset();
});

describe("repoCommitsApi — provider-neutral last commit", () => {
  it("gitea: filters commits by path (limit 1) and normalizes to first message line", async () => {
    giteaApiAsUser.mockResolvedValue([rawCommit]);

    const lc = await repoCommitsApi(giteaTarget, "src/index.ts");

    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-alice",
      "alice",
      "workspace/commits?path=src%2Findex.ts&limit=1&stat=false",
      "GET",
      undefined,
    );
    expect(lc).toEqual({
      message: "Fix the thing",
      date: "2026-06-30T12:00:00Z",
      authorName: "Alice",
      sha: "abc123",
    });
  });

  it("github: filters commits by path (per_page 1) and normalizes the same way", async () => {
    githubCommitsApi.mockResolvedValue([rawCommit]);

    const lc = await repoCommitsApi(githubTarget, "src/index.ts");

    expect(githubCommitsApi).toHaveBeenCalledWith("bob", "site", "src/index.ts", "tok", undefined);
    expect(lc).toEqual({
      message: "Fix the thing",
      date: "2026-06-30T12:00:00Z",
      authorName: "Alice",
      sha: "abc123",
    });
  });

  it("falls back to committer date + author login when author fields are absent", async () => {
    giteaApiAsUser.mockResolvedValue([
      { sha: "def456", commit: { message: "x", committer: { date: "2026-05-01T00:00:00Z" } }, author: { login: "ghost" } },
    ]);

    const lc = await repoCommitsApi(giteaTarget, "a.txt");

    expect(lc).toEqual({ message: "x", date: "2026-05-01T00:00:00Z", authorName: "ghost", sha: "def456" });
  });

  it("returns null for an empty history", async () => {
    giteaApiAsUser.mockResolvedValue([]);
    expect(await repoCommitsApi(giteaTarget, "new.txt")).toBeNull();
  });
});
