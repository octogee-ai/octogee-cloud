import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { ManifestGenerationConflict } from "@octogee/core/workspace-manifest";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";

const fetchMock = vi.fn();
const tempDirs: string[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(name: string, content = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "octogee-blob-sync-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

function client(overrides: Partial<FleetBrokerClient> = {}): FleetBrokerClient {
  return {
    blobDownloadUrl: vi.fn(async () => ({ url: "https://signed.test/download", method: "GET" })),
    blobUploadUrl: vi.fn(async () => ({ url: "https://signed.test/upload", method: "PUT" })),
    workspaceManifestReadUrl: vi.fn(async () => ({ url: "https://signed.test/manifest-read", method: "GET" })),
    workspaceManifestWriteUrl: vi.fn(async () => ({ url: "https://signed.test/manifest-write", method: "PUT" })),
    ...overrides,
  } as FleetBrokerClient;
}

describe("createBrokeredBlobStore", () => {
  it("downloads through a signed broker URL and writes the destination file", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([65, 66]), { status: 200 }));
    const c = client();
    const destination = await tempFile("asset.bin");

    await createBrokeredBlobStore(c).download({
      slug: "acme",
      relativePath: "images/logo.png",
      gcsPath: "unused-by-broker",
      destination,
      size: 2,
    });

    expect(c.blobDownloadUrl).toHaveBeenCalledWith({ slug: "acme", path: "images/logo.png" });
    expect(fetchMock).toHaveBeenCalledWith("https://signed.test/download", expect.objectContaining({ method: "GET", redirect: "error" }));
    await expect(readFile(destination, "utf8")).resolves.toBe("AB");
  });

  it("uploads local bytes through a signed broker URL with the declared content type", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const c = client();
    const localPath = await tempFile("asset.txt", "hello");

    await createBrokeredBlobStore(c).upload({
      slug: "acme",
      relativePath: "docs/readme.txt",
      gcsPath: "unused-by-broker",
      localPath,
      mimeType: "text/plain",
      size: 5,
    });

    expect(c.blobUploadUrl).toHaveBeenCalledWith({
      slug: "acme",
      path: "docs/readme.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://signed.test/upload",
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("hello"),
      }),
    );
  });

  it("rejects a linked upload before transferring bytes", async () => {
    const target = await tempFile("private.txt", "hello");
    const localPath = `${target}.link`;
    await symlink(target, localPath);
    await expect(createBrokeredBlobStore(client()).upload({
      slug: "acme", relativePath: "asset.txt", gcsPath: "unused", localPath,
      mimeType: "text/plain", size: 5,
    })).rejects.toMatchObject({ code: "ELOOP" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the existing file when a blob response exceeds the manifest size", async () => {
    fetchMock.mockResolvedValue(new Response("oversized"));
    const destination = await tempFile("asset.txt", "existing");
    await expect(createBrokeredBlobStore(client()).download({
      slug: "acme", relativePath: "asset.txt", gcsPath: "unused", destination, size: 5,
    })).rejects.toThrow("blob download exceeds manifest size");
    await expect(readFile(destination, "utf8")).resolves.toBe("existing");
  });

  it("includes response status and text when signed download or upload fails", async () => {
    const c = client();
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 403 }));

    await expect(createBrokeredBlobStore(c).download({
      slug: "acme",
      relativePath: "images/logo.png",
      gcsPath: "unused",
      destination: await tempFile("logo.png"),
      size: 5,
    })).rejects.toThrow("blob download acme/images/logo.png failed: 403 expired");

    fetchMock.mockResolvedValueOnce(new Response("too large", { status: 413 }));
    await expect(createBrokeredBlobStore(c).upload({
      slug: "acme",
      relativePath: "images/logo.png",
      gcsPath: "unused",
      localPath: await tempFile("logo-upload.png", "x"),
      mimeType: "image/png",
      size: 1,
    })).rejects.toThrow("blob upload acme/images/logo.png failed: 413 too large");
  });
});

describe("brokered manifest store", () => {
  it("reads an absent manifest as null rather than failing the sync", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    const store = createBrokeredBlobStore(client()).manifestFor("acme");
    await expect(store.read("customers/acme/.files/manifest.json")).resolves.toBeNull();
  });

  it("carries the GCS generation out of the response headers", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", { status: 200, headers: { "x-goog-generation": "17" } }),
    );
    const store = createBrokeredBlobStore(client()).manifestFor("acme");
    await expect(store.read("customers/acme/.files/manifest.json")).resolves.toEqual({
      contents: "{}",
      generation: "17",
    });
  });

  it("uses the S3 ETag and forwards the signed conditional write headers", async () => {
    const etag = '"dcddb75469b4b4875094e14561e573d8"';
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { etag } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const c = client({
      workspaceManifestReadUrl: vi.fn(async () => ({
        url: "https://signed.test/manifest-read", method: "GET", storage: "s3",
        expiresAt: "", gcsPath: "customers/acme/.files/manifest.json",
      })),
      workspaceManifestWriteUrl: vi.fn(async () => ({
        url: "https://signed.test/manifest-write", method: "PUT", storage: "s3",
        expiresAt: "", gcsPath: "customers/acme/.files/manifest.json", requiredHeaders: { "if-match": etag },
      })),
    });
    const store = createBrokeredBlobStore(c).manifestFor("acme");
    const key = "customers/acme/.files/manifest.json";
    await expect(store.read(key)).resolves.toEqual({ contents: "{}", generation: etag });
    await store.write(key, "{}", etag);
    expect(c.workspaceManifestWriteUrl).toHaveBeenCalledWith({ slug: "acme", ifGenerationMatch: etag });
    expect(fetchMock).toHaveBeenLastCalledWith("https://signed.test/manifest-write", expect.objectContaining({
      method: "PUT", headers: { "content-type": "application/json", "if-match": etag }, body: "{}",
    }));
  });

  it("refuses a read with no generation — an unconditional write would follow", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const store = createBrokeredBlobStore(client()).manifestFor("acme");
    await expect(store.read("customers/acme/.files/manifest.json")).rejects.toThrow(/no generation/i);
  });

  it("mints the write URL against the generation it is given", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    const c = client();
    await createBrokeredBlobStore(c).manifestFor("acme").write("p", "{}", "17");
    expect(c.workspaceManifestWriteUrl).toHaveBeenCalledWith({ slug: "acme", ifGenerationMatch: "17" });
  });

  it("sends the precondition the broker signed — as a query param GCS ignores it", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    const c = client({
      workspaceManifestWriteUrl: vi.fn(async () => ({
        url: "https://signed.test/manifest-write",
        method: "PUT" as const,
        requiredHeaders: { "x-goog-if-generation-match": "17" },
      })),
    } as Partial<FleetBrokerClient>);

    await createBrokeredBlobStore(c).manifestFor("acme").write("p", "{}", "17");

    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["x-goog-if-generation-match"]).toBe("17");
  });

  it("turns a precondition failure into a generation conflict so the caller retries", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 412 }));
    const store = createBrokeredBlobStore(client()).manifestFor("acme");
    await expect(store.write("p", "{}", "17")).rejects.toBeInstanceOf(ManifestGenerationConflict);
  });
});
