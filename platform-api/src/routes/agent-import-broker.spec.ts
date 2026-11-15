import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { BlobStore } from "../../../gateway-edge/src/lib/blob-store.js";
import { createAgentImportBrokerRoutes } from "./agent-import-broker.js";

interface StoredBlob {
  bytes: Buffer;
  contentType: string;
}

function memoryBlobs() {
  const objects = new Map<string, StoredBlob>();
  const blobs: BlobStore = {
    async save(key, bytes, { contentType }) {
      objects.set(key, { bytes: Buffer.from(bytes), contentType });
    },
    async download(key) {
      const found = objects.get(key);
      return found ? { bytes: found.bytes, revision: "1" } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
    },
    async saveStream(key, source, { contentType }) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      objects.set(key, { bytes: Buffer.concat(chunks), contentType });
    },
    async move(from, to) {
      const found = objects.get(from);
      if (!found) throw Object.assign(new Error("source object is missing"), { code: 404 });
      objects.set(to, found);
      objects.delete(from);
    },
    async metadata() {
      throw new Error("unexpected metadata read");
    },
    async signedUrl() {
      throw new Error("unexpected signed URL");
    },
  };
  return { objects, blobs };
}

function brokerApp(options: { maxArchiveBytes?: number } = {}) {
  const { objects, blobs } = memoryBlobs();
  const store = createDocumentFixtureStore({
    "users/u1": { provisioning: { openclaw: { gatewayId: "shared-a", slug: "alice", status: "complete" } } },
    "workspaces/alice": { id: "ws-alice", ownerUid: "u1" },
  });
  const app = express();
  app.use((req, _res, next) => {
    req.uid = "u1";
    req.boundTenant = { kind: "gateway", gatewayId: "shared-a", ownerUid: "u1" } as Express.Request["boundTenant"];
    next();
  });
  app.use(express.json());
  app.use(createAgentImportBrokerRoutes({
    store,
    accounts: { get: async () => null, getMany: async () => new Map(), list: async () => new Map() },
    blobs: () => blobs,
    readGithubToken: async () => null,
    listGithubRepos: async () => [],
    readGithubRepoSize: async () => 0,
    readIdentity: async () => ({ name: null, persona: null, emoji: null }),
    syncIdentity: async () => undefined,
    replaceIdentity: async () => undefined,
    now: () => new Date("2026-11-13T00:00:00.000Z"),
    newUploadId: () => "upload-1",
    ...options,
  }));
  return { objects, client: request(app) };
}

const plan = { id: "import-1", uid: "u1", slug: "alice", approvalHash: "hash" };

describe("agent import staging", () => {
  it("stages the source archive under the user's import prefix and serves it back", async () => {
    const { objects, client } = brokerApp();
    const archive = Buffer.from("PK archive bytes");

    await client.put("/archives/import-1").set("content-type", "application/zip").send(archive).expect(204);

    expect([...objects.keys()]).toEqual(["agent-imports/u1/import-1/source.zip"]);
    expect(objects.get("agent-imports/u1/import-1/source.zip")).toEqual({ bytes: archive, contentType: "application/zip" });
    const served = await client.get("/archives/import-1").buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    }).expect(200).expect("content-type", "application/zip");
    expect(served.body).toEqual(archive);
  });

  it("answers 404 for an archive that was never staged", async () => {
    const res = await brokerApp().client.get("/archives/import-1");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("refuses an archive over the limit and keeps nothing", async () => {
    const { objects, client } = brokerApp({ maxArchiveBytes: 4 });

    const res = await client.put("/archives/import-1").set("content-type", "application/zip").send(Buffer.from("12345"));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "archive_too_large" });
    expect([...objects.keys()]).toEqual([]);
  });

  it("refuses an empty archive and keeps nothing", async () => {
    const { objects, client } = brokerApp();

    await client.put("/archives/import-1").set("content-type", "application/zip").send(Buffer.alloc(0))
      .expect(400, { error: "invalid_archive", message: "request body is empty" });

    expect([...objects.keys()]).toEqual([]);
  });

  it("keeps the import plan beside the archive", async () => {
    const { objects, client } = brokerApp();

    await client.get("/plans/import-1").expect(404, { error: "not_found" });
    await client.put("/plans/import-1").send(plan).expect(204);

    expect(objects.get("agent-imports/u1/import-1/plan.json")?.contentType).toBe("application/json");
    await client.get("/plans/import-1").expect(200, plan);
  });

  it("deletes only the staged files of one import", async () => {
    const { objects, client } = brokerApp();
    await client.put("/plans/import-1").send(plan).expect(204);
    await client.put("/plans/import-2").send({ ...plan, id: "import-2" }).expect(204);

    await client.delete("/staging/import-1").expect(204);

    expect([...objects.keys()]).toEqual(["agent-imports/u1/import-2/plan.json"]);
  });
});

describe("agent import workspace blobs", () => {
  it("stores a blob under the workspace import prefix and returns its manifest entry", async () => {
    const { objects, client } = brokerApp();
    const bytes = Buffer.from("binary image");

    await client.put("/blobs/import-1").query({ path: "assets/logo.png" })
      .set("content-type", "application/octet-stream").set("x-agent-import-mime", "image/png")
      .send(bytes)
      .expect(201, {
        type: "blob",
        gcsPath: "customers/alice/agent-imports/import-1/assets/logo.png",
        size: bytes.length,
        mimeType: "image/png",
        uploadedAt: "2026-11-13T00:00:00.000Z",
      });

    expect([...objects.keys()]).toEqual(["customers/alice/agent-imports/import-1/assets/logo.png"]);
    expect(objects.get("customers/alice/agent-imports/import-1/assets/logo.png")).toEqual({ bytes, contentType: "image/png" });
  });

  it("deletes every blob of one import", async () => {
    const { objects, client } = brokerApp();
    for (const id of ["import-1", "import-2"]) {
      await client.put(`/blobs/${id}`).query({ path: "a.bin" }).set("content-type", "application/octet-stream")
        .set("x-agent-import-mime", "application/octet-stream").send(Buffer.from("x")).expect(201);
    }

    await client.delete("/blobs/import-1").expect(204);

    expect([...objects.keys()]).toEqual(["customers/alice/agent-imports/import-2/a.bin"]);
  });
});
