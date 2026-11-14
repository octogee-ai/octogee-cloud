import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const existsByPath = new Map<string, boolean>();
  const deletes: string[] = [];
  return {
    existsByPath,
    deletes,
    removeFromManifest: vi.fn(),
    removeWorkspaceBlob: vi.fn(),
    bucketFile: vi.fn((path: string) => ({
      exists: vi.fn(async () => [existsByPath.get(path) ?? false]),
      delete: vi.fn(async () => {
        deletes.push(path);
      }),
    })),
    target: {
      slug: "mira",
      projectSlug: null,
      provider: "gitea",
      org: "mira",
      repoName: "workspace",
      gcsPrefix: "customers/mira",
      sudoUser: "ws-mira",
      brokered: false,
      canvasFile: "README.md",
    },
  };
});

vi.mock("../lib/gcs-bucket.js", () => ({
  gcsBucket: () => ({
    file: (path: string) => h.bucketFile(path),
  }),
}));

vi.mock("../lib/fileTarget.js", () => ({
  withGiteaTarget: (handler: express.RequestHandler) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) =>
      handler(req, res, next, h.target),
}));

vi.mock("../lib/manifest.js", () => ({
  removeFromManifest: (...args: unknown[]) => h.removeFromManifest(...args),
}));
vi.mock("../lib/project-blob-edit.js", () => ({
  removeUploadedWorkspaceBlob: (...args: unknown[]) => h.removeWorkspaceBlob(...args),
}));

const { default: deleteBlobRoutes } = await import("../routes/workspace/delete-blob.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/workspace", deleteBlobRoutes);
  return a;
}

beforeEach(() => {
  h.existsByPath.clear();
  h.deletes.length = 0;
  h.bucketFile.mockClear();
  h.removeFromManifest.mockReset().mockResolvedValue(undefined);
  h.removeWorkspaceBlob.mockReset().mockResolvedValue(undefined);
});

describe("workspace delete-blob route", () => {
  it("deletes an existing blob, its thumbnail, and the manifest entry", async () => {
    h.existsByPath.set("customers/mira/assets/photo.png", true);
    h.existsByPath.set("customers/mira/.thumbs/assets/photo.png.png", true);

    const res = await request(app())
      .post("/api/workspace/delete-blob")
      .send({ path: "assets/photo.png" })
      .expect(200);

    expect(res.body).toEqual({ success: true, deleted: "assets/photo.png" });
    expect(h.removeWorkspaceBlob).toHaveBeenCalledWith(
      h.target,
      "assets/photo.png",
    );
  });

  it("still removes the manifest entry when files are already absent", async () => {
    await request(app())
      .post("/api/workspace/delete-blob")
      .send({ path: "assets/missing.png" })
      .expect(200, { success: true, deleted: "assets/missing.png" });

    expect(h.removeWorkspaceBlob).toHaveBeenCalledWith(
      h.target,
      "assets/missing.png",
    );
  });

  it("rejects missing or unsafe paths before storage and manifest writes", async () => {
    await request(app())
      .post("/api/workspace/delete-blob")
      .send({})
      .expect(400, { error: "Missing path" });

    await request(app())
      .post("/api/workspace/delete-blob")
      .send({ path: "../secret.png" })
      .expect(400);

    expect(h.removeWorkspaceBlob).not.toHaveBeenCalled();
  });
});
