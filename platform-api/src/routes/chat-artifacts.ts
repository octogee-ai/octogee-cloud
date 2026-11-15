import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { ArtifactRegistry } from "../lib/chat-artifact-registry.js";
import {
  parseArtifactRequest,
  type ArtifactJob,
  type ArtifactOutputObject,
} from "../lib/chat-artifacts.js";

const ARTIFACT_ID = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class ArtifactAccessDeniedError extends Error {
  override readonly name = "ArtifactAccessDeniedError";
}

class ArtifactContractError extends Error {
  override readonly name = "ArtifactContractError";
}

export interface ArtifactAccessAuthorizer {
  authorizeRequest(mattermostUserId: string, request: unknown): Promise<{
    request: unknown;
    workspaceSlug: string;
    workspaceOwnerUid: string;
  }>;
  assertChannelMember(mattermostUserId: string, channelId: string): Promise<void>;
}

export interface ArtifactBlobStore {
  put(input: {
    artifactId: string;
    attempt: number;
    kind: "markdown" | "page";
    pageNumber?: number;
    body: Buffer;
    sha256: string;
  }): Promise<ArtifactOutputObject>;
  delete(output: ArtifactOutputObject): Promise<void>;
  open(output: ArtifactOutputObject): Promise<{
    stream: Readable;
    byteLength: number;
    mediaType: string;
  }>;
}

async function stageStoredOutput(
  deps: WorkerRoutesDeps,
  artifactId: string,
  workerId: string,
  token: string,
  output: ArtifactOutputObject,
): Promise<void> {
  try {
    await deps.registry.stageOutput(artifactId, workerId, token, output);
  } catch (error) {
    try {
      await deps.blobs.delete(output);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "artifact output publication and compensating deletion failed",
      );
    }
    throw error;
  }
}

export interface ArtifactSourceReader {
  open(mattermostFileId: string): Promise<{
    stream: Readable;
    byteLength?: number;
    mediaType: "application/pdf";
  }>;
}

interface PublicRoutesDeps {
  registry: ArtifactRegistry;
  blobs: ArtifactBlobStore;
  access: ArtifactAccessAuthorizer;
  auth: RequestHandler;
}

interface WorkerRoutesDeps {
  registry: ArtifactRegistry;
  blobs: ArtifactBlobStore;
  source: ArtifactSourceReader;
  auth: RequestHandler;
}

export function requireArtifactWorkerAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.boundTenant?.kind !== "platform" || req.boundTenant.actor !== "artifact-worker") {
    res.status(401).json({ error: "artifact worker authentication required" });
    return;
  }
  next();
}

function artifactId(req: Request): string {
  const value = req.params.artifactId;
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    throw new ArtifactContractError("invalid artifact id");
  }
  return value;
}

function mattermostUserId(req: Request): string {
  const userId = (req.user?.mattermost as { userId?: unknown } | undefined)?.userId;
  if (typeof userId !== "string" || !/^[a-z0-9]{26}$/.test(userId)) {
    throw new Error("authenticated user has no Mattermost identity");
  }
  return userId;
}

function publicJob(job: ArtifactJob): Record<string, unknown> {
  const base = `/api/chat/artifacts/${job.artifactId}`;
  return {
    schemaVersion: job.schemaVersion,
    artifactId: job.artifactId,
    request: job.request,
    status: job.status,
    attempt: job.attempt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.failure ? { failure: job.failure } : {}),
    ...(job.result
      ? {
          result: {
            converter: job.result.converter,
            completedAt: job.result.completedAt,
            markdownUrl: `${base}/markdown`,
            pages: job.result.pages.map((page) => ({
              pageNumber: page.pageNumber,
              byteLength: page.byteLength,
              sha256: page.sha256,
              url: `${base}/pages/${page.pageNumber}`,
            })),
          },
        }
      : {}),
  };
}

async function authorizedJob(
  req: Request,
  registry: ArtifactRegistry,
  access: ArtifactAccessAuthorizer,
): Promise<ArtifactJob | null> {
  const job = await registry.get(artifactId(req));
  if (!job) return null;
  await access.assertChannelMember(mattermostUserId(req), job.request.channelId);
  return job;
}

