import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const vercelConnector: ConnectorDef = {
  meta: catalogMeta("vercel"),
  fetchIdentity: async (accessToken) => {
    const resp = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      throw new Error(`Vercel identity check failed: ${resp.status}`);
    }
    const out = (await resp.json()) as { user?: { username?: string; email?: string } };
    const accountLabel = out.user?.username || out.user?.email;
    if (!accountLabel) {
      throw new Error("Vercel identity response has no username or email");
    }
    return { accountLabel };
  },
};
