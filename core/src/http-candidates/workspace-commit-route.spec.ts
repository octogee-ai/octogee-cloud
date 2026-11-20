import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  return {
    resolveUserDir: vi.fn(),
    resolveProjectDir: vi.fn(),
    commitAndPushWorkspace: vi.fn(),
    isSafeSlug: vi.fn(),
    isTrustedGithubUserCheckout: vi.fn(),
    isGithubProjectCheckpoint: vi.fn(),
    resolveCommitAuthor: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    verifyWorkspaceCommitProofViaBroker: vi.fn(),
    divertWorktreeBinaries: vi.fn(),
  };
});

vi.mock("../workspace/workspace-git.js", () => ({
  resolveUserDir: h.resolveUserDir,
  resolveProjectDir: h.resolveProjectDir,
  commitAndPushWorkspace: h.commitAndPushWorkspace,
  isSafeSlug: h.isSafeSlug,
  isTrustedGithubUserCheckout: h.isTrustedGithubUserCheckout,
  isGithubProjectCheckpoint: h.isGithubProjectCheckpoint,
}));

vi.mock("../workspace/route-helpers.js", () => ({
  resolveCommitAuthor: h.resolveCommitAuthor,
}));

vi.mock("../http/logging.js", () => ({
  logger: { warn: h.warn, error: h.error, info: h.info },
}));

vi.mock("../internal-brokers/workspace-commit-proof-broker.js", () => ({
  verifyWorkspaceCommitProofViaBroker: h.verifyWorkspaceCommitProofViaBroker,
}));

vi.mock("../workspace/binary-diversion.js", () => ({
  divertWorktreeBinaries: h.divertWorktreeBinaries,
}));

import workspaceCommitRouter from "./workspace-commit-router.js";

const originalUsersDir = process.env.CUSTOMERS_DIR;

function app() {
  const server = express();
  server.use(express.json());
  server.use("/internal/workspace", workspaceCommitRouter);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isSafeSlug.mockImplementation((slug: string) => /^[a-z0-9-]+$/.test(slug));
  h.resolveUserDir.mockResolvedValue("/customers/acme");
  h.isTrustedGithubUserCheckout.mockReturnValue(false);
  h.isGithubProjectCheckpoint.mockReturnValue(false);
  h.resolveCommitAuthor.mockReturnValue({ name: "Octogee Agent", email: "agent@octogee.test" });
  h.commitAndPushWorkspace.mockImplementation(async (_dir, options) => {
    const prepared = await options.beforeCommit?.();
    if (prepared && !prepared.ok) return prepared;
    return { ok: true, result: { committed: true, pushed: true, nothingToCommit: false } };
  });
  h.verifyWorkspaceCommitProofViaBroker.mockResolvedValue(true);
  h.divertWorktreeBinaries.mockResolvedValue({ diverted: [], failures: [], failedPaths: [] });
});

afterEach(() => {
  if (originalUsersDir === undefined) {
    delete process.env.CUSTOMERS_DIR;
  } else {
    process.env.CUSTOMERS_DIR = originalUsersDir;
  }
});

