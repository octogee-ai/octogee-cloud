import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { projectAgentConfigured } from "@octogee/shared/types/project";
import { parseAgentId } from "@octogee/shared/types/identity";

export const WORKSPACE_COMMIT_PROOF_PATH = "/internal/workspace/commit";

const MAX_AGE_MS = 30_000;

export interface WorkspaceCommitProofTarget {
  agentId: string;
  slug: string;
  project: string | null;
}

export interface WorkspaceCommitProof {
  timestamp: string;
  signature: string;
  body: string;
}

export function workspaceCommitProofSignature(
  secret: string,
  timestamp: string,
  path: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`octogee-workspace-commit-v1\n${timestamp}\n${path}\n${body}`)
    .digest("hex");
}

function signaturesMatch(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function workspaceCommitProofTargetFromBody(
  serializedBody: string,
): WorkspaceCommitProofTarget | null {
  let body: unknown;
  try {
    body = JSON.parse(serializedBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const agentId = typeof data.agentId === "string" ? data.agentId : "";
  const slug = typeof data.slug === "string" ? data.slug : "";
  if (!agentId || !slug) return null;
  return {
    agentId,
    slug,
    project: typeof data.project === "string" ? data.project : null,
  };
}

function agentSecretId(target: WorkspaceCommitProofTarget): string | null {
  const identity = parseAgentId(target.agentId);
  if (identity.kind === "unknown" || identity.username !== target.slug) return null;
  if (identity.kind === "project") {
    if (identity.project !== target.project) return null;
    return `projectAgentMattermost-${identity.project}`;
  }
  return "coachMattermost";
}

export type WorkspaceCommitProofStore = Pick<PlatformStateRepositories, "workspaces" | "secrets">;

function normalizedProof(
  proof: WorkspaceCommitProof,
  now: () => number,
): Pick<WorkspaceCommitProof, "timestamp" | "signature"> | null {
  const timestamp = proof.timestamp.trim();
  const signature = proof.signature.trim();
  if (!/^\d{10,16}$/u.test(timestamp) || !signature) return null;
  const proofTime = Number(timestamp);
  if (!Number.isSafeInteger(proofTime) || Math.abs(now() - proofTime) > MAX_AGE_MS) return null;
  return { timestamp, signature };
}

async function proofSecret(
  store: WorkspaceCommitProofStore,
  target: WorkspaceCommitProofTarget,
): Promise<string | null> {
  const workspace = await store.workspaces.records.get(target.slug);
  if (!workspace || workspace.ownerUid.length === 0) return null;
  const secretId = agentSecretId(target);
  if (!secretId) return null;
  const identity = parseAgentId(target.agentId);
  if (identity.kind === "project") {
    const project = await store.workspaces.projects.get(target.slug, identity.project);
    if (!project || !projectAgentConfigured(project.agent)) return null;
  }
  const secret = await store.secrets.get(workspace.ownerUid, secretId);
  const personalToken = secret && secret.kind !== "connector" ? secret.personalToken : "";
  return personalToken.length > 0 ? personalToken : null;
}

export async function verifyWorkspaceCommitProof(
  proof: WorkspaceCommitProof,
  target: WorkspaceCommitProofTarget,
  store: WorkspaceCommitProofStore,
  now: () => number = Date.now,
): Promise<boolean> {
  const normalized = normalizedProof(proof, now);
  if (!normalized) return false;
  const secret = await proofSecret(store, target);
  if (!secret) return false;

  const expected = workspaceCommitProofSignature(
    secret,
    normalized.timestamp,
    WORKSPACE_COMMIT_PROOF_PATH,
    proof.body,
  );
  return signaturesMatch(normalized.signature, expected);
}
