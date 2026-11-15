import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readConnectorAccessToken: vi.fn(),
  githubListRepos: vi.fn(),
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.uid = "u-admin";
    next();
  },
}));

vi.mock("@octogee/core/connectors/connector-tokens", () => ({
  readConnectorAccessToken: h.readConnectorAccessToken,
}));

vi.mock("@octogee/core/git-host/github", () => ({
  githubListRepos: h.githubListRepos,
}));

const { default: githubReposRoutes } = await import("../routes/workspace/github-repos.js");

function app(): express.Express {
  const instance = express();
  instance.use("/workspace", githubReposRoutes);
  return instance;
}

describe("workspace github repos route", () => {
  beforeEach(() => {
    h.readConnectorAccessToken.mockReset().mockResolvedValue(null);
    h.githubListRepos.mockReset();
  });

  it("returns a typed connection error when the caller has no GitHub token", async () => {
    await request(app()).get("/workspace/github/repos").expect(422, {
      error: "GitHub not connected",
      reason: "github_not_connected",
    });

    expect(h.readConnectorAccessToken).toHaveBeenCalledWith("u-admin", "github");
    expect(h.githubListRepos).not.toHaveBeenCalled();
  });

  it("lists repos with the caller connector token", async () => {
    h.readConnectorAccessToken.mockResolvedValue("gho-token");
    h.githubListRepos.mockResolvedValue({
      repos: [{ owner: "octogee-ai", repo: "octogee" }],
      truncated: false,
    });

    await request(app()).get("/workspace/github/repos").expect(200, {
      repos: [{ owner: "octogee-ai", repo: "octogee" }],
      truncated: false,
    });

    expect(h.githubListRepos).toHaveBeenCalledWith("gho-token");
  });
});
