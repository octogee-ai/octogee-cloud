import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee-gateway");

const REQUIRED_VALUES: Record<string, string> = {
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway-builder",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app.example.com",
};

const ISOLATED_POD: Record<string, string> = {
  gatewayId: "gw-s-0a1b2c3d",
  gatewayClass: "isolated",
  imageProfile: "isolated",
  sizingTier: "s",
  runtimeKind: "cluster",
  rollStrategy: "recreate",
  "builderAccess.controlUiEnabled": "true",
  "builderAccess.controlIdentity": "per-user",
};

interface Container {
  name: string;
  command?: string[];
  env?: Array<{ name: string; value?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string }>;
  resources?: Record<string, Record<string, string>>;
}

interface Volume {
  name: string;
  emptyDir?: { sizeLimit?: string };
  persistentVolumeClaim?: { claimName: string };
}

interface Deployment {
  spec: {
    strategy: { type: string };
    template: {
      spec: {
        nodeSelector?: Record<string, string>;
        initContainers: Container[];
        containers: Container[];
        volumes: Volume[];
      };
    };
  };
}

function helm(values: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const args = ["template", "octogee-gw-isolated", CHART_PATH, "--namespace=octogee-test"];
  for (const [key, value] of Object.entries({ ...REQUIRED_VALUES, ...values })) args.push("--set", `${key}=${value}`);
  return spawnSync("helm", args, { encoding: "utf-8" });
}

