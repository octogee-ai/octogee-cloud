import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const microsoftConnector: ConnectorDef = {
  meta: catalogMeta("microsoft"),
  oauth: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    redirectUriEnv: "MICROSOFT_OAUTH_REDIRECT_URI",
    extraAuthParams: { prompt: "consent" },
  },
  fetchIdentity: async (accessToken) => {
    const resp = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      throw new Error(`Microsoft identity check failed: ${resp.status}`);
    }
    const user = (await resp.json()) as { mail?: string; userPrincipalName?: string };
    const accountLabel = user.mail || user.userPrincipalName;
    if (!accountLabel) {
      throw new Error("Microsoft identity response has no mail or userPrincipalName");
    }
    return { accountLabel };
  },
};
