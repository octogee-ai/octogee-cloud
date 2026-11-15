import { describe, expect, it, vi } from "vitest";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import {
  createRepositoryActivityApi,
  type RepositoryActivityApi,
  type RepositoryActivityDependencies,
} from "../repository-activity.js";

const range = { since: "2026-06-19", until: "2026-06-26" };

function target(provider: FileTarget["provider"]): FileTarget {
  return {
    slug: "acme",
    projectSlug: "rocket",
    provider,
    org: "acme",
    repoName: "acme-rocket",
    gcsPrefix: "customers/acme/projects/rocket",
    ...(provider === "github" ? { githubToken: "gh-token" } : { sudoUser: "ws-acme" }),
  };
}

const mergedPr = {
  number: 12,
  title: "feat: launch",
  createdAt: "2026-06-20T09:00:00Z",
  mergedAt: "2026-06-24T10:00:00Z",
  url: "https://git.example/acme/acme-rocket/pulls/12",
  additions: 0,
  deletions: 0,
};

const commit = {
  subject: "feat: launch",
  committedAt: "2026-06-24T10:00:00Z",
  url: "https://git.example/acme/acme-rocket/commit/abc",
};

const createdIssue = {
  number: 21,
  title: "Document launch",
  body: "",
  state: "open",
  labels: ["docs"],
  assignees: [],
  author: "builder",
  createdAt: "2026-06-21T08:00:00Z",
  closedAt: null,
  updatedAt: "2026-06-27T08:00:00Z",
  url: "https://git.example/acme/acme-rocket/issues/21",
};

const closedBug = {
  number: 22,
  title: "Fix launch",
  body: "",
  state: "closed",
  labels: ["bug"],
  assignees: [],
  author: "builder",
  createdAt: "2026-06-01T08:00:00Z",
  closedAt: "2026-06-23T08:00:00Z",
  updatedAt: "2026-06-23T08:00:00Z",
  url: "https://git.example/acme/acme-rocket/issues/22",
};

const openPr = {
  number: 13,
  title: "fix: follow-up",
  createdAt: "2026-06-10T09:00:00Z",
  mergedAt: null,
  url: "https://git.example/acme/acme-rocket/pulls/13",
  additions: 0,
  deletions: 0,
};

const openBug = {
  number: 23,
  title: "Launch regression",
  body: "",
  state: "open",
  labels: ["bug"],
  assignees: [],
  author: "builder",
  createdAt: "2026-06-25T08:00:00Z",
  closedAt: null,
  updatedAt: "2026-06-25T08:00:00Z",
  url: "https://git.example/acme/acme-rocket/issues/23",
};

function rawIssue(issue: typeof createdIssue | typeof closedBug | typeof openBug) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees,
    user: { login: issue.author },
    created_at: issue.createdAt,
    closed_at: issue.closedAt,
    updated_at: issue.updatedAt,
    html_url: issue.url,
  };
}

interface Harness {
  api: RepositoryActivityApi;
  githubJson: ReturnType<typeof vi.fn>;
  giteaApiAsUser: ReturnType<typeof vi.fn>;
}

function githubHarness(): Harness {
  const githubJson = vi.fn(async (_method: string, rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:pr is:merged")) {
        return {
          items: [
            {
              number: mergedPr.number,
              title: mergedPr.title,
              created_at: mergedPr.createdAt,
              closed_at: mergedPr.mergedAt,
              html_url: mergedPr.url,
            },
            {
              number: 11,
              title: "fix: previous boundary",
              created_at: "2026-06-10T09:00:00Z",
              closed_at: "2026-06-18T23:59:59Z",
              html_url: "https://git.example/acme/acme-rocket/pulls/11",
            },
            {
              number: 14,
              title: "fix: next boundary",
              created_at: "2026-06-25T09:00:00Z",
              closed_at: "2026-06-26T00:00:00Z",
              html_url: "https://git.example/acme/acme-rocket/pulls/14",
            },
          ],
        };
      }
    }
    if (url.pathname.endsWith("/commits")) {
      return [
        {
          html_url: commit.url,
          commit: {
            message: `${commit.subject}\n\nbody`,
            committer: { date: commit.committedAt },
          },
        },
      ];
    }
    if (url.pathname.endsWith("/pulls")) {
      return [
        {
          number: openPr.number,
          title: openPr.title,
          created_at: openPr.createdAt,
          merged_at: null,
          html_url: openPr.url,
        },
      ];
    }
    if (url.pathname.endsWith("/issues") && url.searchParams.get("state") === "open") {
      return [rawIssue(openBug)];
    }
    if (url.pathname.endsWith("/issues")) {
      return [
        rawIssue(createdIssue),
        rawIssue(closedBug),
        {
          ...rawIssue(createdIssue),
          number: 99,
          pull_request: { url: "https://api.github.com/repos/acme/acme-rocket/pulls/99" },
        },
      ];
    }
    throw new Error(`Unexpected GitHub request: ${rawUrl}`);
  });
  const giteaApiAsUser = vi.fn();
  const deps = { githubJson, giteaApiAsUser } as RepositoryActivityDependencies;
  return {
    api: createRepositoryActivityApi(target("github"), deps),
    githubJson,
    giteaApiAsUser,
  };
}

