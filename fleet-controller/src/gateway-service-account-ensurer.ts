import type { KubectlSubprocess } from "./fleet-ingress.js";

// Re-export so callers (and tests) can import the type from the ensurer
// without also reaching into fleet-ingress for an unrelated dep.
export type { KubectlSubprocess } from "./fleet-ingress.js";

export interface ServiceAccountEnsurer {
  ensureServiceAccount(opts: {
    namespace: string;
    serviceAccountName: string;
    identity: GatewayServiceAccountIdentity;
    annotations?: Record<string, string>;
  }): Promise<void>;
}

export interface ServiceAccountEnsurerDeps {
  runKubectl: KubectlSubprocess;
  log: (msg: string) => void;
}

export interface GatewayServiceAccountIdentity {
  gatewayId: string;
  deploymentTargetId: string;
  releaseName: string;
  lifecycleIdentity: string;
}

function ownershipMetadata(identity: GatewayServiceAccountIdentity): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "glm-controller",
    "app.kubernetes.io/part-of": "octogee",
    "octogee.ai/controller": "cowboy",
    "octogee.ai/deployment-target": identity.deploymentTargetId,
    "octogee.ai/gateway-id": identity.gatewayId,
    "octogee.ai/lifecycle-identity": identity.lifecycleIdentity,
    "octogee.ai/release": identity.releaseName,
  };
}

/**
 * Render the gateway-scoped ServiceAccount manifest. The KSA
 * (`octogee-gw-<gatewayId>`) is gateway-scoped, NOT revision-scoped: it is
 * created once by the fleet controller and referenced by every revision Helm release, so two
 * simultaneous revisions never race on ownership metadata. Isolated gateways
 * carry the Workload Identity annotation binding the KSA to the gateway GSA.
 */
export function serviceAccountManifest(opts: {
  namespace: string;
  serviceAccountName: string;
  identity: GatewayServiceAccountIdentity;
  annotations?: Record<string, string>;
}): string {
  const ownership = ownershipMetadata(opts.identity);
  const annotations: Record<string, string> = {
    ...opts.annotations,
    ...ownership,
    "helm.sh/resource-policy": "keep",
  };
  return `${JSON.stringify({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: opts.serviceAccountName,
      namespace: opts.namespace,
      labels: ownership,
      annotations,
    },
  })}\n`;
}

/**
 * Ensures the gateway-scoped K8s ServiceAccount exists before `helm upgrade`
 * runs. KSA creation moved OUT of the chart (GATEWAY-RELEASES-SPEC): the chart
 * rendered it per Helm release, so two simultaneous revision releases would race
 * or fail on ownership metadata. The fleet controller owns it once, gateway-scoped.
 *
 * `kubectl apply -f -` is idempotent create-or-update: it converges the KSA
 * (including the Workload Identity annotation) without churning ownership on an
 * existing object, and never deletes one a per-revision release does not own.
 */
export function createGatewayServiceAccountEnsurer(
  deps: ServiceAccountEnsurerDeps,
): ServiceAccountEnsurer {
  return {
    async ensureServiceAccount({ namespace, serviceAccountName, identity, annotations }) {
      const manifest = serviceAccountManifest({ namespace, serviceAccountName, identity, annotations });
      const result = await deps.runKubectl(["apply", "-n", namespace, "-f", "-"], {
        stdin: manifest,
      });
      if (result.code !== 0) {
        throw new Error(
          `kubectl apply serviceaccount ${serviceAccountName} (ns=${namespace}) failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      deps.log(
        `[gateway-service-account-ensurer] applied ${serviceAccountName} in ns=${namespace}` +
          (annotations && Object.keys(annotations).length > 0 ? " (with Workload Identity annotation)" : ""),
      );
    },
  };
}
