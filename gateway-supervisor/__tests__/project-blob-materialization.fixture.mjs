import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { createBrokeredProjectBlobHydrator } from "./reader.ts";

let mode = "success";
const entry = { type: "blob", gcsPath: "customers/owner/projects/app/images/a.png", size: 3, mimeType: "image/png", uploadedAt: "2026-10-07T00:00:00Z" };
const server = createServer((request, response) => {
  if (request.url === "/manifest") {
    response.setHeader("x-goog-generation", "23");
    response.end(JSON.stringify({ "images/a.png": { ...entry, ...(mode === "foreign" ? { gcsPath: "customers/other/private" } : {}) } }));
  } else {
    assert.equal(request.url, "/blob?generation=17");
    response.setHeader("x-goog-generation", mode === "generation" ? "18" : "17");
    if (mode === "interruption") { response.write("a"); setImmediate(() => response.destroy()); }
    else response.end(mode === "checksum" ? "xyz" : "abc");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const hydrate = createBrokeredProjectBlobHydrator({
  workspaceManifestReadUrl: async () => ({ url: `${base}/manifest`, method: "GET" }),
  blobMaterializationReadUrl: async input => {
    assert.deepEqual(input, { slug: "owner", path: "projects/app/images/a.png", size: 3 });
    return { generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==",
      download: { url: `${base}/blob?generation=17`, method: "GET", gcsPath: entry.gcsPath } };
  },
});
const root = await fs.mkdtemp(path.join(os.tmpdir(), "blob-native-"));
try {
  for (mode of ["success", "checksum", "generation", "interruption", "quota", "foreign", "symlink"]) {
    const destination = path.join(root, mode); await fs.mkdir(destination); await fs.mkdir(path.join(destination, ".git"));
    const durable = path.join(root, "durable");
    if (mode === "symlink") { await fs.mkdir(durable); await fs.symlink(durable, path.join(destination, "images")); }
    const input = { slug: "owner", project: "app", destination, maxBytes: mode === "quota" ? 2 : 8 };
    if (mode === "success") {
      assert.deepEqual(await hydrate(input), { bytes: 3, files: 1, generation: "23" });
      assert.equal(await fs.readFile(path.join(destination, "images/a.png"), "utf8"), "abc");
    } else {
      await assert.rejects(hydrate(input));
      await assert.rejects(fs.stat(path.join(destination, "images/a.png")), { code: "ENOENT" });
      if (mode === "symlink") assert.deepEqual(await fs.readdir(durable), []);
    }
  }
  console.log(`native blob scenarios: 7 passed; ${process.platform}/${process.arch}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await new Promise(resolve => server.close(resolve));
}
