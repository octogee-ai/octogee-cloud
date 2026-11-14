import type { GatewayClass } from "@octogee/shared/types/glm";
import type { KubectlSubprocess } from "./fleet-ingress.js";

export const GATEWAY_MODEL_KEY_SECRET_PREFIX = "gateway-model-key-";
export const GATEWAY_MODEL_KEY_DATA_KEY = "anthropic_api_key";

export interface GatewayModelKeySourceSecret {
  value: string;
  labels: Record<string, string>;
}

export interface GatewayModelKeySecretEnsurer {
  syncGatewayModelKeySecret(opts: {
    namespace: string;
    gatewayId: string;
    gatewayClass: GatewayClass;
  }): Promise<GatewayModelKeySecretResult>;
}

export interface GatewayModelKeySecretResult {
  gatewayId: string;
  secretName: string;
  changed: boolean;
  action:
    | "upserted"
    | "deleted"
    | "unchanged"
    | "skipped";
  reason?:
    | "non_builder"
    | "missing_source"
    | "invalid_source_labels"
    | "empty_source_value";
}

export interface GatewayModelKeySecretEnsurerDeps {
  runKubectl: KubectlSubprocess;
  readSourceSecret: (
    secretName: string,
  ) => Promise<GatewayModelKeySourceSecret | null>;
  log: (msg: string) => void;
}

const NOT_FOUND_PATTERNS = [/NotFound/i, /not found/i];

function isNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

export function gatewayModelKeySecretName(gatewayId: string): string {
  return `${GATEWAY_MODEL_KEY_SECRET_PREFIX}${gatewayId}`;
}

function gatewayClassUsesBrokerToken(gatewayClass: GatewayClass): boolean {
  return gatewayClass === "isolated";
}

export function gatewayModelKeySourceLabels(gatewayId: string): Record<string, string> {
  return {
    octogee_kind: "gateway_model_key",
    gateway_id: gatewayId,
    provider: "anthropic",
    capped: "true",
  };
}

export function gatewayModelKeySourceLabelErrors(
  gatewayId: string,
  labels: Record<string, string>,
): string[] {
  return Object.entries(gatewayModelKeySourceLabels(gatewayId))
    .filter(([key, value]) => labels[key] !== value)
    .map(([key, value]) => `${key}=${value}`);
}

