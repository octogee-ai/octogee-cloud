import { gcsBucket } from "../../../gateway-edge/src/lib/gcs-bucket.js";
import { createGcsBlobStore } from "../../../gateway-edge/src/lib/gcs-blob-store.js";
import type { BlobStore } from "../../../gateway-edge/src/lib/blob-store.js";
import { createS3BlobStore } from "./s3-blob-store.js";

export const gcsBlobStore = createGcsBlobStore(gcsBucket);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for S3 blob storage`);
  return value;
}

let s3: BlobStore | undefined;

export function runtimeBlobStore(): BlobStore {
  const backend = process.env.BLOB_STORE_BACKEND ?? "s3";
  if (backend === "gcs") return gcsBlobStore;
  if (backend !== "s3") throw new Error(`unsupported BLOB_STORE_BACKEND: ${backend}`);
  s3 ??= createS3BlobStore({
    endpoint: required("BLOB_S3_ENDPOINT"),
    publicEndpoint: process.env.BLOB_S3_PUBLIC_ENDPOINT,
    bucket: required("BLOB_S3_BUCKET"),
    workspaceBucket: required("BLOB_S3_WORKSPACE_BUCKET"),
    region: process.env.AWS_REGION ?? "us-east-1",
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  });
  return s3;
}
