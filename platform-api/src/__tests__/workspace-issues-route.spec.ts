import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";

const h = vi.hoisted(() => ({
  target: null as FileTarget | null,
  listIssues: vi.fn(),
  listLabels: vi.fn(),
  createIssue: vi.fn(),
  moveIssue: vi.fn(),
  getIssueDetail: vi.fn(),
  updateIssue: vi.fn(),
  addComment: vi.fn(),
  listIssueAssets: vi.fn(),
  storeIssueAsset: vi.fn(),
  deleteIssueAsset: vi.fn(),
  parseMultipart: vi.fn(),
  assertIssueExists: vi.fn(),
}));

vi.mock("@octogee/core/workspace/fileTarget", () => ({
  withFileTarget:
    (handler: (...args: unknown[]) => unknown) =>
    (req: unknown, res: unknown, next: unknown) =>
      handler(req, res, next, h.target),
}));

vi.mock("../lib/issues.js", () => {
  class NotAnIssueError extends Error {
    constructor(num: number) {
      super(`#${num} is a pull request, not an issue`);
      this.name = "NotAnIssueError";
    }
  }
  class IssueNotFoundError extends Error {
    constructor(num: number) {
      super(`issue #${num} does not exist`);
      this.name = "IssueNotFoundError";
    }
  }

  return {
    listIssues: (...args: unknown[]) => h.listIssues(...args),
    listLabels: (...args: unknown[]) => h.listLabels(...args),
    createIssue: (...args: unknown[]) => h.createIssue(...args),
    moveIssue: (...args: unknown[]) => h.moveIssue(...args),
    getIssueDetail: (...args: unknown[]) => h.getIssueDetail(...args),
    updateIssue: (...args: unknown[]) => h.updateIssue(...args),
    addComment: (...args: unknown[]) => h.addComment(...args),
    assertIssueExists: (...args: unknown[]) => h.assertIssueExists(...args),
    NotAnIssueError,
    IssueNotFoundError,
  };
});

vi.mock("../lib/issue-assets.js", () => {
  class IssueAssetTooLargeError extends Error {
    constructor(readonly size: number) {
      super("attachment too large");
      this.name = "IssueAssetTooLargeError";
    }
  }
  return {
    MAX_ISSUE_ASSET_BYTES: 25 * 1024 * 1024,
    IssueAssetTooLargeError,
    listIssueAssets: (...args: unknown[]) => h.listIssueAssets(...args),
    storeIssueAsset: (...args: unknown[]) => h.storeIssueAsset(...args),
    deleteIssueAsset: (...args: unknown[]) => h.deleteIssueAsset(...args),
  };
});

vi.mock("../routes/workspace/upload.js", () => {
  class UploadTooLargeError extends Error {
    constructor(readonly maxBytes: number) {
      super(`File too large (max ${maxBytes} bytes)`);
      this.name = "UploadTooLargeError";
    }
  }
  return {
    parseMultipart: (...args: unknown[]) => h.parseMultipart(...args),
    UploadTooLargeError,
  };
});

const { default: issuesRouter } = await import("../routes/workspace/issues.js");
const { NotAnIssueError } = await import("../lib/issues.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/workspace", issuesRouter);
  return a;
}

function target(overrides: Partial<FileTarget> = {}): FileTarget {
  return {
    slug: "alice",
    projectSlug: "rocket",
    provider: "gitea",
    org: "octogee-alice",
    repoName: "rocket",
    gcsPrefix: "customers/alice/projects/rocket",
    sudoUser: "ws-alice",
    ...overrides,
  };
}

