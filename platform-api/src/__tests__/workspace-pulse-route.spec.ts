import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";

const h = vi.hoisted(() => ({
  target: null as FileTarget | null,
  fetchPulseReport: vi.fn(),
}));

vi.mock("@octogee/core/workspace/fileTarget", () => ({
  withFileTarget:
    (handler: (...args: unknown[]) => unknown) =>
    (req: unknown, res: unknown, next: unknown) =>
      handler(req, res, next, h.target),
}));

vi.mock("../lib/pulse-ingest.js", () => ({
  fetchPulseReport: (...args: unknown[]) => h.fetchPulseReport(...args),
}));

const { default: workspacePulseRoutes } = await import("../routes/workspace/pulse.js");

function app() {
  const a = express();
  a.use("/api/workspace", workspacePulseRoutes);
  return a;
}

function target(overrides: Partial<FileTarget>): FileTarget {
  return {
    provider: "github",
    projectSlug: "rocket",
    ownerUid: "uid-1",
    slug: "acme",
    repoName: "repo",
    org: "org",
    gcsPrefix: "gcs",
    ...overrides,
  } as FileTarget;
}

describe("workspace Pulse route", () => {
  beforeEach(() => {
    h.target = target({});
    h.fetchPulseReport.mockReset().mockResolvedValue({ ok: true });
  });

  it("requires a project-scoped target", async () => {
    h.target = target({ projectSlug: undefined });

    const res = await request(app()).get("/api/workspace/pulse").expect(403);

    expect(res.body).toEqual({ error: "Pulse is project-scoped", code: "PROJECT_ONLY" });
    expect(h.fetchPulseReport).not.toHaveBeenCalled();
  });

  it("returns the fetched Pulse report for Gitea projects", async () => {
    h.target = target({ provider: "gitea" });
    h.fetchPulseReport.mockResolvedValue({ week: { until: "2026-06-30" } });

    const res = await request(app()).get("/api/workspace/pulse").expect(200);

    expect(h.fetchPulseReport).toHaveBeenCalledWith(h.target, expect.any(Number));
    expect(res.body).toEqual({ week: { until: "2026-06-30" } });
  });

  it("returns the fetched Pulse report for GitHub projects", async () => {
    h.fetchPulseReport.mockResolvedValue({ week: { until: "2026-06-30" } });

    const res = await request(app()).get("/api/workspace/pulse").expect(200);

    expect(h.fetchPulseReport).toHaveBeenCalledWith(h.target, expect.any(Number));
    expect(res.body).toEqual({ week: { until: "2026-06-30" } });
  });
});
