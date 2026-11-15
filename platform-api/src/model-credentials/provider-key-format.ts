import {
  MODEL_CREDENTIAL_CATALOG,
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  type ModelCredentialActiveStaticProviderId,
} from "@octogee/shared/types/model-credentials";
import { validateAnthropicKey, type KeyValidationResult } from "./anthropic-key-format.js";

export type Provider = ModelCredentialActiveStaticProviderId;

export const SUPPORTED = [...MODEL_CREDENTIAL_STATIC_PROVIDER_IDS];

export const CANONICAL_BASE_URL = Object.fromEntries(
  MODEL_CREDENTIAL_CATALOG
    .flatMap((entry) =>
      entry.activeSlotEligible && entry.baseUrl.kind === "canonical"
        ? [[entry.id, entry.baseUrl.value] as const]
        : [],
    ),
) as Partial<Record<Provider, string>>;

export function isSupportedProvider(input: unknown): input is Provider {
  return typeof input === "string" && (SUPPORTED as string[]).includes(input);
}

const OPENAI_PREFIXES = ["sk-proj-", "sk-svcacct-", "sk-"];
const OPENAI_MIN_LENGTH = 32;

function validateOpenAi(input: unknown): KeyValidationResult {
  if (typeof input !== "string") return { valid: false, reason: "API key is required" };
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, reason: "API key is required (empty)" };
  if (trimmed.startsWith("sk-ant-")) {
    return {
      valid: false,
      reason: "That looks like an Anthropic key — pick the Anthropic provider, not OpenAI",
    };
  }
  if (!OPENAI_PREFIXES.some((p) => trimmed.startsWith(p))) {
    return { valid: false, reason: 'OpenAI keys must start with "sk-" (or sk-proj- / sk-svcacct-)' };
  }
  if (trimmed.length < OPENAI_MIN_LENGTH) {
    return { valid: false, reason: "API key is too short (suspected truncation)" };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: "API key contains whitespace" };
  }
  return { valid: true, normalized: trimmed };
}

function validateOpenAiCompatible(input: unknown): KeyValidationResult {
  if (typeof input !== "string") return { valid: false, reason: "API key is required" };
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, reason: "API key is required (empty)" };
  if (/\s/.test(trimmed)) return { valid: false, reason: "API key contains whitespace" };
  return { valid: true, normalized: trimmed };
}

export function validateProviderKey(provider: Provider, input: unknown): KeyValidationResult {
  switch (provider) {
    case "anthropic":         return validateAnthropicKey(input);
    case "openai":            return validateOpenAi(input);
    // openai-compatible family (incl. canonical Grok / OpenRouter / MiniMax):
    // lenient key-shape check — the upstream probe is the real validation.
    case "openai-compatible":
    case "grok":
    case "openrouter":
    case "minimax":           return validateOpenAiCompatible(input);
    default:                  return { valid: false, reason: `Unsupported provider: ${provider}` };
  }
}
