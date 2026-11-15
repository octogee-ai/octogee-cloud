import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { SessionModelAuditCompletion } from "@octogee/core/platform-state";
import { readAgentModelSelections } from "@octogee/core/user-snapshot-mapping";
import {
  channelSessionModelCommand,
  parseChannelSessionModelOperation,
  type ChannelSessionModelOperation,
} from "@octogee/shared/types/channel-session-models";
import {
  ChannelSessionMattermostError,
  parseNativeModelResult,
  pickCorrelatedAgentReply,
  type MattermostModelPost,
} from "../lib/channel-session-model-control.js";
import {
  authorizeChannel,
  type AuthorizedChannel,
} from "../lib/channel-session-authorization.js";
import { platformStateStore } from "../lib/platform-state.js";
import { requireActiveAccount, requireAuthenticatedUid } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";

const router: Router = Router();
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const channelSessionModelRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.uid!,
  message: { error: "Too many model control requests, please try again later." },
});

function asPost(value: unknown): MattermostModelPost | null {
  if (!value || typeof value !== "object") return null;
  const post = value as Partial<MattermostModelPost>;
  return typeof post.id === "string" && MATTERMOST_ID.test(post.id) &&
    post.type === "" &&
    typeof post.root_id === "string" &&
    typeof post.channel_id === "string" && MATTERMOST_ID.test(post.channel_id) &&
    typeof post.user_id === "string" && MATTERMOST_ID.test(post.user_id) &&
    typeof post.create_at === "number" && Number.isSafeInteger(post.create_at) &&
    typeof post.message === "string"
    ? post as MattermostModelPost
    : null;
}

function threadPosts(value: unknown): MattermostModelPost[] {
  const posts = (value as { posts?: unknown } | null)?.posts;
  if (!posts || typeof posts !== "object" || Array.isArray(posts)) return [];
  return Object.values(posts).flatMap((post) => {
    const parsed = asPost(post);
    return parsed ? [parsed] : [];
  });
}

function channelIdParam(req: Request): string | null {
  const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
  return MATTERMOST_ID.test(channelId) ? channelId : null;
}

function handleRouteError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ChannelSessionMattermostError) {
    res.status(502).json({ error: "Chat model control unavailable" });
    return;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    res.status(504).json({ error: "Chat model control timed out" });
    return;
  }
  if (error instanceof Error && error.message === "invalid Mattermost internal base URL") {
    res.status(503).json({ error: "Chat model control misconfigured" });
    return;
  }
  next(error);
}

interface ModelOperationRequest {
  uid: string;
  channelId: string;
  operation: ChannelSessionModelOperation;
  authorization: AuthorizedChannel;
}

async function resolveModelOperationRequest(
  req: Request,
  res: Response,
): Promise<ModelOperationRequest | null> {
  const channelId = channelIdParam(req);
  if (!channelId) {
    res.status(400).json({ error: "Invalid channel ID" });
    return null;
  }
  const operation = parseChannelSessionModelOperation(req.body);
  if (!operation) {
    res.status(400).json({ error: "Invalid model operation" });
    return null;
  }
  const authorization = await authorizeChannel(req.uid!, channelId);
  if (!authorization) {
    res.status(404).json({ error: "Channel model controls unavailable" });
    return null;
  }
  if (authorization.forbidden) {
    res.status(403).json({ error: "Channel access denied" });
    return null;
  }
  if (operation.agentId !== authorization.target.agentId) {
    res.status(409).json({ error: "The channel Agent changed; refresh settings" });
    return null;
  }
  return { uid: req.uid!, channelId, operation, authorization };
}

async function createCommandAudit(request: ModelOperationRequest): Promise<string> {
  const { uid, channelId, operation, authorization } = request;
  const auditId = randomUUID();
  await platformStateStore.users.sessionModelAudit.create({
    auditId,
    actorUid: uid,
    channelId,
    workspaceSlug: authorization.target.workspaceSlug,
    projectId: authorization.target.projectId ?? null,
    agentId: authorization.target.agentId,
    operation: operation.operation,
    requestedModel: operation.operation === "setSessionModel" ? operation.modelRef : null,
    createdAt: { serverNow: true },
  });
  return auditId;
}

async function completeAudit(auditId: string, completion: Omit<SessionModelAuditCompletion, "completedAt">): Promise<void> {
  await platformStateStore.users.sessionModelAudit.complete(auditId, { ...completion, completedAt: { serverNow: true } });
}

