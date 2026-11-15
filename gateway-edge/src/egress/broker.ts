import { isGatewayVmEgressState, type GatewayEgressMode, type GatewayVmEgressState } from "@octogee/shared/types/glm";
import type { FleetBrokerVmEgress } from "@octogee/shared/types/fleet-broker";
import { trustedBrokerBaseUrl } from "@octogee/core/internal-brokers/automation-authorization-broker";
import { internalFetch } from "@octogee/core/internal-fetch";
import type { EgressStore } from "./service.js";

export const COMPUTER_EGRESS_BROKER_PATH = "/internal/fleet/computer-egress";

export interface BrokerEgressStoreOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  tokenPath?: string;
}

async function post(body: Record<string, unknown>, options: BrokerEgressStoreOptions): Promise<GatewayVmEgressState | null> {
  const env = options.env ?? process.env;
  const raw = env.OPENCLAW_RUNTIME_BROKER_URL;
  if (!raw) throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
  const response = await internalFetch(`${trustedBrokerBaseUrl(raw, env)}${COMPUTER_EGRESS_BROKER_PATH}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error",
  }, { tokenPath: options.tokenPath, fetchImpl: options.fetchImpl, requireProjectedToken: true, timeoutMs: 10_000 });
  if (!response.ok) throw new Error(`VM egress broker refused (${response.status})`);
  const payload = await response.json() as Partial<FleetBrokerVmEgress>;
  if (payload.egress === null) return null;
  if (!isGatewayVmEgressState(payload.egress)) throw new Error("VM egress broker returned an invalid record");
  return payload.egress;
}

export function createBrokerEgressStore(options: BrokerEgressStoreOptions = {}): EgressStore {
  return {
    read: () => post({}, options),
    async write(mode: GatewayEgressMode) {
      const stored = await post({ mode }, options);
      if (!stored || stored.mode !== mode) throw new Error("VM egress broker did not record the requested mode");
      return stored;
    },
  };
}
