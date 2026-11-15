import * as crypto from "node:crypto";
import { isValidGatewayId } from "@octogee/shared/types/glm";

export const MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER = "x-byot-sync-timestamp";
export const MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER = "x-byot-sync-signature";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, val]) => val !== undefined && typeof val !== "function" && typeof val !== "symbol")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function signaturePayload(body: unknown, timestamp: string, gatewayId: string): Buffer {
  return Buffer.from(`v1\n${gatewayId}\n${timestamp}\n${canonicalJson(body)}`);
}

export function validModelCredentialSyncPublicKey(key: string): boolean {
  try {
    return key.includes("BEGIN PUBLIC KEY") && crypto.createPublicKey(key).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function createModelCredentialSyncAuthHeaders(args: {
  body: unknown;
  gatewayId: string;
  secret: string;
  nowMs?: number;
}): Record<string, string> {
  const secret = args.secret.trim();
  if (!secret) {
    throw new Error("BYOT_SYNC_INTERNAL_SIGNING_SECRET is required for model credential sync");
  }
  if (!isValidGatewayId(args.gatewayId)) throw new Error("model credential sync requires a valid gatewayId");
  const privateKey = crypto.createPrivateKey(secret);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("model credential sync requires an Ed25519 private key");
  const timestamp = `${Math.floor(args.nowMs ?? Date.now())}`;
  return {
    [MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER]: timestamp,
    [MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER]: crypto.sign(null, signaturePayload(args.body, timestamp, args.gatewayId), privateKey).toString("hex"),
  };
}

export function isValidModelCredentialSyncSignature(args: {
  body: unknown;
  gatewayId: string;
  publicKey: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): boolean {
  if (!validModelCredentialSyncPublicKey(args.publicKey) || !isValidGatewayId(args.gatewayId) || !args.timestamp || !args.signature) return false;
  if (!/^\d+$/.test(args.timestamp) || !/^[a-f0-9]{128}$/i.test(args.signature)) return false;
  const timestampMs = Number(args.timestamp);
  if (!Number.isSafeInteger(timestampMs)) return false;
  if (Math.abs((args.nowMs ?? Date.now()) - timestampMs) > MAX_CLOCK_SKEW_MS) return false;
  return crypto.verify(null, signaturePayload(args.body, args.timestamp, args.gatewayId), args.publicKey, Buffer.from(args.signature, "hex"));
}
