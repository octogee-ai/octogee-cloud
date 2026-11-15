import type { GatewayPodDiagnostics } from "@octogee/core/admin-fleet-router";
import type { AdminIsolatedCapabilities } from "@octogee/core/admin-placement-isolated-router";
import {
  HomeComputeUnavailableError,
  HomeCopyFailure,
  type HomeCapabilities,
  type HomeCapabilitiesFactory,
} from "@octogee/core/isolated-gateway-lifecycle";
import { createAuthSecretEnsurer, defaultRandomTokenHex, type KubectlSubprocess } from "./auth-secret-ensurer.js";
import { spawnKubectl } from "./fleet-ingress.js";
import type { createHomeCopyClient } from "./lib/compute-home-copy.js";
import type { createUserHomeProvider } from "./lib/user-home-provider.js";

export type HomeServiceJournal = <T>(what: string, uid: string, action: () => Promise<T>, resource: string) => Promise<T>;

export interface AdminUserHome {
  environment: string;
  subnetwork: string;
  nativeZones: readonly string[];
  services(journal: HomeServiceJournal): {
    provider: ReturnType<typeof createUserHomeProvider>;
    copy: ReturnType<typeof createHomeCopyClient>;
  };
}

export interface AdminIsolatedCapabilityInputs {
  namespace: string;
  log(message: string): void;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  runKubectl?: KubectlSubprocess;
  userHome?: AdminUserHome;
}

const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);

export function computeUnavailableCode(error: unknown): string | null {
  const status = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof status === "number") return status === 429 || status >= 500 ? `http-${status}` : null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return code.toLowerCase();
  const reported = error instanceof Error ? /\bHTTP (429|5\d\d)\b/u.exec(error.message) : null;
  return reported ? `http-${reported[1]}` : null;
}

function surfacingUnavailable<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof HomeCopyFailure) throw error;
      const code = computeUnavailableCode(error);
      if (code === null) throw error;
      throw new HomeComputeUnavailableError(code, error instanceof Error ? error.message : String(error));
    }
  };
}

export function adminHomeCapabilities(userHome: AdminUserHome): HomeCapabilitiesFactory {
  return (record) => {
    const { provider, copy } = userHome.services((what, _uid, action, resource) => {
      record({ name: what, resource });
      return action();
    });
    const capabilities: HomeCapabilities = {
      environment: userHome.environment,
      subnetwork: userHome.subnetwork,
      nativeZones: userHome.nativeZones,
      nativeZone: surfacingUnavailable(provider.nativeZone),
      inventory: surfacingUnavailable(provider.inventory),
      verifyStopped: surfacingUnavailable(provider.verifyStopped),
      adopt: surfacingUnavailable(provider.adopt),
      removeStoppedHome: surfacingUnavailable(provider.removeStoppedHome),
      copy: {
        advance: surfacingUnavailable(copy.advance),
        release: surfacingUnavailable(copy.release),
        abort: surfacingUnavailable(copy.abort),
      },
    };
    return capabilities;
  };
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
    ...(inputs.userHome ? { home: adminHomeCapabilities(inputs.userHome) } : {}),
  };
}