function streamBlob(res: Response, blob: Awaited<ReturnType<ArtifactBlobStore["open"]>>): void {
  res.setHeader("content-type", blob.mediaType);
  res.setHeader("content-length", String(blob.byteLength));
  res.setHeader("cache-control", "private, max-age=300");
  blob.stream.on("error", (error) => res.destroy(error));
  blob.stream.pipe(res);
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((error) => {
      if (error instanceof ArtifactAccessDeniedError) {
        res.status(403).json({ error: "Artifact access denied" });
        return;
      }
      if (error instanceof ArtifactContractError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

export function createChatArtifactRoutes(deps: PublicRoutesDeps): Router {
  const router = Router();
  router.use(authenticationFailureLimit, deps.auth);

  router.post("/", authenticatedRequestLimit(30), asyncRoute(async (req, res) => {
    let parsed: ReturnType<typeof parseArtifactRequest>;
    try {
      parsed = parseArtifactRequest(req.body);
    } catch (error) {
      throw new ArtifactContractError(error instanceof Error ? error.message : "invalid artifact request");
    }
    const authorized = await deps.access.authorizeRequest(mattermostUserId(req), parsed);
    if (!req.uid) throw new Error("authenticated artifact owner is missing");
    const job = await deps.registry.enqueue(parseArtifactRequest(authorized.request), {
      ownerUid: req.uid,
      workspaceSlug: authorized.workspaceSlug,
      workspaceOwnerUid: authorized.workspaceOwnerUid,
    });
    res.status(job.status === "queued" || job.status === "processing" ? 202 : 200).json(publicJob(job));
  }));

  router.get("/:artifactId", authenticatedRequestLimit(120), asyncRoute(async (req, res) => {
    const job = await authorizedJob(req, deps.registry, deps.access);
    if (!job) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(publicJob(job));
  }));

  router.get("/:artifactId/markdown", authenticatedRequestLimit(120), asyncRoute(async (req, res) => {
    const job = await authorizedJob(req, deps.registry, deps.access);
    if (!job?.result) {
      res.status(job ? 409 : 404).json({ error: job ? "Artifact is not ready" : "Artifact not found" });
      return;
    }
    streamBlob(res, await deps.blobs.open(job.result.markdown));
  }));

  router.get("/:artifactId/pages/:pageNumber", authenticatedRequestLimit(360), asyncRoute(async (req, res) => {
    const job = await authorizedJob(req, deps.registry, deps.access);
    if (!job?.result) {
      res.status(job ? 409 : 404).json({ error: job ? "Artifact is not ready" : "Artifact not found" });
      return;
    }
    const pageNumber = Number(req.params.pageNumber);
    const page = job.result.pages.find((candidate) => candidate.pageNumber === pageNumber);
    if (!page) {
      res.status(404).json({ error: "Artifact page not found" });
      return;
    }
    streamBlob(res, await deps.blobs.open(page));
  }));

  return router;
}

function workerLease(req: Request): { workerId: string; token: string } {
  const workerId = req.get("x-artifact-worker-id");
  const token = req.get("x-artifact-lease");
  if (!workerId || !token) throw new ArtifactContractError("artifact worker lease headers are required");
  return { workerId, token };
}

function knownWorkerError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ArtifactContractError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (
    error instanceof Error &&
    (error.message.includes("lease") || error.message.includes("source verification"))
  ) {
    res.status(409).json({ error: error.message });
    return;
  }
  next(error);
}

function workerRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch((error) => knownWorkerError(error, res, next));
  };
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function outputBody(req: Request): { body: Buffer; digest: string } {
  if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
    throw new ArtifactContractError("artifact output body required");
  }
  const claimed = req.get("x-content-sha256")?.toLowerCase();
  if (!claimed || !SHA256.test(claimed) || sha256(req.body) !== claimed) {
    throw new ArtifactContractError("artifact output checksum mismatch");
  }
  return { body: req.body, digest: claimed };
}

function assertMarkdownBytes(body: Buffer): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ArtifactContractError("artifact Markdown output must be UTF-8");
  }
}

function assertWebpBytes(body: Buffer): void {
  if (
    body.byteLength < 12 ||
    body.toString("ascii", 0, 4) !== "RIFF" ||
    body.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new ArtifactContractError("artifact page output must be WebP");
  }
}

