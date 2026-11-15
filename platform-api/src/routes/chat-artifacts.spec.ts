import express, { type RequestHandler } from "express";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ArtifactRegistry, type ArtifactJobStore } from "../lib/chat-artifact-registry.js";
import type { ArtifactJob, ArtifactOutputObject } from "../lib/chat-artifacts.js";
import {
  createChatArtifactRoutes,
  createChatArtifactWorkerRoutes,
  ArtifactAccessDeniedError,
  requireArtifactWorkerAuth,
  type ArtifactAccessAuthorizer,
  type ArtifactBlobStore,
} from "./chat-artifacts.js";

const FILE_ID = "f".repeat(26);
const CHANNEL_ID = "c".repeat(26);
const POST_ID = "p".repeat(26);
const ROOT_ID = "r".repeat(26);

class MemoryStore implements ArtifactJobStore {
  readonly jobs = new Map<string, ArtifactJob>();
  async createIfAbsent(job: ArtifactJob) {
    const value = this.jobs.get(job.artifactId) ?? job;
    this.jobs.set(job.artifactId, structuredClone(value));
    return structuredClone(value);
  }
  async get(id: string) {
    const value = this.jobs.get(id);
    return value ? structuredClone(value) : null;
  }
  async findClaimable() {
    return [...this.jobs.values()]
      .filter((job) => job.status === "queued" || job.status === "processing")
      .map((job) => job.artifactId);
  }
  async transact(id: string, update: (job: ArtifactJob | null) => ArtifactJob) {
    const next = update(await this.get(id));
    this.jobs.set(id, structuredClone(next));
    return structuredClone(next);
  }
}

class MemoryBlobs implements ArtifactBlobStore {
  readonly values = new Map<string, { body: Buffer; output: ArtifactOutputObject }>();

  async put(input: {
    artifactId: string;
    attempt: number;
    kind: "markdown" | "page";
    pageNumber?: number;
    body: Buffer;
    sha256: string;
  }): Promise<ArtifactOutputObject> {
    const objectPath = input.kind === "markdown"
      ? `chat-artifacts/${input.artifactId}/attempts/${input.attempt}/markdown.md`
      : `chat-artifacts/${input.artifactId}/attempts/${input.attempt}/pages/${input.pageNumber}.webp`;
    const output: ArtifactOutputObject = input.kind === "markdown"
      ? {
          kind: "markdown",
          objectPath,
          mediaType: "text/markdown; charset=utf-8",
          byteLength: input.body.byteLength,
          sha256: input.sha256,
        }
      : {
          kind: "page",
          pageNumber: input.pageNumber!,
          objectPath,
          mediaType: "image/webp",
          byteLength: input.body.byteLength,
          sha256: input.sha256,
        };
    this.values.set(objectPath, { body: input.body, output });
    return output;
  }

  async open(output: ArtifactOutputObject) {
    const value = this.values.get(output.objectPath);
    if (!value) throw new Error("missing test blob");
    return {
      stream: Readable.from(value.body),
      byteLength: value.body.byteLength,
      mediaType: value.output.mediaType,
    };
  }

  async delete(output: ArtifactOutputObject): Promise<void> {
    this.values.delete(output.objectPath);
  }
}

function harness() {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  let lease = 0;
  const registry = new ArtifactRegistry(store, {
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    leaseToken: () => `lease-${++lease}-${"x".repeat(32)}`,
  });
  const firebaseAuth: RequestHandler = (req, _res, next) => {
    req.uid = "builder-1";
    req.workspaceSlug = "builder-one";
    req.user = { mattermost: { userId: "u".repeat(26) } };
    next();
  };
  const workerAuth: RequestHandler = (_req, _res, next) => next();
  const access: ArtifactAccessAuthorizer = {
    authorizeRequest: async (_mmUserId: string, value: unknown) => ({
      request: value,
      workspaceSlug: "channel-workspace",
      workspaceOwnerUid: "workspace-owner",
    }),
    assertChannelMember: async () => undefined,
  };
  const source = {
    open: async () => ({
      stream: Readable.from(Buffer.from("%PDF-source")),
      byteLength: 11,
      mediaType: "application/pdf" as const,
    }),
  };
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use("/api/chat/artifacts", createChatArtifactRoutes({ registry, blobs, access, auth: firebaseAuth }));
  app.use(
    "/internal/chat-artifacts",
    createChatArtifactWorkerRoutes({ registry, blobs, source, auth: workerAuth }),
  );
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, store, blobs, access, registry };
}

