import { afterEach, describe, expect, it, vi } from "vitest";
import { gcsBucket } from "./gcs-bucket.js";

describe("gcsBucket", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to pick a bucket when none is configured", () => {
    vi.stubEnv("BLOB_GCS_BUCKET", "");
    expect(() => gcsBucket()).toThrow("BLOB_GCS_BUCKET is required");
  });

  it("names the configured bucket", () => {
    vi.stubEnv("BLOB_GCS_BUCKET", "workspace-blobs.example");
    expect(gcsBucket().name).toBe("workspace-blobs.example");
  });
});