function requireCommandPost(
  value: unknown,
  channelId: string,
  callerMmUserId: string,
): MattermostModelPost {
  const commandPost = asPost(value);
  if (!commandPost || commandPost.channel_id !== channelId || commandPost.user_id !== callerMmUserId) {
    throw new ChannelSessionMattermostError("Mattermost command post response was invalid");
  }
  return commandPost;
}

async function waitForAgentReply(
  request: ModelOperationRequest,
  posted: MattermostModelPost,
): Promise<MattermostModelPost | null> {
  const { channelId, authorization } = request;
  let reply: MattermostModelPost | null = null;
  for (let attempt = 0; attempt < 20 && !reply; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    const thread = await authorization.client.getJson(["posts", posted.id, "thread"]);
    reply = pickCorrelatedAgentReply(threadPosts(thread), {
      rootPostId: posted.id,
      channelId,
      agentUserId: authorization.target.agentMmUserId,
      commandCreatedAt: posted.create_at,
    });
  }
  return reply;
}

async function dispatchNativeCommand(
  request: ModelOperationRequest,
): Promise<{ posted: MattermostModelPost; reply: MattermostModelPost | null }> {
  const { channelId, operation, authorization } = request;
  const value = await authorization.client.postJson(["posts"], {
    channel_id: channelId,
    message: channelSessionModelCommand(operation),
  });
  const posted = requireCommandPost(value, channelId, authorization.callerMmUserId);
  return { posted, reply: await waitForAgentReply(request, posted) };
}

function auditLogContext(
  auditId: string,
  request: ModelOperationRequest,
): { auditId: string; channelId: string; operation: ChannelSessionModelOperation["operation"] } {
  return {
    auditId,
    channelId: request.channelId,
    operation: request.operation.operation,
  };
}

async function markCommandFailed(
  auditId: string,
  request: ModelOperationRequest,
  error: unknown,
): Promise<void> {
  const context = auditLogContext(auditId, request);
  try {
    await completeAudit(auditId, { outcome: "failed", commandPostId: null, replyPostId: null, resultingModel: null });
  } catch (auditError) {
    logger.error("channel session model audit failure update failed", {
      ...context,
      error: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
  logger.error("channel session model command failed", {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
}

async function completeCommandAudit(
  auditId: string,
  request: ModelOperationRequest,
  posted: MattermostModelPost,
  reply: MattermostModelPost | null,
  parsed: ReturnType<typeof parseNativeModelResult>,
): Promise<void> {
  try {
    await completeAudit(auditId, {
      outcome: parsed.outcome,
      commandPostId: posted.id,
      replyPostId: reply?.id ?? null,
      resultingModel: parsed.currentModel ?? null,
    });
  } catch (error) {
    logger.error("channel session model audit completion failed", {
      ...auditLogContext(auditId, request),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeModelOperation(request: ModelOperationRequest): Promise<Record<string, unknown>> {
  const audit = await createCommandAudit(request);
  try {
    const { posted, reply } = await dispatchNativeCommand(request);
    const nativeMessage = reply?.message.slice(0, 8192) ?? "No correlated Agent reply was received.";
    const parsed = reply
      ? parseNativeModelResult(request.operation.operation, nativeMessage)
      : { outcome: "unknown" as const };
    await completeCommandAudit(audit, request, posted, reply, parsed);
    return {
      ...parsed,
      nativeMessage,
      commandPostId: posted.id,
      ...(reply ? { replyPostId: reply.id } : {}),
    };
  } catch (error) {
    await markCommandFailed(audit, request, error);
    throw error;
  }
}

router.get("/:channelId", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(120), requireActiveAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channelId = channelIdParam(req);
    if (!channelId) { res.status(400).json({ error: "Invalid channel ID" }); return; }
    const authorization = await authorizeChannel(req.uid!, channelId);
    if (!authorization) { res.status(404).json({ error: "Channel model controls unavailable" }); return; }
    if (authorization.forbidden) { res.status(403).json({ error: "Channel access denied" }); return; }
    const selections = await readAgentModelSelections(platformStateStore.users, authorization.target.ownerUid);
    res.json({
      channelId,
      agentId: authorization.target.agentId,
      workspaceSlug: authorization.target.workspaceSlug,
      ...(authorization.target.projectId ? { projectId: authorization.target.projectId } : {}),
      defaultModel: selections[authorization.target.agentId] ?? null,
    });
  } catch (error) { handleRouteError(error, res, next); }
});

router.post("/:channelId", authenticationFailureLimit, requireAuthenticatedUid, channelSessionModelRateLimit, requireActiveAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await resolveModelOperationRequest(req, res);
    if (request) res.json(await executeModelOperation(request));
  } catch (error) { handleRouteError(error, res, next); }
});

export default router;
