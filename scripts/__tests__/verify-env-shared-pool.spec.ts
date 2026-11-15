import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("verify-env shared pool checks", () => {
  const source = readFileSync(new URL("../verify-env.sh", import.meta.url), "utf8");

  it("authenticates kubectl before listing the shared pool deployments", () => {
    expect(source.indexOf("gcloud container clusters get-credentials")).toBeLessThan(
      source.indexOf("GW_DEPLOYMENTS=$(kubectl get deploy"),
    );
  });

  it("derives the pool from the fleet controller's chart labels and the floor from the caller", () => {
    expect(source).toContain('-l "app.kubernetes.io/name=octogee-gateway"');
    expect(source).toContain("octogee_list_shared_gateway_deployments <<<");
    expect(source).toContain('SHARED_POOL_MIN_REPLICAS="${SHARED_POOL_MIN_REPLICAS:-}"');
    expect(source).not.toContain('env[?(@.name=="SHARED_POOL_MIN_REPLICAS")]');
    expect(source).toContain("below minReplicas=");
    expect(source).not.toContain("DEFAULT_GATEWAY_ID");
    expect(source).not.toContain("SHARED_GATEWAY_IDS");
    expect(source).not.toContain("octogee_resolve_default_gateway_deployment");
  });
});
