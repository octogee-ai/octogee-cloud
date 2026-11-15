import { Storage } from "@google-cloud/storage";
let client;
export function gcsBucket() {
    const name = process.env.BLOB_GCS_BUCKET;
    if (!name)
        throw new Error("BLOB_GCS_BUCKET is required for GCS blob storage");
    client ??= new Storage();
    return client.bucket(name);
}
