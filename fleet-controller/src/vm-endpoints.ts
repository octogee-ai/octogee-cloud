import { gatewayVmPodName, resolveGatewayRuntime, type GatewayVmState } from "@octogee/shared/types/glm";
import type { SurgePod, SurgePodSnapshot } from "./surge-user-handoff.js";

export type VmEndpoint = Omit<SurgePod, "ready">;

export type VmReadinessProbe = (endpoint: VmEndpoint, gatewayId: string) => Promise<boolean>;

export function endpointFromVm(gatewayId: string, vm: Partial<GatewayVmState> | null | undefined): VmEndpoint | null {
  if (
    !vm ||
    vm.status !== "RUNNING" ||
    typeof vm.instanceId !== "string" || vm.instanceId.length === 0 ||
    typeof vm.instanceName !== "string" ||
    typeof vm.internalIp !== "string" || vm.internalIp.length === 0
  ) {
    return null;
  }
  return { uid: gatewayVmPodName(gatewayId, vm.instanceId), name: vm.instanceName, podIP: vm.internalIp, terminating: false, crashLooping: false };
}

export async function listVmEndpoints(
  vm: Partial<GatewayVmState> | null | undefined,
  gatewayId: string,
  readVmReady: VmReadinessProbe,
): Promise<SurgePodSnapshot> {
  const observedPodUids = typeof vm?.instanceId === "string" && vm.instanceId.length > 0 ? [gatewayVmPodName(gatewayId, vm.instanceId)] : [];
  const endpoint = endpointFromVm(gatewayId, vm);
  if (!endpoint) return { pods: [], observedPodUids };
  const ready = await readVmReady(endpoint, gatewayId);
  return { pods: [{ ...endpoint, ready }], observedPodUids };
}

export function createSurgeEndpointLister(input: {
  readRuntimeDoc: (gatewayId: string) => Promise<unknown>;
  listPods: (gatewayId: string) => Promise<SurgePodSnapshot>;
  readVmReady: VmReadinessProbe;
}): (gatewayId: string) => Promise<SurgePodSnapshot> {
  return async (gatewayId) => {
    const doc = (await input.readRuntimeDoc(gatewayId)) as { runtime?: unknown; vm?: Partial<GatewayVmState> | null } | undefined;
    if (resolveGatewayRuntime(doc?.runtime) !== "gce-vm") return input.listPods(gatewayId);
    return listVmEndpoints(doc?.vm, gatewayId, input.readVmReady);
  };
}

export function createVmReadinessProbe(opts: {
  port: string | number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log: (message: string) => void;
}): VmReadinessProbe {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lastOutcome = new Map<string, string>();
  const report = (endpoint: VmEndpoint, outcome: string, message: string): void => {
    if (lastOutcome.get(endpoint.uid) === outcome) return;
    lastOutcome.set(endpoint.uid, outcome);
    opts.log(message);
  };
  return async (endpoint, gatewayId) => {
    const host = endpoint.podIP.includes(":") ? `[${endpoint.podIP}]` : endpoint.podIP;
    try {
      const response = await fetchImpl(`http://${host}:${opts.port}/surge-ready`, {
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const verdict = response.ok ? "passing" : `failing (HTTP ${response.status})`;
      report(endpoint, `http:${response.ok}`, `[surge-handoff] ${gatewayId}: readiness probe of ${endpoint.name} is ${verdict}`);
      return response.ok;
    } catch (error) {
      report(endpoint, "unreachable", `[surge-handoff] ${gatewayId}: readiness probe of ${endpoint.name} failed — ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
}
