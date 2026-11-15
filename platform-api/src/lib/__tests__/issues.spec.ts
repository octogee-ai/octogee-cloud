import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";

const h = vi.hoisted(() => ({
  gitea: vi.fn(),
  githubJson: vi.fn(),
}));

vi.mock("@octogee/core/git-host/gitea-client", () => ({
  giteaApiAsUser: (...args: unknown[]) => h.gitea(...args),
}));

vi.mock("@octogee/core/git-host/github", () => ({
  GITHUB_ISSUES_PER_PAGE: 100,
  githubIssuesApi: vi.fn(),
  githubLabelsApi: (..._args: unknown[]) => h.githubJson("GET", "/labels"),
  githubRepoUrl: (_owner: string, _repo: string, suffix: string) => suffix,
  githubJson: (...args: unknown[]) => h.githubJson(...args),
}));

const { createIssue, updateIssue, getIssueDetail, IssueNotFoundError } = await import("../issues.js");

function giteaTarget(): FileTarget {
  return {
    slug: "alice",
    projectSlug: "rocket",
    provider: "gitea",
    org: "alice",
    repoName: "rocket",
    gcsPrefix: "customers/alice/projects/rocket",
    sudoUser: "ws-alice",
  };
}

function githubTarget(): FileTarget {
  return { ...giteaTarget(), provider: "github", org: "chris", repoName: "side", githubToken: "tok" };
}

function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 7, title: "Ship", body: "", state: "open", labels: [], user: { login: "chris" }, ...overrides };
}

beforeEach(() => {
  h.gitea.mockReset();
  h.githubJson.mockReset();
});

describe("createIssue in the done column", () => {
  it("closes the freshly created issue instead of leaving an open backlog card", async () => {
    // done carries no status label, so the calls are: POST create → PATCH state → re-fetch
    h.gitea
      .mockResolvedValueOnce(rawIssue())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rawIssue({ state: "closed", closed_at: "2026-08-05T00:00:00Z" }));

    const issue = await createIssue(giteaTarget(), { title: "Ship", body: "", status: "done" });

    expect(issue.state).toBe("closed");
    const patchCall = h.gitea.mock.calls[1];
    expect(patchCall[3]).toBe("PATCH");
    expect(patchCall[4]).toEqual({ state: "closed" });
  });
});

describe("provider 404 mapping", () => {
  it("maps a Gitea 404 on detail reads to IssueNotFoundError", async () => {
    h.gitea.mockRejectedValue(new Error("Gitea API 404"));

    await expect(getIssueDetail(giteaTarget(), 99)).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  it("maps a GitHub 404 on updates to IssueNotFoundError", async () => {
    h.githubJson.mockRejectedValue(new Error("GitHub API 404"));

    await expect(updateIssue(githubTarget(), 99, { title: "x" })).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  it("re-throws non-404 provider failures untouched", async () => {
    h.gitea.mockRejectedValue(new Error("Gitea API 500"));

    await expect(getIssueDetail(giteaTarget(), 1)).rejects.toThrow("Gitea API 500");
  });
});

describe("label lookup is case-insensitive", () => {
  it("reuses an existing differently-cased GitHub label instead of creating a duplicate", async () => {
    // getIssue → labels load (existing "Bug") → PUT replacement → re-fetch
    h.githubJson
      .mockResolvedValueOnce(rawIssue({ labels: [{ name: "status:todo" }] })) // getIssue
      .mockResolvedValueOnce([{ id: 1, name: "Bug" }, { id: 2, name: "status:todo" }]) // loadRepoLabels
      .mockResolvedValueOnce(null) // PUT labels
      .mockResolvedValueOnce(rawIssue({ labels: [{ name: "status:todo" }, { name: "Bug" }] })); // re-fetch

    await updateIssue(githubTarget(), 7, { labels: ["bug"] });

    const posts = h.githubJson.mock.calls.filter(([method]) => method === "POST");
    expect(posts).toHaveLength(0); // no duplicate label create
    const put = h.githubJson.mock.calls.find(([method]) => method === "PUT");
    expect(put?.[3]).toEqual({ labels: ["status:todo", "bug"] });
  });
});
