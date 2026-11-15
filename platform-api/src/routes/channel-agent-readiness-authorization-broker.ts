import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { authorizeChannel, type AuthorizedChannel } from "../../../gateway-edge/src/lib/channel-session-authorization.js";
import type { ChannelReadinessAuthorization } from "../../../gateway-edge/src/lib/channel-agent-readiness-authorization-broker.js";

export interface ChannelReadinessAuthorizationBrokerDeps {
  store: Pick<PlatformStateRepositories, "users">;
  authorize?: typeof authorizeChannel;
}

function parseBody(value: unknown): { gatewayId: string; channelId: string } | null {
  const body = value as { gatewayId?: unknown; channelId?: unknown } | undefined;
  if (!body || !isValidGatewayId(body.gatewayId) || typeof body.channelId !== "string" || !/^[a-z0-9]{26}$/u.test(body.channelId)) {
    return null;
  }
  return { gatewayId: body.gatewayId, channelId: body.channelId };
}

async function channelPeerKind(client: AuthorizedChannel["client"], channelId: string): Promise<"channel" | "group" | null> {
  const channel = await client.getJson(["channels", channelId]) as { type?: string; delete_at?: number };
  if (channel.delete_at || !["O", "P"].includes(channel.type ?? "")) return null;
  return channel.type === "P" ? "group" : "channel";
}

async function withDeadline<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); })
      .then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function authorize(req: Request, res: Response, deps: ChannelReadinessAuthorizationBrokerDeps): Promise<void> {
  const body = parseBody(req.body);
  if (!body) { res.status(400).json({ error: "invalid channel readiness request" }); return; }
  if (req.boundTenant?.kind !== "gateway" || req.boundTenant.gatewayId !== body.gatewayId) {
    res.status(403).json({ error: "forbidden" }); return;
  }
  if (!req.uid) { res.status(401).json({ error: "Unauthenticated" }); return; }
  const uid = req.uid;
  const signal = AbortSignal.timeout(5_000);
  const access = await withDeadline(() => (deps.authorize ?? authorizeChannel)(uid, body.channelId, undefined, {
    requireActiveLedger: true, includeDefaultAgentConversation: true, signal,
  }), signal);
  if (!access || access.forbidden) { res.status(404).json({ error: "not_found" }); return; }
  const owner = await withDeadline(() => deps.store.users.records.get(access.target.ownerUid), signal);
  if (owner?.gateway?.gatewayId !== body.gatewayId) {
    res.status(404).json({ error: "not_found" }); return;
  }
  const peerKind = await withDeadline(() => channelPeerKind(access.client, body.channelId), signal);
  if (!peerKind) {
    res.status(404).json({ error: "not_found" }); return;
  }
  const metadata: ChannelReadinessAuthorization = {
    gatewayId: body.gatewayId, channelId: body.channelId,
    workspaceId: access.target.workspaceSlug, project: access.target.projectId ?? null,
    agentId: access.target.agentId, agentMmUserId: access.target.agentMmUserId,
    peerKind,
  };
  res.set("cache-control", "no-store").json(metadata);
}

export function createChannelReadinessAuthorizationBrokerRoutes(deps: ChannelReadinessAuthorizationBrokerDeps): Router {
  const router = Router();
  router.post("/authorize", brokerRequestLimit(240, "user"), async (req, res) => {
    res.set("cache-control", "no-store");
    try { await authorize(req, res, deps); } catch (error) {
      console.error("[channel-agent-readiness] authorization unavailable", error);
      res.status(503).json({ error: "channel_readiness_unavailable", retryable: true });
    }
  });
  return router;
}
