import { catalogMeta } from "./def.js";
export const cloudflareConnector = {
    meta: catalogMeta("cloudflare"),
    fetchIdentity: async (accessToken) => {
        const resp = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
            throw new Error(`Cloudflare token verify failed: ${resp.status}`);
        }
        const out = (await resp.json());
        if (!out.success || out.result?.status !== "active") {
            throw new Error(`Cloudflare token is not active: ${out.result?.status ?? "unknown"}`);
        }
        return { accountLabel: `token …${(out.result.id ?? "").slice(-6)}` };
    },
};