describe("internal workspace commit route", () => {
  it("rejects invalid slugs and oversized commit messages before touching the workspace", async () => {
    await request(app()).post("/internal/workspace/commit").send({ agentId: "octogee-acme-coach", slug: "not valid" }).expect(400, {
      error: "Invalid slug",
      code: "BAD_SLUG",
    });
    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme", message: "x".repeat(5_001) })
      .expect(400, {
        error: "Commit message too long",
        code: "MESSAGE_TOO_LONG",
      });

    expect(h.resolveUserDir).not.toHaveBeenCalled();
    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid agent proof before touching the workspace", async () => {
    await request(app()).post("/internal/workspace/commit").send({ slug: "acme" }).expect(400, {
      error: "Invalid agent identity",
      code: "BAD_AGENT",
    });

    h.verifyWorkspaceCommitProofViaBroker.mockResolvedValue(false);
    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme" })
      .expect(403, { error: "Agent identity proof rejected.", code: "PROOF_REJECTED" });

    expect(h.resolveUserDir).not.toHaveBeenCalled();
    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed and reports a retryable error when proof lookup is unavailable", async () => {
    h.verifyWorkspaceCommitProofViaBroker.mockRejectedValue(new Error("proof broker unavailable"));
    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme" })
      .expect(503, {
        error: "Agent identity verification temporarily unavailable.",
        code: "PROOF_UNAVAILABLE",
      });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("identity proof lookup failed slug=acme"));
    expect(h.resolveUserDir).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when the user working tree is unavailable", async () => {
    h.resolveUserDir.mockResolvedValue(null);

    await request(app()).post("/internal/workspace/commit").send({ agentId: "octogee-acme-coach", slug: "acme" }).expect(503, {
      error: "Working tree temporarily unavailable; retry shortly.",
      code: "CUSTOMER_DIR_MISSING",
    });

    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("working tree not accessible slug=acme"));
    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("commits with a trimmed message and resolved agent author", async () => {
    const res = await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme", message: "  checkpoint work  " })
      .expect(200);

    expect(h.resolveUserDir).toHaveBeenCalledWith("/home/node/.openclaw/customers", "acme");
    expect(h.resolveCommitAuthor).toHaveBeenCalledWith(undefined, "acme");
    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith("/customers/acme", expect.objectContaining({
      message: "checkpoint work",
      author: { name: "Octogee Agent", email: "agent@octogee.test" },
      beforeCommit: expect.any(Function),
    }));
    expect(res.body).toEqual({ committed: true, pushed: true, nothingToCommit: false, divertedBlobs: 0 });
    expect(h.info).toHaveBeenCalledWith(expect.stringContaining("internal/workspace/commit slug=acme"));
  });

  it("uses the default commit message and custom user root when no message is provided", async () => {
    process.env.CUSTOMERS_DIR = "/custom/customers";

    await request(app()).post("/internal/workspace/commit").send({ agentId: "octogee-acme-coach", slug: "acme" }).expect(200);

    expect(h.resolveUserDir).toHaveBeenCalledWith("/custom/customers", "acme");
    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith("/customers/acme", expect.objectContaining({
      message: "agent: workspace commit",
    }));

    delete process.env.CUSTOMERS_DIR;
  });

  it("returns git command failures and makes push-only failures explicit", async () => {
    h.commitAndPushWorkspace.mockResolvedValueOnce({ ok: false, error: { code: "COMMIT_FAILED" } });

    await request(app()).post("/internal/workspace/commit").send({ agentId: "octogee-acme-coach", slug: "acme" }).expect(500, {
      error: "git command failed",
      code: "COMMIT_FAILED",
    });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("git error slug=acme code=COMMIT_FAILED"));

    h.commitAndPushWorkspace.mockResolvedValueOnce({
      ok: true,
      result: { committed: true, pushed: false, nothingToCommit: false, pushError: "rejected" },
    });
    await request(app()).post("/internal/workspace/commit").send({ agentId: "octogee-acme-coach", slug: "acme" }).expect(502, {
      error: "Commit was created locally, but the remote rejected the push. Do not build or publish until a later commit succeeds.",
      code: "PUSH_FAILED",
      committed: true,
      pushed: false,
      nothingToCommit: false,
    });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("committed but push failed slug=acme: rejected"));
  });

  it("logs the underlying git stderr alongside the code", async () => {
    h.commitAndPushWorkspace.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "GIT_FAILED",
        cwd: "/customers/acme",
        status: 1,
        stderr: "The following paths are ignored by one of your .gitignore files:\nprojects",
      },
    });

    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme" })
      .expect(500, { error: "git command failed", code: "GIT_FAILED" });

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("status=1 stderr=The following paths are ignored"),
    );
  });

  it("returns a retryable conflict while an import holds the workspace lease", async () => {
    h.commitAndPushWorkspace.mockResolvedValueOnce({
      ok: false,
      error: { code: "WORKSPACE_BUSY", cwd: "/customers/acme" },
    });

    const response = await request(app()).post("/internal/workspace/commit").send({ agentId: "octogee-acme-coach", slug: "acme" }).expect(409, {
      error: "Workspace is busy; retry shortly.",
      code: "WORKSPACE_BUSY",
    });

    expect(response.body.code).toBe("WORKSPACE_BUSY");
  });
});

