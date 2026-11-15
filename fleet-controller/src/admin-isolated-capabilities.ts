import type { GatewayPodDiagnostics } from "@octogee/core/admin-fleet-router";
import type { AdminIsolatedCapabilities } from "@octogee/core/admin-placement-isolated-router";
import { createAuthSecretEnsurer, defaultRandomTokenHex, type KubectlSubprocess } from "./auth-secret-ensurer.js";
import { spawnKubectl } from "./fleet-ingress.js";

export interface AdminIsolatedCapabilityInputs {
  namespace: string;
  log(message: string): void;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  runKubectl?: KubectlSubprocess;
}

export function adminIsolatedCapabilities(inputs: AdminIsolatedCapabilityInputs): AdminIsolatedCapabilities | undefined {
  const { readGatewayPodDiagnostics } = inputs;
  if (!readGatewayPodDiagnostics) return undefined;
  const authSecrets = createAuthSecretEnsurer({
    runKubectl: inputs.runKubectl ?? ((args, options) => spawnKubectl(args, options)),
    randomTokenHex: defaultRandomTokenHex,
    log: inputs.log,
  });
  return {
    namespace: inputs.namespace,
    ensureAuthSecret: (input) => authSecrets.ensureAuthSecret(input),
    readGatewayPodDiagnostics,
  };
}
