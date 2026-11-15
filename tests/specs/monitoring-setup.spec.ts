import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const root = resolve(__dirname, "../..");
const setupMonitoring = readFileSync(
  resolve(root, "scripts/setup-monitoring.sh"),
  "utf8",
);
const verifyMonitoring = readFileSync(
  resolve(root, "scripts/verify-monitoring.sh"),
  "utf8",
);
const setupMonitoringSecrets = readFileSync(
  resolve(root, "scripts/setup-monitoring-secrets.sh"),
  "utf8",
);
const setupMonitoringIap = readFileSync(
  resolve(root, "scripts/setup-monitoring-iap.sh"),
  "utf8",
);

function chart(path: string): string {
  return readFileSync(resolve(root, "charts/monitoring", path), "utf8");
}

function renderedDeployment(name: string): Record<string, unknown> {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "grafana",
      resolve(root, "charts/monitoring"),
      "--namespace",
      "monitoring",
    ],
    { encoding: "utf8" },
  );
  const deployment = parseAllDocuments(rendered)
    .map((document) => document.toJSON() as Record<string, unknown> | null)
    .find((document) =>
      document?.kind === "Deployment" &&
      (document.metadata as Record<string, unknown> | undefined)?.name === name,
    );
  if (!deployment) throw new Error(`Deployment ${name} did not render`);
  return deployment;
}

