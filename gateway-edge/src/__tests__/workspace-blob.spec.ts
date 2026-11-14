import type { BlobStore } from "../lib/blob-store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FileTarget } from "../lib/fileTarget.js";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  brokerUpload: vi.fn(),
  workspaceBrokerUpload: vi.fn(),
  dbDoc: vi.fn(() => { throw new Error("Gateway must not read Firebase Admin"); }),
  getMetadata: vi.fn(),
  delete: vi.fn(),
  getSignedUrl: vi.fn(),
  file: vi.fn(),
  bucket: vi.fn(),
  updateManifest: vi.fn(),
  removeFromManifest: vi.fn(),
  getManifestForQuota: vi.fn(),
  warn: vi.fn(),
  reserveWorkspaceStorage: vi.fn(),
  finalizeWorkspaceStorageReservation: vi.fn(),
  rollbackWorkspaceStorageReservation: vi.fn(),
  releaseWorkspaceStorage: vi.fn(),
}));
vi.mock("../lib/project-blob-upload.js", () => ({ uploadProjectBlobViaBroker: h.brokerUpload, uploadWorkspaceBlobViaBroker: h.workspaceBrokerUpload }));

vi.mock("../lib/db.js", () => ({ db: { doc: h.dbDoc } }));
vi.mock("../lib/gcs-bucket.js", () => ({ gcsBucket: h.bucket }));

vi.mock("../lib/workspace-storage-quota.js", () => ({
  WorkspaceStorageQuotaError: class WorkspaceStorageQuotaError extends Error {
    name = "WorkspaceStorageQuotaError";
    code = "FREE_STORAGE_LIMIT";
    constructor(readonly limitBytes: number, readonly projectedBytes: number) {
      super("quota");
    }
  },
  reserveWorkspaceStorage: (...args: unknown[]) => h.reserveWorkspaceStorage(...args),
  finalizeWorkspaceStorageReservation: (...args: unknown[]) =>
    h.finalizeWorkspaceStorageReservation(...args),
  rollbackWorkspaceStorageReservation: (...args: unknown[]) =>
    h.rollbackWorkspaceStorageReservation(...args),
  releaseWorkspaceStorage: (...args: unknown[]) => h.releaseWorkspaceStorage(...args),
}));

vi.mock("../lib/manifest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/manifest.js")>(),
  updateManifest: h.updateManifest,
  removeFromManifest: h.removeFromManifest,
  getManifestForQuota: h.getManifestForQuota,
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { warn: h.warn, error: vi.fn(), info: vi.fn() },
}));

import { removeWorkspaceBlob, storeWorkspaceBlob, storeWorkspaceBlobCentrally } from "../lib/workspace-blob.js";
import { manifestObjectPath, parseManifest, serializeManifest } from "@octogee/core/workspace-manifest";

