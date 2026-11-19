import { Router, type Response } from 'express';
import { authenticatedRequestLimit, authenticationFailureLimit } from '@octogee/core/http/authenticated-request-limit';
import { requireAuthenticatedUid } from '@octogee/core/http/auth';
import { logger } from '@octogee/core/http/logging';
import { openAuthenticatedUpstream } from '@octogee/core/http-candidates/chat-proxy/openclaw/authenticated-upstream';
import { attachUpstreamRpcClient } from '@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc';
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute } from '@octogee/shared/types/mattermost-session-route';
import { createOpenClawRuntimeBroker, runtimeBrokerBaseUrlFromEnv } from '../chat-proxy/openclaw/runtime-broker.js';

type RunBroker = ReturnType<typeof createOpenClawRuntimeBroker>;
type RunControlBroker = Pick<RunBroker, 'getChannelRunControlAccess'>;
type RunAccess = NonNullable<Awaited<ReturnType<NonNullable<RunBroker['getChannelRunControlAccess']>>>>;
type NativeRpc = ReturnType<typeof attachUpstreamRpcClient>;

export function createChannelRunControlsRouter(deps: {
  broker: RunControlBroker;
  open?: typeof openAuthenticatedUpstream;
}) {
  const router = Router({ mergeParams: true });
  const middleware = [authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(45)];
  const open = deps.open ?? openAuthenticatedUpstream;
  router.all<{ gatewayId: string }>('/', ...middleware, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.sendStatus(405);
      return;
    }
    const gatewayId = process.env.GATEWAY_ID;
    const { channelId } = req.query;
    const stopping = req.method === 'POST';
    const requestedRunId = parseRequestedRunId(req.query.runId, stopping);
    if (!gatewayId || req.params.gatewayId !== gatewayId || !isMattermostPostId(channelId)
      || requestedRunId === null) {
      res.status(400).json({ error: 'A channel and its active run are required.' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    try {
      const access = await scopedRunAccess(deps.broker, gatewayId, channelId, req.uid!);
      if (!access) {
        res.sendStatus(403);
        return;
      }
      const upstream = await open({ gatewayId, url: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789', timeoutMs: 5000 });
      const rpc = attachUpstreamRpcClient(upstream);
      try {
        const allowedRunId = await resolveAllowedRun(rpc, access, requestedRunId);
        if (!stopping) {
          res.json(allowedRunId ? { allowed: true, runId: allowedRunId } : { allowed: false });
          return;
        }
        await stopAllowedRun(rpc, access, allowedRunId, res);
      } finally {
        rpc.dispose();
        upstream.close();
      }
    } catch (error) {
      logger.warn('Channel run control failed', { gatewayId, error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: 'The Gateway could not confirm channel run controls.' });
    }
  });
  return router;
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function parseRequestedRunId(value: unknown, required: boolean) {
  if (isRunId(value)) return value;
  return required || value !== undefined ? null : undefined;
}

async function scopedRunAccess(broker: RunControlBroker, gatewayId: string, channelId: string, uid: string) {
  const access = await broker.getChannelRunControlAccess?.(uid, channelId);
  if (!access || access.gatewayId !== gatewayId) return undefined;
  const route = parseChannelScopedMattermostSessionRoute(access.sessionKey);
  return route?.primaryChannelId === channelId && route.agentId === access.expectedAgentId ? access : undefined;
}

async function resolveAllowedRun(rpc: NativeRpc, access: RunAccess, requestedRunId: string | undefined) {
  if (requestedRunId && access.isOwner) return requestedRunId;
  const origin = await readRunOrigin(rpc, access.sessionKey, requestedRunId);
  if (access.isOwner) return origin?.runId ?? await describeSingleActiveRun(rpc, access.sessionKey, access.expectedAgentId);
  return origin?.starterMmUserId === access.callerMmUserId ? requestedRunId ?? origin?.runId : undefined;
}

async function stopAllowedRun(rpc: NativeRpc, access: RunAccess, runId: string | undefined, res: Response) {
  if (!runId) {
    res.sendStatus(403);
    return;
  }
  const stopped = await rpc.call<{ status?: string; abortedRunId?: string | null }>('sessions.abort', {
    key: access.sessionKey, agentId: access.expectedAgentId, runId,
  });
  const result = stopped.ok ? stopped.result : undefined;
  if (result?.status !== 'no-active-run' && !(result?.status === 'aborted' && result.abortedRunId === runId)) {
    res.status(409).json({ error: 'The Gateway could not stop that run.' });
    return;
  }
  res.json({ status: result.status });
}

async function describeSingleActiveRun(rpc: NativeRpc, key: string, agentId: string) {
  const result = await rpc.call<{ session: { activeRunIds?: unknown } | null }>('sessions.describe', { key, agentId });
  if (!result.ok) throw new Error('Could not read the active session');
  const ids = result.result?.session?.activeRunIds;
  return Array.isArray(ids) && ids.length === 1 && isRunId(ids[0]) ? ids[0] : undefined;
}

async function readRunOrigin(rpc: NativeRpc, sessionKey: string, runId: string | undefined) {
  const origin = await rpc.call<{ runId?: string; starterMmUserId: string | null }>('octogee.activity.channelRunOrigin', {
    sessionKey, ...(runId ? { runId } : {}),
  });
  return origin.ok ? origin.result : undefined;
}

export function channelRunControlsFromEnv(gatewayId: string) {
  return createChannelRunControlsRouter({ broker: createOpenClawRuntimeBroker({ baseUrl: runtimeBrokerBaseUrlFromEnv(), gatewayId }) });
}
