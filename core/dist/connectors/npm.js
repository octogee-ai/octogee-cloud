import { catalogMeta } from "./def.js";
export const npmConnector = {
    meta: catalogMeta("npm"),
    fetchIdentity: async (accessToken) => {
        const resp = await fetch("https://registry.npmjs.org/-/whoami", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
            throw new Error(`npm identity check failed: ${resp.status}`);
        }
        const out = (await resp.json());
        if (!out.username) {
            throw new Error("npm whoami returned no username");
        }
        return { accountLabel: out.username };
    },
};
