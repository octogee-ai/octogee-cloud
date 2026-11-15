import type { Request } from "express";
import { sidecarBrokerHeaders } from "@octogee/core/internal-fetch";
import { isValidUsername } from "@octogee/shared/types/identity";

import { automationAuthorizationBrokerBaseUrlFromEnv } from "@octogee/core/internal-brokers/automation-authorization-broker";
import { internalFetch } from "@octogee/core/internal-fetch";
import type { OwnerAutomationTenant } from "../routes/owner-automation-jobs.js";

const PROOF_TIMESTAMP_HEADER = "x-octogee-agent-proof-timestamp";
const PROOF_SIGNATURE_HEADER = "x-octogee-agent-proof-signature";
const MATTERMOST_ID = /^[a-z0-9]{26}$/u;

export type OwnerAutomationAuthorizationOutcome =
  | { kind: "authorized"; tenant: OwnerAutomationTenant }
  | { kind: "forbidden" }
  | { kind: "rate_limited"; retryAfterSeconds?: number };

export class OwnerAutomationBrokerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OwnerAutomationBrokerError";
  }
}

function authorizedTenant(value: unknown, gatewayId: string, agentId: string): OwnerAutomationTenant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    body.gatewayId !== gatewayId ||
    typeof body.slug !== "string" ||
    !isValidUsername(body.slug) ||
    body.agentId !== agentId ||
    agentId !== `octogee-${body.slug}-coach` ||
    typeof body.ownerMattermostUserId !== "string" ||
    !MATTERMOST_ID.test(body.ownerMattermostUserId) ||
    typeof body.coachChannelId !== "string" ||
    !MATTERMOST_ID.test(body.coachChannelId)
  ) return null;
  return {
    slug: body.slug,
    agentId,
    ownerMattermostUserId: body.ownerMattermostUserId,
    coachChannelId: body.coachChannelId,
  };
}

export async function authorizeOwnerAutomationViaBroker(
  req: Request,
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<OwnerAutomationAuthorizationOutcome> {
  const gatewayId = env.GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("GATEWAY_ID is required");
  const baseUrl = automationAuthorizationBrokerBaseUrlFromEnv(env);
  const res = await internalFetch(`${baseUrl}/internal/owner-automations/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", ...await sidecarBrokerHeaders() },
    body: JSON.stringify({
      gatewayId,
      proof: {
        timestamp: req.get(PROOF_TIMESTAMP_HEADER) ?? "",
        signature: req.get(PROOF_SIGNATURE_HEADER) ?? "",
        body: JSON.stringify(req.body),
      },
    }),
  });
  if (res.status === 403) return { kind: "forbidden" };
  const payload = await res.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (res.status === 429) {
    const retry = payload?.retryAfterSeconds;
    return { kind: "rate_limited", ...(typeof retry === "number" ? { retryAfterSeconds: retry } : {}) };
  }
  if (res.status !== 200) throw new OwnerAutomationBrokerError(res.status, `owner automation broker HTTP ${res.status}`);
  const tenant = authorizedTenant(payload, gatewayId, agentId);
  if (!tenant) throw new OwnerAutomationBrokerError(502, "owner automation broker returned an invalid tenant");
  return { kind: "authorized", tenant };
}
