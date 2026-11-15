import type { ProvisioningRole } from "@octogee/shared/types/provisioning-service";

export interface ServiceConfig {
  port: number;
  databaseUrl: string;
  databaseSchema: string;
  callerNamespace: string;
  tokenReviewUrl: string;
  tokenReviewTokenFile: string;
  tokenReviewCaFile: string | null;
  credentialKey: Buffer;
  hostAdapters: "fake";
  replicaId: string;
}

export const CALLER_ROLES: Readonly<Record<string, readonly ProvisioningRole[]>> = {
  "octogee-glm-controller": ["writer"],
  "octogee-api": ["key-writer", "reader", "credential-reader"],
};

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const port = Number(env.PROVISIONING_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PROVISIONING_PORT must be a port number");
  const databaseSchema = env.PROVISIONING_DATABASE_SCHEMA?.trim() || "provisioning_service";
  if (!SCHEMA_PATTERN.test(databaseSchema)) throw new Error("PROVISIONING_DATABASE_SCHEMA must be a lower-case identifier");
  const credentialKey = Buffer.from(required(env, "PROVISIONING_CREDENTIAL_KEY"), "base64");
  if (credentialKey.length !== 32) throw new Error("PROVISIONING_CREDENTIAL_KEY must be 32 bytes, base64 encoded");
  const hostAdapters = required(env, "PROVISIONING_HOST_ADAPTERS");
  if (hostAdapters !== "fake") throw new Error(`PROVISIONING_HOST_ADAPTERS=${hostAdapters} is not available in this build; only "fake" is`);
  const apiHost = env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const apiPort = env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
  return {
    port,
    databaseUrl: required(env, "PROVISIONING_DATABASE_URL"),
    databaseSchema,
    callerNamespace: required(env, "PROVISIONING_CALLER_NAMESPACE"),
    tokenReviewUrl: env.PROVISIONING_TOKEN_REVIEW_URL?.trim() || `https://${apiHost}:${apiPort}/apis/authentication.k8s.io/v1/tokenreviews`,
    tokenReviewTokenFile: env.PROVISIONING_TOKEN_REVIEW_TOKEN_FILE?.trim() || "/var/run/secrets/kubernetes-api/token",
    tokenReviewCaFile: env.PROVISIONING_TOKEN_REVIEW_CA_FILE?.trim() || null,
    credentialKey,
    hostAdapters,
    replicaId: env.HOSTNAME?.trim() || `replica-${process.pid}`,
  };
}
