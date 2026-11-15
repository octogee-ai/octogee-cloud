import type { GatewayVmClient } from "./lib/compute-vm.js";

export function spreadZones(zones: readonly string[], occupied: readonly string[], avoid: ReadonlySet<string> = new Set()): string[] {
  const load = new Map(zones.map((zone) => [zone, 0]));
  for (const zone of occupied) {
    const count = load.get(zone);
    if (count !== undefined) load.set(zone, count + 1);
  }
  const rank = (zone: string) => [avoid.has(zone) ? 1 : 0, load.get(zone) ?? 0, zones.indexOf(zone)];
  return [...zones].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

export async function occupiedVmZones(vm: Pick<GatewayVmClient, "list">, environment: string): Promise<string[]> {
  const vms = await vm.list({ labels: { "octogee-environment": environment, purpose: "octogee-computer" } });
  return vms.map((instance) => instance.zone);
}
