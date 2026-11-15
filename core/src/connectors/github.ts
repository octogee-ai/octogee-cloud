import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const githubConnector: ConnectorDef = {
  meta: catalogMeta("github"),
  oauth: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    redirectUriEnv: "GITHUB_OAUTH_REDIRECT_URI",
  },
  device: {
    codeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdEnv: "GITHUB_CLIENT_ID",
  },
  fetchIdentity: async (accessToken) => {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "octogee-connect",
      },
    });
    if (!resp.ok) {
      throw new Error(`GitHub identity check failed: ${resp.status}`);
    }
    const user = (await resp.json()) as { login?: string };
    if (!user.login) {
      throw new Error("GitHub identity response has no login");
    }
    return { accountLabel: user.login };
  },
};
