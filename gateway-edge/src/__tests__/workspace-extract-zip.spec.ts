import express from "express";
import JSZip from "jszip";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform-state", () => ({ platformStateStore: {} }));
vi.mock("../lib/gcs-bucket", () => ({ gcsBucket: vi.fn() }));

vi.mock("../lib/gitea", () => ({
  giteaApiAsUser: vi.fn(),
}));

vi.mock("../lib/manifest", () => ({
  removeFromManifest: vi.fn(),
}));

const storeWorkspaceBlob = vi.fn();
vi.mock("../lib/project-blob-edit.js", () => ({
  storeUploadedWorkspaceBlob: (...args: unknown[]) => storeWorkspaceBlob(...args),
  WorkspaceStorageQuotaError: class WorkspaceStorageQuotaError extends Error {},
}));

import {
  extractedZipBaseDir,
  validatedZipEntries,
  type ZipEntryLike,
} from "../routes/workspace/extract-zip.js";
import extractZipRouter from "../routes/workspace/extract-zip.js";
import { gcsBucket } from "../lib/gcs-bucket.js";
import { giteaApiAsUser } from "../lib/gitea.js";
import { removeFromManifest } from "../lib/manifest.js";

function zipEntry(dir = false): ZipEntryLike {
  return {
    dir,
    async: vi.fn(),
  };
}

const mockZipDownload = vi.fn();
const mockZipDelete = vi.fn();
const mockBlobSave = vi.fn();
const mockBucketFile = vi.fn((path: string) => {
  if (path === "customers/alice/imports/site.zip") {
    return {
      download: mockZipDownload,
      delete: mockZipDelete,
    };
  }

  return { save: mockBlobSave };
});

function app() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use((req, _res, next) => {
    req.workspaceSlug = "alice";
    next();
  });
  testApp.use(extractZipRouter);
  return testApp;
}

async function zipBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("notes/readme.md", "# Readme\n");
  zip.file("assets/logo.png", Buffer.from([1, 2, 3]));
  return zip.generateAsync({ type: "nodebuffer" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gcsBucket).mockReturnValue({
    file: mockBucketFile,
  } as unknown as ReturnType<typeof gcsBucket>);
  storeWorkspaceBlob.mockResolvedValue({
    gcsPath: "customers/alice/imports/site/assets/logo.png",
    size: 3,
  });
});

describe("workspace extract-zip helpers", () => {
  it("extracts beside the source zip without the .zip suffix", () => {
    expect(extractedZipBaseDir("imports/site.zip")).toBe("imports/site");
    expect(extractedZipBaseDir("site")).toBe("site");
  });

  it("keeps valid files while skipping directories and macOS archive noise", () => {
    const result = validatedZipEntries({
      "notes/": zipEntry(true),
      "__MACOSX/._notes.md": zipEntry(),
      "assets/.DS_Store": zipEntry(),
      "notes/readme.md": zipEntry(),
    }, "imports/site");

    expect(result).toEqual({
      ok: true,
      entries: [
        {
          relativePath: "notes/readme.md",
          targetPath: "imports/site/notes/readme.md",
          zipEntry: expect.objectContaining({ dir: false }),
        },
      ],
    });
  });

  it("blocks unsafe archive entries before any extraction work starts", () => {
    const result = validatedZipEntries({ "../secret.txt": zipEntry() }, "imports/site");

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining('Blocked entry "../secret.txt"'),
    });
  });

  it("rejects archives with too many file entries", () => {
    const files = Object.fromEntries(
      Array.from({ length: 10001 }, (_item, index) => [`file-${index}.txt`, zipEntry()]),
    );

    const result = validatedZipEntries(files, "imports/site");

    expect(result).toMatchObject({
      ok: false,
      status: 413,
      error: expect.stringContaining("Archive has 10001 entries"),
    });
  });
});

describe("POST /extract-zip", () => {
  it("writes text and blob entries, cleans up the source zip, and removes it from the manifest", async () => {
    mockZipDownload.mockResolvedValue([await zipBuffer()]);
    mockZipDelete.mockRejectedValue(new Error("delete failed"));
    vi.mocked(giteaApiAsUser).mockImplementation(async (_sudoUser, _org, path, method) => {
      if (method === "PUT") return {};
      if (path === "workspace/contents/imports/site/notes/readme.md") {
        return { sha: "existing-text-sha" };
      }
      throw new Error("Gitea API 404");
    });

    const res = await request(app())
      .post("/extract-zip")
      .send({ slug: "alice", zipPath: "imports/site.zip" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      extracted: {
        git: ["imports/site/notes/readme.md"],
        blob: ["imports/site/assets/logo.png"],
      },
    });
    expect(giteaApiAsUser).toHaveBeenCalledWith(
      "ws-alice",
      "alice",
      "workspace/contents/imports/site/notes/readme.md",
      "PUT",
      {
        message: "zip-extract: notes/readme.md",
        content: Buffer.from("# Readme\n").toString("base64"),
        sha: "existing-text-sha",
      },
    );
    expect(storeWorkspaceBlob).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "alice", projectSlug: null, repoName: "workspace" }),
      "imports/site/assets/logo.png",
      Buffer.from([1, 2, 3]),
      "image/png",
    );
    expect(mockZipDelete).toHaveBeenCalled();
    expect(removeFromManifest).toHaveBeenCalledWith("customers/alice", "imports/site.zip", undefined);
  });
});
