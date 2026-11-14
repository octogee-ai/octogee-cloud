import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
import { INSTALLATION_VALUES, useUmbrellaChart } from "./helpers/umbrella-chart";

const GATEWAY_CHART = path.resolve(__dirname, "../../helm/octogee-gateway");
const GATEWAY_ID = "lin-s-f4c76bd3";

interface LabelExpression {
  key: string;
  operator: "In" | "NotIn" | "Exists" | "DoesNotExist";
  values?: string[];
}

interface Manifest {
  kind?: string;
  metadata: { name: string };
  spec: {
    podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: LabelExpression[] };
    policyTypes?: string[];
    template?: { metadata: { labels: Record<string, string> } };
  };
}

function manifests(rendered: string): Manifest[] {
  return parseAllDocuments(rendered).map((doc) => doc.toJS() as Manifest | null).filter((doc): doc is Manifest => Boolean(doc));
}

function selects(policy: Manifest, labels: Record<string, string>): boolean {
  const selector = policy.spec.podSelector ?? {};
  const matched = Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
  return matched && (selector.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
    if (operator === "In") return values.includes(labels[key]);
    if (operator === "NotIn") return !values.includes(labels[key]);
    if (operator === "Exists") return key in labels;
    return !(key in labels);
  });
}

function egressPoliciesSelecting(rendered: string, labels: Record<string, string>): string[] {
  return manifests(rendered)
    .filter((doc) => doc.kind === "NetworkPolicy" && (doc.spec.policyTypes ?? []).includes("Egress") && selects(doc, labels))
    .map((doc) => doc.metadata.name);
}

const umbrella = useUmbrellaChart("octogee-kind-isolated-egress-");
let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-kind-gateway-values-"));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function renderKindIsolatedGateway(): string {
  const installation = parse(fs.readFileSync(INSTALLATION_VALUES, "utf8")) as Record<string, Record<string, unknown>>;
  const gatewayValues = path.join(scratch, "gateway-values.yaml");
  fs.writeFileSync(gatewayValues, stringify(installation["glm-controller"].gatewayValues));
  const sets = {
    imageTag: "abc1234",
    "image.repository": "localhost:5001/octogee/octogee-gateway-builder",
    "gatewayEdge.image.repository": "localhost:5001/octogee/gateway-edge",
    gatewayId: GATEWAY_ID,
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: "s",
    runtimeKind: "cluster",
    rollStrategy: "recreate",
    "builderAccess.controlUiEnabled": "true",
    "builderAccess.controlIdentity": "per-user",
    "builderAccess.kubeApiServerEgressCidrs[0]": "172.18.0.2/32",
  };
  const args = ["template", `octogee-gateway-${GATEWAY_ID}`, GATEWAY_CHART, "--namespace=octogee-local", "-f", gatewayValues];
  for (const [key, value] of Object.entries(sets)) args.push("--set", `${key}=${value}`);
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr}`);
  return result.stdout;
}

describe("an isolated gateway on kind", () => {
  it("has open egress to DNS and the platform API, because kind installs no gateway egress allow-list", () => {
    const gateway = renderKindIsolatedGateway();
    const deployment = manifests(gateway).find((doc) => doc.kind === "Deployment");
    if (!deployment?.spec.template) throw new Error("no gateway Deployment rendered");
    const podLabels = deployment.spec.template.metadata.labels;

    expect(egressPoliciesSelecting(umbrella.helmTemplate(), podLabels)).toEqual([]);
    expect(egressPoliciesSelecting(gateway, podLabels)).toEqual([]);
  });
});
