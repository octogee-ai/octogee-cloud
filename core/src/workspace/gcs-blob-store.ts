import { pipeline } from "node:stream/promises";
import type { Bucket } from "@google-cloud/storage";
import { blobStatus, type BlobMetadata, type BlobStore } from "./blob-store.js";

function generationOf(generation: unknown): string | undefined {
  return typeof generation === "string" || typeof generation === "number" ? String(generation) : undefined;
}

function metadataOf(metadata: { size?: unknown; generation?: unknown; md5Hash?: unknown }): BlobMetadata {
  const generation = generationOf(metadata.generation);
  return {
    size: String(metadata.size ?? ""),
    generation,
    md5Hash: typeof metadata.md5Hash === "string" ? metadata.md5Hash : undefined,
  };
}

export function createGcsBlobStore(bucket: () => Bucket | Promise<Bucket>): BlobStore {
  return {
    async save(key, bytes, { contentType, ifGenerationMatch }) {
      const file = (await bucket()).file(key);
      await file.save(bytes, {
        metadata: { contentType },
        ...(ifGenerationMatch === undefined ? {} : { preconditionOpts: { ifGenerationMatch } }),
      });
    },
    async saveStream(key, source, { contentType }) {
      await pipeline(source, (await bucket()).file(key).createWriteStream({ metadata: { contentType } }));
    },
    async move(from, to) {
      await (await bucket()).file(from).move(to);
    },
    async download(key) {
      const current = await bucket();
      for (let attempt = 0; attempt < 2; attempt++) {
        let generation: string | undefined;
        try {
          const [metadata] = await current.file(key).getMetadata();
          generation = generationOf(metadata.generation);
        } catch (error) {
          if (blobStatus(error) === "404") return null;
          throw error;
        }
        if (!generation) throw new Error("object metadata has no generation");
        try {
          const [bytes] = await current.file(key, { generation }).download();
          return { bytes, revision: generation };
        } catch (error) {
          if (blobStatus(error) !== "404" || attempt !== 0) throw error;
        }
      }
      throw new Error("object generation changed during download");
    },
    async delete(key, generation) {
      const current = await bucket();
      if (generation) {
        await current.file(key, { generation }).delete({ ifGenerationMatch: generation });
      } else {
        await current.file(key).delete({ ignoreNotFound: true });
      }
    },
    async deletePrefix(prefix) {
      await (await bucket()).deleteFiles({ prefix });
    },
    async metadata(key) {
      const [metadata] = await (await bucket()).file(key).getMetadata();
      return metadataOf(metadata);
    },
    async signedUrl(input, expires) {
      const requiredHeaders = {
        ...(input.ifGenerationMatch === undefined ? {} : { "x-goog-if-generation-match": String(input.ifGenerationMatch) }),
        ...(input.contentMd5 === undefined ? {} : { "content-md5": input.contentMd5 }),
        ...(input.contentLength === undefined ? {} : { "content-length": String(input.contentLength) }),
      };
      const [url] = await (await bucket()).file(input.gcsPath).getSignedUrl({
        version: "v4",
        action: input.action,
        expires,
        ...(input.action === "write" ? { contentType: input.contentType } : {}),
        ...(input.contentMd5 ? { contentMd5: input.contentMd5 } : {}),
        ...(Object.keys(requiredHeaders).length ? { extensionHeaders: requiredHeaders } : {}),
        ...(input.generation ? { queryParams: { generation: input.generation } } : {}),
      });
      return {
        url, method: input.action === "read" ? "GET" : "PUT", gcsPath: input.gcsPath,
        expiresAt: new Date(expires).toISOString(),
        ...(Object.keys(requiredHeaders).length ? { requiredHeaders } : {}),
      };
    },
  };
}
