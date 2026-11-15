import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import type { BlobStore } from "../../../gateway-edge/src/lib/blob-store.js";
import { registerAgentExportBrokerRoutes } from "./agent-export-broker.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { UserAccountReader } from "@octogee/core/user-account";
import {
  agentImportRecordFromPayload,
  type AgentImportRecord,
  type PlatformUserRecord,
  type PlatformStateStore,
} from "@octogee/core/platform-state";
import { classifyAgentImportArchivePath } from "@octogee/shared/types/agent-import";
import {
  isAgentImportAuthorizationIntent,
  type AgentImportAuthorizationIntent,
} from "@octogee/shared/types/agent-import";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import type { FeaturePolicy } from "@octogee/shared/types/feature-flags";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";
import type { AgentImportManifestEntry } from "../../../gateway-edge/src/lib/agent-import-git.js";
import type {
  AgentImportIdentity,
  AgentImportIdentitySnapshot,
} from "../../../gateway-edge/src/lib/agent-import-service.js";

const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RECOVERY_STATUSES = new Set([
  "workspace", "identity", "config", "verifying", "complete", "failed",
  "rolling_back", "rollback_failed", "rolled_back",
]);

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;
type JsonObject = Record<string, unknown>;

export interface AgentImportBrokerDeps {
  store: PlatformStateStore;
  accounts: UserAccountReader;
  blobs: () => BlobStore;
  readGithubToken(uid: string): Promise<string | null>;
  listGithubRepos(token: string): Promise<unknown>;
  readGithubRepoSize(owner: string, repo: string, token: string): Promise<number>;
  readIdentity(uid: string): Promise<AgentImportIdentitySnapshot>;
  syncIdentity(uid: string, identity: AgentImportIdentity): Promise<void>;
  replaceIdentity(uid: string, identity: AgentImportIdentitySnapshot): Promise<void>;
  now(): Date;
  maxArchiveBytes?: number;
  maxBlobBytes?: number;
  newUploadId?(): string;
  featurePolicy?: FeaturePolicy;
}

export interface OwnerContext {
  uid: string;
  slug: string;
  gatewayId: string;
  isAdmin: boolean;
  workspacePolicy: { preserveConvergedContextFiles: boolean };
}

type BrokerRouter = ReturnType<typeof Router>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function safeUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/");
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return bound;
}

function assignedWorkspaceSlug(user: PlatformUserRecord | null, gatewayId: string, res: Response): string | null {
  const slug = user?.slug ?? null;
  if (!user || !slug || !isValidUsername(slug) || user.gateway?.gatewayId !== gatewayId) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (user.openclaw.status !== "complete") {
    res.status(409).json({ error: "openclaw_not_ready" });
    return null;
  }
  return slug;
}

async function ownerContext(
  req: Request,
  res: Response,
  deps: AgentImportBrokerDeps,
): Promise<OwnerContext | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const uid = authenticatedUid(req, res, bound);
  if (!uid) return null;
  const user = await deps.store.users.records.get(uid);
  const slug = assignedWorkspaceSlug(user, bound.gatewayId, res);
  if (!slug) return null;
  const [workspace, account] = await Promise.all([deps.store.workspaces.records.get(slug), deps.accounts.get(uid)]);
  if (workspace?.ownerUid !== uid) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  const planInputs = account?.planInputs ?? {};
  return {
    uid,
    slug,
    gatewayId: bound.gatewayId,
    isAdmin: user?.role === "admin",
    workspacePolicy: {
      preserveConvergedContextFiles: userEntitlements().policy(planInputs, deps.now()).modelAccess === "house_only",
    },
  };
}

function authenticatedUid(req: Request, res: Response, bound: GatewayBinding): string | null {
  if (!safeUid(req.uid)) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (bound.ownerUid && bound.ownerUid !== req.uid) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return req.uid;
}

