import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

const TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;

function isTenantLike(t: string): boolean {
  return TENANT_GUID_RE.test(t) || TENANT_DOMAIN_RE.test(t);
}

export const azureConnector: ConnectorDef = {
  meta: catalogMeta("azure"),
  fetchIdentity: async () => {
    throw new Error("Azure uses a service-principal triple, not a bare token");
  },
  validateFields: async (fields) => {
    if (!isTenantLike(fields.tenantId)) {
      throw new Error("Tenant ID does not look like a tenant GUID or domain");
    }
    const resp = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(fields.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: fields.clientId,
          client_secret: fields.clientSecret,
          scope: "https://management.azure.com/.default",
        }),
      },
    );
    if (!resp.ok) {
      throw new Error(`Azure token request failed: ${resp.status}`);
    }
    const out = (await resp.json()) as { access_token?: string };
    if (!out.access_token) {
      throw new Error("Azure returned no access token for the service principal");
    }
    return { accountLabel: `app ${fields.clientId.slice(0, 8)}…` };
  },
};
