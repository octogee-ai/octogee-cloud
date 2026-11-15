import type { Request } from "express";
import { sidecarBrokerHeaders } from "../internal-fetch.js";

import { internalFetch } from "../internal-fetch.js";

const PROOF_TIMESTAMP_HEADER = "x-octogee-agent-proof-timestamp";
const PROOF_SIGNATURE_HEADER = "x-octogee-agent-proof-signature";

export interface WorkspaceCommitProofTarget {
  agentId: string;
  slug: string;
  project: string | null;
}

function requiredEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function trimBaseUrl(baseUrl: string): string {
  let out = baseUrl.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export class WorkspaceCommitProofBrokerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WorkspaceCommitProofBrokerError";
  }
}

export async function verifyWorkspaceCommitProofViaBroker(
  req: Request,
  target: WorkspaceCommitProofTarget,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const baseUrl = trimBaseUrl(requiredEnv("WORKSPACE_COMMIT_PROOF_BROKER_URL", env));
  const gatewayId = requiredEnv("GATEWAY_ID", env);
  const res = await internalFetch(
    `${baseUrl}/internal/workspace-commit/verify-proof`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await sidecarBrokerHeaders(),
      },
      body: JSON.stringify({
        gatewayId,
        target,
        proof: {
          timestamp: req.get(PROOF_TIMESTAMP_HEADER) ?? "",
          signature: req.get(PROOF_SIGNATURE_HEADER) ?? "",
          body: JSON.stringify(req.body),
        },
      }),
    },
  );
  if (res.status === 403) return false;
  if (res.status !== 204) {
    throw new WorkspaceCommitProofBrokerError(res.status, `proof broker HTTP ${res.status}`);
  }
  return true;
}
