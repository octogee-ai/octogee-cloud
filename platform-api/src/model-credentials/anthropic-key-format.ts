export interface KeyValidationResult {
  valid: boolean;
  reason?: string;
  normalized?: string;
}

const ANTHROPIC_PREFIX = "sk-ant-";
const MIN_LENGTH = 32;

export function validateAnthropicKey(input: unknown): KeyValidationResult {
  if (typeof input !== "string") {
    return { valid: false, reason: "API key is required" };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, reason: "API key is required (empty)" };
  }
  if (!trimmed.startsWith(ANTHROPIC_PREFIX)) {
    return {
      valid: false,
      reason: `Anthropic keys must start with "${ANTHROPIC_PREFIX}"`,
    };
  }
  if (trimmed.length < MIN_LENGTH) {
    return { valid: false, reason: "API key is too short (suspected truncation)" };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: "API key contains whitespace" };
  }
  return { valid: true, normalized: trimmed };
}
