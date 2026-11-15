import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function rules(name: string): string {
  return `apiVersion: monitoring.googleapis.com/v1\nkind: ClusterRules\nmetadata:\n  name: ${name}\nspec:\n  groups: []\n`;
}

function verifyMonitoring(unowned = "") {
  const root = mkdtempSync(join(tmpdir(), "octogee-verify-monitoring-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const monitoring = join(root, "charts", "monitoring");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(join(monitoring, "dashboards"), { recursive: true });
  mkdirSync(join(monitoring, "files"));
  mkdirSync(join(monitoring, "extra"));
  mkdirSync(bin);
  copyFileSync(join(repoRoot, "scripts/verify-monitoring.sh"), join(scripts, "verify-monitoring.sh"));
  writeFileSync(join(monitoring, "dashboards", "smoke.json"), "{}\n");
  writeFileSync(join(monitoring, "files", "gmp-rules.yaml"), rules("base-alerts"));
  writeFileSync(join(monitoring, "extra", "gmp-rules.yaml"), rules("extra-alerts"));
  writeFileSync(join(monitoring, "gmp-collection-filter.json"), '{"collection":{"filter":{"matchOneOf":["up"]}}}\n');
  writeFileSync(join(scripts, "lib/deployment-target.sh"), `octogee_load_deployment_target() {
  TARGET_LIFECYCLE=active TARGET_ID=test-west TARGET_CLUSTER_NAME=gw TARGET_REGION=r
  TARGET_CLUSTER_PROJECT=p TARGET_KUBE_CONTEXT=ctx
}
octogee_deployment_target_field() { printf 'octogee-ns'; }
`);
  writeFileSync(join(scripts, "lib/iap-endpoint-health.sh"), "");
  writeFileSync(join(scripts, "lib/grafana-health.sh"), "octogee_verify_grafana_health() { :; }\n");
  for (const command of ["gcloud", "helm", "curl"]) executable(join(bin, command), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(bin, "kubectl"), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.KUBECTL_LOG, args.join(" ") + "\\n");
if (args[0] === "config") { if (args[1] === "current-context") process.stdout.write("ctx"); process.exit(0); }
if (args[0] !== "get") process.exit(0);
if (args[1] === "configmap" && args[2].startsWith("--")) { process.stdout.write("grafana-dash-smoke\\n"); process.exit(0); }
if (args[1] === "operatorconfig") { process.stdout.write(readFileSync(process.env.FILTER, "utf8")); process.exit(0); }
if (process.env.UNOWNED === args[2]) process.exit(0);
const query = args.find((arg) => arg.startsWith("jsonpath="));
process.stdout.write(query.includes("release-namespace") ? "monitoring" : query.includes("release-name") ? "grafana" : "Helm");
`);
  const log = join(root, "kubectl.log");
  writeFileSync(log, "");
  const result = spawnSync("bash", [join(scripts, "verify-monitoring.sh"), "--env=test"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      KUBECTL_LOG: log,
      FILTER: join(monitoring, "gmp-collection-filter.json"),
      UNOWNED: unowned,
    },
  });
  return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(log, "utf8") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verify-monitoring", () => {
  it("checks Helm ownership of every ClusterRules object the chart's rule files declare", () => {
    const { status, output, calls } = verifyMonitoring();

    expect(status, output).toBe(0);
    expect(calls).toContain("get clusterrules base-alerts");
    expect(calls).toContain("get clusterrules extra-alerts");
  });

  it("fails when a ClusterRules object from an added rule file is not owned by the release", () => {
    const { status, output } = verifyMonitoring("extra-alerts");

    expect(status).toBe(1);
    expect(output).toContain("Unowned first-party monitoring resource: clusterrules/extra-alerts");
  });
});
