import { createHash } from "node:crypto";
import { sidecarBrokerHeaders } from "../internal-fetch.js";
import {
  UserCredentialRejected,
  type UserDocument,
  type UserIdentityProvider,
} from "../user-identity-provider.js";
import { trustedBrokerBaseUrl } from "../trusted-broker-url.js";
import { isValidGatewayId } from "@octogee/shared/types/glm";

import { installUserIdentityProvider } from "../http/auth.js";
import { internalFetch } from "../internal-fetch.js";

export const USER_IDENTITY_BROKER_PATH = "/internal/user-identity/verify";
export const USER_IDENTITY_BROKER_TIMEOUT_MS = 5_000;
const ANSWER_MEMORY_MS = 60_000;
const ANSWER_MEMORY_ENTRIES = 5_000;

interface BrokeredAnswer {
  readonly uid: string;
  readonly authTime: number | null;
  readonly user: UserDocument | null;
  readonly expiresAt: number;
}

function isUserDocument(value: unknown): value is UserDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function answerFrom(body: unknown): Omit<BrokeredAnswer, "expiresAt"> | null {
  if (!isUserDocument(body)) return null;
  const { uid, authTime, user } = body;
  if (typeof uid !== "string" || uid === "") return null;
  if (authTime !== null && !Number.isSafeInteger(authTime)) return null;
  if (user !== null && !isUserDocument(user)) return null;
  return { uid, authTime: authTime as number | null, user: user as UserDocument | null };
}

function rememberBounded<V>(memory: Map<string, V>, key: string, value: V): void {
  memory.delete(key);
  memory.set(key, value);
  for (const oldest of memory.keys()) {
    if (memory.size <= ANSWER_MEMORY_ENTRIES) break;
    memory.delete(oldest);
  }
}

export function userIdentityBrokerUrlFromEnv(env: Record<string, string | undefined> = process.env): string {
  const value = env.OPENCLAW_RUNTIME_BROKER_URL?.trim();
  if (!value) throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required to verify users through the platform API");
  return trustedBrokerBaseUrl(value, env);
}

export function brokeredUserIdentityProvider(options: {
  readonly brokerUrl: string;
  readonly gatewayId: string;
  readonly fetch?: typeof internalFetch;
  readonly credentialHeaders?: () => Promise<Record<string, string>>;
  readonly now?: () => number;
}): UserIdentityProvider {
  if (!isValidGatewayId(options.gatewayId)) {
    throw new Error(`the gateway id is not valid: ${JSON.stringify(options.gatewayId)}`);
  }
  const fetchImpl = options.fetch ?? internalFetch;
  const credentialHeaders = options.credentialHeaders ?? sidecarBrokerHeaders;
  const now = options.now ?? Date.now;
  const answersByBearer = new Map<string, BrokeredAnswer>();
  const answersByUid = new Map<string, BrokeredAnswer>();

  const ask = async (token: string): Promise<Omit<BrokeredAnswer, "expiresAt">> => {
    const response = await fetchImpl(`${options.brokerUrl}${USER_IDENTITY_BROKER_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...await credentialHeaders(),
      },
      body: JSON.stringify({ gatewayId: options.gatewayId }),
    }, { timeoutMs: USER_IDENTITY_BROKER_TIMEOUT_MS });
    if (response.status === 401) throw new UserCredentialRejected("the platform API rejected the bearer");
    if (response.status !== 200) throw new Error(`the user identity broker answered HTTP ${response.status}`);
    const answer = answerFrom(await response.json().catch(() => null));
    if (answer === null) throw new Error("the user identity broker answered without a uid, sign-in time and user");
    return answer;
  };

  return {
    verifyBearer: async (token) => {
      const key = createHash("sha256").update(token).digest("hex");
      const remembered = answersByBearer.get(key);
      const answer = remembered !== undefined && remembered.expiresAt > now()
        ? remembered
        : { ...await ask(token), expiresAt: now() + ANSWER_MEMORY_MS };
      rememberBounded(answersByBearer, key, answer);
      rememberBounded(answersByUid, answer.uid, answer);
      return { uid: answer.uid, authTime: answer.authTime };
    },
    loadUser: async (uid) => {
      const answer = answersByUid.get(uid);
      if (answer === undefined) throw new Error("the user identity broker has not verified this user");
      return answer.user;
    },
  };
}

export function installBrokeredUserIdentity(env: Record<string, string | undefined> = process.env): void {
  installUserIdentityProvider(brokeredUserIdentityProvider({
    brokerUrl: userIdentityBrokerUrlFromEnv(env),
    gatewayId: env.GATEWAY_ID?.trim() ?? "",
  }));
}
