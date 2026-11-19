import { Router } from 'express';
import { authenticatedRequestLimit, authenticationFailureLimit } from '@octogee/core/http/authenticated-request-limit';
import { requireAuthenticatedUid } from '@octogee/core/http/auth';
import { logger } from '@octogee/core/http/logging';
import { openAuthenticatedUpstream } from '@octogee/core/http-candidates/chat-proxy/openclaw/authenticated-upstream';
import { attachUpstreamRpcClient } from '@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc';
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute } from '@octogee/shared/types/mattermost-session-route';
import { createOpenClawRuntimeBroker, runtimeBrokerBaseUrlFromEnv } from '../chat-proxy/openclaw/runtime-broker.js';

type RunBroker = ReturnType<typeof createOpenClawRuntimeBroker>;

export function createChannelRunControlsRouter(deps: {
  broker: Pick<RunBroker, 'getChannelRunControlAccess'>;
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
    const { channelId, runId } = req.query;
    const stopping = req.method === 'POST';
    if (!gatewayId || req.params.gatewayId !== gatewayId || !isMattermostPostId(channelId)
      || ((stopping || runId !== undefined) && !isRunId(runId))) {
      res.status(400).json({ error: 'A channel and its active run are required.' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    try {
      const access = await deps.broker.getChannelRunControlAccess?.(req.uid!, channelId);
      const route = parseChannelScopedMattermostSessionRoute(access?.sessionKey);
      if (!access || access.gatewayId !== gatewayId || route?.primaryChannelId !== channelId || route.agentId !== access.expectedAgentId) {
        res.sendStatus(403);
        return;
      }
      const upstream = await open({ gatewayId, url: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789', timeoutMs: 5000 });
      const rpc = attachUpstreamRpcClient(upstream);
      try {
        const requestedRunId = isRunId(runId) ? runId : undefined;
        const origin = requestedRunId && access.isOwner ? undefined : await readRunOrigin(rpc, access.sessionKey, requestedRunId);
        const currentRunId = requestedRunId ?? origin?.runId
          ?? (access.isOwner ? await describeSingleActiveRun(rpc, access.sessionKey, access.expectedAgentId) : undefined);
        const allowed = currentRunId !== undefined
          && (access.isOwner || origin?.starterMmUserId === access.callerMmUserId);
        if (!stopping) {
          res.json(allowed ? { allowed, runId: currentRunId } : { allowed });
          return;
        }
        if (!allowed) {
          res.sendStatus(403);
          return;
        }
        const stopped = await rpc.call('sessions.abort', { key: access.sessionKey, agentId: access.expectedAgentId, runId: currentRunId });
        const result = stopped.ok ? stopped.result as { status?: string; abortedRunId?: string | null } : undefined;
        if (result?.status !== 'no-active-run' && !(result?.status === 'aborted' && result.abortedRunId === currentRunId)) {
          res.status(409).json({ error: 'The Gateway could not stop that run.' });
          return;
        }
        res.json({ status: result.status });
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

async function describeSingleActiveRun(rpc: ReturnType<typeof attachUpstreamRpcClient>, key: string, agentId: string) {
  const result = await rpc.call<{ session: { activeRunIds?: unknown } | null }>('sessions.describe', { key, agentId });
  if (!result.ok) throw new Error('Could not read the active session');
  const ids = result.result?.session?.activeRunIds;
  return Array.isArray(ids) && ids.length === 1 && isRunId(ids[0]) ? ids[0] : undefined;
}

async function readRunOrigin(rpc: ReturnType<typeof attachUpstreamRpcClient>, sessionKey: string, runId: string | undefined) {
  const origin = await rpc.call<{ runId?: string; starterMmUserId: string | null }>('octogee.activity.channelRunOrigin', {
    sessionKey, ...(runId ? { runId } : {}),
  });
  return origin.ok ? origin.result : undefined;
}

export function channelRunControlsFromEnv(gatewayId: string) {
  return createChannelRunControlsRouter({ broker: createOpenClawRuntimeBroker({ baseUrl: runtimeBrokerBaseUrlFromEnv(), gatewayId }) });
}
