import { isValidGatewayId } from "@octogee/shared/types/glm";

import { internalFetch } from "@octogee/core/internal-fetch";

export interface ByosubGatewayAssignment {
  slug: string;
  gatewayId: string;
  refProvider: "openai" | "anthropic" | null;
}

export interface ByosubFlowRecord {
  uid: string;
  gatewayId: string;
  agentId: string;
  provider: string;
  modelCredentialProvider?: string;
}

function brokerBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FLEET_BROKER_URL || env.OCTOGEE_API_URL;
  if (!base) throw new Error("FLEET_BROKER_URL or OCTOGEE_API_URL is required");
  let trimmed = base;
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

async function brokerPost<T>(path: string, body: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await internalFetch(
      `${brokerBase()}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      {},
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`byosub broker ${response.status} ${await response.text().catch(() => "")}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveByosubUserGateway(uid: string): Promise<ByosubGatewayAssignment | null> {
  const payload = await brokerPost<{ user?: unknown }>("/internal/byok/byosub-user", { uid });
  if (!payload) return null;
  const user = payload.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const record = user as Record<string, unknown>;
  if (
    record.uid !== uid ||
    typeof record.slug !== "string" ||
    !record.slug ||
    typeof record.gatewayId !== "string" ||
    !isValidGatewayId(record.gatewayId) ||
    (record.refProvider !== null &&
      record.refProvider !== "openai" &&
      record.refProvider !== "anthropic")
  ) {
    return null;
  }
  return {
    slug: record.slug,
    gatewayId: record.gatewayId,
    refProvider: record.refProvider,
  };
}

export async function readByosubFlow(flowId: string): Promise<ByosubFlowRecord | null> {
  const payload = await brokerPost<{ flow?: unknown }>("/internal/byok/byosub-flow-read", { flowId });
  if (!payload) return null;
  const flow = payload.flow;
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return null;
  const record = flow as Record<string, unknown>;
  if (
    typeof record.uid !== "string" ||
    typeof record.gatewayId !== "string" ||
    !isValidGatewayId(record.gatewayId) ||
    typeof record.agentId !== "string" ||
    typeof record.provider !== "string"
  ) {
    return null;
  }
  return {
    uid: record.uid,
    gatewayId: record.gatewayId,
    agentId: record.agentId,
    provider: record.provider,
    ...(typeof record.modelCredentialProvider === "string"
      ? { modelCredentialProvider: record.modelCredentialProvider }
      : {}),
  };
}
