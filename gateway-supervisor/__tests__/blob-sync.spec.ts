import { test, expect } from "vitest";
import {
  computeBlobSyncActions,
  type Manifest,
  type LocalFile,
} from "../lib/blob-sync";

const ONE_MB = 1024 * 1024;
const HUNDRED_MB = 100 * ONE_MB;

function manifestEntry(overrides: Partial<Manifest[string]> = {}): Manifest[string] {
  return {
    type: "blob",
    gcsPath: "customers/test-slug/asset",
    size: 1000,
    mimeType: "image/png",
    uploadedAt: "2026-03-14T10:00:00Z",
    ...overrides,
  };
}

function localFile(overrides: Partial<LocalFile>): LocalFile {
  return {
    path: "asset",
    mtimeMs: Date.now(),
    size: 1000,
    ...overrides,
  };
}

test.describe("computeBlobSyncActions — download decisions", () => {
  test("new blob in manifest → download", () => {
    const manifest: Manifest = {
      "assets/logo.png": manifestEntry({ gcsPath: "customers/test/assets/logo.png" }),
    };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [],
      prevSyncedPaths: [],
    });
    expect(actions.toDownload).toHaveLength(1);
    expect(actions.toDownload[0].path).toBe("assets/logo.png");
  });

  test("blob already up to date → skip download", () => {
    const uploadedAt = "2026-03-14T10:00:00Z";
    const manifest: Manifest = {
      "assets/logo.png": manifestEntry({ uploadedAt }),
    };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [localFile({
        path: "assets/logo.png",
        mtimeMs: new Date(uploadedAt).getTime() + 1000,
      })],
      prevSyncedPaths: ["assets/logo.png"],
    });
    expect(actions.toDownload).toHaveLength(0);
  });

  test("blob exists but outdated → download", () => {
    const uploadedAt = "2026-03-14T12:00:00Z";
    const manifest: Manifest = {
      "assets/logo.png": manifestEntry({ uploadedAt }),
    };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [localFile({
        path: "assets/logo.png",
        mtimeMs: new Date(uploadedAt).getTime() - 60_000,
      })],
      prevSyncedPaths: ["assets/logo.png"],
    });
    expect(actions.toDownload).toHaveLength(1);
  });

  test("blob > 100MB → skipped (skippedDownload), no download queued", () => {
    const manifest: Manifest = {
      "videos/huge.mp4": manifestEntry({ size: 150 * ONE_MB, mimeType: "video/mp4" }),
    };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [],
      prevSyncedPaths: [],
    });
    expect(actions.toDownload).toHaveLength(0);
    expect(actions.skippedDownload.map(s => s.path)).toContain("videos/huge.mp4");
    expect(actions.skippedDownload[0].size).toBe(150 * ONE_MB);
  });

  test("multiple blobs — mix of new, outdated, current, and oversized", () => {
    const manifest: Manifest = {
      "new.png":       manifestEntry({ uploadedAt: "2026-03-14T10:00:00Z" }),
      "current.png":   manifestEntry({ uploadedAt: "2026-03-14T08:00:00Z" }),
      "outdated.png":  manifestEntry({ uploadedAt: "2026-03-14T12:00:00Z" }),
      "huge.bin":      manifestEntry({ size: 200 * ONE_MB, mimeType: "application/octet-stream" }),
    };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [
        localFile({ path: "current.png",  mtimeMs: new Date("2026-03-14T09:00:00Z").getTime() }),
        localFile({ path: "outdated.png", mtimeMs: new Date("2026-03-14T10:00:00Z").getTime() }),
      ],
      prevSyncedPaths: ["current.png", "outdated.png"],
    });
    expect(actions.toDownload.map(d => d.path).sort()).toEqual(["new.png", "outdated.png"]);
    expect(actions.skippedDownload.map(s => s.path)).toContain("huge.bin");
  });

  test("non-blob manifest entries are ignored across all decisions", () => {

const manifest = {
      "weird-entry": { type: "text", size: 100, uploadedAt: "2026-01-01T00:00:00Z" } as unknown as Manifest[string],
    };

    const downloadActions = computeBlobSyncActions({
      manifest,
      localFiles: [],
      prevSyncedPaths: [],
    });
    expect(downloadActions.toDownload).toHaveLength(0);

    const uploadActions = computeBlobSyncActions({
      manifest,
      localFiles: [localFile({ path: "weird-entry", size: 50 })],
      prevSyncedPaths: [],
    });
    expect(uploadActions.toUpload).toEqual(["weird-entry"]);

    const deleteActions = computeBlobSyncActions({
      manifest,
      localFiles: [localFile({ path: "weird-entry" })],
      prevSyncedPaths: ["weird-entry"],
    });
    expect(deleteActions.toDelete).toEqual(["weird-entry"]);
  });

  test("custom maxSize threshold honored", () => {
    const manifest: Manifest = {
      "big.png": manifestEntry({ size: 50 * ONE_MB }),
    };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [],
      prevSyncedPaths: [],
      maxSize: 10 * ONE_MB,
    });
    expect(actions.skippedDownload.map(s => s.path)).toContain("big.png");
    expect(actions.toDownload).toHaveLength(0);
  });
});