describe("internal workspace commit route — multi-agent project lane", () => {
  it("commits the project clone when a project is given", async () => {
    h.resolveProjectDir.mockResolvedValue("/customers/acme/projects/orbit");

    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit", message: "checkpoint" })
      .expect(200);

    expect(h.resolveProjectDir).toHaveBeenCalledWith(process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", "acme", "orbit");
    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith(
      "/customers/acme/projects/orbit",
      expect.objectContaining({ message: "checkpoint" }),
    );
  });

  it("checkpoints GitHub-backed projects without diverting files into a generated manifest", async () => {
    h.resolveProjectDir.mockResolvedValue("/customers/acme/projects/orbit");
    h.isGithubProjectCheckpoint.mockReturnValue(true);

    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit", message: "checkpoint" })
      .expect(200);

    expect(h.commitAndPushWorkspace).toHaveBeenCalledWith(
      "/customers/acme/projects/orbit",
      expect.objectContaining({ message: "checkpoint" }),
    );
    expect(h.divertWorktreeBinaries).not.toHaveBeenCalled();
  });

  it("rejects malformed project ids before touching the tree", async () => {
    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme", project: "Not-Valid!" })
      .expect(400, { error: "Invalid project", code: "BAD_PROJECT" });

    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });

  it("503s when the project clone is missing, without committing the workspace instead", async () => {
    h.resolveProjectDir.mockResolvedValue(null);

    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit" })
      .expect(503);

    expect(h.commitAndPushWorkspace).not.toHaveBeenCalled();
  });
});

describe("binary diversion on the commit path", () => {
  it("rehomes binaries before the commit, against the workspace's own blob prefix", async () => {
    h.divertWorktreeBinaries.mockResolvedValue({
      diverted: [{ path: "notes/diagram.png", size: 12 }],
      failures: [],
      failedPaths: [],
    });

    const res = await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme" })
      .expect(200);

    expect(h.divertWorktreeBinaries).toHaveBeenCalledWith("/customers/acme", {
      slug: "acme",
      projectSlug: null,
      gcsPrefix: "customers/acme",
    }, undefined, { excludePaths: [".system/project-coaches"] });
    expect(res.body.divertedBlobs).toBe(1);
  });

  it("uses the project's blob prefix on the project lane", async () => {
    h.resolveProjectDir.mockResolvedValue("/customers/acme/projects/orbit");
    h.divertWorktreeBinaries.mockResolvedValue({ diverted: [{ path: "asset.png", size: 12 }], failures: [], failedPaths: [] });

    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit" })
      .expect(200);

    expect(h.divertWorktreeBinaries).toHaveBeenCalledWith("/customers/acme/projects/orbit", {
      slug: "acme",
      projectSlug: "orbit",
      gcsPrefix: "customers/acme/projects/orbit",
    }, undefined, { retainLocalFiles: true });
    const options = h.commitAndPushWorkspace.mock.calls.at(-1)![1];
    expect(await options.beforeCommit()).toEqual({ ok: true, excludePaths: ["asset.png"] });
  });

  it("aborts without committing when a binary cannot be rehomed", async () => {
    h.divertWorktreeBinaries.mockResolvedValue({
      diverted: [],
      failures: ["big.zip: 200000000 bytes exceeds the blob limit"],
      failedPaths: ["big.zip"],
    });

    await request(app())
      .post("/internal/workspace/commit")
      .send({ agentId: "octogee-acme-coach", slug: "acme" })
      .expect(503, {
        error: "Binary files could not be stored; no commit was created.",
        code: "BLOB_DIVERSION_FAILED",
        paths: ["big.zip"],
      });

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("blob diversion incomplete slug=acme"),
    );
    expect(h.commitAndPushWorkspace).toHaveBeenCalledOnce();
  });
});
