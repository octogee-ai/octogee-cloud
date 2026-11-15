import { randomUUID } from "node:crypto";

import { signFleetRequest } from "@octogee/core/fleet-signature";
import {
  FLEET_STATE_PATH,
  SIGNATURE_HEADER,
  type FleetStateRequestBody,
} from "@octogee/shared/types/fleet-controller";

import { parseFleetStateResponse, type GatewayFleetState } from "./gateway-heartbeat-poller.js";

export interface FleetStateFetcherDeps {
  privateKey: string;
  resolveBaseUrl: (gatewayId: string) => string;
  timeoutMs: number;
  log: (message: string) => void;
  fetchImpl?: typeof fetch;
  newRequestId?: () => string;
}

// A pod that answers but refuses is a different failure from a pod that is gone,
// and only the poller can tell them apart: an unreachable gateway is routine (rolls,
// preemption), while a rejected read means the fleet keypair or the pod's build is
// wrong and every heartbeat this gateway owes will silently stall until it is fixed.
export function describeFleetStateRejection(status: number): string {
  if (status === 401 || status === 403) {
    return "the pod rejected the fleet controller signature — the pod's " +
      "FLEET_CONTROLLER_PUBLIC_KEY does not match the fleet controller's signing key";
  }
  if (status === 404) {
    return "the pod has no /fleet-state route — it predates the signed roster read " +
      "and must be rolled";
  }
  if (status === 400) {
    return "the pod refused the addressed gatewayId — the fleet controller and the pod disagree " +
      "about which gateway answers here";
  }
  return "the pod refused the fleet state read";
}

// Reported on change only: these polls run per gateway on a timer, so a persistent
// fault must stay one log line rather than a per-tick flood.
function createOutcomeReporter(
  log: (message: string) => void,
): (gatewayId: string, outcome: string, message: string) => void {
  const lastOutcome = new Map<string, string>();
  return (gatewayId, outcome, message) => {
    if (lastOutcome.get(gatewayId) === outcome) return;
    lastOutcome.set(gatewayId, outcome);
    log(message);
  };
}

export interface FleetStateRequest {
  baseUrl: string;
  gatewayId: string;
  privateKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  newRequestId: () => string;
  privateProjectCoachSlug?: string;
}

// The fleet controller is the only holder of the fleet controller private key, so this signed
// read is what separates the trusted fleet authority from any pod that the
// gateway ingress policy lets reach the controller port. Callers address either
// the gateway Service or one pod, and each keeps its own failure reporting.
export async function requestFleetState(input: FleetStateRequest): Promise<Response> {
  const body: FleetStateRequestBody = {
    requestId: input.newRequestId(),
    gatewayId: input.gatewayId,
    ...(input.privateProjectCoachSlug ? { privateProjectCoachSlug: input.privateProjectCoachSlug } : {}),
  };
  const rawBody = JSON.stringify(body);
  return input.fetchImpl(`${input.baseUrl}${FLEET_STATE_PATH}/${input.gatewayId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signFleetRequest(input.privateKey, body.requestId, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(input.timeoutMs),
  });
}

export async function readPrivateProjectAgentWorkspace(input: FleetStateRequest & { privateProjectCoachSlug: string }): Promise<boolean | undefined> {
  const response = await requestFleetState(input);
  if (!response.ok) throw new Error(`Fleet state refused the workspace check: HTTP ${response.status}`);
  const state = await response.json() as { gatewayId?: unknown; privateProjectCoachWorkspace?: unknown } | null;
  if (state?.gatewayId !== input.gatewayId) throw new Error("Fleet state answered for a different gateway");
  const workspace = state.privateProjectCoachWorkspace;
  if (workspace !== undefined && typeof workspace !== "boolean") throw new Error("Fleet state returned an invalid workspace capability");
  return workspace;
}

export function createFleetStateFetcher(
  deps: FleetStateFetcherDeps,
): (gatewayId: string) => Promise<GatewayFleetState | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newRequestId = deps.newRequestId ?? randomUUID;
  const report = createOutcomeReporter(deps.log);
  return async (gatewayId) => {
    try {
      const res = await requestFleetState({
        baseUrl: deps.resolveBaseUrl(gatewayId),
        gatewayId,
        privateKey: deps.privateKey,
        timeoutMs: deps.timeoutMs,
        fetchImpl,
        newRequestId,
      });
      if (!res.ok) {
        report(
          gatewayId,
          `rejected:${res.status}`,
          `[gateway-poll] ⚠ ${gatewayId}: fleet state read returned HTTP ${res.status} — ` +
            `${describeFleetStateRejection(res.status)}; heartbeats stall until this is fixed`,
        );
        return null;
      }
      const state = parseFleetStateResponse(await res.json());
      if (!state) {
        report(
          gatewayId,
          "malformed",
          `[gateway-poll] ⚠ ${gatewayId}: fleet state body is malformed — treating as unreachable`,
        );
        return null;
      }
      report(gatewayId, "ok", `[gateway-poll] ${gatewayId}: fleet state read healthy`);
      return state;
    } catch (error) {
      report(
        gatewayId,
        "unreachable",
        `[gateway-poll] ${gatewayId}: fleet state read failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
}
