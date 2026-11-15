import { resolveGatewayRuntime, type GatewayVmState } from "@octogee/shared/types/glm";

export interface GatewayVmAddress {
  instanceName: string;
  internalIp: string;
  instanceId?: string;
}

export function gatewayVmAddress(runtimeDoc: unknown): GatewayVmAddress | null {
  const doc = runtimeDoc as { runtime?: unknown; vm?: Partial<GatewayVmState> | null } | null | undefined;
  if (!doc || resolveGatewayRuntime(doc.runtime) !== "gce-vm") return null;
  const vm = doc.vm;
  if (!vm || typeof vm.instanceName !== "string" || typeof vm.internalIp !== "string" || vm.internalIp.length === 0) {
    return null;
  }
  return { instanceName: vm.instanceName, internalIp: vm.internalIp, ...(typeof vm.instanceId === "string" ? { instanceId: vm.instanceId } : {}) };
}

export function gatewayFleetBaseUrl(input: {
  runtimeDoc: unknown;
  gatewayId: string;
  namespace: string;
  port: string | number;
}): string {
  const vm = gatewayVmAddress(input.runtimeDoc);
  if (vm) return `http://${vm.internalIp}:${input.port}`;
  return `http://octogee-gateway-${input.gatewayId}.${input.namespace}.svc.cluster.local:${input.port}`;
}
