import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";

import { useUmbrellaChart } from "./helpers/umbrella-chart";

type Document = Record<string, any>;
type Direction = "Ingress" | "Egress";

const NAMESPACE = "octogee-local";
const PROVISIONING_SERVICE = "Deployment/provisioning-service";
const ENABLED = {
  "provisioningService.enabled": "true",
  "provisioningService.image.repository": "registry.example/provisioning-service",
  "provisioningService.image.tag": "bbbbbbb",
  "provisioningService.image.digest": `sha256:${"1".repeat(64)}`,
};
const DEFAULT_DENY = {
  "networkPolicy.enforceDefaultDeny": "true",
  "networkPolicy.controlPlaneCidr": "172.16.0.0/28",
  "networkPolicy.privateServicesCidr": "10.10.0.0/16",
};
const POSTURES: Array<[string, Record<string, string>]> = [
  ["default deny off", {}],
  ["default deny off, gitea and chat policies off", { "gitea.networkPolicy.enabled": "false", "mattermost.networkPolicy.enabled": "false" }],
  ["default deny on", DEFAULT_DENY],
  ["default deny on, gitea and chat policies off", { ...DEFAULT_DENY, "gitea.networkPolicy.enabled": "false", "mattermost.networkPolicy.enabled": "false" }],
];

const chart = useUmbrellaChart("octogee-network-policy-selection-");

function render(sets: Record<string, string>): Document[] {
  return parseAllDocuments(chart.helmTemplate({ namespace: NAMESPACE, sets }))
    .map((document) => document.toJSON() as Document | null)
    .filter((document): document is Document => document !== null);
}

function podLabels(document: Document): Record<string, string> | null {
  switch (document.kind) {
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "Job":
      return document.spec.template.metadata?.labels ?? {};
    case "CronJob":
      return document.spec.jobTemplate.spec.template.metadata?.labels ?? {};
    default:
      return null;
  }
}

function matches(selector: Document, labels: Record<string, string>): boolean {
  const byLabel = Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
  const byExpression = (selector.matchExpressions ?? []).every((expression: Document) => {
    const value = labels[expression.key];
    switch (expression.operator) {
      case "In": return value !== undefined && expression.values.includes(value);
      case "NotIn": return value === undefined || !expression.values.includes(value);
      case "Exists": return value !== undefined;
      case "DoesNotExist": return value === undefined;
      default: throw new Error(`unknown selector operator ${expression.operator}`);
    }
  });
  return byLabel && byExpression;
}

function describeSelector(selector: Document | undefined): string {
  if (!selector) return "";
  const labels = Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  const expressions = (selector.matchExpressions ?? []).map((expression: Document) =>
    `${expression.key} ${expression.operator} (${(expression.values ?? []).join(",")})`);
  const terms = [...labels, ...expressions];
  return terms.length === 0 ? "*" : terms.join(",");
}

function describePeer(peer: Document): string {
  if (peer.ipBlock) {
    const except = peer.ipBlock.except?.length ? ` except ${peer.ipBlock.except.join(",")}` : "";
    return `ip ${peer.ipBlock.cidr}${except}`;
  }
  const namespace = peer.namespaceSelector ? `ns ${describeSelector(peer.namespaceSelector)} ` : "";
  return `${namespace}pod ${describeSelector(peer.podSelector ?? {})}`;
}

function describePorts(ports: Document[] | undefined): string {
  if (!ports?.length) return "all ports";
  return ports.map((port) => `${port.protocol ?? "TCP"}/${port.port}${port.endPort ? `-${port.endPort}` : ""}`).join(",");
}

function allowedPeers(policy: Document, direction: Direction): string[] {
  const rules: Document[] = policy.spec[direction === "Ingress" ? "ingress" : "egress"] ?? [];
  return rules.flatMap((rule) => {
    const peers: Document[] = rule[direction === "Ingress" ? "from" : "to"] ?? [];
    const ports = describePorts(rule.ports);
    return peers.length === 0 ? [`anywhere on ${ports}`] : peers.map((peer) => `${describePeer(peer)} on ${ports}`);
  });
}

function selectsDirection(policy: Document, direction: Direction): boolean {
  const types: string[] | undefined = policy.spec.policyTypes;
  if (types) return types.includes(direction);
  return direction === "Ingress" || policy.spec.egress !== undefined;
}

function allowedPeersByWorkload(rendered: Document[], direction: Direction): Record<string, string[]> {
  const namespaceOf = (document: Document) => document.metadata.namespace ?? NAMESPACE;
  const workloads = rendered.flatMap((document) => {
    const labels = podLabels(document);
    return labels ? [{ name: `${document.kind}/${document.metadata.name}`, namespace: namespaceOf(document), labels }] : [];
  });
  const policies = rendered.filter((document) => document.kind === "NetworkPolicy" && selectsDirection(document, direction));
  const result: Record<string, string[]> = {};
  for (const workload of workloads) {
    const selecting = policies.filter((policy) =>
      namespaceOf(policy) === workload.namespace && matches(policy.spec.podSelector ?? {}, workload.labels));
    if (selecting.length === 0) continue;
    result[workload.name] = [...new Set(selecting.flatMap((policy) => allowedPeers(policy, direction)))].sort();
  }
  return result;
}

describe("the provisioning service's NetworkPolicies only add to policies that already select another component", () => {
  it.each(POSTURES)("%s: enabling it selects no other pod and narrows no other pod's traffic", (_posture, sets) => {
    const before = render(sets);
    const after = render({ ...sets, ...ENABLED });

    for (const direction of ["Ingress", "Egress"] as const) {
      const selectedBefore = allowedPeersByWorkload(before, direction);
      const selectedAfter = allowedPeersByWorkload(after, direction);
      const others = Object.keys(selectedAfter).filter((workload) => workload !== PROVISIONING_SERVICE).sort();

      expect(others).toEqual(Object.keys(selectedBefore).sort());
      for (const workload of others) expect(selectedAfter[workload]).toEqual(expect.arrayContaining(selectedBefore[workload]!));
    }
  });

  it("without default deny, the fleet controller and the API stay unselected while gitea and chat admit the service on top of their own policies", () => {
    const after = render(ENABLED);
    const ingress = allowedPeersByWorkload(after, "Ingress");
    const egress = allowedPeersByWorkload(after, "Egress");

    for (const workload of ["Deployment/glm-controller", "Deployment/octogee-api"]) {
      expect(ingress).not.toHaveProperty([workload]);
      expect(egress).not.toHaveProperty([workload]);
    }
    expect(egress).not.toHaveProperty([PROVISIONING_SERVICE]);
    expect(ingress["Deployment/octogee-gitea"]).toContain("pod app=provisioning-service on TCP/3000");
    expect(ingress["Deployment/mattermost"]).toContain("pod app=provisioning-service on TCP/8065");
  });
});
