import { randomBytes } from "node:crypto";
import type { KubectlSubprocess } from "./fleet-ingress.js";

// Re-export so callers (and tests) can import the type from the ensurer
// without also reaching into fleet-ingress for an unrelated dep.
export type { KubectlSubprocess } from "./fleet-ingress.js";

export interface AuthSecretEnsurer {
  ensureAuthSecret(opts: {
    namespace: string;
    gatewayId: string;
  }): Promise<void>;
}

export interface AuthSecretEnsurerDeps {
  runKubectl: KubectlSubprocess;
  /**
   * Returns a fresh random token string. Production wires this to
   * `defaultRandomTokenHex` (48 hex chars from node:crypto); tests inject
   * a deterministic stub.
   */
  randomTokenHex: () => string;
  log: (msg: string) => void;
}

/**
 * Returns a 48-hex-char (192-bit) random token. Matches the historical
 * `cat /dev/urandom | tr -dc 'a-f0-9' | head -c 48` invocation from
 * entrypoint.sh, so existing log-grep / op-runbook habits stay valid.
 */
export function defaultRandomTokenHex(): string {
  return randomBytes(24).toString("hex");
}

const NOT_FOUND_PATTERNS = [/NotFound/i, /not found/i];
const ALREADY_EXISTS_PATTERNS = [/AlreadyExists/i, /already exists/i];

function isSecretNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

function isSecretAlreadyExists(stderr: string): boolean {
  return ALREADY_EXISTS_PATTERNS.some((p) => p.test(stderr));
}

function secretNameForGateway(gatewayId: string): string {
  return `gateway-auth-token-${gatewayId}`;
}

export interface GatewayAuthSecret {
  token: string;
  agentStoreDsn?: string | undefined;
  agentStoreOwner?: string | undefined;
}

export async function readGatewayAuthSecret(
  deps: { runKubectl: KubectlSubprocess },
  opts: { namespace: string; gatewayId: string },
): Promise<GatewayAuthSecret> {
  const secretName = secretNameForGateway(opts.gatewayId);
  const result = await deps.runKubectl(["get", "secret", secretName, "-n", opts.namespace, "-o", "json"]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get secret ${secretName} (ns=${opts.namespace}) failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const secretData = (parsed as { data?: unknown } | null)?.data;
    if (typeof secretData === "object" && secretData !== null) data = secretData as Record<string, unknown>;
  } catch {
    throw new Error(`gateway auth secret ${secretName} (ns=${opts.namespace}) is not readable`);
  }
  const decode = (key: string): string | undefined => {
    const raw = data[key];
    const value = typeof raw === "string" ? Buffer.from(raw, "base64").toString("utf8") : "";
    return value || undefined;
  };
  const token = decode("token");
  if (!token) {
    throw new Error(`gateway auth secret ${secretName} (ns=${opts.namespace}) has no token data`);
  }
  return { token, agentStoreDsn: decode("agent-store-dsn"), agentStoreOwner: decode("agent-store-owner") };
}

/**
 * Ensures a per-gateway K8s secret `gateway-auth-token-<gatewayId>` exists
 * in `namespace` with key `token`. Idempotent: a live secret is never
 * rotated by this function (token rotation is a separate explicit op).
 *
 * Why this exists: see __tests__/auth-secret-ensurer.spec.ts header.
 * Short version: the chart now threads OPENCLAW_GATEWAY_TOKEN via
 * secretKeyRef on every container that needs it, so the secret MUST
 * exist before `helm upgrade` runs or pod boot fails on the missing
 * secretKeyRef. The fleet controller calls this before each upsertInstance.
 */
export function createAuthSecretEnsurer(
  deps: AuthSecretEnsurerDeps,
): AuthSecretEnsurer {
  return {
    async ensureAuthSecret({ namespace, gatewayId }) {
      const secretName = secretNameForGateway(gatewayId);
      const getResult = await deps.runKubectl([
        "get",
        "secret",
        secretName,
        "-n",
        namespace,
        "-o",
        "name",
      ]);
      if (getResult.code === 0) {
        return;
      }
      if (!isSecretNotFound(getResult.stderr)) {
        throw new Error(
          `kubectl get secret ${secretName} (ns=${namespace}) failed (code=${getResult.code}): ${getResult.stderr.trim() || getResult.stdout.trim()}`,
        );
      }
      const token = deps.randomTokenHex();
      const createResult = await deps.runKubectl([
        "create",
        "secret",
        "generic",
        secretName,
        `--from-literal=token=${token}`,
        "-n",
        namespace,
      ]);
      if (createResult.code === 0) {
        deps.log(
          `[auth-secret-ensurer] created ${secretName} in ns=${namespace} (random token, 48 hex chars)`,
        );
        return;
      }
      // Race: two reconcilers / a retry chasing a peer can both see NotFound
      // and both race to create. One wins, the other gets AlreadyExists. The
      // desired end state is satisfied either way — don't crash the helm
      // upsert behind us.
      if (isSecretAlreadyExists(createResult.stderr)) {
        deps.log(
          `[auth-secret-ensurer] ${secretName} in ns=${namespace} already exists (AlreadyExists from kubectl create — concurrent ensurer won the race)`,
        );
        return;
      }
      throw new Error(
        `kubectl create secret ${secretName} (ns=${namespace}) failed (code=${createResult.code}): ${createResult.stderr.trim() || createResult.stdout.trim()}`,
      );
    },
  };
}
