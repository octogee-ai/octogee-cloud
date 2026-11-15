import { catalogMeta } from "./def.js";
export const netlifyConnector = {
    meta: catalogMeta("netlify"),
    fetchIdentity: async (accessToken) => {
        const resp = await fetch("https://api.netlify.com/api/v1/user", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
            throw new Error(`Netlify identity check failed: ${resp.status}`);
        }
        const user = (await resp.json());
        const accountLabel = user.email || user.full_name;
        if (!accountLabel) {
            throw new Error("Netlify identity response has no email or name");
        }
        return { accountLabel };
    },
};
