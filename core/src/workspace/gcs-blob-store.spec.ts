import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createGcsBlobStore } from "./gcs-blob-store.js";

type Bucket = Parameters<typeof createGcsBlobStore>[0] extends () => infer B ? Awaited<B> : never;

function fakeBucket() {
  const written = new Map<string, { bytes: Buffer; options: unknown }>();
  const move = vi.fn(async (_destination: string) => undefined);
  const file = vi.fn((key: string) => ({
    createWriteStream(options: unknown) {
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          written.set(key, { bytes: Buffer.concat(chunks), options });
          callback();
        },
      });
    },
    move,
  }));
  return { bucket: { file } as unknown as Bucket, file, move, written };
}

describe("GCS blob store", () => {
  it("streams a source into the object with its content type", async () => {
    const { bucket, written } = fakeBucket();
    const blobs = createGcsBlobStore(async () => bucket);

    await blobs.saveStream("agent-imports/u1/import-1/source.zip", Readable.from([Buffer.from("PK"), Buffer.from("zip")]), {
      contentType: "application/zip",
    });

    expect(written.get("agent-imports/u1/import-1/source.zip")).toEqual({
      bytes: Buffer.from("PKzip"),
      options: { metadata: { contentType: "application/zip" } },
    });
  });

  it("moves an object within the bucket", async () => {
    const { bucket, file, move } = fakeBucket();
    const blobs = createGcsBlobStore(() => bucket);

    await blobs.move("customers/alice/agent-imports/import-1/a.png.upload-1", "customers/alice/agent-imports/import-1/a.png");

    expect(file).toHaveBeenCalledWith("customers/alice/agent-imports/import-1/a.png.upload-1");
    expect(move).toHaveBeenCalledWith("customers/alice/agent-imports/import-1/a.png");
  });
});