interface ExistingK8sSecret {
  value: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

interface ApplyK8sSecretOptions {
  deps: Pick<GatewayModelKeySecretEnsurerDeps, "runKubectl">;
  namespace: string;
  secretName: string;
  gatewayId: string;
  sourceSecretName: string;
  value: string;
}

async function readExistingK8sSecret(
  deps: Pick<GatewayModelKeySecretEnsurerDeps, "runKubectl">,
  namespace: string,
  secretName: string,
): Promise<ExistingK8sSecret | null> {
  const result = await deps.runKubectl([
    "get",
    "secret",
    secretName,
    "-n",
    namespace,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    if (isNotFound(result.stderr)) return null;
    throw new Error(
      `kubectl get secret ${secretName} (ns=${namespace}) failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed: {
    data?: Record<string, string>;
    metadata?: {
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
  };
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch (err) {
    throw new Error(
      `kubectl get secret ${secretName} (ns=${namespace}) returned invalid JSON: ${(err as Error).message}`,
    );
  }
  const encoded = parsed.data?.[GATEWAY_MODEL_KEY_DATA_KEY];
  return {
    value: encoded ? Buffer.from(encoded, "base64").toString("utf8") : null,
    labels: parsed.metadata?.labels ?? {},
    annotations: parsed.metadata?.annotations ?? {},
  };
}

async function deleteK8sSecretIfExists(
  deps: Pick<GatewayModelKeySecretEnsurerDeps, "runKubectl" | "log">,
  namespace: string,
  secretName: string,
  reason: GatewayModelKeySecretResult["reason"],
): Promise<boolean> {
  const getResult = await deps.runKubectl([
    "get",
    "secret",
    secretName,
    "-n",
    namespace,
    "-o",
    "name",
  ]);
  if (getResult.code !== 0) {
    if (isNotFound(getResult.stderr)) return false;
    throw new Error(
      `kubectl get secret ${secretName} (ns=${namespace}) failed (code=${getResult.code}): ${getResult.stderr.trim() || getResult.stdout.trim()}`,
    );
  }
  const deleteResult = await deps.runKubectl([
    "delete",
    `secret/${secretName}`,
    "-n",
    namespace,
    "--ignore-not-found=true",
  ]);
  if (deleteResult.code !== 0) {
    throw new Error(
      `kubectl delete secret/${secretName} (ns=${namespace}) failed (code=${deleteResult.code}): ${deleteResult.stderr.trim() || deleteResult.stdout.trim()}`,
    );
  }
  deps.log(
    `[model-key-secret] deleted ${secretName} in ns=${namespace} (${reason ?? "policy"})`,
  );
  return true;
}

function k8sLabels(gatewayId: string): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "glm-controller",
    "octogee.ai/secret-kind": "gateway-model-key",
    "octogee.ai/gateway-id": gatewayId,
    "octogee.ai/provider": "anthropic",
  };
}

function k8sAnnotations(sourceSecretName: string): Record<string, string> {
  return {
    "octogee.ai/source-secret": sourceSecretName,
    "octogee.ai/source-contract":
      "Secret Manager labels octogee_kind=gateway_model_key,gateway_id=<gateway>,provider=anthropic,capped=true",
  };
}

function existingMatchesDesired(
  existing: ExistingK8sSecret | null,
  value: string,
  labels: Record<string, string>,
  annotations: Record<string, string>,
): boolean {
  if (!existing) return false;
  if (existing.value !== value) return false;
  for (const [key, expected] of Object.entries(labels)) {
    if (existing.labels[key] !== expected) return false;
  }
  for (const [key, expected] of Object.entries(annotations)) {
    if (existing.annotations[key] !== expected) return false;
  }
  return true;
}

async function applyK8sSecret(opts: ApplyK8sSecretOptions): Promise<void> {
  const { deps, namespace, secretName, gatewayId, sourceSecretName, value } = opts;
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace,
      labels: k8sLabels(gatewayId),
      annotations: k8sAnnotations(sourceSecretName),
    },
    type: "Opaque",
    stringData: {
      [GATEWAY_MODEL_KEY_DATA_KEY]: value,
    },
  };
  const result = await deps.runKubectl(["apply", "-f", "-"], {
    stdin: JSON.stringify(manifest),
  });
  if (result.code !== 0) {
    throw new Error(
      `kubectl apply secret/${secretName} (ns=${namespace}) failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

export function createGatewayModelKeySecretEnsurer(
  deps: GatewayModelKeySecretEnsurerDeps,
): GatewayModelKeySecretEnsurer {
  return {
    async syncGatewayModelKeySecret({
      namespace,
      gatewayId,
      gatewayClass,
    }) {
      const secretName = gatewayModelKeySecretName(gatewayId);
      const deleteAndReport = async (
        reason: GatewayModelKeySecretResult["reason"],
      ): Promise<GatewayModelKeySecretResult> => {
        const changed = await deleteK8sSecretIfExists(
          deps,
          namespace,
          secretName,
          reason,
        );
        return {
          gatewayId,
          secretName,
          changed,
          action: changed ? "deleted" : "skipped",
          reason,
        };
      };

      if (!gatewayClassUsesBrokerToken(gatewayClass)) {
        return deleteAndReport("non_builder");
      }

      const source = await deps.readSourceSecret(secretName);
      if (!source) {
        return deleteAndReport("missing_source");
      }

      const labelErrors = gatewayModelKeySourceLabelErrors(gatewayId, source.labels);
      if (labelErrors.length > 0) {
        deps.log(
          `[model-key-secret] refusing ${secretName}: Secret Manager source is missing required label(s): ${labelErrors.join(", ")}`,
        );
        return deleteAndReport("invalid_source_labels");
      }

      const value = source.value.trim();
      if (!value) {
        deps.log(
          `[model-key-secret] refusing ${secretName}: Secret Manager source payload is empty`,
        );
        return deleteAndReport("empty_source_value");
      }

      const labels = k8sLabels(gatewayId);
      const annotations = k8sAnnotations(secretName);
      const existing = await readExistingK8sSecret(deps, namespace, secretName);
      if (existingMatchesDesired(existing, value, labels, annotations)) {
        return { gatewayId, secretName, changed: false, action: "unchanged" };
      }

      await applyK8sSecret({
        deps,
        namespace,
        secretName,
        gatewayId,
        sourceSecretName: secretName,
        value,
      });
      deps.log(
        `[model-key-secret] upserted ${secretName} in ns=${namespace} from capped Secret Manager source`,
      );
      return { gatewayId, secretName, changed: true, action: "upserted" };
    },
  };
}
