import { dualReadGatewayClassValue } from "./glm.js";

export const ACCOUNT_DELETION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type AccountLifecycleStatus =
  | "active"
  | "suspended"
  | "deletion_scheduled"
  | "erasing";

export interface AccountLifecycle {
  status: AccountLifecycleStatus;
  deletionId?: string;
  suspendedAt?: number;
  eraseAfter?: number;
}

export const USER_DELETION_JOBS_COLLECTION = "customerDeletionJobs";
export const ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION =
  "anonymousOperationalArchives";

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
} as const;

export function isAnonymousOperationalModelDimension(
  provider: unknown,
  model: unknown,
): boolean {
  if (typeof provider !== "string" || typeof model !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(
    ANONYMOUS_OPERATIONAL_MODELS_BY_PROVIDER,
    provider,
  )) return false;
  const models = ANONYMOUS_OPERATIONAL_MODELS_BY_PROVIDER[
    provider as keyof typeof ANONYMOUS_OPERATIONAL_MODELS_BY_PROVIDER
  ] as readonly string[];
  return models.includes(model);
}

const ANONYMOUS_OPERATIONAL_ENVIRONMENTS = ["test", "prod"] as const;
const ANONYMOUS_OPERATIONAL_GATEWAY_CLASSES = [
  "shared",
  "isolated",
] as const;

export function closedOperationalValue(
  value: unknown,
  allowed: readonly string[],
): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

export function anonymousOperationalEnvironment(value: unknown): string {
  return closedOperationalValue(value, ANONYMOUS_OPERATIONAL_ENVIRONMENTS) ?? "unknown";
}

export function anonymousOperationalGatewayClass(value: unknown): string | null {
  return closedOperationalValue(dualReadGatewayClassValue(value), ANONYMOUS_OPERATIONAL_GATEWAY_CLASSES);
}

export function accountAllowsInteractiveAccess(
  userData: Record<string, unknown> | undefined,
): boolean {
  const lifecycle = userData?.accountLifecycle;
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
    return true;
  }
  const status = (lifecycle as Record<string, unknown>).status;
  return status === undefined || status === "active";
}

export function buildUserDeletionSchedule(input: {
  now: number;
  eraseNow: boolean;
}): { requestedAt: number; eraseAfter: number } {
  return {
    requestedAt: input.now,
    eraseAfter: input.eraseNow
      ? input.now
      : input.now + ACCOUNT_DELETION_RETENTION_MS,
  };
}
