import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee-gateway");

const REQUIRED_VALUES: Record<string, string> = {
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmSiteUrl": "https://mm-test.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app-test.octogee.com",
};

const USER_VALUES: Record<string, string> = {
  gatewayClass: "isolated",
  imageProfile: "isolated",
  profile: "isolated",
  sizingTier: "s",
  runtimeKind: "gce-vm",
  "builderAccess.controlUiEnabled": "true",
  "builderAccess.controlIdentity": "per-user",
};

const VM_VALUES: Record<string, string> = { ...USER_VALUES, computerDesktop: "omarchy" };
const POD_VALUES: Record<string, string> = { ...USER_VALUES, runtimeKind: "cluster" };

interface Container {
  name: string;
  env?: Array<{ name: string; value?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string }>;
}

interface Pod {
  metadata: { annotations?: Record<string, string>; labels?: Record<string, string> };
  spec: {
    initContainers?: Container[];
    containers: Container[];
    volumes: Array<{ name: string; emptyDir?: { sizeLimit?: string } }>;
  };
}

function renderPod(gatewayId: string, values: Record<string, string>): { pod: Pod; rendered: string } {
  const args = ["template", `octogee-gw-${gatewayId}`, CHART_PATH, "--namespace=octogee-test"];
  for (const [key, value] of Object.entries({ ...REQUIRED_VALUES, gatewayId, ...values })) {
    args.push("--set", `${key}=${value}`);
  }
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr}`);
  for (const doc of parseAllDocuments(result.stdout)) {
    const value = doc.toJS() as { kind?: string; spec?: { template?: Pod } } | null;
    if (value?.kind === "Deployment" && value.spec?.template) return { pod: value.spec.template, rendered: result.stdout };
  }
  throw new Error("no Deployment rendered");
}

function allContainers(pod: Pod): Container[] {
  return [...(pod.spec.initContainers ?? []), ...pod.spec.containers];
}

describe("helm/octogee-gateway/ — User identity is never rendered", () => {
  it.each([
    ["Shared", { gatewayClass: "shared" }],
    ["X11 gateway VM", USER_VALUES],
    ["Omarchy gateway VM", { ...VM_VALUES, sizingTier: "m" }],
    ["Kubernetes isolated gateway", POD_VALUES],
  ])("supplies declared browser origins to the %s edge process", (_label, values) => {
    const { pod } = renderPod("origin-proof", values);
    const edge = pod.spec.containers.find((container) => container.name === "gateway-edge")!;
    expect(edge.env?.filter((entry) => entry.name === "PUBLIC_APP_ORIGINS"))
      .toEqual([{ name: "PUBLIC_APP_ORIGINS", value: "https://app-test.octogee.com" }]);
  });

  it.each([
    ["X11 VM", USER_VALUES],
    ["Omarchy VM", { ...VM_VALUES, sizingTier: "m" }],
    ["Kubernetes", POD_VALUES],
  ])("renders a %s isolated pod with no owner or slug env, annotation, label, or path", (_label, values) => {
    const { pod, rendered } = renderPod("b-alice", values);

    expect(pod.metadata.annotations ?? {}).not.toHaveProperty("octogee.ai/owner-uid");
    expect(pod.metadata.annotations ?? {}).not.toHaveProperty("octogee.ai/builder-slug");
    expect(pod.metadata.labels ?? {}).not.toHaveProperty("octogee.ai/builder-slug");
    for (const container of allContainers(pod)) {
      const names = (container.env ?? []).map((entry) => entry.name);
      expect(names, container.name).not.toContain("GATEWAY_BUILDER_SLUG");
      expect(names, container.name).not.toContain("GATEWAY_OWNER_UID");
      for (const mount of container.volumeMounts ?? []) {
        expect(mount.mountPath, container.name).not.toMatch(/\/customers\//);
      }
    }
    expect(rendered).not.toMatch(/ownerUid and builderSlug/);
  });

  it.each([
    ["VM", USER_VALUES],
    ["Kubernetes", POD_VALUES],
  ])("ignores owner values a caller still passes to a %s isolated gateway", (_label, values) => {
    const { rendered } = renderPod("b-x", { ...values, ownerUid: "uid-alice", builderSlug: "alice" });
    expect(rendered).not.toContain("uid-alice");
    expect(rendered).not.toMatch(/\balice\b/);
  });

  it("renders a user without an owner", () => {
    expect(() => renderPod("b-unowned", USER_VALUES)).not.toThrow();
  });

  it("keeps the Omarchy VM's own project materialization volume for its runtime to bind", () => {
    const { pod } = renderPod("b-alice", { ...VM_VALUES, sizingTier: "m" });

    expect(pod.spec.volumes.map((volume) => volume.name)).toContain("project-materializations");
    for (const name of ["gateway", "gateway-edge"]) {
      const container = pod.spec.containers.find((entry) => entry.name === name)!;
      expect(container.volumeMounts).toContainEqual({ name: "project-materializations", mountPath: "/work/materialized", subPath: "projects" });
    }
  });
});
