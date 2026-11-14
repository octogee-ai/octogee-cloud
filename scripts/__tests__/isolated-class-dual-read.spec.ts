import { describe, expect, it } from "vitest";
import { gatewayAgentRosterUserSlug } from "../lib/openclaw-config-users.js";
import { clusterIsolatedGateway } from "../lib/openclaw-state-store.js";
import { systemConfigInvariantContextFromEnv } from "../lib/system-config-invariants.js";
import { configuredUserReport } from "../lib/user-claim.js";
import { projectCheckoutScopeForRuntime } from "../lib/user-lifecycle-broker-adapter.js";
import { withUserClaim } from "./helpers/user-claim.js";

function readers(gatewayClass: string) {
  const env = withUserClaim({ GATEWAY_CLASS: gatewayClass, GATEWAY_RUNTIME_KIND: "cluster", OPENCLAW_CONTROL_IDENTITY: "per-user" }, "alice");
  const invariants = systemConfigInvariantContextFromEnv(env);
  return {
    invariantClass: invariants.gatewayClass,
    invariantClaim: invariants.workspaceSlug ?? null,
    configuredUser: configuredUserReport(env),
    checkoutScope: projectCheckoutScopeForRuntime("alice", env),
    rosterUser: gatewayAgentRosterUserSlug(env),
    clusterIsolated: clusterIsolatedGateway(env),
  };
}

describe("gateway image readers of GATEWAY_CLASS", () => {
  it("read the builder class a previous controller renders exactly as isolated", () => {
    expect(readers("builder")).toEqual(readers("isolated"));
    expect(readers("isolated")).toMatchObject({ invariantClass: "isolated", invariantClaim: "alice", rosterUser: "alice", clusterIsolated: true });
  });

  it("still treat an unknown class as not isolated", () => {
    expect(readers("operator")).toMatchObject({
      invariantClass: "shared", invariantClaim: null, configuredUser: null, rosterUser: "", clusterIsolated: false,
    });
    expect(readers("operator").checkoutScope).not.toBe("workspace-and-projects");
  });
});
