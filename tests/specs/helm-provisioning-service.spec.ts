import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

import { findDoc, INSTALLATION_SETS, INSTALLATION_VALUES, useUmbrellaChart } from "./helpers/umbrella-chart";

const UMBRELLA_PATH = path.resolve(__dirname, "../../charts/octogee");
const TEMPLATE = "templates/provisioning-service.yaml";
const DIGEST = `sha256:${"1".repeat(64)}`;
const ENABLED = {
  "provisioningService.enabled": "true",
  "provisioningService.image.repository": "registry.example/provisioning-service",
  "provisioningService.image.tag": "bbbbbbb",
  "provisioningService.image.digest": DIGEST,
};
const DEFAULT_DENY = {
  "networkPolicy.enforceDefaultDeny": "true",
  "networkPolicy.controlPlaneCidr": "172.16.0.0/28",
  "networkPolicy.privateServicesCidr": "10.10.0.0/16",
};

const chart = useUmbrellaChart("octogee-provisioning-service-");

function renderDirectory(chartDir: string, sets: Record<string, string> = {}): string {
  const args = ["template", "octogee", chartDir, "-f", INSTALLATION_VALUES, "-n", "octogee-local"];
  for (const [key, value] of Object.entries({ ...INSTALLATION_SETS, ...sets })) args.push("--set", `${key}=${value}`);
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr.slice(0, 2000)}`);
  return result.stdout;
}

interface Resource {
  kind: string;
  metadata: { name: string };
  spec: Record<string, any>;
}

function resources(out: string): Resource[] {
  return parseAllDocuments(out).map((document) => document.toJSON() as Resource).filter(Boolean);
}

function container(out: string): Record<string, any> {
  const deployment = parse(findDoc(out, "Deployment", "provisioning-service")!) as Resource;
  return deployment.spec.template.spec.containers[0];
}

describe("the provisioning service in the platform chart", () => {
  let withoutTemplate: string;

  beforeAll(() => {
    withoutTemplate = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-without-provisioning-"));
    fs.cpSync(UMBRELLA_PATH, withoutTemplate, { recursive: true });
    fs.rmSync(path.join(withoutTemplate, TEMPLATE));
  });
  afterAll(() => fs.rmSync(withoutTemplate, { recursive: true, force: true }));

  it.each([{}, DEFAULT_DENY])("renders exactly what the chart rendered without it while it is off", (sets) => {
    expect(renderDirectory(UMBRELLA_PATH, sets)).toBe(renderDirectory(withoutTemplate, sets));
  });

  it("runs two replicas of its own image with real adapters, probed on /healthz and /readyz", () => {
    const out = chart.helmTemplate({ sets: ENABLED });
    const deployment = parse(findDoc(out, "Deployment", "provisioning-service")!) as Resource;
    const main = container(out);

    expect(deployment.spec.replicas).toBe(2);
    expect(main.image).toBe(`registry.example/provisioning-service:bbbbbbb@${DIGEST}`);
    expect(main.env).toContainEqual({ name: "PROVISIONING_HOST_ADAPTERS", value: "real" });
    expect(main.readinessProbe.httpGet.path).toBe("/readyz");
    expect(main.livenessProbe.httpGet.path).toBe("/healthz");
    expect(findDoc(out, "Service", "provisioning-service")).toMatch(/type: ClusterIP/);
    expect(resources(out).filter((resource) => resource.kind === "Ingress" && JSON.stringify(resource).includes("provisioning-service"))).toEqual([]);
  });

  it("reads every credential from a Secret and no setting selects fake adapters", () => {
    const env = container(chart.helmTemplate({ sets: ENABLED })).env as Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }>;
    const secret = (name: string) => env.find((entry) => entry.name === name)?.valueFrom?.secretKeyRef;

    expect(secret("PROVISIONING_DB_PASSWORD")).toMatchObject({ name: "provisioning-service-postgres", key: "password" });
    expect(secret("PROVISIONING_CREDENTIAL_KEY")).toMatchObject({ name: "provisioning-service-credential-key", key: "key" });
    expect(secret("PROVISIONING_CHAT_HOST_ADMIN_TOKEN")).toMatchObject({ name: "mattermost-gateway", key: "admin_token" });
    expect(secret("PROVISIONING_GIT_HOST_ADMIN_TOKEN")).toMatchObject({ name: "gitea-token", key: "token" });
    expect(env.filter((entry) => entry.value === "fake")).toEqual([]);
    expect(env.find((entry) => entry.name === "PROVISIONING_CHAT_CONTROL_COMMAND_URL")?.value)
      .toBe("http://mattermost-callback-router.octogee-local.svc.cluster.local:3001/internal/mattermost/commands/control-ui");
  });

  it("refuses to render without the namespace TokenReview grant its callers' authentication needs", () => {
    expect(() => chart.helmTemplate({ sets: { ...ENABLED, "gatewayFleet.tokenReviewRbac.enabled": "false" } }))
      .toThrow(/requires gatewayFleet.tokenReviewRbac.enabled/);
  });

  it("admits only the fleet controller, the platform API and the metrics collector", () => {
    const policy = parse(findDoc(chart.helmTemplate({ sets: ENABLED }), "NetworkPolicy", "provisioning-service-ingress")!) as Resource;

    expect(policy.spec.ingress[0].from[0].podSelector.matchExpressions[0].values).toEqual(["glm-controller", "octogee-api"]);
    expect(policy.spec.ingress[1].from[0].namespaceSelector.matchLabels).toEqual({ "kubernetes.io/metadata.name": "gke-gmp-system" });
  });

  it("is scraped on the service's own port when that port is not the default", () => {
    const main = container(chart.helmTemplate({ sets: { ...ENABLED, "provisioningService.port": "9090" } }));
    const monitoring = spawnSync("helm", ["template", "grafana", path.resolve(__dirname, "../../charts/monitoring"), "-n", "monitoring"], { encoding: "utf-8" });
    expect(monitoring.status, monitoring.stderr).toBe(0);
    const scrape = resources(monitoring.stdout).find((resource) => resource.kind === "ClusterPodMonitoring" && resource.metadata.name === "provisioning-service")!;
    const scraped = main.ports.find((port: { name: string }) => port.name === scrape.spec.endpoints[0].port);

    expect(scrape.spec.selector.matchLabels).toEqual({ app: "provisioning-service" });
    expect(scraped?.containerPort).toBe(9090);
  });

  it("reaches public HTTPS but never link-local metadata under default deny", () => {
    const out = chart.helmTemplate({ sets: { ...ENABLED, ...DEFAULT_DENY } });
    const policy = parse(findDoc(out, "NetworkPolicy", "provisioning-service-egress")!) as Resource;
    const internet = policy.spec.egress.find((rule: any) => rule.to[0].ipBlock?.cidr === "0.0.0.0/0");

    expect(internet.to[0].ipBlock.except).toEqual(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]);
    expect(internet.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(findDoc(out, "NetworkPolicy", "provisioning-service-callers-egress")).not.toBeNull();
  });
});
