import { Storage, type Bucket } from "@google-cloud/storage";

let client: Storage | undefined;

export function gcsBucket(): Bucket {
  const name = process.env.BLOB_GCS_BUCKET;
  if (!name) throw new Error("BLOB_GCS_BUCKET is required for GCS blob storage");
  client ??= new Storage();
  return client.bucket(name);
}
