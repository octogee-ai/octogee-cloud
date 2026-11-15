import * as crypto from "crypto";

export const CONNECT_STATE_TTL_SECONDS = 10 * 60;

function getSecret(): string {
  const secret = process.env.CONNECT_STATE_SECRET;
  if (!secret) {
    throw new Error("CONNECT_STATE_SECRET environment variable is required for connect state");
  }
  return secret;
}

export interface ConnectStatePayload {
  uid: string;
  connector: string;
  returnUrl: string;
  nonce: string;
  expiresAt: number;
}

export function generateConnectState(
  payload: Omit<ConnectStatePayload, "nonce" | "expiresAt">,
): { state: string; nonce: string; expiresAt: Date } {
  const secret = getSecret();
  const nonce = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + CONNECT_STATE_TTL_SECONDS;
  const fullPayload: ConnectStatePayload = { ...payload, nonce, expiresAt };
  const payloadStr = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadStr).digest("base64url");

  return {
    state: `${payloadStr}.${signature}`,
    nonce,
    expiresAt: new Date(expiresAt * 1000),
  };
}

export function verifyConnectState(state: string): ConnectStatePayload {
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid state format");
  }

  const [payloadStr, providedSig] = parts;
  const expectedSig = crypto.createHmac("sha256", getSecret()).update(payloadStr).digest("base64url");

  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    throw new Error("Invalid state signature");
  }

  const payload: ConnectStatePayload = JSON.parse(
    Buffer.from(payloadStr, "base64url").toString("utf-8"),
  );

  if (payload.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("State has expired");
  }

  return payload;
}
