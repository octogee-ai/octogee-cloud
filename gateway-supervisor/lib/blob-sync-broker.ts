import { constants } from "node:fs";
import { mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ManifestGenerationConflict,
  type ManifestStore,
} from "@octogee/core/workspace-manifest";
import type { BlobStore } from "./blob-sync.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";
import { BLOB_SYNC_MAX_SIZE } from "./config.js";

const TRANSFER_TIMEOUT_MS = 5 * 60_000;

function transferOptions(): Pick<RequestInit, "redirect" | "signal"> {
  return { redirect: "error", signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) };
}

async function requireOk(resp: Response, label: string): Promise<void> {
  if (resp.ok) return;
  const text = (await resp.text().catch(() => "")).slice(0, 300);
  throw new Error(`${label} failed: ${resp.status} ${text}`);
}

function brokeredManifestStore(client: FleetBrokerClient, slug: string): ManifestStore {
  return {
    async read(objectPath) {
      const signed = await client.workspaceManifestReadUrl({ slug });
      const resp = await fetch(signed.url, { ...transferOptions(), method: signed.method });
      if (resp.status === 404) return null;
      await requireOk(resp, `manifest read ${slug}`);
      const generation = resp.headers.get(signed.storage === "s3" ? "etag" : "x-goog-generation");
      if (!generation) {
        throw new Error(`manifest read ${slug} returned no generation for ${objectPath}`);
      }
      return { contents: await resp.text(), generation };
    },
    async write(objectPath, contents, ifGenerationMatch) {
      const signed = await client.workspaceManifestWriteUrl({ slug, ifGenerationMatch });
      const resp = await fetch(signed.url, {
        ...transferOptions(),
        method: signed.method,
        headers: { "content-type": "application/json", ...signed.requiredHeaders },
        body: contents,
      });
      if (resp.status === 412) throw new ManifestGenerationConflict(objectPath);
      await requireOk(resp, `manifest write ${slug}`);
    },
  };
}

async function writeDownloadedBlob(body: Response["body"], output: FileHandle, size: number): Promise<void> {
  let received = 0;
  if (body) {
    for await (const chunk of body) {
      received += chunk.byteLength;
      if (received > size) throw new Error("blob download exceeds manifest size");
      await output.writeFile(chunk);
    }
  }
  if (received !== size) throw new Error("blob download does not match manifest size");
}

async function publishDownloadedBlob(response: Response, destination: string, size: number): Promise<void> {
  const staging = await mkdtemp(join(dirname(destination), ".blob-sync-"));
  const file = join(staging, "contents");
  try {
    const output = await open(file, "wx", 0o600);
    try { await writeDownloadedBlob(response.body, output, size); }
    finally { await output.close(); }
    await rename(file, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function readUploadFile(file: string, size: number): Promise<Buffer<ArrayBuffer>> {
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) throw new Error("blob upload source is not a regular file of the expected size");
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await input.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await input.stat();
    if (length !== size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("blob upload source changed during read");
    return bytes.subarray(0, length);
  } finally { await input.close(); }
}

function assertTransferSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > BLOB_SYNC_MAX_SIZE) throw new Error("invalid blob transfer size");
}

export function createBrokeredBlobStore(client: FleetBrokerClient): BlobStore {
  return {
    manifestFor: (slug) => brokeredManifestStore(client, slug),
    async download(input) {
      assertTransferSize(input.size);
      const signed = await client.blobDownloadUrl({
        slug: input.slug,
        path: input.relativePath,
      });
      const resp = await fetch(signed.url, { ...transferOptions(), method: signed.method });
      await requireOk(resp, `blob download ${input.slug}/${input.relativePath}`);
      await publishDownloadedBlob(resp, input.destination, input.size);
    },
    async upload(input) {
      assertTransferSize(input.size);
      const body = await readUploadFile(input.localPath, input.size);
      const signed = await client.blobUploadUrl({
        slug: input.slug,
        path: input.relativePath,
        mimeType: input.mimeType,
        size: input.size,
      });
      const resp = await fetch(signed.url, {
        ...transferOptions(),
        method: signed.method,
        headers: { "content-type": input.mimeType, ...signed.requiredHeaders },
        body,
      });
      await requireOk(resp, `blob upload ${input.slug}/${input.relativePath}`);
    },
  };
}
