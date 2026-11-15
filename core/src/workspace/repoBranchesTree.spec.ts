import { describe, expect, it, vi, beforeEach } from "vitest";

const giteaApiAsUser = vi.fn();
const githubBranchesApi = vi.fn();
const githubRepoApi = vi.fn();
const githubTreeApi = vi.fn();
const githubContentsApi = vi.fn();
const githubCommitsApi = vi.fn();

vi.mock("../git-host/gitea-client", () => ({
  giteaApiAsUser: (...args: unknown[]) => giteaApiAsUser(...args),
}));
vi.mock("../git-host/github", () => ({
  githubBranchesApi: (...args: unknown[]) => githubBranchesApi(...args),
  githubRepoApi: (...args: unknown[]) => githubRepoApi(...args),
  githubTreeApi: (...args: unknown[]) => githubTreeApi(...args),
  githubContentsApi: (...args: unknown[]) => githubContentsApi(...args),
  githubCommitsApi: (...args: unknown[]) => githubCommitsApi(...args),
}));

import {
  repoBranchesApi,
  repoCommitsApi,
  repoContentsApi,
  repoTreeApi,
} from "./route-helpers.js";
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

beforeEach(() => {
  giteaApiAsUser.mockReset();
  githubBranchesApi.mockReset();
  githubRepoApi.mockReset();
  githubTreeApi.mockReset();
  githubContentsApi.mockReset();
  githubCommitsApi.mockReset();
});

describe("repoBranchesApi", () => {
  it("gitea: lists branches and marks the default", async () => {
    giteaApiAsUser.mockResolvedValueOnce({ default_branch: "main" }); // repo
    giteaApiAsUser.mockResolvedValueOnce([{ name: "main" }, { name: "dev" }]); // branches

    const res = await repoBranchesApi(giteaTarget);

    expect(res.default).toBe("main");
    expect(res.branches).toEqual([
      { name: "main", isDefault: true },
      { name: "dev", isDefault: false },
    ]);
  });

  it("github: uses the repo default_branch + branches list", async () => {
    githubRepoApi.mockResolvedValueOnce({ default_branch: "trunk" });
    githubBranchesApi.mockResolvedValueOnce([{ name: "trunk" }, { name: "feature/x" }]);

    const res = await repoBranchesApi(githubTarget);

    expect(res.default).toBe("trunk");
    expect(res.branches).toEqual([
      { name: "trunk", isDefault: true },
      { name: "feature/x", isDefault: false },
    ]);
  });
});

describe("repoTreeApi", () => {
  it("returns blob paths only, filters hidden/reserved, and reports truncation", async () => {
    githubTreeApi.mockResolvedValueOnce({
      truncated: true,
      tree: [
        { path: "src", type: "tree" },
        { path: "src/index.ts", type: "blob" },
        { path: "README.md", type: "blob" },
        { path: ".git/config", type: "blob" },
        { path: "node_modules/x.js", type: "blob" },
      ],
    });

    const res = await repoTreeApi(githubTarget, "main");

    expect(githubTreeApi).toHaveBeenCalledWith("bob", "site", "main", "tok");
    expect(res.truncated).toBe(true);
    expect(res.paths).toEqual(["src/index.ts", "README.md"]);
  });
});

describe("ref threading", () => {
  it("gitea contents appends ?ref", async () => {
    giteaApiAsUser.mockResolvedValue([]);
    await repoContentsApi(giteaTarget, "src", "dev");
    expect(giteaApiAsUser).toHaveBeenCalledWith("ws-alice", "alice", "workspace/contents/src?ref=dev", "GET", undefined);
  });

  it("gitea commits appends &sha", async () => {
    giteaApiAsUser.mockResolvedValue([]);
    await repoCommitsApi(giteaTarget, "src/a.ts", "dev");
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-alice",
      "alice",
      "workspace/commits?path=src%2Fa.ts&limit=1&stat=false&sha=dev",
      "GET",
      undefined,
    );
  });

  it("github contents + commits pass ref through", async () => {
    githubContentsApi.mockResolvedValue([]);
    githubCommitsApi.mockResolvedValue([]);
    await repoContentsApi(githubTarget, "src", "dev");
    await repoCommitsApi(githubTarget, "src/a.ts", "dev");
    expect(githubContentsApi).toHaveBeenCalledWith("bob", "site", "src", "tok", "dev");
    expect(githubCommitsApi).toHaveBeenCalledWith("bob", "site", "src/a.ts", "tok", "dev");
  });
});