beforeEach(() => {
  h.target = target();
  h.listIssues.mockReset().mockResolvedValue([{ number: 1, title: "Ship", labels: [], state: "open" }]);
  h.listLabels.mockReset().mockResolvedValue([{ name: "status:todo", color: "c5def5" }]);
  h.createIssue.mockReset().mockResolvedValue({ number: 2, title: "New", labels: ["status:todo"], state: "open" });
  h.moveIssue.mockReset().mockResolvedValue({ number: 1, title: "Ship", labels: ["status:doing"], state: "open" });
  h.getIssueDetail.mockReset().mockResolvedValue({
    issue: { number: 1, title: "Ship", labels: [], state: "open" },
    comments: [{ id: 9, body: "On it", author: "chris", createdAt: "2026-08-01T00:00:00Z" }],
  });
  h.updateIssue.mockReset().mockResolvedValue({ number: 1, title: "Renamed", labels: ["bug"], state: "open" });
  h.addComment.mockReset().mockResolvedValue({ id: 10, body: "Done", author: "chris", createdAt: "2026-08-02T00:00:00Z" });
  h.listIssueAssets.mockReset().mockResolvedValue([]);
  h.storeIssueAsset.mockReset().mockResolvedValue({ id: "a", name: "shot.png", size: 3, contentType: "image/png", createdAt: "", url: "https://signed" });
  h.deleteIssueAsset.mockReset().mockResolvedValue(true);
  h.parseMultipart.mockReset().mockResolvedValue({
    slug: "",
    projectSlug: null,
    path: "",
    fileBuffer: Buffer.from("png"),
    filename: "shot.png",
    mimeType: "image/png",
  });
  h.assertIssueExists.mockReset().mockResolvedValue(undefined);
});

