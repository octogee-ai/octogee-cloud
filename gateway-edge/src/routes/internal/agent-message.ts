import { clientRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { assertWorkspaceIdentityReady } from "@octogee/core/openclaw-workspace-bootstrap";
import { Router, type NextFunction, type Request, type Response } from "express";
import { parseAgentId } from "@octogee/shared/types/identity";

import {
  OPENCLAW_EDGE_SERVICE_IDENTITY,
  isPerUserControlIdentity,
  openClawProxyIdentityHeaders,
} from "@octogee/shared/types/openclaw-proxy-identity";

import { requireAgentMessageAuth } from "../../middleware/agent-message-auth.js";
import { logger } from "@octogee/core/http/logging";

const OPENCLAW_URL = "http://127.0.0.1:18789";
const MESSAGE_TIMEOUT_MS = 15_000;

interface AgentMessageInput {
  uid: string;
  agentId: string;
  message: string;
}

function requestString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validUid(uid: string): boolean {
  return Boolean(uid) && uid.length <= 128 && !uid.includes("/") && uid.trim() === uid;
}

function agentMessageInput(body: unknown): AgentMessageInput | null {
  const input = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const uid = requestString(input.uid);
  const agentId = requestString(input.agentId);
  const message = requestString(input.message);
  if (!validUid(uid) || parseAgentId(agentId).kind !== "coach" || !message.trim()) {
    return null;
  }
  return { uid, agentId, message };
}

type OpenClawCredential =
  | { kind: "token"; gatewayToken: string }
  | { kind: "proxy-identity" };

function localOpenClawCredential(env: NodeJS.ProcessEnv = process.env): OpenClawCredential | null {
  if (isPerUserControlIdentity(env)) return { kind: "proxy-identity" };
  const gatewayToken = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  return gatewayToken ? { kind: "token", gatewayToken } : null;
}

function credentialHeaders(credential: OpenClawCredential): Record<string, string> {
  if (credential.kind === "proxy-identity") assertWorkspaceIdentityReady();
  return credential.kind === "token"
    ? { authorization: `Bearer ${credential.gatewayToken}` }
    : openClawProxyIdentityHeaders({ user: OPENCLAW_EDGE_SERVICE_IDENTITY });
}

async function deliverAgentMessage(
  input: AgentMessageInput,
  credential: OpenClawCredential,
): Promise<globalThis.Response> {
  return fetch(
    `${OPENCLAW_URL}/api/agents/${encodeURIComponent(input.agentId)}/message`,
    {
      method: "POST",
      headers: {
        ...credentialHeaders(credential),
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: input.message, source: "system" }),
      signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
    },
  );
}

export function createInternalAgentMessageRouter(): Router {
  const router = Router({ mergeParams: true });
  router.post(
    "/",
    clientRequestLimit(1200, true),
    requireAgentMessageAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      let agentId: string | undefined;
      try {
        const gatewayId = requestString(req.params.gatewayId);
        if (!gatewayId || gatewayId !== process.env.GATEWAY_ID) {
          res.status(409).json({ error: "gateway mismatch" });
          return;
        }
        const input = agentMessageInput(req.body);
        if (!input) {
          res.status(400).json({ error: "invalid agent message" });
          return;
        }
        agentId = input.agentId;
        const credential = localOpenClawCredential();
        if (!credential) {
          logger.error("internal agent message delivery failed", {
            gatewayId,
            agentId: input.agentId,
            error: "local OpenClaw credential unavailable",
          });
          res.status(503).json({ error: "OpenClaw message delivery unavailable" });
          return;
        }
        const response = await deliverAgentMessage(input, credential);
        if (!response.ok) {
          logger.error("internal agent message delivery failed", {
            gatewayId,
            agentId: input.agentId,
            status: response.status,
          });
          res.status(502).json({ error: "OpenClaw message delivery failed" });
          return;
        }
        res.sendStatus(204);
      } catch (error) {
        logger.error("internal agent message delivery failed", {
          gatewayId: req.params.gatewayId,
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        next(error);
      }
    },
  );
  return router;
}

export default createInternalAgentMessageRouter();
