import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("canonical Gitea gateway token", () => {
  it("grants write:issue for Board reads and mutations", () => {
    const setup = readFileSync(path.join(repoRoot, "scripts/setup-gitea.sh"), "utf8");
    const payload = setup.match(/-d '(\{"name":"octogee-gateway-token"[^\n]+\})'/)?.[1];

    expect(payload).toBeDefined();
    expect(JSON.parse(payload as string).scopes).toContain("write:issue");
  });

  it("rejects cached tokens that cannot access issue routes", () => {
    const setup = readFileSync(path.join(repoRoot, "scripts/setup-gitea.sh"), "utf8");

    expect(setup).toContain("/api/v1/repos/issues/search?limit=1");
    expect(setup).toContain('"$issue_status" == "200"');
  });

  it("converges rotated platform credentials into every platform consumer before success", () => {
    const setup = readFileSync(path.join(repoRoot, "scripts/setup-gitea.sh"), "utf8");
    const convergence = readFileSync(
      path.join(repoRoot, "scripts/lib/gitea-token-convergence.sh"),
      "utf8",
    );

    expect(setup).toContain("restart_gitea_token_consumers");
    expect(setup).toContain('source "$SCRIPT_DIR/lib/gitea-token-convergence.sh"');
    expect(convergence).toContain("for deployment in octogee-api glm-controller");
    expect(convergence).toContain('"deployment/$deployment"');
    expect(convergence).toContain("Gitea token consumers did not become Ready");
    expect(convergence).toContain("Gitea token consumer validation failed");
    expect(convergence).toContain(
      '`http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`',
    );
    expect(setup).not.toContain("restart_gitea_gateway_ssh_consumers");
  });

  it("keeps the recovered platform token out of isolated gateways", () => {
    const convergence = readFileSync(
      path.join(repoRoot, "scripts/lib/gitea-token-convergence.sh"),
      "utf8",
    );
    const gatewayChart = readFileSync(path.join(repoRoot, "charts/octogee-gateway/values.yaml"), "utf8");

    expect(convergence).toContain("octogee-api and glm-controller");
    expect(gatewayChart).toContain("Platform secrets (GITEA_TOKEN");
    expect(gatewayChart).toContain("intentionally NOT mounted");
  });

  it("verify-env probes the admin broker without restoring the gateway admin token", () => {
    const verify = readFileSync(path.join(repoRoot, "scripts/verify-env.sh"), "utf8");
    const probe = readFileSync(
      path.join(repoRoot, "scripts/lib/ready-assigned-gateway-probe.sh"),
      "utf8",
    );
    const convergence = readFileSync(
      path.join(repoRoot, "scripts/lib/gitea-token-convergence.sh"),
      "utf8",
    );

    expect(verify).toContain('source "$SCRIPT_DIR/lib/ready-assigned-gateway-probe.sh"');
    expect(verify).toContain(
      'probe_ready_assigned_gateway_gitea_broker "$K8S_CONTEXT" "$NAMESPACE"',
    );
    expect(probe).toContain("process.env.GITEA_ADMIN_BROKER_URL");
    expect(probe).toContain("!process.env.GIT_API_TOKEN");
    expect(probe).toContain("gitea-broker-probe.ts");
    expect(verify).toContain('source "$SCRIPT_DIR/lib/gitea-token-convergence.sh"');
    expect(verify).toContain("validate_gitea_token_consumers");
    expect(convergence).toContain("repos/issues/search?limit=1");
    expect(probe).not.toContain("gitea-gateway-push-probe.ts");
    expect(`${verify}\n${probe}`).not.toContain("fetch(u+'/health')");
    expect(`${verify}\n${probe}`).not.toContain("const t=process.env.GIT_API_TOKEN||''");
  });
});
