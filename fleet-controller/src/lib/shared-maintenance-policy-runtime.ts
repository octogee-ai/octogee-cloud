import { isDeepStrictEqual } from "node:util";
import type { SurgeKubectl } from "../surge-user-handoff-runtime.js";
import {
  assertSharedMigrationIngressHeld,
  changeSharedMigrationIngress,
  planSharedMigrationIngress,
  type ObservedNetworkPolicy,
  type SharedIngressScope,
} from "./shared-maintenance-ingress.js";

export type SharedMigrationPolicy = ReturnType<typeof planSharedMigrationIngress>;

export function createSharedMaintenancePolicyRuntime(run: SurgeKubectl, namespace: string) {
  async function policies() {
    const result = await run(["-n", namespace, "get", "networkpolicies", "-o", "json"]);
    if (result.code !== 0) throw new Error("Cannot read Shared migration ingress");
    return (JSON.parse(result.stdout) as { items: ObservedNetworkPolicy[] }).items;
  }

  function assertOriginal(observed: ObservedNetworkPolicy[], scope: SharedIngressScope, saved: SharedMigrationPolicy) {
    if (!isDeepStrictEqual(planSharedMigrationIngress(observed, scope), saved)) {
      throw new Error("Shared migration ingress differs from the retained original");
    }
  }

  async function verify(scope: SharedIngressScope, saved: SharedMigrationPolicy, state: "original" | "held") {
    if (scope.namespace !== namespace) throw new Error("Shared maintenance policy namespace changed");
    const observed = await policies();
    if (state === "held") assertSharedMigrationIngressHeld(observed, scope, saved);
    else assertOriginal(observed, scope, saved);
  }

  async function change(
    scope: SharedIngressScope, saved: SharedMigrationPolicy, action: "hold" | "restore",
    assertCurrent: () => Promise<void>,
  ) {
    if (scope.namespace !== namespace) throw new Error("Shared maintenance policy namespace changed");
    await assertCurrent();
    const observed = await policies();
    const matches = observed.filter(({ metadata }) => metadata.uid === saved.uid);
    if (matches.length !== 1) throw new Error("The original Shared migration policy is missing");
    const member = matches[0]!;
    const patch = changeSharedMigrationIngress(member, saved, action);
    if (isDeepStrictEqual(member.spec, saved.held)) assertSharedMigrationIngressHeld(observed, scope, saved);
    else assertOriginal(observed, scope, saved);
    if (patch.length) {
      await assertCurrent();
      const result = await run(["-n", namespace, "patch", "networkpolicy", saved.name, "--type=json", "-p", JSON.stringify(patch)]);
      if (result.code !== 0) throw new Error("Shared migration ingress changed before its guarded update");
    }
    await verify(scope, saved, action === "hold" ? "held" : "original");
    await assertCurrent();
  }

  return { change, verify };
}
