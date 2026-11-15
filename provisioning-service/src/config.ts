import type { ProvisioningRole } from "@octogee/shared/types/provisioning-service";
import { databaseConnection, databaseSettingsFromEnvironment } from "./store/database-settings.js";
import type { DatabaseConnection } from "./store/database.js";
import type { CallerLimits } from "./http/caller-limits.js";

export interface RealHostSettings {
  chatHostUrl: string;
  chatHostAdminToken: string;
  chatHostAdminUserId: string | null;
  chatControlCommandUrl: string;
  gitHostUrl: string;
  gitHostAdminToken: string;
}

export type HostAdapterConfig = { kind: "fake" } | { kind: "real"; settings: RealHostSettings };

export interface ServiceConfig {
  port: number;
  database: DatabaseConnection;
  databaseSchema: string;
  callerNamespace: string;
  tokenReviewUrl: string;
  tokenReviewTokenFile: string;
  tokenReviewCaFile: string | null;
  credentialKey: Buffer;
  hosts: HostAdapterConfig;
  replicaId: string;
  limits: CallerLimits;
}

export const CALLER_ROLES: Readonly<Record<string, readonly ProvisioningRole[]>> = {
  "octogee-glm-controller": ["writer", "credential-reader"],
  "octogee-api": ["key-writer", "reader", "credential-reader"],
};

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const IN_CLUSTER_REVIEWER_TOKEN = "/var/run/secrets/kubernetes-api/token";
const IN_CLUSTER_REVIEWER_CA = "/var/run/secrets/kubernetes-api/ca.crt";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null;
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${name} must be an http or https URL`);
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const text = optional(env, name);
  if (text === null) return fallback;
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new Error(`${name} must be a whole number of at least 1`);
  return Number(text);
}

function hostAdapters(env: NodeJS.ProcessEnv): HostAdapterConfig {
  const kind = required(env, "PROVISIONING_HOST_ADAPTERS");
  if (kind === "fake") return { kind: "fake" };
  if (kind !== "real") throw new Error(`PROVISIONING_HOST_ADAPTERS must be "real" or "fake", not "${kind}"`);
  return {
    kind: "real",
    settings: {
      chatHostUrl: url(env, "PROVISIONING_CHAT_HOST_URL"),
      chatHostAdminToken: required(env, "PROVISIONING_CHAT_HOST_ADMIN_TOKEN"),
      chatHostAdminUserId: optional(env, "PROVISIONING_CHAT_HOST_ADMIN_USER_ID"),
      chatControlCommandUrl: url(env, "PROVISIONING_CHAT_CONTROL_COMMAND_URL"),
      gitHostUrl: url(env, "PROVISIONING_GIT_HOST_URL"),
      gitHostAdminToken: required(env, "PROVISIONING_GIT_HOST_ADMIN_TOKEN"),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const port = Number(env.PROVISIONING_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PROVISIONING_PORT must be a port number");
  const databaseSchema = optional(env, "PROVISIONING_DATABASE_SCHEMA") ?? "provisioning_service";
  if (!SCHEMA_PATTERN.test(databaseSchema)) throw new Error("PROVISIONING_DATABASE_SCHEMA must be a lower-case identifier");
  const credentialKey = Buffer.from(required(env, "PROVISIONING_CREDENTIAL_KEY"), "base64");
  if (credentialKey.length !== 32) throw new Error("PROVISIONING_CREDENTIAL_KEY must be 32 bytes, base64 encoded");
  const configuredReviewUrl = optional(env, "PROVISIONING_TOKEN_REVIEW_URL");
  const tokenReviewUrl = configuredReviewUrl
    ?? `https://${required(env, "KUBERNETES_SERVICE_HOST")}:${env.KUBERNETES_SERVICE_PORT_HTTPS?.trim() || "443"}/apis/authentication.k8s.io/v1/tokenreviews`;
  const tokenReviewCaFile = optional(env, "PROVISIONING_TOKEN_REVIEW_CA_FILE") ?? (tokenReviewUrl.startsWith("https:") ? IN_CLUSTER_REVIEWER_CA : null);
  return {
    port,
    database: databaseConnection(databaseSettingsFromEnvironment(env)),
    databaseSchema,
    callerNamespace: required(env, "PROVISIONING_CALLER_NAMESPACE"),
    tokenReviewUrl,
    tokenReviewTokenFile: optional(env, "PROVISIONING_TOKEN_REVIEW_TOKEN_FILE") ?? IN_CLUSTER_REVIEWER_TOKEN,
    tokenReviewCaFile,
    credentialKey,
    hosts: hostAdapters(env),
    replicaId: optional(env, "HOSTNAME") ?? `replica-${process.pid}`,
    limits: {
      requestsPerMinute: positiveInteger(env, "PROVISIONING_CALLER_REQUESTS_PER_MINUTE", 3_000),
      concurrentWaits: positiveInteger(env, "PROVISIONING_CALLER_CONCURRENT_WAITS", 100),
    },
  };
}
