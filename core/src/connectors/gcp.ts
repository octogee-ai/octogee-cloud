import { GoogleAuth } from "google-auth-library";
import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const gcpConnector: ConnectorDef = {
  meta: catalogMeta("gcp"),
  fetchIdentity: async () => {
    throw new Error("Google Cloud uses a service-account key file, not a bare token");
  },
  validateFields: async (fields) => {
    let parsed: { type?: string; client_email?: string };
    try {
      parsed = JSON.parse(fields.serviceAccountJson);
    } catch {
      throw new Error("Service account key is not valid JSON");
    }
    if (parsed.type !== "service_account" || !parsed.client_email) {
      throw new Error("Not a service-account key file (expected type: service_account)");
    }
    const auth = new GoogleAuth({
      credentials: parsed as Record<string, string>,
      scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
    });
    const token = await auth.getAccessToken();
    if (!token) {
      throw new Error("Service-account key could not mint an access token");
    }
    return { accountLabel: parsed.client_email };
  },
};
