import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request } from "express";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import type { SizingKeyReader } from "@octogee/core/sizing-key";
import type { PlatformStateRepositories, PlatformStateStore } from "@octogee/core/platform-state";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { resolveWorkspaceConversation, resolveWorkspaceToolChannel, resolveWorkspaceToolControl, type WorkspaceConversationDeps } from "../lib/workspace-conversation.js";
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import {
  ownerWorkspacePermissionsEnabled,
  perUserOwnerUid,
  principalAccess,
  withGatewayOwnerSizingKey,
  workspaceScopeFor,
} from "../../../gateway-edge/src/routes/user/gateways.js";

const MOVING_ASSIGNMENT_STATES = new Set<unknown>(["quiescing", "migrating"]);

function workspaceAccessClaim(req: Request): { gatewayId: string; targetUid?: string } | null {
  const body = req.body;
  const gatewayId = body?.gatewayId;
  const targetUid = body?.targetUid;
  if (req.boundTenant?.kind !== "gateway" || !isValidGatewayId(gatewayId) || gatewayId !== req.boundTenant.gatewayId) return null;
  if (!body || Object.keys(body).some(key => !["gatewayId", "targetUid"].includes(key))) return null;
  if (targetUid !== undefined && (typeof targetUid !== "string" || !targetUid || targetUid.length > 128 || targetUid.includes("/"))) return null;
  return { gatewayId, targetUid };
}

async function targetMemberAllowed(targetUid: string | undefined, scope: { ownerUid: string; workspaceSlug: string }, state: PlatformStateRepositories): Promise<boolean> {
  if (!targetUid || targetUid === scope.ownerUid) return true;
  return isCanonicalWorkspaceMembership(await state.workspaces.members.get(scope.workspaceSlug, targetUid));
}

interface WorkspaceAccessDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
}

interface WorkspaceAccessResult {
  status: number;
  body: Record<string, unknown>;
}

async function workspaceAccess(
  deps: WorkspaceAccessDeps,
  uid: string,
  claim: { gatewayId: string; targetUid?: string },
): Promise<WorkspaceAccessResult> {
  const { gatewayId, targetUid } = claim;
  const auth = await readGatewayAuthorizationInStore(deps.store, gatewayId);
  if (!auth) return { status: 404, body: { error: "not_found" } };
  return withGatewayOwnerSizingKey(
    { store: deps.store, readSizingKey: deps.readSizingKey, ownerUid: perUserOwnerUid(auth), now: Date.now() },
    async (ownerSizingKey): Promise<WorkspaceAccessResult> => {
      const scope = await workspaceScopeFor(auth, auth.config.builderSlug, deps.store, true);
      if (!scope) return { status: 404, body: { error: "not_found" } };
      const owner = await deps.store.users.records.get(scope.ownerUid);
      if (!ownerWorkspacePermissionsEnabled(auth.config, ownerSizingKey, owner)) {
        return { status: 403, body: { error: "builder_workspace_required" } };
      }
      const access = await principalAccess(scope, uid, deps.store, ownerSizingKey);
      if (access.kind === "denied") return { status: 403, body: { error: "forbidden" } };
      const assignmentState = (await deps.store.gateways.assignments.get(gatewayId, scope.ownerUid))?.state;
      if (MOVING_ASSIGNMENT_STATES.has(assignmentState)) return { status: 403, body: { error: "workspace_not_serving" } };
      if (assignmentState !== "serving") return { status: 503, body: { error: "workspace_not_serving", retryable: true } };
      if (!await targetMemberAllowed(targetUid, scope, deps.store)) return { status: 404, body: { error: "member_not_found" } };
      return { status: 200, body: { uid, gatewayId, workspaceSlug: scope.workspaceSlug, ...(targetUid ? { targetUid } : {}) } };
    },
  );
}

export function createWorkspaceNativeAccessRoutes(deps: WorkspaceAccessDeps): Router {
  const router = Router();
  router.post("/workspace-access", async (req: Request, res, next) => {
    try {
      const claim = workspaceAccessClaim(req);
      if (!claim) { res.status(403).json({ error: "forbidden" }); return; }
      if (!req.uid) { res.status(401).json({ error: "Unauthenticated" }); return; }
      const result = await workspaceAccess(deps, req.uid, claim);
      if (result.status === 200) res.set("cache-control", "no-store");
      res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  });
  return router;
}

type ToolConversationClaim = { gatewayId: string; uid: string; channelId: string } & ({ purpose: 'conversation'; threadRootPostId: string } | { purpose: 'control' | 'channel-tools' });
function isToolConversationUid(uid: unknown): uid is string {
  return typeof uid === "string" && !!uid && uid.length <= 128 && !uid.includes("/");
}
function toolConversationClaim(req: Request): ToolConversationClaim | null {
  const { gatewayId, uid, channelId, purpose, threadRootPostId } = req.body ?? {};
  if (req.boundTenant?.kind !== "gateway" || req.boundTenant.gatewayId !== gatewayId || !isValidGatewayId(gatewayId)) return null;
  if (!isToolConversationUid(uid)) return null;
  if (typeof channelId !== "string" || !/^[a-z0-9]{26}$/u.test(channelId)) return null;
  if (Object.keys(req.body).some(key => !["gatewayId", "uid", "channelId", "purpose", "threadRootPostId"].includes(key))) return null;
  if ((purpose === 'control' || purpose === 'channel-tools') && threadRootPostId === undefined) return { gatewayId, uid, channelId, purpose };
  if (purpose === 'conversation' && isMattermostPostId(threadRootPostId)) return { gatewayId, uid, channelId, purpose, threadRootPostId };
  return null;
}
async function toolConversation(deps: WorkspaceConversationDeps, claim: ToolConversationClaim) {
  let resolved;
  if (claim.purpose === 'conversation') resolved = await resolveWorkspaceConversation(deps, claim);
  else if (claim.purpose === 'channel-tools') resolved = await resolveWorkspaceToolChannel(deps, claim);
  else resolved = await resolveWorkspaceToolControl(deps, claim);
  return resolved?.scope.nativeAccess ? resolved.context : null;
}
export function createToolConversationRoutes(deps: WorkspaceConversationDeps): Router {
  const router = Router();
  router.post("/tool-conversation", brokerRequestLimit(2400), async (req: Request, res, next) => {
    try {
      const claim = toolConversationClaim(req);
      const context = claim ? await toolConversation(deps, claim) : null;
      if (!context) { res.status(403).json({ error: "forbidden" }); return; }
      res.set("cache-control", "no-store").json(context);
    } catch (error) { next(error); }
  });
  return router;
}
