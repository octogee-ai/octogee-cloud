import {
  listObsidianRemoteVaults,
  runObsidianHeadless,
  type ObsidianCommandRunner,
  verifyObsidianConnection,
} from "./obsidian-headless.js";
import { catalogMeta, type ConnectorDef } from "./def.js";

export async function revokeObsidianConnection(
  fields: Record<string, string>,
  runner: ObsidianCommandRunner = runObsidianHeadless,
): Promise<void> {
  const authToken = fields.authToken;
  if (typeof authToken !== "string" || authToken.length === 0 || authToken.length > 4096) {
    throw new Error("Stored Obsidian auth token is invalid");
  }
  await runner(["logout"], {
    env: { OBSIDIAN_AUTH_TOKEN: authToken },
    timeoutMs: 30_000,
  });
}

export const obsidianConnector: ConnectorDef = {
  meta: catalogMeta("obsidian"),
  fetchIdentity: async (authToken) => {
    const vaults = await listObsidianRemoteVaults(authToken);
    return { accountLabel: `${vaults.length} vault${vaults.length === 1 ? "" : "s"}` };
  },
  validateStoredFields: verifyObsidianConnection,
  revokeStoredFields: revokeObsidianConnection,
};
