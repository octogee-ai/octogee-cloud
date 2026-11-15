import * as crypto from "node:crypto";
import type { Provider } from "./provider-key-format.js";

const BYOT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function byotSecretName(slug: string, provider: Provider): string {
  if (!BYOT_SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  }
  return `byok-${slug}-${provider}`;
}

export function keyFingerprintFor(key: string): string {
  if (!key) return "none";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function credentialVersionFingerprint(versionName: string): string {
  return crypto
    .createHash("sha256")
    .update(versionName)
    .digest("hex")
    .slice(0, 12);
}