function giteaHarness(): Harness {
  const githubJson = vi.fn();
  const giteaApiAsUser = vi.fn(async (_sudo: string, _org: string, rawPath: string) => {
    const url = new URL(`https://gitea.example/${rawPath}`);
    if (url.pathname.endsWith("/commits")) {
      return [
        {
          html_url: commit.url,
          created: commit.committedAt,
          commit: { message: `${commit.subject}\n\nbody` },
        },
      ];
    }
    if (url.pathname.endsWith("/issues") && url.searchParams.get("type") === "pulls") {
      if (url.searchParams.get("state") === "open") {
        return [
          {
            number: openPr.number,
            title: openPr.title,
            created_at: openPr.createdAt,
            html_url: openPr.url,
            pull_request: { merged: false, merged_at: null },
          },
        ];
      }
      return [
        {
          number: mergedPr.number,
          title: mergedPr.title,
          created_at: mergedPr.createdAt,
          html_url: mergedPr.url,
          pull_request: { merged: true, merged_at: mergedPr.mergedAt },
        },
        {
          number: 11,
          title: "fix: previous boundary",
          created_at: "2026-06-10T09:00:00Z",
          html_url: "https://git.example/acme/acme-rocket/pulls/11",
          pull_request: { merged: true, merged_at: "2026-06-18T23:59:59Z" },
        },
        {
          number: 14,
          title: "fix: next boundary",
          created_at: "2026-06-25T09:00:00Z",
          html_url: "https://git.example/acme/acme-rocket/pulls/14",
          pull_request: { merged: true, merged_at: "2026-06-26T00:00:00Z" },
        },
        {
          number: 15,
          title: "closed without merge",
          created_at: "2026-06-25T09:00:00Z",
          html_url: "https://git.example/acme/acme-rocket/pulls/15",
          pull_request: { merged: false, merged_at: null },
        },
      ];
    }
    if (url.pathname.endsWith("/issues") && url.searchParams.get("state") === "open") {
      return [rawIssue(openBug)];
    }
    if (url.pathname.endsWith("/issues")) {
      return [rawIssue(createdIssue), rawIssue(closedBug)];
    }
    throw new Error(`Unexpected Gitea request: ${rawPath}`);
  });
  const deps = { githubJson, giteaApiAsUser } as RepositoryActivityDependencies;
  return {
    api: createRepositoryActivityApi(target("gitea"), deps),
    githubJson,
    giteaApiAsUser,
  };
}

function bindContract(name: string, createHarness: () => Harness): void {
  describe(`${name} repository activity contract`, () => {
    it("normalizes the same repository lifecycle resources", async () => {
      const { api } = createHarness();

      await expect(api.mergedPullRequests(range)).resolves.toEqual([mergedPr]);
      await expect(api.commits(range)).resolves.toEqual([commit]);
      await expect(api.issues(range)).resolves.toEqual([createdIssue, closedBug]);
      await expect(api.openPullRequests()).resolves.toEqual([openPr]);
      await expect(api.openIssues(["bug"])).resolves.toEqual([openBug]);
    });
  });
}

bindContract("GitHub", githubHarness);
bindContract("Gitea", giteaHarness);

describe("repository activity provider binding", () => {
  it("uses the GitHub project token and GitHub resource URLs", async () => {
    const { api, githubJson, giteaApiAsUser } = githubHarness();

    await api.mergedPullRequests(range);
    await api.commits(range);
    await api.issues(range);
    await api.openPullRequests();
    await api.openIssues(["bug"]);

    expect(giteaApiAsUser).not.toHaveBeenCalled();
    expect(githubJson).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("https://api.github.com/search/issues?"),
      "gh-token",
    );
    expect(githubJson).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/repos/acme/acme-rocket/commits?"),
      "gh-token",
    );
  });

  it("uses the Gitea Sudo identity and repository-scoped API paths", async () => {
    const { api, githubJson, giteaApiAsUser } = giteaHarness();

    await api.mergedPullRequests(range);
    await api.commits(range);
    await api.issues(range);
    await api.openPullRequests();
    await api.openIssues(["bug"]);

    expect(githubJson).not.toHaveBeenCalled();
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-acme",
      "acme",
      expect.stringContaining("acme-rocket/commits?"),
    );
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-acme",
      "acme",
      expect.stringContaining("acme-rocket/issues?state=closed&type=pulls"),
    );
  });

  it("fails loudly when a provider breaks the collection response contract", async () => {
    const github = githubHarness();
    github.githubJson.mockResolvedValueOnce({});
    await expect(github.api.mergedPullRequests(range)).rejects.toThrow(
      "Invalid acme/acme-rocket merged pull requests response: expected an array",
    );

    const gitea = giteaHarness();
    gitea.giteaApiAsUser.mockResolvedValueOnce({});
    await expect(gitea.api.commits(range)).rejects.toThrow(
      "Invalid acme/acme-rocket commits response: expected an array",
    );
  });
});