describe("monitoring setup", () => {
  it("adopts all first-party monitoring objects through one pinned Helm release", () => {
    expect(chart("Chart.yaml")).toContain("name: octogee-monitoring");
    expect(chart("Chart.yaml")).toContain("name: grafana");
    expect(chart("Chart.yaml")).toContain('version: "13.0.1"');
    expect(chart("Chart.yaml")).toContain('repository: "https://grafana-community.github.io/helm-charts"');
    expect(chart("Chart.lock")).toContain("grafana");
    expect(readFileSync(resolve(root, "charts/monitoring/charts/grafana-13.0.1.tgz")).length).toBeGreaterThan(0);

    expect(setupMonitoring).toContain('helm upgrade --install grafana "$REPO_DIR/charts/monitoring"');
    expect(setupMonitoring).toContain("--take-ownership");
    expect(setupMonitoring).not.toContain("kubectl apply -f");
    expect(setupMonitoring).not.toContain("kubectl create configmap");
    expect(setupMonitoringIap).toContain('setup-monitoring.sh" "${setup_args[@]}"');
    expect(setupMonitoringIap).not.toContain("kubectl apply -f");
    expect(setupMonitoringIap).not.toContain("gcloud compute addresses create");
  });

  it("recreates Grafana when the as-code dashboard set changes so deletions converge", () => {
    expect(setupMonitoring).toContain("DASHBOARD_CHECKSUM=");
    expect(setupMonitoring).toContain("charts/monitoring/dashboards");
    expect(setupMonitoring).toContain(
      'grafana.podAnnotations.octogee\\\\.ai/dashboard-checksum=$DASHBOARD_CHECKSUM',
    );
    expect(chart("values.yaml")).toContain("disableDelete: false");
  });

  it("hands monitoring Helm no compute class and keeps no ComputeClass preflight", () => {
    for (const script of [setupMonitoring, setupMonitoringIap]) {
      expect(script).not.toContain("platformComputeClass");
      expect(script).not.toContain("compute-class");
      expect(script).not.toContain("octogee_preflight_monitoring_platform_compute_class");
      expect(script).not.toContain("monitoring-platform-preflight.sh");
    }
    expect(existsSync(resolve(root, "scripts/lib/monitoring-platform-preflight.sh"))).toBe(false);
    const iapSecretMaterialization = setupMonitoringIap.indexOf(
      '"$SCRIPT_DIR/setup-monitoring-secrets.sh"',
    );
    const staticIpCheck = setupMonitoringIap.indexOf("gcloud compute addresses describe");
    expect(iapSecretMaterialization).toBeGreaterThan(-1);
    expect(staticIpCheck).toBeGreaterThan(iapSecretMaterialization);
  });

  it("uses the tested secret materializer instead of a workstation environment file", () => {
    expect(setupMonitoring).toContain("setup-monitoring-secrets.sh");
    expect(setupMonitoring).not.toContain("ENV_FILE=");
    expect(setupMonitoringSecrets).toContain("GRAFANA_ADMIN_PASSWORD-");
    expect(setupMonitoringSecrets).toContain("grafana-admin");
    expect(setupMonitoringSecrets).toContain('source_secret="grafana"');
    expect(setupMonitoringSecrets).toContain("--adopt-existing-secret");
    expect(setupMonitoringSecrets).toContain("--bootstrap-secret");
    expect(setupMonitoringSecrets).not.toContain(".env");
  });

  it("materializes the exact Grafana admin secret contract without exposing credentials", () => {
    const values = chart("values.yaml");
    const grafana = renderedDeployment("grafana");
    const containers = ((grafana.spec as { template: { spec: { containers: Array<{
      name: string;
      env?: Array<{ name: string; valueFrom?: { secretKeyRef?: unknown } }>;
    }> } } }).template.spec.containers);
    const server = containers.find((container) => container.name === "grafana");
    const secretRef = (name: string) => server?.env?.find((entry) => entry.name === name)?.valueFrom?.secretKeyRef;

    expect(values).toContain("userKey: admin-user");
    expect(values).toContain("passwordKey: admin-password");
    expect(secretRef("GF_SECURITY_ADMIN_USER")).toEqual({
      key: "admin-user",
      name: "grafana-admin",
    });
    expect(secretRef("GF_SECURITY_ADMIN_PASSWORD")).toEqual({
      key: "admin-password",
      name: "grafana-admin",
    });
    expect(setupMonitoringSecrets).toContain('GRAFANA_ADMIN_USER="admin"');
    expect(setupMonitoringSecrets).toContain('--from-literal=admin-user="$GRAFANA_ADMIN_USER"');
    expect(setupMonitoringSecrets).toContain(".data.admin-user");
    expect(setupMonitoringSecrets).not.toContain("set -x");
  });

  it("opens the Octogee overview as the managed Grafana home screen", () => {
    const rendered = execFileSync(
      "helm",
      [
        "template",
        "grafana",
        resolve(root, "charts/monitoring"),
        "--namespace",
        "monitoring",
      ],
      { encoding: "utf8" },
    );
    const resources = parseAllDocuments(rendered)
      .map((document) => document.toJSON() as Record<string, unknown> | null)
      .filter((document): document is Record<string, unknown> => document !== null);
    const grafana = resources.find((resource) =>
      resource.kind === "Deployment" &&
      (resource.metadata as { name?: string } | undefined)?.name === "grafana",
    );
    const config = resources.find((resource) =>
      resource.kind === "ConfigMap" &&
      (resource.metadata as { name?: string } | undefined)?.name === "grafana",
    );
    if (!grafana || !config) throw new Error("Grafana resources did not render");

    const pod = (grafana.spec as {
      template: {
        spec: {
          containers: Array<{
            name: string;
            volumeMounts?: Array<Record<string, unknown>>;
          }>;
          volumes?: Array<Record<string, unknown>>;
        };
      };
    }).template.spec;
    const server = pod.containers.find((container) => container.name === "grafana");

    expect(server?.volumeMounts).toContainEqual({
      name: "home-dashboard",
      mountPath: "/etc/grafana/home-dashboard.json",
      subPath: "octogee-overview.json",
      readOnly: true,
    });
    expect(pod.volumes).toContainEqual({
      name: "home-dashboard",
      configMap: { name: "grafana-dash-octogee-overview" },
    });
    expect((config.data as { "grafana.ini": string })["grafana.ini"]).toContain(
      "[dashboards]\ndefault_home_dashboard_path = /etc/grafana/home-dashboard.json",
    );
  });

  it("grants the dashboard sidecar only namespace-scoped ConfigMap access", () => {
    const values = chart("values.yaml");
    const dashboardReader = chart("templates/grafana-dashboard-reader.yaml");

    expect(values).toContain(
      "useExistingRole: octogee-monitoring-grafana-dashboard-reader",
    );
    expect(values).toContain("namespaced: true");
    expect(values).toContain("resource: configmap");
    expect(dashboardReader).toContain("kind: Role");
    expect(dashboardReader).not.toContain("kind: ClusterRole");
    expect(dashboardReader).toContain("namespace: {{ .Release.Namespace }}");
    expect(dashboardReader).toContain("resources: [\"configmaps\"]");
    expect(dashboardReader).not.toContain("secrets");
    expect(verifyMonitoring).toContain("role octogee-monitoring-grafana-dashboard-reader");
    expect(verifyMonitoring).toContain("rolebinding grafana");
  });

  it("opens gateway-edge metrics to GMP in the selected target's namespace", () => {
    const rendered = execFileSync(
      "helm",
      [
        "template",
        "grafana",
        resolve(root, "charts/monitoring"),
        "--namespace",
        "monitoring",
        "--set",
        "monitoredNamespaces={octogee-test}",
      ],
      { encoding: "utf8" },
    );
    const policies = parseAllDocuments(rendered)
      .map((document) => document.toJSON() as Record<string, unknown> | null)
      .filter((document) =>
        document?.kind === "NetworkPolicy" &&
        (document.metadata as { name?: string } | undefined)?.name ===
          "allow-gateway-edge-monitoring-scrape",
      );

    expect(policies.map((policy) =>
      (policy?.metadata as { namespace: string }).namespace,
    ).sort()).toEqual(["octogee-test"]);
    for (const policy of policies) {
      const spec = policy?.spec as {
        podSelector: { matchLabels: Record<string, string> };
        ingress: Array<{
          from: Array<{ namespaceSelector: { matchLabels: Record<string, string> } }>;
          ports: Array<{ port: number; protocol: string }>;
        }>;
      };
      expect(spec.podSelector.matchLabels).toEqual({ app: "octogee-gateway" });
      expect(spec.ingress[0].from[0].namespaceSelector.matchLabels).toEqual({
        "kubernetes.io/metadata.name": "gke-gmp-system",
      });
      expect(spec.ingress[0].ports).toEqual([{ port: 3001, protocol: "TCP" }]);
    }
    expect(verifyMonitoring).toContain("allow-gateway-edge-monitoring-scrape");
  });

  it("renders every supported app monitor as a separate cluster resource", () => {
    const rendered = execFileSync(
      "helm",
      [
        "template",
        "grafana",
        resolve(root, "charts/monitoring"),
        "--namespace",
        "monitoring",
      ],
      { encoding: "utf8" },
    );
    const names = parseAllDocuments(rendered)
      .map((document) => document.toJSON() as Record<string, unknown> | null)
      .filter((document) => document?.kind === "ClusterPodMonitoring")
      .map((document) => (document?.metadata as { name: string }).name);

    expect(names).toEqual(expect.arrayContaining([
      "gmp-kube-state-metrics",
      "octogee-api",
      "octogee-gateway",
      "gateway-edge",
      "gitea",
      "glm-controller",
    ]));
    expect(names).not.toContain("mattermost");
  });

  it("keeps the GKE-owned singleton as the explicit verified patch exception", () => {
    expect(setupMonitoring).toMatch(/operatorconfig config -n gmp-public[\s\S]*--type=merge/);
    expect(setupMonitoring).toContain("gmp-collection-filter.json");
    expect(setupMonitoring).toContain("verify-monitoring.sh");
    expect(verifyMonitoring).toContain("gmp-public/config collection filter");
    expect(verifyMonitoring).toContain("metadata.annotations.meta\\.helm\\.sh/release-name");
    expect(verifyMonitoring).not.toContain("grep '^grafana-dash-' || true");
  });

  it("waits for the managed rule evaluator after Helm renders ClusterRules", () => {
    const release = setupMonitoring.indexOf(
      'helm upgrade --install grafana "$REPO_DIR/charts/monitoring"',
    );
    const evaluatorWait = setupMonitoring.indexOf(
      "deployment/rule-evaluator",
      release,
    );

    expect(release).toBeGreaterThan(-1);
    expect(evaluatorWait).toBeGreaterThan(release);
    expect(
      setupMonitoring.slice(evaluatorWait - 180, evaluatorWait + 180),
    ).toMatch(
      /kubectl wait[\s\S]*?--for=condition=Available[\s\S]*?--timeout=5m/,
    );
  });

  it("converges IAP without first deleting the existing protected endpoint", () => {
    expect(setupMonitoring).toContain("--iap) IAP_ENABLED=true");
    expect(setupMonitoring).toContain("--set iap.enabled=true");
    expect(setupMonitoringIap).toContain('setup_args=(--target="$TARGET_ID" --iap)');
    expect(setupMonitoringIap).not.toContain('helm upgrade grafana "$REPO_DIR/charts/monitoring"');
    expect(setupMonitoringIap).toContain('setup-monitoring.sh" "${setup_args[@]}"');
  });

  it("verifies every Helm-owned IAP resource when IAP is enabled", () => {
    expect(verifyMonitoring).toContain("--iap) IAP_ENABLED=true");
    expect(verifyMonitoring).toContain("backendconfig grafana-iap");
    expect(verifyMonitoring).toContain("service grafana-nodeport");
    expect(verifyMonitoring).toContain("managedcertificate grafana-cert");
    expect(verifyMonitoring).toContain("ingress grafana");
    expect(verifyMonitoring).toContain("networking\\.gke\\.io/managed-certificates");
    expect(verifyMonitoring).toContain("compute backend-services describe");
    expect(verifyMonitoring).toContain(
      "terraform/environments/control-plane/variables.tf",
    );
    expect(verifyMonitoring).toContain("monitoring_iap_operator_principal");
    expect(verifyMonitoring).toContain("iap_policy_grants_principal");
    expect(verifyMonitoring).toContain("is_expected_iap_redirect");
  });

  it("renders Grafana for Restricted PSA without a root ownership init container", () => {
    const rendered = execFileSync(
      "helm",
      [
        "template",
        "grafana",
        resolve(root, "charts/monitoring"),
        "--namespace",
        "monitoring",
      ],
      { encoding: "utf8" },
    );
    const values = chart("values.yaml");

    expect(rendered).not.toContain("init-chown-data");
    expect(rendered).toContain("fsGroupChangePolicy: OnRootMismatch");
    expect(rendered).toContain("runAsNonRoot: true");
    expect(rendered).toContain("replicas: 1");
    expect(rendered).toContain("app.kubernetes.io/part-of: octogee-monitoring");
    expect(values).toContain("initChownData:");
    expect(values).toContain("enabled: false");
    expect(values).toContain("replicas: 1");
    expect(values).not.toContain("replicaCount:");
    expect(values).not.toContain("commonLabels:");
    expect(verifyMonitoring).toContain('octogee_verify_grafana_health "$TARGET_KUBE_CONTEXT"');
    expect(verifyMonitoring).not.toContain("kubectl exec deployment/grafana");
  });

  it("preinstalls the logging datasource with writable data and scratch volumes on distroless Grafana", () => {
    const deployment = renderedDeployment("grafana");
    const pod = (deployment.spec as { template: { spec: {
      containers: Array<{ name: string; image: string; env: Array<Record<string, unknown>>;
        securityContext: Record<string, unknown>; volumeMounts: Array<Record<string, unknown>> }>;
      volumes: Array<Record<string, unknown>>;
    } } }).template.spec;
    const server = pod.containers.find((container) => container.name === "grafana")!;

    expect(server.image).toBe("docker.io/grafana/grafana:13.2.1-distroless@sha256:3600073f45a9895d2e2c4042da0e745819f5b78bf781266952a400c40dcd8d69");
    expect(server.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(server.env).toContainEqual({ name: "GF_PLUGINS_PREINSTALL_SYNC", valueFrom: {
      configMapKeyRef: { name: "grafana", key: "plugins" },
    } });
    expect(server.env.some((entry) => entry.name === "GF_INSTALL_PLUGINS")).toBe(false);
    expect(server.volumeMounts).toContainEqual({ name: "tmp", mountPath: "/tmp" });
    expect(server.volumeMounts).toContainEqual(expect.objectContaining({ name: "storage", mountPath: "/var/lib/grafana" }));
    expect(pod.volumes).toContainEqual({ name: "tmp", emptyDir: {} });
    expect(pod.volumes).toContainEqual({ name: "storage", persistentVolumeClaim: { claimName: "grafana" } });
  });

  it("places every monitoring workload on private nodes without selecting a compute class", () => {
    const expectedSelector = {
      "kubernetes.io/os": "linux",
      "cloud.google.com/private-node": "true",
    };

    for (const name of ["grafana", "gmp-frontend", "gmp-kube-state-metrics"]) {
      const spec = renderedDeployment(name).spec as {
        template: { spec: { nodeSelector: Record<string, string> } };
      };
      expect(spec.template.spec.nodeSelector).toEqual(expectedSelector);
    }
  });
});
