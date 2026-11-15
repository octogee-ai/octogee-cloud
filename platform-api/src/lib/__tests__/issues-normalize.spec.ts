import { describe, it, expect } from "vitest";
import {
  isPullRequest,
  normalizeComments,
  normalizeIssue,
  normalizeIssues,
  normalizeLabel,
} from "../issues-normalize.js";

// GitHub and Gitea both mirror the v3 issue shape; one normalizer serves both.
const githubIssue = {
  number: 42,
  title: "Onboard Mountain Mama",
  body: "Walk a user to first ship.",
  state: "open",
  labels: [{ id: 1, name: "status:todo", color: "d73a4a" }, { id: 2, name: "ux", color: "00ff00" }],
  user: { login: "dan" },
  assignees: [{ login: "chris" }, { login: "dan" }],
  created_at: "2026-06-01T00:00:00Z",
  closed_at: null,
  updated_at: "2026-06-02T00:00:00Z",
  html_url: "https://github.com/octogee-ai/octogee/issues/42",
};

const githubPull = { ...githubIssue, number: 43, pull_request: { url: "https://api.github.com/…/pulls/43" } };

const giteaIssue = {
  number: 7,
  title: "Pricing experiment",
  body: null,
  state: "closed",
  labels: [{ name: "status:doing", color: "#cccccc" }],
  user: { login: "chris" },
  assignees: null,
  created_at: "2026-05-01T00:00:00Z",
  closed_at: "2026-05-09T00:00:00Z",
  updated_at: "2026-05-09T00:00:00Z",
  html_url: "https://gitea.example/acme/acme-rocket/issues/7",
  pull_request: null,
};

describe("isPullRequest", () => {
  it("flags objects carrying a pull_request payload", () => {
    expect(isPullRequest(githubPull)).toBe(true);
    expect(isPullRequest(githubIssue)).toBe(false);
    expect(isPullRequest(giteaIssue)).toBe(false);
  });
});

describe("normalizeIssue", () => {
  it("normalizes a GitHub-shaped open issue", () => {
    expect(normalizeIssue(githubIssue)).toEqual({
      number: 42,
      title: "Onboard Mountain Mama",
      body: "Walk a user to first ship.",
      state: "open",
      labels: ["status:todo", "ux"],
      assignees: ["chris", "dan"],
      author: "dan",
      createdAt: "2026-06-01T00:00:00Z",
      closedAt: null,
      updatedAt: "2026-06-02T00:00:00Z",
      url: "https://github.com/octogee-ai/octogee/issues/42",
    });
  });

  it("normalizes a Gitea-shaped closed issue with null body/assignees", () => {
    const n = normalizeIssue(giteaIssue);
    expect(n.state).toBe("closed");
    expect(n.body).toBe("");
    expect(n.assignees).toEqual([]);
    expect(n.labels).toEqual(["status:doing"]);
    expect(n.closedAt).toBe("2026-05-09T00:00:00Z");
    expect(n.author).toBe("chris");
  });

  it("defaults missing optional fields rather than throwing", () => {
    const n = normalizeIssue({ number: 1, title: "Bare", state: "open" });
    expect(n).toMatchObject({ number: 1, title: "Bare", body: "", labels: [], assignees: [], author: "", closedAt: null });
  });
});

describe("normalizeIssues", () => {
  it("drops pull requests and normalizes the rest", () => {
    const out = normalizeIssues([githubIssue, githubPull, giteaIssue]);
    expect(out.map((i) => i.number)).toEqual([42, 7]);
  });
});

describe("normalizeLabel", () => {
  it("keeps name and color", () => {
    expect(normalizeLabel({ name: "status:review", color: "ededed" })).toEqual({
      name: "status:review",
      color: "ededed",
    });
  });
});

describe("normalizeComments", () => {
  it("normalizes provider comment shapes and drops malformed entries", () => {
    const out = normalizeComments([
      { id: 9, body: "Looks good", user: { login: "chris" }, created_at: "2026-08-01T00:00:00Z" },
      { body: "no id" },
      "junk",
    ]);
    expect(out).toEqual([{ id: 9, body: "Looks good", author: "chris", createdAt: "2026-08-01T00:00:00Z" }]);
  });

  it("returns empty for non-array payloads", () => {
    expect(normalizeComments(null)).toEqual([]);
  });
});
