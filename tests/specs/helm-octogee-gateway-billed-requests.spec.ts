import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import { gatewayPodRequests, type GatewayPodRequests } from "../../shared/types/cost-estimator.js";
import { SIZING_TIERS, type SizingTier } from "../../shared/types/sizing.js";

const CHART_PATH = path.join(path.resolve(__dirname, "../.."), "charts/octogee-gateway");

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "gw-billing",
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmInternalUrl": "http://mattermost.example.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app.example.com",
};

const ISOLATED_POD: Record<string, string> = {
  gatewayClass: "isolated",
  imageProfile: "isolated",
  runtimeKind: "cluster",
  rollStrategy: "recreate",
};

type Requests = Record<string, string | undefined>;
interface Container { name: string; resources?: { requests?: Requests } }
interface PodSpec { initContainers?: Container[]; containers: Container[] }

function renderPod(values: Record<string, string>): PodSpec {
  const args = ["template", "octogee-gw-billing", CHART_PATH, "--namespace=gateways"];
  for (const [key, value] of Object.entries({ ...REQUIRED_VALUES, ...values })) args.push("--set", `${key}=${value}`);
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr}`);
  const deployment = parseAllDocuments(result.stdout)
    .map((doc) => doc.toJS() as { kind?: string; spec?: { template?: { spec?: PodSpec } } } | null)
    .find((doc) => doc?.kind === "Deployment");
  if (!deployment?.spec?.template?.spec) throw new Error("no Deployment rendered");
  return deployment.spec.template.spec;
}

function quantity(value: string): number {
  const match = /^(\d+)(m|Mi|Gi)?$/.exec(value);
  if (!match) throw new Error(`unexpected quantity ${value}`);
  const amount = Number(match[1]);
  return { m: amount / 1000, Mi: amount / 1024, Gi: amount, "": amount }[match[2] ?? ""]!;
}

function billedRequests(pod: PodSpec): GatewayPodRequests {
  const billed = (resource: string) => {
    const appSum = pod.containers.reduce((total, container) => {
      const requested = container.resources?.requests?.[resource];
      if (!requested) throw new Error(`container ${container.name} has no ${resource} request`);
      return total + quantity(requested);
    }, 0);
    const largestInit = Math.max(0, ...(pod.initContainers ?? []).map((container) => {
      const requested = container.resources?.requests?.[resource];
      return requested ? quantity(requested) : 0;
    }));
    return Math.max(appSum, largestInit);
  };
  return { vcpu: billed("cpu"), memoryGiB: billed("memory"), ephemeralStorageGiB: billed("ephemeral-storage") };
}

describe("gateway pod cost estimate follows what the rendered pod requests", () => {
  it.each(SIZING_TIERS)("prices a %s shared gateway by every container's requests", (tier: SizingTier) => {
    expect(gatewayPodRequests(tier)).toEqual(billedRequests(renderPod({ sizingTier: tier })));
  });

  it.each(SIZING_TIERS)("prices a %s isolated pod gateway with a home claim by every container's requests", (tier: SizingTier) => {
    expect(gatewayPodRequests(tier)).toEqual(billedRequests(renderPod({ ...ISOLATED_POD, sizingTier: tier })));
  });

  it.each([4, 6])("prices an isolated pod gateway with a %sGi ephemeral home by every container's requests", (ephemeralHomeGiB) => {
    const pod = renderPod({ ...ISOLATED_POD, sizingTier: "s", ephemeralHomeGiB: String(ephemeralHomeGiB) });
    expect(gatewayPodRequests("s", { ephemeralHomeGiB })).toEqual(billedRequests(pod));
  });

  it("counts a sidecar added to the pod", () => {
    const pod = renderPod({ sizingTier: "m" });
    const withSidecar: PodSpec = {
      ...pod,
      containers: [...pod.containers, { name: "extra", resources: { requests: { cpu: "50m", memory: "64Mi", "ephemeral-storage": "1Gi" } } }],
    };
    expect(gatewayPodRequests("m")).not.toEqual(billedRequests(withSidecar));
  });
});
