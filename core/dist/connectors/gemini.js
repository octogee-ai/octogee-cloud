import { catalogMeta } from "./def.js";
export const geminiConnector = {
    meta: catalogMeta("gemini"),
    fetchIdentity: async (accessToken) => {
        const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
            headers: { "x-goog-api-key": accessToken },
        });
        if (!resp.ok) {
            throw new Error(`Gemini key check failed: ${resp.status}`);
        }
        const out = (await resp.json());
        if (!Array.isArray(out.models) || out.models.length === 0) {
            throw new Error("Gemini key check returned no models");
        }
        return { accountLabel: "AI Studio key" };
    },
};
