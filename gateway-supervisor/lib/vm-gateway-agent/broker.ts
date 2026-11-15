import type { MetadataClient } from "./metadata.js";

export const TENANT_TOKEN_AUDIENCE = "octogee-api";
export const CREDENTIAL_TOKEN_AUDIENCE = "octogee-api-gateway-credentials";

export interface BrokerClientDeps {
  gatewayId: string;
  apiUrl: string;
  metadata: Pick<MetadataClient, "identityToken">;
  fetchImpl: typeof fetch;
}

export async function brokerPost(deps: BrokerClientDeps, path: string, body: Record<string, unknown>): Promise<Response> {
  const [tenantToken, credentialToken] = await Promise.all([
    deps.metadata.identityToken(TENANT_TOKEN_AUDIENCE),
    deps.metadata.identityToken(CREDENTIAL_TOKEN_AUDIENCE),
  ]);
  return deps.fetchImpl(`${deps.apiUrl}/internal/fleet/${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "x-k8s-sa-token": tenantToken,
      "x-octogee-gateway-credential-token": credentialToken,
    },
    body: JSON.stringify({ gatewayId: deps.gatewayId, ...body }),
  });
}

export async function brokerFailure(label: string, res: Response): Promise<Error> {
  return new Error(`${label}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
