import { createHmac, timingSafeEqual } from "node:crypto";

import { isSafeAgentId } from "@octogee/core/byosub-restore";
import type { PlatformUserRecord, PlatformStateRepositories, Stored } from "@octogee/core/platform-state";
import { parseAgentId } from "@octogee/shared/types/identity";

import { userAllowsInteractiveAccess } from "./assigned-user.js";
import { verifyOwnerAutomationTurn } from "./openclaw-owner-turn.js";

export const OWNER_AUTOMATIONS_PROOF_PATH = "/internal/owner-automations";

const MAX_AGE_MS = 30_000;

export interface OwnerAutomationProof {
  timestamp: string;
  signature: string;
  body: string;
}

export interface OwnerAutomationAuthorization {
  slug: string;
  agentId: string;
  ownerMattermostUserId: string;
  coachChannelId: string;
  readOnly: boolean;
}

export type AssignedUserLookup = (
  store: PlatformStateRepositories,
  gatewayId: string,
  agentId: string,
) => Promise<Stored<PlatformUserRecord> | null>;

export function ownerAutomationProofSignature(
  secret: string,
  timestamp: string,
  path: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`octogee-owner-automation-v1\n${timestamp}\n${path}\n${body}`)
    .digest("hex");
}

function signaturesMatch(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function freshTimestamp(timestamp: string, now: () => number): boolean {
  if (!/^\d{10,16}$/u.test(timestamp)) return false;
  const proofTime = Number(timestamp);
  return Number.isSafeInteger(proofTime) && Math.abs(now() - proofTime) <= MAX_AGE_MS;
}

function signedRequest(body: string): { agentId: string; requestContext: unknown; readOnly: boolean } | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const agentId = data.agentId;
  if (typeof agentId !== "string" || !isSafeAgentId(agentId) || parseAgentId(agentId).kind !== "coach") {
    return null;
  }
  return { agentId, requestContext: data.requestContext, readOnly: data.action === "list" };
}

async function defaultAgentProofSecret(store: PlatformStateRepositories, uid: string): Promise<string | null> {
  const secret = await store.secrets.get(uid, "coachMattermost");
  return secret?.kind === "coach-mattermost" && secret.personalToken.length > 0 ? secret.personalToken : null;
}

export async function authorizeOwnerAutomation(
  store: PlatformStateRepositories,
  gatewayId: string,
  proof: OwnerAutomationProof,
  deps: { findAssignedUser: AssignedUserLookup; now?: () => number },
): Promise<OwnerAutomationAuthorization | null> {
  const timestamp = proof.timestamp.trim();
  if (!freshTimestamp(timestamp, deps.now ?? Date.now)) return null;
  const request = signedRequest(proof.body);
  if (!request) return null;
  const assigned = await deps.findAssignedUser(store, gatewayId, request.agentId);
  if (!assigned || !userAllowsInteractiveAccess(assigned)) return null;
  const secret = await defaultAgentProofSecret(store, assigned.uid);
  if (!secret) return null;
  const expected = ownerAutomationProofSignature(secret, timestamp, OWNER_AUTOMATIONS_PROOF_PATH, proof.body);
  if (!signaturesMatch(proof.signature.trim(), expected)) return null;
  const turn = await verifyOwnerAutomationTurn(store, {
    agentId: request.agentId,
    ownerUid: assigned.uid,
    owner: assigned,
    requestContext: request.requestContext,
  });
  if (!turn) return null;
  const parsed = parseAgentId(request.agentId);
  if (parsed.kind !== "coach") return null;
  return { slug: parsed.username, agentId: request.agentId, ...turn, readOnly: request.readOnly };
}
