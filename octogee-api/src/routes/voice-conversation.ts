import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request } from 'express';
import { isValidGatewayId } from '@octogee/shared/types/glm';
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { isVoiceArchiveRequest, isVoiceGrantRequest, isVoiceGrantEndRequest, isVoiceTurnRequest } from '@octogee/core/voice-conversation';
import { archiveWorkspaceVoiceCall, bindWorkspaceVoiceGrant, endWorkspaceVoiceGrant, postWorkspaceVoiceTurn, VoicePostingGrantError } from '../lib/voice-posting-grant.js';
import { resolveVoiceConversationContext, type WorkspaceConversationDeps } from '../lib/workspace-conversation.js';

interface VoiceConversationRequest {
  gatewayId: string;
  uid: string;
  channelId: string;
  threadRootPostId: string;
}

function boundToGateway(req: Request, gatewayId: unknown): gatewayId is string {
  return req.boundTenant?.kind === 'gateway' && req.boundTenant.gatewayId === gatewayId && isValidGatewayId(gatewayId);
}

function isVoiceConversationRequest(req: Request, body: VoiceConversationRequest): boolean {
  return boundToGateway(req, body.gatewayId) &&
    typeof body.uid === 'string' && Boolean(body.uid) && body.uid.length <= 128 && !body.uid.includes('/') &&
    isMattermostPostId(body.channelId) && isMattermostPostId(body.threadRootPostId) &&
    Object.keys(body).every(key => ['gatewayId', 'uid', 'channelId', 'threadRootPostId'].includes(key));
}

function mountGrantOperation<T>(router: Router, deps: WorkspaceConversationDeps, path: string,
  validate: (body: unknown) => body is T,
  execute: (dependencies: WorkspaceConversationDeps, gatewayId: string, request: T) => Promise<unknown>): void {
  router.post(path, brokerRequestLimit(2400), async (req: Request, res, next) => {
    try {
      const gatewayId = req.boundTenant?.kind === 'gateway' ? req.boundTenant.gatewayId : null;
      const body: unknown = req.body;
      if (!gatewayId || !validate(body)) { res.status(403).json({ error: 'voice_grant_forbidden' }); return; }
      res.set('cache-control', 'no-store').json(await execute(deps, gatewayId, body));
    } catch (error) {
      if (error instanceof VoicePostingGrantError) { res.status(error.status).json({ error: error.code }); return; }
      next(error);
    }
  });
}

export function createVoiceConversationRoutes(deps: WorkspaceConversationDeps): Router {
  const router = Router();
  router.post('/conversation', brokerRequestLimit(1200), async (req: Request, res, next) => {
    try {
      const body = req.body ?? {};
      if (!isVoiceConversationRequest(req, body)) { res.status(403).json({ error: 'forbidden' }); return; }
      const resolved = await resolveVoiceConversationContext(deps, body);
      if (!resolved) { res.status(403).json({ error: 'forbidden' }); return; }
      const { scope, context } = resolved;
      res.set('cache-control', 'no-store').json({
        ...context,
        nativeInterrupt: scope.gatewayClass === 'isolated' && scope.nativeAccess && scope.auth.config.builderAccess?.controlUiEnabled === true,
      });
    } catch (error) { next(error); }
  });
  mountGrantOperation(router, deps, '/bind', isVoiceGrantRequest, bindWorkspaceVoiceGrant);
  mountGrantOperation(router, deps, '/end', isVoiceGrantEndRequest, endWorkspaceVoiceGrant);
  mountGrantOperation(router, deps, '/turn', isVoiceTurnRequest, postWorkspaceVoiceTurn);
  mountGrantOperation(router, deps, '/archive', isVoiceArchiveRequest, archiveWorkspaceVoiceCall);
  return router;
}