function renderDeployment(values: Record<string, string> = {}): { deployment: Deployment; rendered: string; kinds: string[] } {
  const result = helm({ ...ISOLATED_POD, ...values });
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr}`);
  const docs = parseAllDocuments(result.stdout).map((doc) => doc.toJS() as { kind?: string } | null).filter(Boolean);
  const deployment = docs.find((doc) => doc?.kind === "Deployment") as unknown as Deployment | undefined;
  if (!deployment) throw new Error("no Deployment rendered");
  return { deployment, rendered: result.stdout, kinds: docs.map((doc) => doc!.kind!) };
}

function renderFailure(values: Record<string, string>): string {
  const result = helm({ ...ISOLATED_POD, ...values });
  expect(result.status, result.stdout).not.toBe(0);
  return result.stderr;
}

function container(deployment: Deployment, name: string): Container {
  const found = deployment.spec.template.spec.containers.find((entry) => entry.name === name);
  if (!found) throw new Error(`no ${name} container`);
  return found;
}

function envOf(entry: Container): Record<string, string | undefined> {
  return Object.fromEntries((entry.env ?? []).map((variable) => [variable.name, variable.value]));
}

describe("helm/octogee-gateway/ — isolated gateway as a Kubernetes pod", () => {
  it("mounts the home from the gateway's own claim, which the chart never creates", () => {
    const { deployment, kinds } = renderDeployment();
    expect(deployment.spec.template.spec.volumes).toContainEqual({
      name: "data",
      persistentVolumeClaim: { claimName: "octogee-gateway-gw-s-0a1b2c3d-data" },
    });
    expect(kinds).not.toContain("PersistentVolumeClaim");
  });

  it("mounts the home from a directory inside the claim, so tightening /home/node never changes the claim root fsGroup checks", () => {
    const pod = renderDeployment().deployment.spec.template.spec;
    const homeMounts = [...pod.initContainers, ...pod.containers]
      .flatMap((entry) => (entry.volumeMounts ?? []).filter((mount) => mount.name === "data").map((mount) => ({ container: entry.name, ...mount })));
    expect(homeMounts.map((mount) => mount.container)).toEqual(["fix-perms", "gateway", "gateway-edge"]);
    for (const mount of homeMounts) expect(mount, mount.container).toEqual({ container: mount.container, name: "data", mountPath: "/home/node", subPath: "home" });
  });

  it("mounts a shared gateway's scratch home at its root", () => {
    const result = helm({ gatewayId: "shared-a", gatewayClass: "shared", rollStrategy: "surge" });
    expect(result.status, result.stderr).toBe(0);
    const deployment = parseAllDocuments(result.stdout).map((doc) => doc.toJS() as { kind?: string } | null)
      .find((doc) => doc?.kind === "Deployment") as unknown as Deployment;
    const pod = deployment.spec.template.spec;
    expect(pod.volumes).toContainEqual({ name: "data", emptyDir: {} });
    for (const entry of [...pod.initContainers, ...pod.containers]) {
      for (const mount of (entry.volumeMounts ?? []).filter((candidate) => candidate.name === "data")) {
        expect(mount, entry.name).toEqual({ name: "data", mountPath: "/home/node" });
      }
    }
  });

  it("keeps projects in the home, with no separate project volume, mount or preparation", () => {
    const { deployment } = renderDeployment();
    const pod = deployment.spec.template.spec;
    expect(pod.volumes.map((volume) => volume.name)).not.toContain("project-materializations");
    for (const entry of [...pod.initContainers, ...pod.containers]) {
      expect(entry.volumeMounts?.map((mount) => mount.name), entry.name).not.toContain("project-materializations");
      expect(envOf(entry), entry.name).not.toHaveProperty("OCTOGEE_PROJECTS_MOUNT");
    }
    expect(pod.initContainers.flatMap((entry) => entry.command ?? []).join("\n")).not.toContain("prepare-project-storage");
  });

  it("keeps the toolchain cache as a bounded scratch volume", () => {
    const { deployment } = renderDeployment();
    expect(deployment.spec.template.spec.volumes).toContainEqual({ name: "builder-cache", emptyDir: { sizeLimit: "2Gi" } });
    expect(container(deployment, "gateway").volumeMounts).toContainEqual({ name: "builder-cache", mountPath: "/work/cache" });
  });

  it("tells the gateway and its edge that they run in the cluster with no desktop", () => {
    const { deployment } = renderDeployment();
    for (const name of ["gateway", "gateway-edge"]) {
      const env = envOf(container(deployment, name));
      expect(env.GATEWAY_RUNTIME_KIND, name).toBe("cluster");
      expect(env, name).not.toHaveProperty("GATEWAY_COMPUTER_DESKTOP");
      expect(env, name).not.toHaveProperty("GATEWAY_COMPUTER_CONTROL_URL");
    }
    const volumes = deployment.spec.template.spec.volumes.map((volume) => volume.name);
    expect(volumes).not.toEqual(expect.arrayContaining(["desktop-runtime"]));
    expect(volumes).not.toContain("desktop-node-identity");
  });

  it("gives each user their own control identity, as a VM gateway does, so the workspace identities bootstrap", () => {
    const pod = renderDeployment().deployment;
    const vm = renderDeployment({ runtimeKind: "gce-vm", rollStrategy: "surge" }).deployment;
    for (const name of ["gateway", "gateway-edge"]) {
      const identity = (deployment: Deployment) => {
        const env = envOf(container(deployment, name));
        return { GATEWAY_CLASS: env.GATEWAY_CLASS, OPENCLAW_CONTROL_IDENTITY: env.OPENCLAW_CONTROL_IDENTITY };
      };
      expect(identity(pod), name).toEqual({ GATEWAY_CLASS: "isolated", OPENCLAW_CONTROL_IDENTITY: "per-user" });
      expect(identity(pod), name).toEqual(identity(vm));
    }
  });

  it("replaces the pod rather than surging, because the home claim has one writer", () => {
    expect(renderDeployment().deployment.spec.strategy).toEqual({ type: "Recreate" });
    expect(renderFailure({ rollStrategy: "surge" })).toMatch(/isolated pod gateway .* rollStrategy must be recreate/);
  });

  it("takes its resources from the sizing tier preset as they are", () => {
    const { deployment } = renderDeployment({
      "tiers.s.resources.requests.ephemeral-storage": "6Gi",
      "tiers.s.resources.limits.ephemeral-storage": "6Gi",
    });
    const resources = container(deployment, "gateway").resources!;
    expect(resources.requests["ephemeral-storage"]).toBe("6Gi");
    expect(resources.limits["ephemeral-storage"]).toBe("6Gi");
    expect(resources.requests.cpu).toBe("2000m");
  });

  it.each(["x11", "omarchy"])("refuses a %s desktop, which only a GCE VM carries", (computerDesktop) => {
    expect(renderFailure({ computerDesktop })).toMatch(new RegExp(`isolated pod gateway has no desktop; computerDesktop=${computerDesktop}`));
  });
});

describe("helm/octogee-gateway/ — isolated pod placement", () => {
  it("places the pod on an amd64 node, because the isolated image is built for linux/amd64 only", () => {
    expect(renderDeployment().deployment.spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/arch": "amd64" });
  });

  it("adds the architecture to the operator's node selector", () => {
    const { deployment } = renderDeployment({ "nodeSelector.pool": "isolated" });
    expect(deployment.spec.template.spec.nodeSelector).toEqual({ pool: "isolated", "kubernetes.io/arch": "amd64" });
  });

  it("adds the architecture to the compute class selector", () => {
    const { deployment } = renderDeployment({ computeClass: "octogee-gateway" });
    expect(deployment.spec.template.spec.nodeSelector).toEqual({
      "cloud.google.com/compute-class": "octogee-gateway",
      "kubernetes.io/arch": "amd64",
    });
  });

  it("accepts an operator selector that already names amd64", () => {
    const { deployment } = renderDeployment({ "nodeSelector.kubernetes\\.io/arch": "amd64" });
    expect(deployment.spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/arch": "amd64" });
  });

  it("refuses an operator selector that names another architecture", () => {
    expect(renderFailure({ "nodeSelector.kubernetes\\.io/arch": "arm64" }))
      .toMatch(/isolated gateway image is linux\/amd64 only; nodeSelector names kubernetes.io\/arch=arm64/);
  });

  it("leaves shared gateways on any architecture", () => {
    const result = helm({ gatewayId: "shared-a", gatewayClass: "shared", rollStrategy: "surge" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("kubernetes.io/arch");
  });
});
