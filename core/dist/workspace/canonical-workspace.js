import { USERNAME_RE } from "@octogee/shared/types/identity";
import { platformStateStore } from "../identity/platform-state-store.js";
function usableSlug(v) {
    return typeof v === "string" && USERNAME_RE.test(v) ? v : null;
}
function unique(values) {
    return Array.from(new Set(values));
}
async function ownsWorkspace(uid, slug) {
    return (await platformStateStore.workspaces.records.get(slug))?.ownerUid === uid;
}
export async function resolveCanonicalWorkspaceSlug(uid, data) {
    const provisionedSlug = usableSlug(data?.provisioning?.openclaw?.slug);
    if (provisionedSlug)
        return provisionedSlug;
    const candidates = unique([
        data?.workspaceSlug,
        data?.workspaceId,
        data?.defaultWorkspaceId,
        data?.username,
    ]
        .map(usableSlug)
        .filter((slug) => !!slug));
    for (const slug of candidates) {
        if (await ownsWorkspace(uid, slug))
            return slug;
    }
    return null;
}
