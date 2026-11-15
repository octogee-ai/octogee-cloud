import { computeWorkspaceDisplayName } from "@octogee/shared/types/display-names";
import { buildProvisioningContext, provisionMattermostUserInput } from "./provisionSteps.js";
export function defaultAgentId(slug) {
    return `octogee-${slug}-coach`;
}
export function desiredUserProvisioningSpec(uid, userData) {
    const input = provisionMattermostUserInput(buildProvisioningContext(uid, userData));
    return {
        slug: input.slug,
        displayName: { first: input.firstName, last: input.lastName ?? "" },
        email: input.email,
        avatarUrl: input.photoURL ? input.photoURL : null,
        chat: {
            teamDisplayName: computeWorkspaceDisplayName({ slug: input.slug, firstName: input.firstName, vibe: input.vibe ?? null }),
            defaultAgent: { enabled: true },
        },
        git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
        agentIds: [defaultAgentId(input.slug)],
    };
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}
export function sameProvisioningSpec(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
