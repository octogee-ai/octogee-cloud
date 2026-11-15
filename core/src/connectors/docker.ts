import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const dockerConnector: ConnectorDef = {
  meta: catalogMeta("docker"),
  fetchIdentity: async () => {
    throw new Error("Docker Hub uses username+token fields, not a bare token");
  },
  validateFields: async (fields) => {
    const resp = await fetch("https://hub.docker.com/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: fields.username, password: fields.token }),
    });
    if (!resp.ok) {
      throw new Error(`Docker Hub login failed: ${resp.status}`);
    }
    const out = (await resp.json()) as { token?: string };
    if (!out.token) {
      throw new Error("Docker Hub login returned no session token");
    }
    return { accountLabel: fields.username };
  },
};
