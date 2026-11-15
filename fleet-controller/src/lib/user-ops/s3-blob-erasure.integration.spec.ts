import { CreateBucketCommand, DeleteObjectCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { createS3UserBlobErasure } from "./s3-blob-erasure.js";

const endpoint = process.env.OCTOGEE_TEST_S3_ENDPOINT;
const versioned = "octogee-blob-erasure-versioned";
const workspace = "octogee-blob-erasure-workspace";
const environment = {
  BLOB_STORE_BACKEND: "s3",
  BLOB_S3_ENDPOINT: endpoint,
  BLOB_S3_BUCKET: versioned,
  BLOB_S3_WORKSPACE_BUCKET: workspace,
  AWS_ACCESS_KEY_ID: "fixture-s3-key",
  AWS_SECRET_ACCESS_KEY: "fixture-s3-secret",
  AWS_REGION: "us-east-1",
};

describe.skipIf(!endpoint)("S3 user blob erasure", () => {
  const client = new S3Client({
    endpoint, region: environment.AWS_REGION, forcePathStyle: true,
    credentials: { accessKeyId: environment.AWS_ACCESS_KEY_ID, secretAccessKey: environment.AWS_SECRET_ACCESS_KEY },
  });
  beforeAll(async () => {
    for (const Bucket of [versioned, workspace]) {
      try {
        await client.send(new CreateBucketCommand({ Bucket }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "BucketAlreadyOwnedByYou") throw error;
      }
    }
    await client.send(new PutBucketVersioningCommand({ Bucket: versioned, VersioningConfiguration: { Status: "Enabled" } }));
  });

  it("verifies and removes project history, workspace files and export snapshots without affecting another user", async () => {
    const erasure = createS3UserBlobErasure(environment)!;
    const save = (Bucket: string, Key: string) => client.send(new PutObjectCommand({ Bucket, Key, Body: "fixture" }));
    const project = "customers/alice/projects/demo/image.png";
    try {
      await save(versioned, project);
      await save(versioned, project);
      await client.send(new DeleteObjectCommand({ Bucket: versioned, Key: project }));
      await save(versioned, "agent-imports/uid-alice/export-a/export.json");
      await save(workspace, "customers/alice/document.pdf");
      await save(workspace, "customers/alice-2/document.pdf");
      expect(await erasure.remaining("uid-alice", "alice")).toHaveLength(3);
      await erasure.erase("uid-alice", "alice");
      expect(await erasure.remaining("uid-alice", "alice")).toEqual([]);
      expect(await erasure.remaining("uid-alice-2", "alice-2")).toHaveLength(1);
    } finally {
      await erasure.erase("uid-alice", "alice");
      await erasure.erase("uid-alice-2", "alice-2");
    }
  });
});
