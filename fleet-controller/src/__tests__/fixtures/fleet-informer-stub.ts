import type { FleetInformer } from "../../fleet-informer.js";

export function stubInformer(overrides: Partial<FleetInformer> = {}): FleetInformer {
  return {
    gateways: () => null,
    fleetRegistry: () => null,
    fleetRegistryWithoutMalformed: () => null,
    users: () => null,
    usersWithoutMalformed: () => null,
    assignments: () => null,
    subscribe: () => () => undefined,
    stop: () => undefined,
    ...overrides,
  };
}
