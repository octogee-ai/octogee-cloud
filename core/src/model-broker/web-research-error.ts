export type WebResearchErrorCode =
  | "allowance_exhausted"
  | "credits_exhausted"
  | "billing_unavailable"
  | "rate_limited"
  | "provider_unconfigured"
  | "provider_rate_limited"
  | "provider_error";

export class WebResearchError extends Error {
  constructor(
    public readonly code: WebResearchErrorCode,
    public readonly status: 402 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "WebResearchError";
  }
}
