import { describe, expect, it } from "vitest";
import { createIssue, listIssues, listLabels, moveIssue, NotAnIssueError } from "../lib/issues.js";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import type { WorkspaceIssue } from "../lib/issues-normalize.js";

const RUN_LIVE = process.env.RUN_LIVE === "1";

function githubTarget(owner: string, repo: string): FileTarget {
  return {
    slug: "live",
    projectSlug: "live",
    provider: "github",
    org: owner,
    repoName: repo,
    gcsPrefix: "live",
    githubToken: process.env.GITHUB_TOKEN,
  };
}

function assertIssueShape(i: WorkspaceIssue): void {
  expect(typeof i.number).toBe("number");
  expect(typeof i.title).toBe("string");
  expect(["open", "closed"]).toContain(i.state);
  expect(Array.isArray(i.labels)).toBe(true);
  expect(Array.isArray(i.assignees)).toBe(true);
}

// Real GitHub, no mocks — octocat/Hello-World is a stable public repo. Proves the
// fetch + normalize pipeline against the live v3 shape the normalizer unit-tests pin.
describe.skipIf(!RUN_LIVE)("listIssues/listLabels — live against real GitHub", () => {
  it("returns normalized issues (PRs filtered) in the WorkspaceIssue shape", async () => {
    const issues = await listIssues(githubTarget("octocat", "Hello-World"));
    expect(Array.isArray(issues)).toBe(true);
    issues.slice(0, 5).forEach(assertIssueShape);
  }, 20_000);

  it("returns labels as {name,color}", async () => {
    const labels = await listLabels(githubTarget("octocat", "Hello-World"));
    expect(Array.isArray(labels)).toBe(true);
    for (const l of labels.slice(0, 5)) {
      expect(typeof l.name).toBe("string");
      expect(l.name.length).toBeGreaterThan(0);
      expect(typeof l.color).toBe("string");
    }
  }, 20_000);
});

// A PR shares the issue-number space; moveIssue must reject one before any write.
// octogee#1936 is a real pull request — needs a token that can read the private repo.
describe.skipIf(!RUN_LIVE || !process.env.GITHUB_TOKEN)("moveIssue rejects pull requests", () => {
  it("throws NotAnIssueError for a PR number without mutating it", async () => {
    await expect(moveIssue(githubTarget("octogee-ai", "octogee"), 1936, "todo")).rejects.toBeInstanceOf(
      NotAnIssueError,
    );
  }, 20_000);
});

// Real Gitea — runs only with a live Gitea target configured (GITEA_URL/GITEA_TOKEN
// from env via the gitea client, plus a repo to read). Proves the sudo path + the
// shared normalizer against the live Gitea shape.
const GITEA_REPO = process.env.GITEA_LIVE_REPO; // "owner/repo"
const GITEA_SUDO = process.env.GITEA_LIVE_SUDO; // impersonated user
describe.skipIf(!RUN_LIVE || !GITEA_REPO || !GITEA_SUDO)("listIssues — live against real Gitea", () => {
  it("returns normalized issues in the WorkspaceIssue shape", async () => {
    const [owner, repo] = GITEA_REPO!.split("/");
    const target = {
      slug: "live",
      projectSlug: "live",
      provider: "gitea",
      org: owner,
      repoName: repo,
      gcsPrefix: "live",
      sudoUser: GITEA_SUDO!,
    } as FileTarget;
    const issues = await listIssues(target);
    expect(Array.isArray(issues)).toBe(true);
    issues.slice(0, 5).forEach(assertIssueShape);
  }, 20_000);
});

// Mutates a repo, so it runs only against a dedicated scratch repo (BOARD_LIVE_REPO).
// Self-cleans by closing the card it creates (Done = closed); the caller deletes the
// scratch repo afterward. Proves seed-labels + create + relabel + close end-to-end.
const BOARD_REPO = process.env.BOARD_LIVE_REPO; // "owner/repo"
describe.skipIf(!RUN_LIVE || !BOARD_REPO || !process.env.GITHUB_TOKEN)(
  "createIssue/moveIssue — live write against real GitHub",
  () => {
    it("creates a card in a column, relabels across columns, and closes on done", async () => {
      const [owner, repo] = BOARD_REPO!.split("/");
      const target = githubTarget(owner, repo);

      const created = await createIssue(target, { title: `board-smoke ${owner}`, body: "smoke", status: "todo" });
      expect(created.number).toBeGreaterThan(0);
      expect(created.labels).toContain("status:todo");
      expect(created.state).toBe("open");

      const moved = await moveIssue(target, created.number, "review");
      expect(moved.labels).toContain("status:review");
      expect(moved.labels).not.toContain("status:todo");
      expect(moved.state).toBe("open");

      const backlog = await moveIssue(target, created.number, "backlog");
      expect(backlog.labels.filter((l) => l.startsWith("status:"))).toEqual([]);

      const done = await moveIssue(target, created.number, "done");
      expect(done.state).toBe("closed");
      expect(done.labels.filter((l) => l.startsWith("status:"))).toEqual([]);
    }, 40_000);
  },
);