const target: FileTarget = {
  slug: "alice",
  projectSlug: "site",
  provider: "gitea",
  org: "octogee-alice",
  repoName: "alice-site",
  gcsPrefix: "customers/alice/projects/site",
  sudoUser: "ws-alice",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.file.mockReturnValue({
    save: h.save,
    getMetadata: h.getMetadata,
    delete: h.delete,
    getSignedUrl: h.getSignedUrl,
  });
  h.bucket.mockReturnValue({ file: h.file });
  h.save.mockResolvedValue(undefined);
  h.delete.mockResolvedValue(undefined);
  h.updateManifest.mockResolvedValue(undefined);
  h.removeFromManifest.mockResolvedValue(undefined);
  h.getSignedUrl.mockResolvedValue(["https://signed-thumb"]);
  h.getManifestForQuota.mockResolvedValue({});
  h.reserveWorkspaceStorage.mockImplementation(async (_db: unknown, input: {
    slug: string;
    path: string;
    newSize: number;
    manifestBytes: number;
    manifestPathBytes: number;
    limitBytes: number;
  }) => {
    const projectedBytes = input.manifestBytes - input.manifestPathBytes + input.newSize;
    if (projectedBytes > input.limitBytes) {
      const error = new Error("quota") as Error & Record<string, unknown>;
      Object.assign(error, {
        name: "WorkspaceStorageQuotaError",
        code: "FREE_STORAGE_LIMIT",
        limitBytes: input.limitBytes,
        projectedBytes,
      });
      throw error;
    }
    return {
      slug: input.slug,
      path: input.path,
      id: "reservation-1",
      previousSize: input.manifestPathBytes,
      newSize: input.newSize,
    };
  });
  h.finalizeWorkspaceStorageReservation.mockResolvedValue(undefined);
  h.rollbackWorkspaceStorageReservation.mockResolvedValue(undefined);
  h.releaseWorkspaceStorage.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

it("saves runtime project assets through the broker without broad cloud credentials", async () => {
  vi.stubEnv("FLEET_BROKER_URL", "http://tenant-api");
  h.save.mockRejectedValue(new Error("storage.objects.create denied"));
  h.brokerUpload.mockResolvedValue({ gcsPath: "immutable-project-object", sha256: "a".repeat(64), size: 3 });
  await expect(storeWorkspaceBlob(target, "asset.bin", Buffer.from("abc"), "application/octet-stream", { immutable: true }))
    .resolves.toMatchObject({ gcsPath: "immutable-project-object" });
  expect(h.brokerUpload).toHaveBeenCalledWith("http://tenant-api", target, Buffer.from("abc"), "application/octet-stream");
  expect(h.bucket).not.toHaveBeenCalled();
  expect(h.updateManifest).not.toHaveBeenCalled();
});

it("saves an ordinary Shared workspace binary through its central owner without local Firebase Admin", async () => {
  vi.stubEnv("GATEWAY_CLASS", "shared");
  vi.stubEnv("GATEWAY_ID", "shared-alice");
  vi.stubEnv("FLEET_BROKER_URL", "http://tenant-api");
  const workspace = { ...target, projectSlug: null, repoName: "workspace", gcsPrefix: "customers/alice" };
  const contents = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  h.workspaceBrokerUpload.mockResolvedValue({ gcsPath: "customers/alice/notes/file.bin", size: contents.length });
  await expect(storeWorkspaceBlob(workspace, "notes/file.bin", contents, "application/octet-stream"))
    .resolves.toEqual({ gcsPath: "customers/alice/notes/file.bin", size: contents.length });
  expect(h.workspaceBrokerUpload).toHaveBeenCalledWith("http://tenant-api", workspace, "notes/file.bin", contents, "application/octet-stream");
  expect(h.dbDoc).not.toHaveBeenCalled();
  expect(h.bucket).not.toHaveBeenCalled();
  expect(h.reserveWorkspaceStorage).not.toHaveBeenCalled();
  expect(h.updateManifest).not.toHaveBeenCalled();
});

it("refuses a gateway workspace upload without its broker instead of falling back to Firebase Admin", async () => {
  vi.stubEnv("GATEWAY_CLASS", "shared"); vi.stubEnv("FLEET_BROKER_URL", "");
  await expect(storeWorkspaceBlob({ ...target, projectSlug: null, gcsPrefix: "customers/alice" }, "notes/file.bin", Buffer.from("data")))
    .rejects.toThrow("configured fleet broker");
  expect(h.dbDoc).not.toHaveBeenCalled(); expect(h.bucket).not.toHaveBeenCalled();
});

it("stores an immutable project asset with create-only semantics and verifies a deduplicated object", async () => {
  const contents = Buffer.from("abc");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  h.getMetadata.mockResolvedValue([{ size: "3", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" }]);
  const saved = await storeWorkspaceBlob(target, "asset.bin", contents, "application/octet-stream", { immutable: true });
  expect(saved).toMatchObject({ gcsPath: `${target.gcsPrefix}/.objects/${sha256}`, sha256, size: 3 });
  expect(h.save).toHaveBeenCalledWith(contents, expect.objectContaining({ preconditionOpts: { ifGenerationMatch: 0 } }));
  expect(h.updateManifest).toHaveBeenCalledWith(target.gcsPrefix, expect.objectContaining({ "asset.bin": expect.objectContaining({ sha256 }) }), undefined);
  h.save.mockRejectedValueOnce(Object.assign(new Error("already exists"), { code: 412 }));
  await expect(storeWorkspaceBlob(target, "asset.bin", contents, "application/octet-stream", { immutable: true })).resolves.toMatchObject({ sha256 });
  h.save.mockRejectedValueOnce(Object.assign(new Error("already exists"), { code: 412 }));
  h.getMetadata.mockResolvedValueOnce([{ size: "3", md5Hash: "wrong" }]);
  await expect(storeWorkspaceBlob(target, "asset.bin", contents, "application/octet-stream", { immutable: true })).rejects.toThrow(/checksum/);
});

describe("storeWorkspaceBlob", () => {
  it.each(["runtime-state/allocations/shared-alice-g1/checkpoint.tar.gz", "notes/runtime-state/file.bin", "notes/__proto__/file.bin", "notes/constructor/file.bin", "notes/prototype/file.bin"])("refuses manifest-reserved paths before quota or GCS effects: %s", async name => {
    h.updateManifest.mockImplementation(async (prefix, entries) => { parseManifest(manifestObjectPath(prefix), serializeManifest(entries)); });
    await expect(storeWorkspaceBlobCentrally({ ...target, projectSlug: null, gcsPrefix: "customers/alice" }, name, Buffer.from("data"), "application/octet-stream", { maxStorageBytes: 10 })).rejects.toThrow();
    expect(h.reserveWorkspaceStorage).not.toHaveBeenCalled(); expect(h.bucket).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled(); expect(h.updateManifest).not.toHaveBeenCalled();
    expect(h.rollbackWorkspaceStorageReservation).not.toHaveBeenCalled();
  });
  it("requires a project target for paths that would use versioned project storage", async () => {
    const save = vi.fn<BlobStore["save"]>();
    const blobs = { save } as unknown as BlobStore;
    const workspace = { ...target, projectSlug: null, gcsPrefix: "customers/alice", blobStore: blobs };
    await expect(storeWorkspaceBlob(workspace, "projects/orbit/asset.bin", Buffer.from("data")))
      .rejects.toThrow(/project upload target/);
    expect(save).not.toHaveBeenCalled();
    expect(h.reserveWorkspaceStorage).not.toHaveBeenCalled();
  });

  it("saves non-image blobs to GCS and writes the manifest placeholder", async () => {
    const result = await storeWorkspaceBlob(
      target,
      "files/report.pdf",
      Buffer.from("pdf"),
    );

    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/files/report.pdf");
    expect(h.save).toHaveBeenCalledWith(Buffer.from("pdf"), {
      metadata: { contentType: "application/pdf" },
    });
    expect(h.updateManifest).toHaveBeenCalledWith("customers/alice/projects/site", {
      "files/report.pdf": expect.objectContaining({
        type: "blob",
        gcsPath: "customers/alice/projects/site/files/report.pdf",
        size: 3,
        mimeType: "application/pdf",
        uploadedAt: expect.any(String),
      }),
    }, undefined);
    expect(result).toEqual({
      gcsPath: "customers/alice/projects/site/files/report.pdf",
      size: 3,
    });
  });

  it("uses the caller-supplied content type when provided", async () => {
    await storeWorkspaceBlob(target, "files/custom.bin", Buffer.from("data"), "application/x-custom");

    expect(h.save).toHaveBeenCalledWith(Buffer.from("data"), {
      metadata: { contentType: "application/x-custom" },
    });
    expect(h.updateManifest).toHaveBeenCalledWith(
      "customers/alice/projects/site",
      expect.objectContaining({
        "files/custom.bin": expect.objectContaining({ mimeType: "application/x-custom" }),
      }),
      undefined,
    );
  });

  it("rejects a Free workspace upload before GCS when its projected manifest exceeds the configured limit", async () => {
    h.getManifestForQuota.mockResolvedValue({
      "files/existing.bin": { type: "blob", size: 8 },
    });

    await expect(storeWorkspaceBlob(
      { ...target, projectSlug: null },
      "files/new.bin",
      Buffer.from("123"),
      "application/octet-stream",
      { maxStorageBytes: 10 },
    )).rejects.toMatchObject({
      name: "WorkspaceStorageQuotaError",
      code: "FREE_STORAGE_LIMIT",
      limitBytes: 10,
      projectedBytes: 11,
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("subtracts the replaced blob before applying the configured limit", async () => {
    h.getManifestForQuota.mockResolvedValue({
      "files/existing.bin": { type: "blob", size: 8 },
    });

    await expect(storeWorkspaceBlob(
      { ...target, projectSlug: null },
      "files/existing.bin",
      Buffer.from("1234567890"),
      "application/octet-stream",
      { maxStorageBytes: 10 },
    )).resolves.toMatchObject({ size: 10 });
    expect(h.save).toHaveBeenCalledOnce();
  });

  it("rolls back the atomic reservation when blob persistence fails", async () => {
    h.save.mockRejectedValueOnce(new Error("GCS unavailable"));

    await expect(storeWorkspaceBlob(
      { ...target, projectSlug: null },
      "files/new.bin",
      Buffer.from("123"),
      "application/octet-stream",
      { maxStorageBytes: 10 },
    )).rejects.toThrow("GCS unavailable");

    expect(h.rollbackWorkspaceStorageReservation).toHaveBeenCalledOnce();
    expect(h.finalizeWorkspaceStorageReservation).not.toHaveBeenCalled();
  });
});

describe("removeWorkspaceBlob", () => {
  it("removes the workspace file and thumbnail from the selected store", async () => {
    const prefix = "customers/alice";
    const remove = vi.fn<BlobStore["delete"]>();
    const blobs = { delete: remove } as unknown as BlobStore;
    await removeWorkspaceBlob({ ...target, projectSlug: null, gcsPrefix: prefix, blobStore: blobs }, "photo.png");
    expect(remove.mock.calls).toEqual([[prefix + "/photo.png"], [prefix + "/.thumbs/photo.png.png"]]);
    expect(h.removeFromManifest).toHaveBeenCalledWith(prefix, "photo.png", expect.objectContaining({ read: expect.any(Function), write: expect.any(Function) }));
    expect(h.bucket).not.toHaveBeenCalled();
  });

  it("removes the blob, image thumbnail, and manifest entry", async () => {
    await removeWorkspaceBlob(target, "images/logo.png");

    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/images/logo.png");
    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/.thumbs/images/logo.png.png");
    expect(h.delete).toHaveBeenNthCalledWith(1, { ignoreNotFound: true });
    expect(h.delete).toHaveBeenNthCalledWith(2, { ignoreNotFound: true });
    expect(h.removeFromManifest).toHaveBeenCalledWith("customers/alice/projects/site", "images/logo.png", undefined);
  });

  it("does not attempt thumbnail deletion for non-image blobs", async () => {
    await removeWorkspaceBlob(target, "docs/readme.pdf");

    expect(h.file).toHaveBeenCalledTimes(1);
    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/docs/readme.pdf");
    expect(h.removeFromManifest).toHaveBeenCalledWith("customers/alice/projects/site", "docs/readme.pdf", undefined);
  });
});