test.describe("computeBlobSyncActions — upload decisions", () => {
  test("local file not in manifest → upload", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [localFile({ path: "output/report.pdf" })],
      prevSyncedPaths: [],
    });
    expect(actions.toUpload).toEqual(["output/report.pdf"]);
  });

  test("local file already in manifest → skip upload", () => {
    const manifest: Manifest = { "assets/logo.png": manifestEntry() };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [localFile({ path: "assets/logo.png" })],
      prevSyncedPaths: ["assets/logo.png"],
    });
    expect(actions.toUpload).toHaveLength(0);
  });

  test("previously synced file not in manifest → do not re-upload, schedule delete", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [localFile({ path: "assets/deleted.png" })],
      prevSyncedPaths: ["assets/deleted.png"],
    });
    expect(actions.toUpload).toHaveLength(0);
    expect(actions.toDelete).toContain("assets/deleted.png");
  });

  test("oversized local file is skipped, not uploaded (skippedUpload)", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [localFile({ path: "big.zip", size: 150 * ONE_MB })],
      prevSyncedPaths: [],
    });
    expect(actions.toUpload).toHaveLength(0);
    expect(actions.skippedUpload).toEqual([{ path: "big.zip", size: 150 * ONE_MB }]);
  });

  test("oversized local file at exactly maxSize is NOT skipped (boundary)", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [localFile({ path: "exact.bin", size: HUNDRED_MB })],
      prevSyncedPaths: [],
    });
    expect(actions.toUpload).toEqual(["exact.bin"]);
    expect(actions.skippedUpload).toHaveLength(0);
  });
});

test.describe("computeBlobSyncActions — cleanup decisions", () => {
  test("previously synced path removed from manifest → delete local", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [localFile({ path: "assets/old.png" })],
      prevSyncedPaths: ["assets/old.png"],
    });
    expect(actions.toDelete).toEqual(["assets/old.png"]);
  });

  test("previously synced path still in manifest → do not delete", () => {
    const manifest: Manifest = { "assets/keep.png": manifestEntry() };
    const actions = computeBlobSyncActions({
      manifest,
      localFiles: [localFile({ path: "assets/keep.png" })],
      prevSyncedPaths: ["assets/keep.png"],
    });
    expect(actions.toDelete).toHaveLength(0);
  });

  test("path not previously synced and not in manifest → upload, do not delete", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [localFile({ path: "agent-output/chart.png" })],
      prevSyncedPaths: [],
    });
    expect(actions.toDelete).toHaveLength(0);
    expect(actions.toUpload).toContain("agent-output/chart.png");
  });

  test("previously synced path not present locally → no delete (already gone)", () => {
    const actions = computeBlobSyncActions({
      manifest: {},
      localFiles: [],
      prevSyncedPaths: ["assets/already-gone.png"],
    });
    expect(actions.toDelete).toHaveLength(0);
  });
});
