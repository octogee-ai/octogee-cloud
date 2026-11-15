export type WebResearchErrorCode = "allowance_exhausted" | "credits_exhausted" | "billing_unavailable" | "rate_limited" | "provider_unconfigured" | "provider_rate_limited" | "provider_error";
export declare class WebResearchError extends Error {
    readonly code: WebResearchErrorCode;
    readonly status: 402 | 429 | 502 | 503;
    constructor(code: WebResearchErrorCode, status: 402 | 429 | 502 | 503, message: string);
}
