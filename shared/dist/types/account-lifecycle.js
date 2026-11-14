import { dualReadGatewayClassValue } from "./glm.js";
export const ACCOUNT_DELETION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const USER_DELETION_JOBS_COLLECTION = "customerDeletionJobs";
export const ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION = "anonymousOperationalArchives";
const ANONYMOUS_OPERATIONAL_MODELS_BY_PROVIDER = {
    anthropic: [
        "fable",
        "mythos",
        "opus-latest",
        "opus-legacy",
        "sonnet",
        "haiku-4.5",
        "haiku-3.5",
        "unknown-fable-fallback",
    ],
    openrouter: [
        "openrouter:z-ai/glm-5.2",
        "openrouter:deepseek/deepseek-v4-pro",
        "openrouter:openai/gpt-5.6-luna",
        "openrouter:unknown-fallback",
    ],
    openai: [
        "openai:gpt-6-luna",
        "openai:gpt-6.1-terra",
        "openai:gpt-6.1-sol",
        "openai:gpt-5.4-mini",
        "openai:unknown-fallback",
    ],
    brave: ["brave/web-search", "brave/unknown"],
    tavily: [
        "tavily/search-basic",
        "tavily/search-advanced",
        "tavily/extract-basic",
        "tavily/extract-advanced",
        "tavily/unknown",
    ],
    unknown: ["unknown"],
};
export function isAnonymousOperationalModelDimension(provider, model) {
    if (typeof provider !== "string" || typeof model !== "string")
        return false;
    if (!Object.prototype.hasOwnProperty.call(ANONYMOUS_OPERATIONAL_MODELS_BY_PROVIDER, provider))
        return false;
    const models = ANONYMOUS_OPERATIONAL_MODELS_BY_PROVIDER[provider];
    return models.includes(model);
}
const ANONYMOUS_OPERATIONAL_ENVIRONMENTS = ["test", "prod"];
const ANONYMOUS_OPERATIONAL_GATEWAY_CLASSES = [
    "shared",
    "isolated",
];
export function closedOperationalValue(value, allowed) {
    return typeof value === "string" && allowed.includes(value) ? value : null;
}
export function anonymousOperationalEnvironment(value) {
    return closedOperationalValue(value, ANONYMOUS_OPERATIONAL_ENVIRONMENTS) ?? "unknown";
}
export function anonymousOperationalGatewayClass(value) {
    return closedOperationalValue(dualReadGatewayClassValue(value), ANONYMOUS_OPERATIONAL_GATEWAY_CLASSES);
}
export function accountAllowsInteractiveAccess(userData) {
    const lifecycle = userData?.accountLifecycle;
    if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
        return true;
    }
    const status = lifecycle.status;
    return status === undefined || status === "active";
}
export function buildUserDeletionSchedule(input) {
    return {
        requestedAt: input.now,
        eraseAfter: input.eraseNow
            ? input.now
            : input.now + ACCOUNT_DELETION_RETENTION_MS,
    };
}