function importId(req: Request, res: Response): string | null {
  const value = req.params.importId;
  if (typeof value !== "string" || value.startsWith("export-") || !IMPORT_ID_RE.test(value)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return value;
}

function ownedPayload(value: unknown, context: OwnerContext): JsonObject | null {
  const payload = object(value);
  return payload?.kind !== "authored-agent-export" && payload?.uid === context.uid && payload.slug === context.slug
    ? payload
    : null;
}

function isoTime(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function storablePayload(payload: JsonObject): boolean {
  return typeof payload.status === "string" && isoTime(payload.createdAt) && isoTime(payload.updatedAt) &&
    (payload.importCommit === undefined || payload.importCommit === null || typeof payload.importCommit === "string");
}

function durableRecord(owner: OwnerContext, id: string, payload: JsonObject, now: Date): AgentImportRecord {
  const { cleanupAt: _cleanupAt, ...record } = payload;
  const rollbackEligible = typeof record.importCommit === "string" && record.status !== "rolled_back";
  return agentImportRecordFromPayload(owner.uid, id, record, now.getTime() + (rollbackEligible ? 8 : 1) * DAY_MS);
}

function stagingPath(owner: OwnerContext, id: string, name: string): string {
  return `agent-imports/${owner.uid}/${id}/${name}`;
}

async function streamRequestBody(
  req: Request,
  deps: AgentImportBrokerDeps,
  objectPath: string,
  limit: number,
  contentType: string,
): Promise<number> {
  const blobs = deps.blobs();
  const uploadId = deps.newUploadId?.() ?? randomUUID();
  const temporaryPath = `${objectPath}.upload-${uploadId}`;
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        callback(Object.assign(new Error("request body exceeds the import limit"), {
          status: 413,
          code: "archive_too_large",
        }));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, (source: AsyncIterable<Uint8Array>) => blobs.saveStream(temporaryPath, source, { contentType }));
    if (size === 0) {
      throw Object.assign(new Error("request body is empty"), {
        status: 400,
        code: "invalid_archive",
      });
    }
    await blobs.move(temporaryPath, objectPath);
  } catch (error) {
    req.resume();
    try {
      await blobs.delete(temporaryPath);
    } catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError], "import upload cleanup failed"), {
        status: typeof object(error)?.status === "number" ? object(error)?.status : 500,
        code: typeof object(error)?.code === "string" ? object(error)?.code : "upload_cleanup_failed",
      });
    }
    throw error;
  }
  return size;
}

function identity(value: unknown): AgentImportIdentity | null {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !["name", "persona", "emoji"].includes(key))) return null;
  if (Object.values(input).some((entry) => entry !== undefined && typeof entry !== "string")) return null;
  return input as AgentImportIdentity;
}

function identitySnapshot(value: unknown): AgentImportIdentitySnapshot | null {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !["name", "persona", "emoji"].includes(key))) return null;
  if (!["name", "persona", "emoji"].every((key) => Object.prototype.hasOwnProperty.call(input, key))) return null;
  if (Object.values(input).some((entry) => entry !== null && typeof entry !== "string")) return null;
  return input as unknown as AgentImportIdentitySnapshot;
}

async function githubToken(context: OwnerContext, deps: AgentImportBrokerDeps): Promise<string> {
  const token = await deps.readGithubToken(context.uid);
  if (!token) throw Object.assign(new Error("GitHub not connected"), { status: 422, code: "github_not_connected" });
  return token;
}

function context(res: Response): OwnerContext {
  return res.locals.agentImportOwner as OwnerContext;
}

function releaseGateIntent(intent: AgentImportAuthorizationIntent): boolean {
  return intent === "source_listing" || intent === "preview" || intent === "apply";
}

function registerAccessRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.post("/authorize", brokerRequestLimit(360, "user"), async (req, res, next) => {
    const owner = context(res);
    const body = object(req.body);
    if (
      !body ||
      Object.keys(body).length !== 2 ||
      !isValidGatewayId(body.gatewayId) ||
      body.gatewayId !== owner.gatewayId ||
      !isAgentImportAuthorizationIntent(body.intent)
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      if (deps.featurePolicy && releaseGateIntent(body.intent)) {
        const decision = await deps.featurePolicy.evaluate("release-agent-import", {
          uid: owner.uid,
          isAdmin: owner.isAdmin,
          workspaceSlug: owner.slug,
        }, "agent-import");
        if (decision.state === "disabled") {
          res.status(404).json({ error: "feature_unavailable" });
          return;
        }
        if (decision.state === "unavailable") {
          res.status(503).json({ error: "feature_evaluation_unavailable" });
          return;
        }
      }
      res.json({
        slug: owner.slug,
        gatewayId: owner.gatewayId,
        workspacePolicy: owner.workspacePolicy,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/github/sources", async (_req, res, next) => {
    try {
      const owner = context(res);
      res.json(await deps.listGithubRepos(await githubToken(owner, deps)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/github/token", async (_req, res, next) => {
    try {
      res.json({ token: await githubToken(context(res), deps) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/github/repos/:owner/:repo/size", async (req, res, next) => {
    try {
      const owner = context(res);
      if (!GITHUB_OWNER_RE.test(req.params.owner) || !GITHUB_REPO_RE.test(req.params.repo)) {
        res.status(400).json({ error: "invalid_github_source" });
        return;
      }
      res.json({ sizeKiB: await deps.readGithubRepoSize(req.params.owner, req.params.repo, await githubToken(owner, deps)) });
    } catch (error) {
      next(error);
    }
  });
}

function registerRecordRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/records/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const owner = context(res);
      const payload = ownedPayload(req.body, owner);
      if (!payload || payload.id !== id || !storablePayload(payload)) {
        res.status(400).json({ error: "invalid_import_record" });
        return;
      }
      const now = deps.now();
      const record = durableRecord(owner, id, payload, now);
      await deps.store.transaction({ label: "agent-import.record" }, async (tx) => {
        await tx.jobs.agentImports.put(record);
        if (RECOVERY_STATUSES.has(record.status)) {
          await tx.jobs.agentImports.putPointer(owner.uid, "latest", { importId: id, slug: owner.slug, updatedAt: now.getTime() });
        }
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/records/latest", async (_req, res, next) => {
    try {
      const owner = context(res);
      const pointer = await deps.store.jobs.agentImports.getPointer(owner.uid, "latest");
      const id = pointer?.slug === owner.slug && IMPORT_ID_RE.test(pointer.importId) ? pointer.importId : null;
      if (!id) {
        res.json(null);
        return;
      }
      const stored = await deps.store.jobs.agentImports.get(owner.uid, id);
      res.json(stored ? ownedPayload(stored.record, owner) : null);
    } catch (error) {
      next(error);
    }
  });

  router.get("/records/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const stored = await deps.store.jobs.agentImports.get(context(res).uid, id);
      const payload = stored ? ownedPayload(stored.record, context(res)) : null;
      if (!payload || payload.id !== id) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/records/:importId/abandon", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const owner = context(res);
      const requested = ownedPayload(req.body, owner);
      if (
        !requested || requested.id !== id || requested.status !== "abandoned" ||
        typeof requested.updatedAt !== "string" || requested.updatedAt.length > 100 || !isoTime(requested.updatedAt)
      ) {
        res.status(400).json({ error: "invalid_import_record" });
        return;
      }
      const abandoned = await deps.store.transaction({ label: "agent-import.abandon" }, async (tx) => {
        const [stored, pointer] = await Promise.all([
          tx.jobs.agentImports.get(owner.uid, id),
          tx.jobs.agentImports.getPointer(owner.uid, "latest"),
        ]);
        const current = stored ? ownedPayload(stored.record, owner) : null;
        if (!current || current.id !== id) {
          throw Object.assign(new Error("agent import was not found"), { status: 404, code: "not_found" });
        }
        if (current.importCommit || !["previewed", "workspace", "failed", "abandoned"].includes(String(current.status))) {
          throw Object.assign(new Error("an applied workspace import cannot be abandoned"), {
            status: 409,
            code: "invalid_import_state",
          });
        }
        const { error: _error, ...kept } = current;
        const next = durableRecord(owner, id, { ...kept, status: "abandoned", updatedAt: requested.updatedAt }, deps.now());
        await tx.jobs.agentImports.put(next);
        if (pointer?.importId === id && pointer.slug === owner.slug) await tx.jobs.agentImports.deletePointer(owner.uid, "latest");
        return next.record;
      });
      res.json(abandoned);
    } catch (error) {
      next(error);
    }
  });
}

function registerPlanRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/plans/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const payload = ownedPayload(req.body, context(res));
      if (!payload || typeof payload.approvalHash !== "string") {
        res.status(400).json({ error: "invalid_import_plan" });
        return;
      }
      await deps.blobs().save(stagingPath(context(res), id, "plan.json"), JSON.stringify(payload), {
        contentType: "application/json",
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/plans/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const stored = await deps.blobs().download(stagingPath(context(res), id, "plan.json"));
      const payload = stored ? ownedPayload(JSON.parse(stored.bytes.toString("utf8")), context(res)) : null;
      if (!payload || typeof payload.approvalHash !== "string") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}

function registerArchiveRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/archives/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      if (!req.is("application/zip")) {
        req.resume();
        res.status(415).json({ error: "invalid_archive" });
        return;
      }
      await streamRequestBody(
        req,
        deps,
        stagingPath(context(res), id, "source.zip"),
        deps.maxArchiveBytes ?? MAX_ARCHIVE_BYTES,
        "application/zip",
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/archives/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const archive = await deps.blobs().download(stagingPath(context(res), id, "source.zip"));
      if (!archive) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.type("application/zip").send(archive.bytes);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/staging/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      await deps.blobs().deletePrefix(stagingPath(context(res), id, ""));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function registerBlobRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/blobs/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const filePath = typeof req.query.path === "string" ? req.query.path : "";
      const mimeType = req.get("x-agent-import-mime") ?? "";
      if (classifyAgentImportArchivePath(`workspace/${filePath}`) !== "workspace" || !mimeType || mimeType.length > 200) {
        req.resume();
        res.status(400).json({ error: "invalid_import_blob" });
        return;
      }
      const objectPath = `customers/${context(res).slug}/agent-imports/${id}/${filePath}`;
      const size = await streamRequestBody(
        req,
        deps,
        objectPath,
        deps.maxBlobBytes ?? MAX_BLOB_BYTES,
        mimeType,
      );
      const manifest: AgentImportManifestEntry = {
        type: "blob",
        gcsPath: objectPath,
        size,
        mimeType,
        uploadedAt: deps.now().toISOString(),
      };
      res.status(201).json(manifest);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/blobs/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      await deps.blobs().deletePrefix(`customers/${context(res).slug}/agent-imports/${id}/`);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function registerIdentityRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.get("/identity", async (_req, res, next) => {
    try {
      res.json(await deps.readIdentity(context(res).uid));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/identity", async (req, res, next) => {
    try {
      const value = identity(req.body);
      if (!value) {
        res.status(400).json({ error: "invalid_identity" });
        return;
      }
      await deps.syncIdentity(context(res).uid, value);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.put("/identity", async (req, res, next) => {
    try {
      const value = identitySnapshot(req.body);
      if (!value) {
        res.status(400).json({ error: "invalid_identity" });
        return;
      }
      await deps.replaceIdentity(context(res).uid, value);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function agentImportBrokerError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  const data = object(error);
  if (typeof data?.status !== "number" || typeof data.code !== "string") {
    next(error);
    return;
  }
  res.status(data.status).json({
    error: data.code,
    message: error instanceof Error ? error.message : "Agent import broker failed",
  });
}

export function createAgentImportBrokerRoutes(deps: AgentImportBrokerDeps): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      const owner = await ownerContext(req, res, deps);
      if (!owner) return;
      res.locals.agentImportOwner = owner;
      next();
    } catch (error) {
      next(error);
    }
  });

  registerAgentExportBrokerRoutes(router, deps, context);
  registerAccessRoutes(router, deps);
  registerRecordRoutes(router, deps);
  registerPlanRoutes(router, deps);
  registerArchiveRoutes(router, deps);
  registerBlobRoutes(router, deps);
  registerIdentityRoutes(router, deps);
  router.use(agentImportBrokerError);

  return router;
}
