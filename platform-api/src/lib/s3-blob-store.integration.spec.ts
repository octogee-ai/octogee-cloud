import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  S3Client, CreateBucketCommand, HeadObjectCommand, ListMultipartUploadsCommand, ListObjectVersionsCommand, PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { createS3BlobStore } from "./s3-blob-store.js";

const endpoint = process.env.OCTOGEE_TEST_S3_ENDPOINT;
const bucket = "octogee-blob-store-integration";
const workspaceBucket = "octogee-workspace-blobs-integration";
const region = "us-east-1";
const accessKeyId = "fixture-s3-key";
const secretAccessKey = "fixture-s3-secret";

describe.skipIf(!endpoint)("SeaweedFS blob storage", () => {
  const options = { endpoint: endpoint!, bucket, workspaceBucket, region, accessKeyId, secretAccessKey };
  const store = () => createS3BlobStore(options);
  const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

  beforeAll(async () => {
    for (const name of [bucket, workspaceBucket]) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: name }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "BucketAlreadyOwnedByYou") throw error;
      }
    }
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
  });

  it("writes, reads, lists and deletes objects and enforces conditional updates", async () => {
    const blobs = store();
    const key = "workspace/manifest.json";
    const original = Buffer.from("original");

    await blobs.save(key, original, { contentType: "application/json" });
    const found = await blobs.download(key);
    expect(found?.bytes).toEqual(original);

    await blobs.save(key, "updated", { contentType: "application/json", ifGenerationMatch: found!.revision });
    await expect(blobs.save(key, "stale", { contentType: "application/json", ifGenerationMatch: found!.revision }))
      .rejects.toMatchObject({ code: 412 });
    const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: "workspace/" }));
    expect(versions.Versions).toHaveLength(2);
    await blobs.deletePrefix("workspace/");
    await expect(blobs.download(key)).resolves.toBeNull();
  });

  it("purges every version and delete marker under a project prefix", async () => {
    const blobs = store();
    const prefix = "workspace/project/";
    const asset = prefix + "asset.bin";
    const sibling = "workspace/project-2/asset.bin";
    const contentType = "application/octet-stream";
    try {
      await blobs.save(asset, "first", { contentType });
      await blobs.save(asset, "second", { contentType });
      await blobs.delete(asset);
      await blobs.save(sibling, "keep", { contentType });
      const before = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
      expect(before.Versions).toHaveLength(2);
      await blobs.deletePrefix(prefix);
      await expect(blobs.download(sibling)).resolves.toMatchObject({ bytes: Buffer.from("keep") });
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
      expect(versions.Versions ?? []).toEqual([]);
      expect(versions.DeleteMarkers ?? []).toEqual([]);
    } finally {
      await blobs.deletePrefix(prefix);
      await blobs.deletePrefix("workspace/project-2/");
    }
  });

  it("overwrites and deletes mutable workspace blobs without retaining hidden versions", async () => {
    const blobs = store();
    const key = "customers/alice/photo.png";
    const contentType = "application/octet-stream";
    await blobs.save(key, "first", { contentType });
    const signed = await blobs.signedUrl({ gcsPath: key, action: "write", contentType }, Date.now() + 30_000);
    expect(new URL(signed.url).pathname).toBe(`/${workspaceBucket}/${key}`);
    expect((await fetch(signed.url, { method: "PUT", headers: signed.requiredHeaders, body: "second" })).status).toBe(200);
    const listing = (Bucket: string) => client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key }));
    expect((await listing(workspaceBucket)).Versions).toHaveLength(1);
    expect((await listing(bucket)).Versions ?? []).toEqual([]);
    await blobs.delete(key);
    const after = await listing(workspaceBucket);
    expect(after.Versions ?? []).toEqual([]);
    expect(after.DeleteMarkers ?? []).toEqual([]);
    await expect(blobs.download(key)).resolves.toBeNull();
    expect(() => createS3BlobStore({ ...options, workspaceBucket: bucket })).toThrow(/separate unversioned/);
    const misconfigured = createS3BlobStore({ ...options, bucket: workspaceBucket, workspaceBucket: bucket });
    await expect(misconfigured.save(key, "data", { contentType })).rejects.toThrow(/never have had versioning enabled/);
  });

  it("signs an immutable upload and a version-pinned download", async () => {
    const blobs = store();
    const key = "project/attachment with spaces.bin";
    const data = Buffer.from("bounded attachment");
    // eslint-disable-next-line sonarjs/hashing -- S3 transport checksum
    const contentMd5 = createHash("md5").update(data).digest("base64");
    const expires = Date.now() + 30_000;
    const upload = await blobs.signedUrl({
      gcsPath: key, action: "write", contentType: "application/octet-stream",
      ifGenerationMatch: 0, contentLength: data.length, contentMd5,
    }, expires);
    const put = () => fetch(upload.url, { method: "PUT", headers: upload.requiredHeaders, body: data });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(412);

    const metadata = await blobs.metadata(key);
    expect(metadata).toMatchObject({ size: String(data.length), md5Hash: contentMd5 });
    expect(metadata.generation).toBeTruthy();

    const download = await blobs.signedUrl({ gcsPath: key, action: "read", generation: metadata.generation }, expires);
    const response = await fetch(download.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-amz-version-id")).toBe(metadata.generation);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    await blobs.delete(key, metadata.generation);
  });
  it("streams an upload in parts and moves it without keeping the source", async () => {
    const blobs = store();
    const staged = "agent-imports/uid-stream/import-1/source.zip.upload-1";
    const key = "agent-imports/uid-stream/import-1/source.zip";
    const chunk = Buffer.alloc(256 * 1024, 7);
    const chunks = Array.from({ length: 80 }, (_, index) => Buffer.from(chunk.map((byte) => (byte + index) % 256)));
    try {
      await blobs.saveStream(staged, Readable.from(chunks), { contentType: "application/zip" });
      await blobs.move(staged, key);

      await expect(blobs.download(key)).resolves.toMatchObject({ bytes: Buffer.concat(chunks) });
      expect((await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentType).toBe("application/zip");
      const source = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: staged }));
      expect(source.Versions ?? []).toEqual([]);
      expect(source.DeleteMarkers ?? []).toEqual([]);
    } finally {
      await blobs.deletePrefix("agent-imports/uid-stream/");
    }
  });

  it("moves a workspace blob whose path needs encoding", async () => {
    const blobs = store();
    const key = "customers/alice/agent-imports/import-1/notes/a b+c#d?ü.md";
    try {
      await blobs.saveStream(`${key}.upload-1`, Readable.from([Buffer.from("# notes")]), { contentType: "text/markdown" });
      await blobs.move(`${key}.upload-1`, key);

      await expect(blobs.download(key)).resolves.toMatchObject({ bytes: Buffer.from("# notes") });
      await expect(blobs.download(`${key}.upload-1`)).resolves.toBeNull();
      expect((await client.send(new HeadObjectCommand({ Bucket: workspaceBucket, Key: key }))).ContentType).toBe("text/markdown");
    } finally {
      await blobs.deletePrefix("customers/alice/agent-imports/");
    }
  });

  it("leaves no object or open upload when the source fails partway", async () => {
    const blobs = store();
    const key = "agent-imports/uid-abort/import-1/source.zip.upload-1";
    async function* failing() {
      yield Buffer.alloc(9 * 1024 * 1024, 1);
      throw new Error("client went away");
    }

    await expect(blobs.saveStream(key, failing(), { contentType: "application/zip" })).rejects.toThrow("client went away");

    await expect(blobs.download(key)).resolves.toBeNull();
    const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: "agent-imports/uid-abort/" }));
    expect(uploads.Uploads ?? []).toEqual([]);
  });
});