function artifactRequest() {
  return {
    mattermostFileId: FILE_ID,
    channelId: CHANNEL_ID,
    sourcePostId: POST_ID,
    runRootPostId: ROOT_ID,
    runId: "run-17",
    filename: "report.pdf",
    mediaType: "application/pdf",
    byteLength: 11,
  };
}

describe("chat artifact routes", () => {
  it("admits only the platform worker identity", async () => {
    const denied = express().post("/", requireArtifactWorkerAuth, (_req, res) => res.sendStatus(204));
    await request(denied).post("/").expect(401);
    const admitted = express()
      .use((req, _res, next) => {
        req.boundTenant = { kind: "platform", actor: "artifact-worker" };
        next();
      })
      .post("/", requireArtifactWorkerAuth, (_req, res) => res.sendStatus(204));
    await request(admitted).post("/").expect(204);
    const wrongPlatformActor = express()
      .use((req, _res, next) => {
        req.boundTenant = { kind: "platform", actor: "octogee-api" };
        next();
      })
      .post("/", requireArtifactWorkerAuth, (_req, res) => res.sendStatus(204));
    await request(wrongPlatformActor).post("/").expect(401);
  });

  it("returns a client error for malformed enqueue input", async () => {
    const h = harness();
    const response = await request(h.app)
      .post("/api/chat/artifacts")
      .send({ mediaType: "application/pdf" })
      .expect(400);
    expect(response.body.error).toBeTypeOf("string");
  });

  it("enqueues an authorized Mattermost original idempotently", async () => {
    const h = harness();
    const first = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const second = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    expect(first.body.artifactId).toBe(second.body.artifactId);
    expect(first.body.status).toBe("queued");
    expect(h.store.jobs).toHaveLength(1);
    expect(h.store.jobs.values().next().value).toMatchObject({
      ownerUid: "builder-1",
      workspaceSlug: "channel-workspace",
      workspaceOwnerUid: "workspace-owner",
    });
  });

  it("checks current channel membership before returning job state", async () => {
    const h = harness();
    let checked: string | undefined;
    h.access.assertChannelMember = async (_user, channelId) => { checked = channelId; };
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const result = await request(h.app).get(`/api/chat/artifacts/${created.body.artifactId}`).expect(200);
    expect(checked).toBe(CHANNEL_ID);
    expect(result.body).not.toHaveProperty("lease");
    expect(result.body).not.toHaveProperty("staged");
  });

  it("does not reveal artifact state after Mattermost membership is lost", async () => {
    const h = harness();
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    h.access.assertChannelMember = async () => {
      throw new ArtifactAccessDeniedError("not a channel member");
    };
    await request(h.app).get(`/api/chat/artifacts/${created.body.artifactId}`).expect(403);
  });

  it("runs the authenticated worker claim, source, output, and completion contract", async () => {
    const h = harness();
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const claim = await request(h.app)
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "pdf-worker-1" })
      .expect(200);
    expect(claim.body.job.artifactId).toBe(created.body.artifactId);
    expect(claim.body.leaseToken).toMatch(/^lease-/);

    await request(h.app)
      .post(`/internal/chat-artifacts/${created.body.artifactId}/lease`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .expect(200);

    await request(h.app)
      .get(`/internal/chat-artifacts/${created.body.artifactId}/source`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .expect("content-type", /application\/pdf/)
      .expect(200);

    await request(h.app)
      .post(`/internal/chat-artifacts/${created.body.artifactId}/source/verify`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .send({
        sha256: createHash("sha256").update(Buffer.from("%PDF-source")).digest("hex"),
        byteLength: 11,
      })
      .expect(200);

    const markdown = Buffer.from("# Extracted\n");
    await request(h.app)
      .put(`/internal/chat-artifacts/${created.body.artifactId}/outputs/markdown`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .set("x-content-sha256", createHash("sha256").update(markdown).digest("hex"))
      .set("content-type", "application/octet-stream")
      .send(markdown)
      .expect(201);
    const page = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPpage");
    await request(h.app)
      .put(`/internal/chat-artifacts/${created.body.artifactId}/outputs/pages/1`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .set("x-content-sha256", createHash("sha256").update(page).digest("hex"))
      .set("content-type", "application/octet-stream")
      .send(page)
      .expect(201);
    await request(h.app)
      .post(`/internal/chat-artifacts/${created.body.artifactId}/complete`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .send({
        outcome: "ready",
        pageCount: 1,
        converter: { name: "pdf-inspector+pdfium", version: "contract-v1" },
      })
      .expect(200);

    const manifest = await request(h.app).get(`/api/chat/artifacts/${created.body.artifactId}`).expect(200);
    expect(manifest.body.status).toBe("ready");
    expect(manifest.body.result.markdownUrl).toContain("/markdown");
    expect(manifest.body.result.pages[0].url).toContain("/pages/1");
    const downloaded = await request(h.app)
      .get(`/api/chat/artifacts/${created.body.artifactId}/markdown`)
      .expect("content-type", /text\/markdown/)
      .expect(200);
    expect(downloaded.text).toBe(markdown.toString("utf8"));
  });

  it("will not publish derivatives before canonical source verification", async () => {
    const h = harness();
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const claim = await request(h.app)
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "pdf-worker-1" })
      .expect(200);
    const response = await request(h.app)
      .post(`/internal/chat-artifacts/${created.body.artifactId}/complete`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .send({
        outcome: "ready",
        pageCount: 1,
        converter: { name: "pdf-inspector+pdfium", version: "contract-v1" },
      })
      .expect(409);
    expect(response.body.error).toContain("source verification");
  });

  it("does not expose source or accept output without the active lease", async () => {
    const h = harness();
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const response = await request(h.app)
      .get(`/internal/chat-artifacts/${created.body.artifactId}/source`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", "wrong")
      .expect(409);
    expect(response.body.error).toContain("lease");
  });

  it("deletes a just-written derivative when lifecycle fencing rejects publication", async () => {
    const h = harness();
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const claim = await request(h.app)
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "pdf-worker-1" })
      .expect(200);
    vi.spyOn(h.registry, "stageOutput").mockRejectedValueOnce(
      new Error("artifact workspace owner is not active"),
    );
    const markdown = Buffer.from("# Extracted\n");

    await request(h.app)
      .put(`/internal/chat-artifacts/${created.body.artifactId}/outputs/markdown`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .set("x-content-sha256", createHash("sha256").update(markdown).digest("hex"))
      .set("content-type", "application/octet-stream")
      .send(markdown)
      .expect(500);

    expect(h.blobs.values).toHaveLength(0);
  });

  it("rejects output bytes that do not match the declared derivative format", async () => {
    const h = harness();
    const created = await request(h.app).post("/api/chat/artifacts").send(artifactRequest()).expect(202);
    const claim = await request(h.app)
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "pdf-worker-1" })
      .expect(200);
    const invalid = Buffer.from("not-webp");
    const response = await request(h.app)
      .put(`/internal/chat-artifacts/${created.body.artifactId}/outputs/pages/1`)
      .set("x-artifact-worker-id", "pdf-worker-1")
      .set("x-artifact-lease", claim.body.leaseToken)
      .set("x-content-sha256", createHash("sha256").update(invalid).digest("hex"))
      .set("content-type", "application/octet-stream")
      .send(invalid)
      .expect(400);
    expect(response.body.error).toContain("WebP");
  });
});
