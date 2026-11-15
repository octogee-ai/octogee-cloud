import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { runtimeBlobStore } from "../lib/runtime-blob-store.js";
import type { Request, Response, Router } from "express";
import type { PlatformUserRecord, GatewayAssignment, PlatformStateStore, WorkspaceRecord } from "@octogee/core/platform-state";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { isManifestPath } from "@octogee/core/workspace-manifest";
import { parseMultipart, MAX_UPLOAD_BYTES, UploadTooLargeError } from "../../../gateway-edge/src/routes/workspace/upload.js";
import { validateFilePath } from "../../../gateway-edge/src/lib/path-validation.js";
import { pathHasReservedOrHiddenSegment } from "../../../gateway-edge/src/routes/workspace/helpers.js";
import { WorkspaceStorageQuotaError, type storeWorkspaceBlobCentrally } from "../../../gateway-edge/src/lib/workspace-blob.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { workspaceGiteaOrg, workspaceRepoName } from "@octogee/core/gitea-naming";

export type WorkspaceBlobStore = typeof storeWorkspaceBlobCentrally;
interface AssignedWorkspace { uid: string; slug: string; gatewayId: string }
interface WorkspaceBlobBrokerDeps {
  store: PlatformStateStore;
  authorize: (req: Request, res: Response, slug: string) => Promise<AssignedWorkspace | null>;
  blobStore?: WorkspaceBlobStore;
}

function workspaceOwnerMatches(user: PlatformUserRecord | null, workspace: WorkspaceRecord | null, scope: AssignedWorkspace): boolean {
  return user !== null && accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined }) &&
    user.slug === scope.slug && user.gateway?.gatewayId === scope.gatewayId && user.openclaw.status === "complete" &&
    user.fences.restoreFence === undefined && workspace?.ownerUid === scope.uid && workspace.ownerActive !== false;
}

function checkpointAssignmentMatches(assignment: GatewayAssignment | null, scope: AssignedWorkspace): boolean {
  return assignment?.slug === scope.slug && assignment.gatewayId === scope.gatewayId && ["serving", "quiescing"].includes(assignment.state);
}

async function canonicalWorkspaceOwned(store: PlatformStateStore, scope: AssignedWorkspace): Promise<boolean> {
  return store.transaction({ label: "fleet-broker.workspace-blob-owner", readOnly: true }, async (tx) => {
    const [user, workspace, assignment] = await Promise.all([
      tx.users.records.get(scope.uid), tx.workspaces.records.get(scope.slug), tx.gateways.assignments.get(scope.gatewayId, scope.uid),
    ]);
    return workspaceOwnerMatches(user, workspace, scope) && checkpointAssignmentMatches(assignment, scope);
  });
}

const centralStore: WorkspaceBlobStore = async (target, path, bytes, mimeType, options) => {
  const { storeWorkspaceBlobCentrally } = await import("../../../gateway-edge/src/lib/workspace-blob.js");
  const blobStore = process.env.BLOB_STORE_BACKEND === "gcs" ? undefined : runtimeBlobStore();
  return storeWorkspaceBlobCentrally(target, path, bytes, mimeType, { ...options, blobStore });
};

function workspaceBlobPathAllowed(parsed: Awaited<ReturnType<typeof parseMultipart>>): boolean {
  return parsed.projectSlug === null && isManifestPath(parsed.path) && !validateFilePath(parsed.path) && !pathHasReservedOrHiddenSegment(parsed.path) && parsed.path !== "projects" && !parsed.path.startsWith("projects/");
}

export function installWorkspaceBlobBrokerRoute(router: Router, deps: WorkspaceBlobBrokerDeps): void {
  router.post("/blob/workspace/upload", brokerRequestLimit(1800), async (req, res) => {
    if (req.boundTenant?.kind !== "gateway") { res.status(403).json({ error: "forbidden" }); return; }
    let parsed: Awaited<ReturnType<typeof parseMultipart>>;
    try { parsed = await parseMultipart(req, MAX_UPLOAD_BYTES, { rejectUnexpectedFields: true }); }
    catch (error) {
      res.status(error instanceof UploadTooLargeError ? 413 : 400).json({ error: "invalid_workspace_blob" }); return;
    }
    if (!workspaceBlobPathAllowed(parsed)) {
      res.status(400).json({ error: "invalid_workspace_blob" }); return;
    }
    const assigned = await deps.authorize(req, res, parsed.slug);
    if (!assigned) return;
    if (!await canonicalWorkspaceOwned(deps.store, assigned)) { res.status(403).json({ error: "forbidden" }); return; }
    try {
      const stored = await (deps.blobStore ?? centralStore)({ slug: assigned.slug, projectSlug: null, gcsPrefix: `customers/${assigned.slug}`, provider: "gitea", org: workspaceGiteaOrg(assigned.slug), repoName: workspaceRepoName() }, parsed.path, parsed.fileBuffer, parsed.mimeType);
      res.json(stored);
    } catch (error) {
      if (error instanceof WorkspaceStorageQuotaError) {
        res.status(413).json({ code: error.code, limitBytes: error.limitBytes, projectedBytes: error.projectedBytes }); return;
      }
      logger.error("workspace blob broker storage failed", { slug: assigned.slug, gatewayId: assigned.gatewayId, error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "workspace_blob_save_failed" });
    }
  });
}
