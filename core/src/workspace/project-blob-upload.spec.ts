import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn() }));
vi.mock("../internal-fetch.js", () => ({ internalFetch: h.request,
  sidecarBrokerHeaders: async () => ({ "x-sidecar": "sidecar-purpose" }),
  gatewayCredentialHeaders: async () => ({ "x-credential": "read-purpose" }),
}));
import { uploadProjectBlobViaBroker, projectBlobHydrationClient } from "./project-blob-upload.js";
const contents = Buffer.from("abc"), sha256 = createHash("sha256").update(contents).digest("hex"), md5Hash = "kAFQmDzST7DWlj99KOF/cg==";
const target = { slug: "alice", projectSlug: "demo", gcsPrefix: "customers/alice/projects/demo" };
const gcsPath = `${target.gcsPrefix}/.objects/${sha256}`;
const signed = { url: "https://storage.googleapis.com/bucket/object?signed=true", method: "PUT", gcsPath,
  requiredHeaders: { "x-goog-if-generation-match": "0", "content-md5": md5Hash, "content-length": "3" } };
const verified = { download: { gcsPath }, size: 3, md5Hash, generation: "17" };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", h.fetch); vi.stubEnv("GATEWAY_ID", "b-alice");
  h.request.mockResolvedValueOnce(Response.json(signed)).mockResolvedValueOnce(Response.json(verified));
  h.fetch.mockResolvedValue(new Response(null, { status: 200 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("uses tenant-bound signing and verifies the stored object before acknowledging", async () => {
  expect(await uploadProjectBlobViaBroker("http://api", target, contents, "application/octet-stream")).toEqual({ gcsPath, sha256, size: 3 });
  expect(h.request.mock.calls[0][1].headers).toMatchObject({ "x-sidecar": "sidecar-purpose" });
  expect(JSON.parse(h.request.mock.calls[0][1].body)).toMatchObject({ gatewayId: "b-alice", slug: "alice", projectSlug: "demo", sha256, md5Hash, size: 3 });
  expect(h.fetch).toHaveBeenCalledWith(signed.url, expect.objectContaining({ method: "PUT", redirect: "error", headers: { ...signed.requiredHeaders, "content-type": "application/octet-stream" } }));
  expect(h.request.mock.calls[1][1].headers).toMatchObject({ "x-credential": "read-purpose" });
});
it("accepts an existing immutable object only after checksum verification", async () => {
  h.fetch.mockResolvedValue(new Response(null, { status: 412 }));
  await expect(uploadProjectBlobViaBroker("http://api", target, contents, "application/octet-stream")).resolves.toMatchObject({ sha256 });
});
it.each([403, 503])("retains local work when upload returns %s", async status => {
  h.fetch.mockResolvedValue(new Response(null, { status }));
  await expect(uploadProjectBlobViaBroker("http://api", target, contents, "application/octet-stream")).rejects.toThrow(`HTTP ${status}`);
  expect(h.request).toHaveBeenCalledTimes(1);
});
it.each([{ md5Hash: "wrong" }, { size: 4 }, { generation: "" }, { download: { gcsPath: "customers/other/private" } }])("rejects changed stored identity: %j", async changed => {
  h.request.mockReset().mockResolvedValueOnce(Response.json(signed)).mockResolvedValueOnce(Response.json({ ...verified, ...changed }));
  await expect(uploadProjectBlobViaBroker("http://api", target, contents, "application/octet-stream")).rejects.toThrow(/checksum/);
});
it.each([{ gcsPath: "customers/other/private" }, { requiredHeaders: {} }, { url: "http://metadata.google.internal" }, { method: "GET" }])("refuses unexpected upload capabilities: %j", async changed => {
  h.request.mockReset().mockResolvedValueOnce(Response.json({ ...signed, ...changed }));
  await expect(uploadProjectBlobViaBroker("http://api", target, contents, "application/octet-stream")).rejects.toThrow(/identity/);
  expect(h.fetch).not.toHaveBeenCalled();
});
it("refuses a mismatched project prefix before requesting authority", async () => {
  await expect(uploadProjectBlobViaBroker("http://api", { ...target, gcsPrefix: "customers/other/projects/demo" }, contents, "application/octet-stream")).rejects.toThrow(/scope/);
  expect(h.request).not.toHaveBeenCalled();
});

it("uses the existing gateway credential for source project manifest and immutable object reads", async () => {
  const client = projectBlobHydrationClient("http://api");
  await client.workspaceManifestReadUrl({ slug: "alice", projectSlug: "demo" });
  await client.blobMaterializationReadUrl({ slug: "alice", path: "projects/demo/asset.bin", sha256, size: 3 });
  expect(h.request.mock.calls.map(call => call[0])).toEqual(["http://api/internal/fleet/blob/materialization/manifest/read-url", "http://api/internal/fleet/blob/materialization/read-url"]);
  for (const call of h.request.mock.calls) expect(call[1].headers).toMatchObject({ "x-credential": "read-purpose" });
  expect(JSON.parse(h.request.mock.calls[0][1].body)).toEqual({ gatewayId: "b-alice", slug: "alice", projectSlug: "demo" });
  expect(JSON.parse(h.request.mock.calls[1][1].body)).toEqual({ gatewayId: "b-alice", slug: "alice", path: "projects/demo/asset.bin", sha256, size: 3 });
});