function completion(value: unknown):
  | { outcome: "ready"; pageCount: number; converter: { name: string; version: string } }
  | { outcome: "unsupported" | "failed"; code: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactContractError("invalid artifact completion");
  }
  const input = value as Record<string, unknown>;
  if (input.outcome === "ready") {
    const converter = input.converter as Record<string, unknown> | undefined;
    if (
      !Number.isSafeInteger(input.pageCount) ||
      typeof converter?.name !== "string" ||
      typeof converter.version !== "string" ||
      converter.name.length === 0 ||
      converter.version.length === 0
    ) {
      throw new ArtifactContractError("invalid ready artifact completion");
    }
    return {
      outcome: "ready",
      pageCount: input.pageCount as number,
      converter: { name: converter.name, version: converter.version },
    };
  }
  if (
    (input.outcome === "unsupported" || input.outcome === "failed") &&
    typeof input.code === "string" &&
    typeof input.message === "string"
  ) {
    return { outcome: input.outcome, code: input.code, message: input.message };
  }
  throw new ArtifactContractError("invalid artifact completion");
}

export function createChatArtifactWorkerRoutes(deps: WorkerRoutesDeps): Router {
  const router = Router();
  router.use(deps.auth);

  router.post("/claim", workerRoute(async (req, res) => {
    const workerId = req.body?.workerId;
    const claim = await deps.registry.claimNext(workerId);
    if (!claim) {
      res.status(204).end();
      return;
    }
    res.json(claim);
  }));

  router.post("/:artifactId/lease", workerRoute(async (req, res) => {
    const id = artifactId(req);
    const lease = workerLease(req);
    const job = await deps.registry.renewLease(id, lease.workerId, lease.token);
    res.json({ artifactId: id, expiresAt: job.lease?.expiresAt });
  }));

  router.get("/:artifactId/source", workerRoute(async (req, res) => {
    const id = artifactId(req);
    const lease = workerLease(req);
    const job = await deps.registry.assertLease(id, lease.workerId, lease.token);
    const source = await deps.source.open(job.request.mattermostFileId);
    res.setHeader("content-type", source.mediaType);
    if (source.byteLength !== undefined) res.setHeader("content-length", String(source.byteLength));
    res.setHeader("cache-control", "no-store");
    source.stream.on("error", (error) => res.destroy(error));
    source.stream.pipe(res);
  }));

  router.post("/:artifactId/source/verify", workerRoute(async (req, res) => {
    const id = artifactId(req);
    const lease = workerLease(req);
    const sha256 = req.body?.sha256;
    const byteLength = req.body?.byteLength;
    if (typeof sha256 !== "string" || !SHA256.test(sha256) || !Number.isSafeInteger(byteLength)) {
      throw new ArtifactContractError("invalid artifact source verification");
    }
    const job = await deps.registry.verifySource(id, lease.workerId, lease.token, { sha256, byteLength });
    res.json({ artifactId: id, source: job.source });
  }));

  const rawOutput = express.raw({ type: "application/octet-stream", limit: "8mb" });
  router.put("/:artifactId/outputs/markdown", rawOutput, workerRoute(async (req, res) => {
    const id = artifactId(req);
    const lease = workerLease(req);
    const job = await deps.registry.assertLease(id, lease.workerId, lease.token);
    const output = outputBody(req);
    assertMarkdownBytes(output.body);
    const stored = await deps.blobs.put({
      artifactId: id,
      attempt: job.attempt,
      kind: "markdown",
      body: output.body,
      sha256: output.digest,
    });
    await stageStoredOutput(deps, id, lease.workerId, lease.token, stored);
    res.status(201).json(stored);
  }));

  router.put("/:artifactId/outputs/pages/:pageNumber", rawOutput, workerRoute(async (req, res) => {
    const id = artifactId(req);
    const lease = workerLease(req);
    const job = await deps.registry.assertLease(id, lease.workerId, lease.token);
    const pageNumber = Number(req.params.pageNumber);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 500) {
      throw new ArtifactContractError("invalid artifact page number");
    }
    const output = outputBody(req);
    if (output.body.byteLength > 4 * 1024 * 1024) {
      throw new ArtifactContractError("artifact page output is too large");
    }
    assertWebpBytes(output.body);
    const stored = await deps.blobs.put({
      artifactId: id,
      attempt: job.attempt,
      kind: "page",
      pageNumber,
      body: output.body,
      sha256: output.digest,
    });
    await stageStoredOutput(deps, id, lease.workerId, lease.token, stored);
    res.status(201).json(stored);
  }));

  router.post("/:artifactId/complete", workerRoute(async (req, res) => {
    const id = artifactId(req);
    const lease = workerLease(req);
    const job = await deps.registry.complete(id, lease.workerId, lease.token, completion(req.body));
    res.json({ artifactId: job.artifactId, status: job.status, updatedAt: job.updatedAt });
  }));

  return router;
}