describe("workspace issues route", () => {
  it("requires project-scoped targets for Board issue reads", async () => {
    h.target = target({ projectSlug: null });

    const res = await request(app()).get("/api/workspace/issues").expect(403);

    expect(res.body).toEqual({ error: "The Board is project-scoped", code: "PROJECT_ONLY" });
    expect(h.listIssues).not.toHaveBeenCalled();
  });

  it("returns issues and labels for project targets", async () => {
    const res = await request(app()).get("/api/workspace/issues").expect(200);

    expect(h.listIssues).toHaveBeenCalledWith(h.target);
    expect(h.listLabels).toHaveBeenCalledWith(h.target);
    expect(res.body).toEqual({
      issues: [{ number: 1, title: "Ship", labels: [], state: "open" }],
      labels: [{ name: "status:todo", color: "c5def5" }],
    });
  });

  it("validates create issue input before calling the provider", async () => {
    await request(app()).post("/api/workspace/issues").send({ title: "" }).expect(400, {
      error: "Missing title",
    });
    await request(app()).post("/api/workspace/issues").send({ title: "x".repeat(251) }).expect(400, {
      error: "Title too long",
    });
    await request(app()).post("/api/workspace/issues").send({ title: "New", status: "blocked" }).expect(400, {
      error: "Invalid column",
    });

    expect(h.createIssue).not.toHaveBeenCalled();
  });

  it("creates issues with trimmed titles and default backlog status", async () => {
    const res = await request(app()).post("/api/workspace/issues").send({ title: "  New  ", body: "Body" }).expect(201);

    expect(h.createIssue).toHaveBeenCalledWith(h.target, {
      title: "New",
      body: "Body",
      status: "backlog",
    });
    expect(res.body).toEqual({ issue: { number: 2, title: "New", labels: ["status:todo"], state: "open" } });
  });

  it("passes a GitHub project member's caller-bound token to issue mutations", async () => {
    h.target = target({
      provider: "github",
      org: "octogee-ai",
      repoName: "rocket",
      githubToken: "gh-member-token",
      sudoUser: undefined,
      brokered: true,
    });

    await request(app()).post("/api/workspace/issues").send({ title: "Member issue" }).expect(201);

    expect(h.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "gh-member-token" }),
      expect.objectContaining({ title: "Member issue" }),
    );
  });

  it("validates move input before calling the provider", async () => {
    await request(app()).patch("/api/workspace/issues/0/move").send({ status: "doing" }).expect(400, {
      error: "Invalid issue number",
    });
    await request(app()).patch("/api/workspace/issues/1/move").send({ status: "blocked" }).expect(400, {
      error: "Invalid column",
    });

    expect(h.moveIssue).not.toHaveBeenCalled();
  });

  it("moves issues and maps pull-request numbers to not found", async () => {
    const moved = await request(app()).patch("/api/workspace/issues/1/move").send({ status: "doing" }).expect(200);
    expect(h.moveIssue).toHaveBeenCalledWith(h.target, 1, "doing");
    expect(moved.body).toEqual({ issue: { number: 1, title: "Ship", labels: ["status:doing"], state: "open" } });

    h.moveIssue.mockRejectedValueOnce(new NotAnIssueError(2));
    await request(app()).patch("/api/workspace/issues/2/move").send({ status: "done" }).expect(404, {
      error: "Issue not found",
    });
  });

  it("returns issue detail with comments and attachments", async () => {
    h.listIssueAssets.mockResolvedValueOnce([
      { id: "a", name: "shot.png", size: 3, contentType: "image/png", createdAt: "", url: "https://signed" },
    ]);

    const res = await request(app()).get("/api/workspace/issues/1").expect(200);

    expect(h.getIssueDetail).toHaveBeenCalledWith(h.target, 1);
    expect(h.listIssueAssets).toHaveBeenCalledWith(h.target, 1);
    expect(res.body.issue.number).toBe(1);
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.attachments).toEqual([
      { id: "a", name: "shot.png", size: 3, contentType: "image/png", createdAt: "", url: "https://signed" },
    ]);
  });

  it("maps pull-request numbers to not found on detail reads", async () => {
    h.getIssueDetail.mockRejectedValueOnce(new NotAnIssueError(3));
    await request(app()).get("/api/workspace/issues/3").expect(404, { error: "Issue not found" });
  });

  it("validates edit input before calling the provider", async () => {
    await request(app()).patch("/api/workspace/issues/1").send({}).expect(400, { error: "Nothing to update" });
    await request(app()).patch("/api/workspace/issues/1").send({ title: "  " }).expect(400, { error: "Missing title" });
    await request(app()).patch("/api/workspace/issues/1").send({ labels: ["status:doing"] }).expect(400, {
      error: "Invalid labels",
    });
    await request(app()).patch("/api/workspace/issues/1").send({ labels: "bug" }).expect(400, {
      error: "Invalid labels",
    });

    expect(h.updateIssue).not.toHaveBeenCalled();
  });

  it("edits title, body, and labels", async () => {
    const res = await request(app())
      .patch("/api/workspace/issues/1")
      .send({ title: " Renamed ", body: "New body", labels: [" bug ", ""] })
      .expect(200);

    expect(h.updateIssue).toHaveBeenCalledWith(h.target, 1, { title: "Renamed", body: "New body", labels: ["bug"] });
    expect(res.body).toEqual({ issue: { number: 1, title: "Renamed", labels: ["bug"], state: "open" } });
  });

  it("creates issues with validated labels", async () => {
    await request(app()).post("/api/workspace/issues").send({ title: "New", labels: ["bug"] }).expect(201);
    expect(h.createIssue).toHaveBeenCalledWith(h.target, { title: "New", body: "", status: "backlog", labels: ["bug"] });

    await request(app()).post("/api/workspace/issues").send({ title: "New", labels: ["status:x"] }).expect(400, {
      error: "Invalid labels",
    });
  });

  it("validates and adds comments", async () => {
    await request(app()).post("/api/workspace/issues/1/comments").send({ body: "  " }).expect(400, {
      error: "Missing comment body",
    });

    const res = await request(app()).post("/api/workspace/issues/1/comments").send({ body: "Done" }).expect(201);
    expect(h.addComment).toHaveBeenCalledWith(h.target, 1, "Done");
    expect(res.body.comment.id).toBe(10);
  });

  it("stores attachments and maps oversize uploads to 413", async () => {
    const res = await request(app()).post("/api/workspace/issues/1/attachments").expect(201);
    expect(h.storeIssueAsset).toHaveBeenCalledWith(h.target, 1, {
      name: "shot.png",
      content: Buffer.from("png"),
      contentType: "image/png",
    });
    expect(res.body.attachment.url).toBe("https://signed");

    const { IssueAssetTooLargeError } = await import("../lib/issue-assets.js");
    h.storeIssueAsset.mockRejectedValueOnce(new IssueAssetTooLargeError(999));
    await request(app()).post("/api/workspace/issues/1/attachments").expect(413);
  });

  it("deletes attachments and 404s when nothing was removed", async () => {
    await request(app()).delete("/api/workspace/issues/1/attachments/abc").expect(200, { removed: true });
    expect(h.deleteIssueAsset).toHaveBeenCalledWith(h.target, 1, "abc");

    h.deleteIssueAsset.mockResolvedValueOnce(false);
    await request(app()).delete("/api/workspace/issues/1/attachments/abc").expect(404, {
      error: "Attachment not found",
    });
  });

  it("guards attachment writes behind issue existence — PRs and missing numbers 404", async () => {
    const { NotAnIssueError: NotAnIssue, IssueNotFoundError: NotFound } = await import("../lib/issues.js");

    h.assertIssueExists.mockRejectedValueOnce(new NotAnIssue(5));
    await request(app()).post("/api/workspace/issues/5/attachments").expect(404, { error: "Issue not found" });
    expect(h.storeIssueAsset).not.toHaveBeenCalled();

    h.assertIssueExists.mockRejectedValueOnce(new NotFound(9));
    await request(app()).delete("/api/workspace/issues/9/attachments/a").expect(404, { error: "Issue not found" });
    expect(h.deleteIssueAsset).not.toHaveBeenCalled();
  });

  it("maps oversized multipart bodies to 413 during parsing", async () => {
    const { UploadTooLargeError: TooLarge } = await import("../routes/workspace/upload.js");
    h.parseMultipart.mockRejectedValueOnce(new TooLarge(25 * 1024 * 1024));

    await request(app()).post("/api/workspace/issues/1/attachments").expect(413);
    expect(h.storeIssueAsset).not.toHaveBeenCalled();
  });

  it("rejects non-string title/body/status/comment payloads instead of coercing", async () => {
    await request(app()).post("/api/workspace/issues").send({ title: { evil: 1 } }).expect(400, { error: "Invalid title" });
    await request(app()).post("/api/workspace/issues").send({ title: "x", body: [1] }).expect(400, { error: "Invalid body" });
    await request(app()).patch("/api/workspace/issues/1").send({ title: 7 }).expect(400, { error: "Invalid title" });
    await request(app()).post("/api/workspace/issues/1/comments").send({ body: {} }).expect(400, { error: "Invalid comment body" });
    await request(app()).patch("/api/workspace/issues/1/move").send({ status: {} }).expect(400, { error: "Invalid status" });

    expect(h.createIssue).not.toHaveBeenCalled();
    expect(h.updateIssue).not.toHaveBeenCalled();
    expect(h.addComment).not.toHaveBeenCalled();
    expect(h.moveIssue).not.toHaveBeenCalled();
  });

  it("maps provider 404s to not found on detail reads", async () => {
    const { IssueNotFoundError: NotFound } = await import("../lib/issues.js");
    h.getIssueDetail.mockRejectedValueOnce(new NotFound(99));

    await request(app()).get("/api/workspace/issues/99").expect(404, { error: "Issue not found" });
  });

  it("rejects workspace-scoped targets on every new endpoint", async () => {
    h.target = target({ projectSlug: null });
    await request(app()).get("/api/workspace/issues/1").expect(403);
    await request(app()).patch("/api/workspace/issues/1").send({ title: "x" }).expect(403);
    await request(app()).post("/api/workspace/issues/1/comments").send({ body: "x" }).expect(403);
    await request(app()).post("/api/workspace/issues/1/attachments").expect(403);
    await request(app()).delete("/api/workspace/issues/1/attachments/a").expect(403);
  });
});
