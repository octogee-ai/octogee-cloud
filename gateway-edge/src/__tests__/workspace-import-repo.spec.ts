import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform-state", () => ({ platformStateStore: {} }));
vi.mock("../lib/gcs-bucket", () => ({ gcsBucket: vi.fn() }));

vi.mock("../lib/gitea", () => ({
  giteaApiAsUser: vi.fn(),
}));

const storeWorkspaceBlob = vi.fn();
vi.mock("../lib/project-blob-edit.js", () => ({
  storeUploadedWorkspaceBlob: (...args: unknown[]) => storeWorkspaceBlob(...args),
  WorkspaceStorageQuotaError: class WorkspaceStorageQuotaError extends Error {},
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import importRepoRouter, {
  importableGitHubBlob,
  parseGitHubRepoUrl,
  validatedImportTargetDir,
} from "../routes/workspace/import-repo.js";
import { gcsBucket } from "../lib/gcs-bucket.js";
import { giteaApiAsUser } from "../lib/gitea.js";
import { logger } from "../middleware/logging.js";

const mockFetch = vi.fn();
const mockBlobSave = vi.fn();
const mockBucketFile = vi.fn(() => ({ save: mockBlobSave }));

function app() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use((req, _res, next) => {
    req.workspaceSlug = "alice";
    next();
  });
  testApp.use(importRepoRouter);
  return testApp;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  vi.mocked(gcsBucket).mockReturnValue({
    file: mockBucketFile,
  } as unknown as ReturnType<typeof gcsBucket>);
  storeWorkspaceBlob.mockResolvedValue({
    gcsPath: "customers/alice/imports/demo/assets/logo.png",
    size: 3,
  });
});

describe("workspace import-repo helpers", () => {
  it("parses and validates GitHub repo URLs using existing owner/repo rules", () => {
    expect(parseGitHubRepoUrl("https://github.com/octogee-ai/demo")).toEqual({
      owner: "octogee-ai",
      repo: "demo",
    });
    expect(parseGitHubRepoUrl("https://example.com/octogee-ai/demo")).toBeNull();
    expect(parseGitHubRepoUrl("https://github.com/bad_owner/demo")).toBeNull();
  });

  it("validates explicit and default target directories", () => {
    expect(validatedImportTargetDir("demo")).toEqual({ ok: true, targetDir: "builds/demo/src" });
    expect(validatedImportTargetDir("demo", "imports/demo")).toEqual({ ok: true, targetDir: "imports/demo" });
    expect(validatedImportTargetDir("demo", "../outside")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid targetDir"),
    });
  });

  it("filters unsupported GitHub tree entries before fetching blob content", () => {
    expect(importableGitHubBlob({
      path: "src/index.ts",
      type: "blob",
      sha: "a".repeat(40),
      size: 12,
    })).toBe(true);
    expect(importableGitHubBlob({ path: "src", type: "tree", sha: "a".repeat(40) })).toBe(false);
    expect(importableGitHubBlob({
      path: "node_modules/pkg/index.js",
      type: "blob",
      sha: "a".repeat(40),
    })).toBe(false);
    expect(importableGitHubBlob({ path: "bad.txt", type: "blob", sha: "not-a-sha" })).toBe(false);
  });
});

describe("POST /import-repo", () => {
  it("imports text to Gitea, blobs to storage, and writes manifest entries", async () => {
    const textSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return jsonResponse({
          tree: [
            { path: "README.md", type: "blob", sha: textSha, size: 7 },
            { path: "assets/logo.png", type: "blob", sha: blobSha, size: 3 },
            { path: "node_modules/pkg/index.js", type: "blob", sha: "c".repeat(40), size: 4 },
          ],
        });
      }

      if (url.endsWith(`/git/blobs/${textSha}`)) {
        return jsonResponse({ content: Buffer.from("# Demo\n").toString("base64") });
      }

      if (url.endsWith(`/git/blobs/${blobSha}`)) {
        return jsonResponse({ content: Buffer.from([1, 2, 3]).toString("base64") });
      }

      return jsonResponse({}, 404);
    });
    vi.mocked(giteaApiAsUser).mockImplementation(async (_sudoUser, _org, path, method) => {
      if (method === "PUT") return {};
      if (path === "workspace/contents/imports/demo/README.md") return { sha: "existing-readme-sha" };
      throw new Error("Gitea API 404");
    });

    const res = await request(app())
      .post("/import-repo")
      .send({
        slug: "alice",
        repoUrl: "https://github.com/octogee-ai/demo",
        targetDir: "imports/demo",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, targetDir: "imports/demo", fileCount: 2 });
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-alice",
      "alice",
      "workspace/contents/imports/demo/README.md",
      "PUT",
      {
        message: "import: README.md from octogee-ai/demo",
        content: Buffer.from("# Demo\n").toString("base64"),
        sha: "existing-readme-sha",
      },
    );
    expect(storeWorkspaceBlob).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "alice", projectSlug: null, repoName: "workspace" }),
      "imports/demo/assets/logo.png",
      Buffer.from([1, 2, 3]),
      "image/png",
    );
  });

  it("logs non-404 existing text lookup failures and imports without an overwrite sha", async () => {
    const textSha = "a".repeat(40);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return jsonResponse({ tree: [{ path: "README.md", type: "blob", sha: textSha, size: 7 }] });
      }

      if (url.endsWith(`/git/blobs/${textSha}`)) {
        return jsonResponse({ content: Buffer.from("# Demo\n").toString("base64") });
      }

      return jsonResponse({}, 404);
    });
    vi.mocked(giteaApiAsUser).mockImplementation(async (_sudoUser, _org, _path, method) => {
      if (method === "PUT") return {};
      throw new Error("Gitea API 500");
    });

    const res = await request(app())
      .post("/import-repo")
      .send({
        slug: "alice",
        repoUrl: "https://github.com/octogee-ai/demo",
        targetDir: "imports/demo",
      });

    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to read existing imported repo entry SHA for imports/demo/README.md: Gitea API 500",
    );
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-alice",
      "alice",
      "workspace/contents/imports/demo/README.md",
      "PUT",
      {
        message: "import: README.md from octogee-ai/demo",
        content: Buffer.from("# Demo\n").toString("base64"),
      },
    );
  });

  it("imports empty text blobs instead of treating them as fetch failures", async () => {
    const textSha = "a".repeat(40);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return jsonResponse({ tree: [{ path: "empty.txt", type: "blob", sha: textSha, size: 0 }] });
      }

      if (url.endsWith(`/git/blobs/${textSha}`)) {
        return jsonResponse({ content: "" });
      }

      return jsonResponse({}, 404);
    });
    vi.mocked(giteaApiAsUser).mockImplementation(async (_sudoUser, _org, _path, method) => {
      if (method === "PUT") return {};
      throw new Error("Gitea API 404");
    });

    const res = await request(app())
      .post("/import-repo")
      .send({
        slug: "alice",
        repoUrl: "https://github.com/octogee-ai/demo",
        targetDir: "imports/demo",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, targetDir: "imports/demo", fileCount: 1 });
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-alice",
      "alice",
      "workspace/contents/imports/demo/empty.txt",
      "PUT",
      {
        message: "import: empty.txt from octogee-ai/demo",
        content: "",
      },
    );
  });
});
