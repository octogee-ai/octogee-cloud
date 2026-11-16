import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createHarness(): {
  root: string;
  script: string;
  iapScript: string;
  log: string;
} {
  const root = mkdtempSync(join(tmpdir(), "octogee-monitoring-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  const monitoring = join(root, "charts", "monitoring");
  const dashboards = join(monitoring, "dashboards");
  mkdirSync(dashboards, { recursive: true });
  writeFileSync(join(dashboards, "smoke.json"), "{}\n");
  writeFileSync(join(monitoring, "gmp-collection-filter.json"), JSON.stringify({
    collection: { filter: { matchOneOf: ["{job=\"platform\"}"] } },
  }));
  const filters = join(monitoring, "gmp-collection-filters");
  mkdirSync(filters);
  writeFileSync(join(filters, "hosted.json"), JSON.stringify(["{job=\"hosted-controller\"}", "{job=\"platform\"}"]));
  copyFileSync(
    join(repoRoot, "scripts/lib/monitoring-collection-filter.mjs"),
    join(scripts, "lib/monitoring-collection-filter.mjs"),
  );
  mkdirSync(bin);
  copyFileSync(
    join(repoRoot, "scripts/setup-monitoring.sh"),
    join(scripts, "setup-monitoring.sh"),
  );
  copyFileSync(
    join(repoRoot, "scripts/setup-monitoring-iap.sh"),
    join(scripts, "setup-monitoring-iap.sh"),
  );
  executable(
    join(scripts, "lib/deployment-target.sh"),
    `octogee_load_deployment_target() {
  TARGET_LIFECYCLE=active
  TARGET_ID=test-west
  TARGET_CLUSTER_NAME=octogee-gateway
  TARGET_REGION=us-west1
  TARGET_CLUSTER_PROJECT=octogee
  TARGET_KUBE_CONTEXT=gke_us-west1_octogee
  TARGET_NAMESPACE=octogee-west
}
octogee_deployment_target_field() {
  case "$1 $2" in
    "--environment=prod namespace") printf '%s\\n' prod-ns ;;
    "--environment=test namespace") printf '%s\\n' test-ns ;;
    *) return 1 ;;
  esac
}
`,
  );
  copyFileSync(
    join(repoRoot, "scripts/lib/control-plane-config.mjs"),
    join(scripts, "lib/control-plane-config.mjs"),
  );
  const controlPlane = join(root, "terraform/environments/control-plane");
  mkdirSync(controlPlane, { recursive: true });
  writeFileSync(
    join(controlPlane, "variables.tf"),
    `variable "project_id" {
  default = "acme-central"
}

variable "monitoring_iap_domain" {
  default = "grafana.example.test"
}
`,
  );
  executable(
    join(scripts, "setup-monitoring-secrets.sh"),
    `#!/usr/bin/env bash
printf 'secrets:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  executable(
    join(scripts, "verify-monitoring.sh"),
    `#!/usr/bin/env bash
printf 'verify:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  executable(
    join(bin, "gcloud"),
    `#!/usr/bin/env bash
if [[ "$*" == *"compute addresses describe"* ]]; then
  printf 'static-ip:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
fi
exit 0
`,
  );
  executable(
    join(bin, "kubectl"),
    `#!/usr/bin/env bash
if [[ "$*" == "config current-context" ]]; then
  printf '%s\n' gke_us-west1_octogee
elif [[ "$*" == "patch operatorconfig config "* ]]; then
  for arg; do last="$arg"; done
  printf 'filter:%s\n' "$last" >>"$OCTOGEE_MONITORING_TEST_LOG"
elif [[ "$*" == *"get computeclass"* ]]; then
  printf 'computeclass:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
  printf '%s' True
fi
`,
  );
  executable(
    join(bin, "helm"),
    `#!/usr/bin/env bash
printf 'helm:%s\n' "$*" >>"$OCTOGEE_MONITORING_TEST_LOG"
`,
  );
  return {
    root,
    script: join(scripts, "setup-monitoring.sh"),
    iapScript: join(scripts, "setup-monitoring-iap.sh"),
    log,
  };
}

function runHarness(
  args: string[] = [],
  entrypoint: "setup" | "iap" = "setup",
): { status: number | null; calls: string[]; stderr: string } {
  const harness = createHarness();
  const result = spawnSync(
    "bash",
    [
      entrypoint === "iap" ? harness.iapScript : harness.script,
      "--target=test-west",
      ...args,
    ],
    {
      env: {
        ...process.env,
        OCTOGEE_MONITORING_TEST_LOG: harness.log,
        PATH: `${join(harness.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      encoding: "utf8",
    },
  );
  let calls: string[] = [];
  try {
    calls = readFileSync(harness.log, "utf8").trim().split("\n");
  } catch {
    calls = [];
  }
  return { status: result.status, calls, stderr: result.stderr };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("monitoring setup", () => {
  it("applies product collection filters alongside the base filters", () => {
    const result = runHarness();
    expect(result.status, result.stderr).toBe(0);
    const applied = result.calls.find(call => call.startsWith("filter:"));
    expect(JSON.parse(applied!.slice("filter:".length))).toEqual({
      collection: { filter: { matchOneOf: ["{job=\"platform\"}", "{job=\"hosted-controller\"}"] } },
    });
  });

  it("runs secrets then Helm with no compute-class preflight", () => {
    const result = runHarness();

    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe("secrets:--target=test-west");
    expect(result.calls[1]).toContain("helm:upgrade --install grafana");
    expect(result.calls.every((call) => !call.startsWith("computeclass:"))).toBe(true);
    expect(result.calls.at(-1)).toBe("verify:--target=test-west");
  });

  it("opens gateway-edge scraping in the selected target's namespace", () => {
    const result = runHarness();
    const helmCall = result.calls.find((call) => call.startsWith("helm:"));

    expect(helmCall).toContain("--set monitoredNamespaces={octogee-west}");
  });

  it("selects every environment's namespace in alert rules and dashboards", () => {
    const helmCall = runHarness().calls.find((call) => call.startsWith("helm:upgrade")) ?? "";

    expect(helmCall).toContain("--set environmentNamespaces={prod-ns,test-ns}");
  });

  it("binds Grafana to the monitoring service account in the control-plane project", () => {
    const helmCall = runHarness().calls.find((call) => call.startsWith("helm:upgrade")) ?? "";

    expect(helmCall).toContain(
      "--set-string grafana.serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account=monitoring-grafana@acme-central.iam.gserviceaccount.com",
    );
    expect(helmCall).not.toContain("iap.domain");
  });

  it("passes no compute class to the monitoring Helm release", () => {
    const result = runHarness();
    const helmCall = result.calls.find((call) => call.startsWith("helm:upgrade")) ?? "";

    expect(helmCall).not.toContain("platformComputeClass");
    expect(helmCall).not.toContain("compute-class");
  });

  it("keeps uninstall available", () => {
    const result = runHarness(["--uninstall"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "helm:uninstall grafana --namespace monitoring --kube-context gke_us-west1_octogee --ignore-not-found",
    ]);
  });

  it("runs the IAP path through secrets, static IP, then Helm", () => {
    const result = runHarness([], "iap");

    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe("secrets:--target=test-west --iap");
    expect(result.calls[1]).toContain("static-ip:compute addresses describe grafana-ip");
    expect(result.calls.findIndex((call) => call.startsWith("helm:"))).toBeGreaterThan(1);
    expect(result.calls.every((call) => !call.startsWith("computeclass:"))).toBe(true);
    const helmCall = result.calls.find((call) => call.startsWith("helm:upgrade")) ?? "";
    expect(helmCall).toContain("--set iap.enabled=true --set iap.domain=grafana.example.test");
  });
});
