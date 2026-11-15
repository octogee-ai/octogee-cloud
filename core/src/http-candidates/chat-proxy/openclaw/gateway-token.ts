import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  GATEWAY_TOKEN_PLACEHOLDER,
} from "./gateway-token-constants.js";
import {
  GATEWAY_ID_REQUIREMENT,
  isValidGatewayId,
} from "@octogee/shared/types/glm";
import { isPerUserControlIdentity } from "@octogee/shared/types/openclaw-proxy-identity";

export type GatewayTokenErrorCode =
  | "empty-token"
  | "fetch-failed"
  | "not-configured"
  | "invalid-gateway-id"
  | "device-token-persist-failed";

export class GatewayTokenError extends Error {
  override readonly name = "GatewayTokenError";
  constructor(
    readonly code: GatewayTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface CacheEntry {
  token: string;
  fetchedAt: number;
}
const TOKEN_CACHE_TTL_MS = 30_000;
const TOKEN_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_OPENCLAW_DEVICE_TOKEN_PATH =
  "/var/run/octogee/openclaw-device-auth/token";
const cache = new Map<string, CacheEntry>();

export interface FetchGatewayTokenOptions {
  gatewayId: string;
  projectId?: string;
  client?: Pick<
    SecretManagerServiceClient,
    "accessSecretVersion"
  >;
  skipCache?: boolean;
}

export interface FetchGatewayAuthOptions extends FetchGatewayTokenOptions {
  allowLegacyFallback?: boolean;
  deviceTokenPath?: string;
}

export type GatewayOpenClawAuth =
  | { source: "device-token-file"; deviceToken: string; token?: undefined }
  | { source: "legacy-token"; token: string; deviceToken?: undefined }
  | { source: "trusted-proxy"; token?: undefined; deviceToken?: undefined };

let sharedClient: SecretManagerServiceClient | null = null;
function getClient(): SecretManagerServiceClient {
  if (sharedClient === null) sharedClient = new SecretManagerServiceClient();
  return sharedClient;
}

function requireValidGatewayId(gatewayId: string): void {
  if (!isValidGatewayId(gatewayId)) {
    throw new GatewayTokenError(
      "invalid-gateway-id",
      `gatewayId ${JSON.stringify(gatewayId)} is invalid: ${GATEWAY_ID_REQUIREMENT}`,
    );
  }
}

function projectIdFromEnv(projectId?: string): string {
  return projectId ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
}

function envTokenFallback(opts: {
  gatewayId: string;
  projectId: string;
}): string | null {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const isLocalGateway = process.env.GATEWAY_ID === opts.gatewayId;
  if (isLocalGateway && envToken.length > 0) return envToken;
  if (opts.projectId) return null;
  if (envToken.length > 0) return envToken;
  throw new GatewayTokenError(
    "not-configured",
    "GCP_PROJECT_ID unset and OPENCLAW_GATEWAY_TOKEN unset — no token source",
  );
}

function cachedToken(gatewayId: string, skipCache?: boolean): string | null {
  if (skipCache) return null;
  const cached = cache.get(gatewayId);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  return null;
}

function isSecretManagerNetworkDown(e: { code?: unknown; errno?: unknown }): boolean {
  return (
    e.code === 4 ||
    e.code === 14 ||
    e.errno === "ENOTFOUND" ||
    e.errno === "ECONNREFUSED" ||
    (typeof e.code === "string" && (e.code === "DEADLINE_EXCEEDED" || e.code === "ENOTFOUND" || e.code === "ECONNREFUSED"))
  );
}

function assertResolvedToken(token: string, secretName: string, gatewayId: string): void {
  if (!token || token.trim().length === 0) {
    throw new GatewayTokenError(
      "empty-token",
      `Secret ${secretName} returned an empty payload — gateway publish failed?`,
    );
  }
  // eslint-disable-next-line security/detect-possible-timing-attacks -- public bootstrap sentinel, not a secret-dependent auth decision.
  if (token === GATEWAY_TOKEN_PLACEHOLDER) {
    throw new GatewayTokenError(
      "empty-token",
      `gateway-auth-token-${gatewayId} is still the bootstrap placeholder — gateway has not yet published its token`,
    );
  }
}

function resolveDeviceTokenPath(deviceTokenPath?: string): string {
  return (
    deviceTokenPath ??
    process.env.OPENCLAW_GATEWAY_DEVICE_TOKEN_PATH ??
    DEFAULT_OPENCLAW_DEVICE_TOKEN_PATH
  );
}

async function readDeviceTokenFromFile(deviceTokenPath?: string): Promise<string | null> {
  try {
    const token = (await readFile(resolveDeviceTokenPath(deviceTokenPath), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function rememberToken(gatewayId: string, token: string): void {
  if (cache.size >= TOKEN_CACHE_MAX_ENTRIES && !cache.has(gatewayId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(gatewayId, { token, fetchedAt: Date.now() });
}

export async function fetchGatewayToken(
  opts: FetchGatewayTokenOptions,
): Promise<string> {
  requireValidGatewayId(opts.gatewayId);
  const projectId = projectIdFromEnv(opts.projectId);
  const fallback = envTokenFallback({ gatewayId: opts.gatewayId, projectId });
  if (fallback) return fallback;
  const cached = cachedToken(opts.gatewayId, opts.skipCache);
  if (cached) return cached;

  const client = opts.client ?? getClient();
  const secretName = `projects/${projectId}/secrets/gateway-auth-token-${opts.gatewayId}/versions/latest`;

  let accessResult;
  try {
    [accessResult] = await client.accessSecretVersion({ name: secretName });
  } catch (err) {
    const e = err as { code?: unknown; errno?: unknown } & Error;
    const envToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    if (envToken.length > 0 && isSecretManagerNetworkDown(e)) {
      return envToken;
    }
    throw new GatewayTokenError(
      "fetch-failed",
      `Secret Manager access failed for ${secretName}: ${e.message}`,
    );
  }

  const payload = accessResult.payload?.data;
  const token = typeof payload === "string" ? payload : Buffer.from(payload ?? "").toString("utf8");
  assertResolvedToken(token, secretName, opts.gatewayId);
  rememberToken(opts.gatewayId, token);
  return token;
}

export async function fetchGatewayAuth(
  opts: FetchGatewayAuthOptions,
): Promise<GatewayOpenClawAuth> {
  requireValidGatewayId(opts.gatewayId);
  if (isPerUserControlIdentity() && process.env.GATEWAY_ID === opts.gatewayId) {
    return { source: "trusted-proxy" };
  }
  const deviceToken = await readDeviceTokenFromFile(opts.deviceTokenPath);
  if (deviceToken) {
    return { source: "device-token-file", deviceToken };
  }
  if (!opts.allowLegacyFallback) {
    throw new GatewayTokenError(
      "not-configured",
      `OpenClaw device token unavailable at ${resolveDeviceTokenPath(opts.deviceTokenPath)} and legacy gateway-token fallback is disabled`,
    );
  }
  const token = await fetchGatewayToken(opts);
  return { source: "legacy-token", token };
}

export async function persistGatewayDeviceToken(opts: {
  token: string;
  deviceTokenPath?: string;
}): Promise<void> {
  const token = opts.token.trim();
  if (!token) return;
  const filePath = resolveDeviceTokenPath(opts.deviceTokenPath);
  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, `${token}\n`, { mode: 0o600 });
  } catch (err) {
    throw new GatewayTokenError(
      "device-token-persist-failed",
      `failed writing OpenClaw device token to ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function clearGatewayDeviceToken(deviceTokenPath?: string): Promise<void> {
  await rm(resolveDeviceTokenPath(deviceTokenPath), { force: true }).catch(() => undefined);
}

export function invalidateGatewayToken(gatewayId: string): void {
  cache.delete(gatewayId);
}

export function __resetGatewayTokenCacheForTest(): void {
  cache.clear();
}
