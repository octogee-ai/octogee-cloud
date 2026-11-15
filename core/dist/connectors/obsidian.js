import { listObsidianRemoteVaults, runObsidianHeadless, verifyObsidianConnection, } from "./obsidian-headless.js";
import { catalogMeta } from "./def.js";
export async function revokeObsidianConnection(fields, runner = runObsidianHeadless) {
    const authToken = fields.authToken;
    if (typeof authToken !== "string" || authToken.length === 0 || authToken.length > 4096) {
        throw new Error("Stored Obsidian auth token is invalid");
    }
    await runner(["logout"], {
        env: { OBSIDIAN_AUTH_TOKEN: authToken },
        timeoutMs: 30_000,
    });
}
export const obsidianConnector = {
    meta: catalogMeta("obsidian"),
    fetchIdentity: async (authToken) => {
        const vaults = await listObsidianRemoteVaults(authToken);
        return { accountLabel: `${vaults.length} vault${vaults.length === 1 ? "" : "s"}` };
    },
    validateStoredFields: verifyObsidianConnection,
    revokeStoredFields: revokeObsidianConnection,
};
