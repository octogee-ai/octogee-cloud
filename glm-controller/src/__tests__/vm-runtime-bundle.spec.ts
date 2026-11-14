import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isGatewayVmRuntimeBundle } from "@octogee/shared/types/glm";
import {
  helmTemplateArgsFromUpgradeArgs,
  parseConcatenatedJson,
  renderDesktopNode,
  renderVmRuntimeBundle,
} from "../lib/vm-runtime-bundle";

const manifests = JSON.parse(
  readFileSync(new URL("./fixtures/vm-runtime-render.json", import.meta.url), "utf8"),
) as unknown[];

const secrets: Record<string, string> = {
  "gateway-auth-token-b-x/token": "gwtoken",
  "octogee-fleet-controller/public-key": "fleetpub",
  "agent-control-router/public-key": "acr",
  "byot-sync-internal/public-key": "byot",
};

function render(overrides: Partial<Parameters<typeof renderVmRuntimeBundle>[0]> = {}) {
  return renderVmRuntimeBundle({
    gatewayId: "b-x",
    namespace: "octogee-test",
    imageRepository: "us-docker.pkg.dev/octogee/octogee/gateway",
    imageTag: "main.abc123",
    desktop: "omarchy",
    computer: { serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com", projectId: "octogee" },
    manifests,
    readSecret: async (name, key) => {
      const value = secrets[`${name}/${key}`];
      if (value === undefined) throw new Error(`missing secret ${name}/${key}`);
      return value;
    },
    hostAliases: { "octogee-api.octogee-test.svc.cluster.local": "172.20.5.5" },
    kubernetes: { apiHost: "172.20.16.18", apiPort: "443", caCert: "CA" },
    now: () => 1_000,
    ...overrides,
  });
}

describe("parseConcatenatedJson", () => {
  it("splits kubectl's concatenated objects, respecting braces inside strings", () => {
    expect(parseConcatenatedJson('{"a":"}{"}\n{"b":[1,{"c":2}]}')).toEqual([{ a: "}{" }, { b: [1, { c: 2 }] }]);
    expect(parseConcatenatedJson("")).toEqual([]);
    expect(() => parseConcatenatedJson('{"a":')).toThrow(/ended inside/);
  });
});

describe("helmTemplateArgsFromUpgradeArgs", () => {
  it("turns the upgrade argv into a template argv with the apply flags removed", () => {
    expect(helmTemplateArgsFromUpgradeArgs([
      "upgrade", "--install", "octogee-gw-b-x", "/chart", "-n", "ns", "--set-string", "gatewayId=b-x",
      "--server-side=true", "--force-conflicts", "--take-ownership", "--wait", "--timeout=10m",
    ])).toEqual(["template", "octogee-gw-b-x", "/chart", "-n", "ns", "--set-string", "gatewayId=b-x"]);
    expect(() => helmTemplateArgsFromUpgradeArgs(["status", "x"])).toThrow(/upgrade --install/);
  });
});

describe("renderVmRuntimeBundle", () => {
  it.each([
    ["agent-control-router", "secret"],
    ["byot-sync-internal", "secret"],
    ["agent-control-signing", "secret"],
    ["gateway-auth-token-b-other", "token"],
  ])("refuses to materialize %s/%s inside the tenant VM", async (name, key) => {
    const unsafe = structuredClone(manifests) as Array<{ kind: string; spec?: { template: { spec: { containers: Array<{ env: unknown[] }> } } } }>;
    const deployment = unsafe.find((item) => item.kind === "Deployment")!;
    deployment.spec!.template.spec.containers[1].env.push({ name: "UNSAFE", valueFrom: { secretKeyRef: { name, key } } });
    const readSecret = vi.fn(async () => "secret-value");
    await expect(render({ manifests: unsafe, readSecret })).rejects.toThrow("is not permitted in a tenant VM");
    expect(readSecret).not.toHaveBeenCalledWith(name, key);
  });

  it("keeps home durable while translating user scratch volumes to boot storage", async () => {
    const changed = structuredClone(manifests) as Array<{ kind: string; spec?: { template: { spec: { volumes: unknown[] } } } }>;
    const pod = changed.find(item => item.kind === "Deployment")!.spec!.template.spec;
    pod.volumes.push({ name: "builder-cache", emptyDir: { sizeLimit: "4Gi" } }, { name: "project-materializations", emptyDir: { sizeLimit: "4Gi" } });
    const bundle = await render({ manifests: changed });
    expect(bundle.volumes).toContainEqual({ name: "data", kind: "emptyDir" });
    expect(bundle.volumes).toContainEqual({ name: "builder-cache", kind: "ephemeral" });
    expect(bundle.volumes).toContainEqual({ name: "project-materializations", kind: "ephemeral" });
  });

  it("binds the user identity and mounts its projects at the user's own user path", async () => {
    const changed = structuredClone(manifests) as Array<{ kind: string; spec?: { template: { spec: {
      volumes: unknown[];
      initContainers: Array<{ volumeMounts: unknown[] }>;
      containers: Array<{ name: string; volumeMounts: unknown[] }>;
    } } } }>;
    const pod = changed.find(item => item.kind === "Deployment")!.spec!.template.spec;
    pod.volumes.push({ name: "project-materializations", emptyDir: { sizeLimit: "2Gi" } });
    pod.initContainers[0].volumeMounts.push({ name: "project-materializations", mountPath: "/work/materialized" });
    for (const container of pod.containers) {
      container.volumeMounts.push({ name: "project-materializations", mountPath: "/work/materialized", subPath: "projects" });
    }

    const bundle = await render({ manifests: changed, builderIdentity: { ownerUid: "UidA", builderSlug: "mama" } });

    expect(isGatewayVmRuntimeBundle(bundle)).toBe(true);
    expect(bundle.builderIdentity).toEqual({ ownerUid: "UidA", builderSlug: "mama" });
    const projectMount = { volume: "project-materializations", mountPath: "/home/node/.openclaw/customers/mama/projects", readOnly: false, subPath: "projects" };
    for (const name of ["gateway", "gateway-edge"]) {
      expect(bundle.containers.find(container => container.name === name)?.mounts).toContainEqual(projectMount);
    }
    expect(bundle.init?.mounts).not.toContainEqual(projectMount);
    expect(Object.values(bundle.containers.map(container => container.env))).not.toContainEqual(expect.objectContaining({ GATEWAY_BUILDER_SLUG: expect.anything() }));
  });

  it("renders a bundle without user identity when the gateway has none", async () => {
    const bundle = await render();
    expect(bundle).not.toHaveProperty("builderIdentity");
    expect(isGatewayVmRuntimeBundle(bundle)).toBe(true);
  });

  it("renders the chart's pod into containers, resolved secrets, token volumes, and mounts", async () => {
    const bundle = await render();
    expect(isGatewayVmRuntimeBundle(bundle)).toBe(true);
    expect(bundle.version).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.init?.name).toBe("fix-perms");
    expect(bundle.init?.command?.[0]).toBe("sh");
    expect(bundle.init?.env.OPENCLAW_GATEWAY_TOKEN).toBe("gwtoken");
    expect(bundle.containers.map((c) => c.name)).toEqual(["gateway", "gateway-edge", "desktop-node"]);

    const gateway = bundle.containers[0];
    expect(gateway.image).toBe("us-docker.pkg.dev/octogee/octogee/gateway:main.abc123");
    expect(gateway.env).toMatchObject({
      GATEWAY_ID: "b-x",
      GATEWAY_CLASS: "isolated",
      K8S_NAMESPACE: "octogee-test",
      POD_UID: "",
      OPENCLAW_GATEWAY_TOKEN: "gwtoken",
      FLEET_CONTROLLER_PUBLIC_KEY: "fleetpub",
      OCTOGEE_API_SA_TOKEN_PATH: "/var/run/secrets/octogee-gateway-broker/token",
    });
    expect(gateway.mounts).toEqual(expect.arrayContaining([
      { volume: "data", mountPath: "/home/node", readOnly: false, subPath: null },
      { volume: "secret-resolver", mountPath: "/octogee/scripts/secret-resolver.mjs", readOnly: true, subPath: "secret-resolver.mjs" },
      { volume: "gateway-credential-sa-token", mountPath: "/var/run/secrets/octogee-gateway-credentials", readOnly: true, subPath: null },
    ]));

    const edge = bundle.containers[1];
    expect(edge.env).toMatchObject({
      AGENT_CONTROL_ROUTER_PUBLIC_KEY: "acr",
      BYOT_SYNC_INTERNAL_PUBLIC_KEY: "byot",
      GATEWAY_ID: "b-x",
    });
    expect(edge.env).not.toHaveProperty("AGENT_CONTROL_ROUTER_KEY");
    expect(edge.env).not.toHaveProperty("BYOT_SYNC_INTERNAL_SIGNING_SECRET");
    expect(edge.env).not.toHaveProperty("OCTOGEE_AGENT_CONTROL_SIGNING_SECRET");
    expect(edge.mounts.find((m) => m.volume === "k8s-api-token")?.mountPath).toBe("/var/run/secrets/kubernetes.io/serviceaccount");

    expect(bundle.volumes).toEqual(expect.arrayContaining([
      { name: "data", kind: "emptyDir" },
      { name: "octogee-api-sa-token", kind: "identityToken", audience: "octogee-api" },
      { name: "gateway-credential-sa-token", kind: "identityToken", audience: "octogee-api-gateway-credentials" },
      { name: "sidecar-broker-sa-token", kind: "identityToken", audience: "octogee-api-sidecar-broker" },
      { name: "k8s-api-token", kind: "kubernetesApi" },
    ]));
    expect(bundle.hostAliases).toEqual({ "octogee-api.octogee-test.svc.cluster.local": "172.20.5.5" });
    expect(bundle.kubernetes.apiHost).toBe("172.20.16.18");
    expect(bundle.renderedAt).toBe(1_000);
  });

  it("connects the edge to the visible desktop and enables VM runtime behavior in both services", async () => {
    const bundle = await render();
    const [gateway, edge] = bundle.containers;
    expect(edge.name).toBe("gateway-edge");
    expect(edge.env).toMatchObject({
      GATEWAY_RUNTIME_KIND: "gce-vm",
      GATEWAY_COMPUTER_DESKTOP: "omarchy",
      GATEWAY_COMPUTER_CONTROL_URL: "http://127.0.0.1:7777",
      GATEWAY_COMPUTER_VNC_URL: "ws://127.0.0.1:6080",
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: "octogee-computer-test@octogee.iam.gserviceaccount.com",
      GATEWAY_COMPUTER_PROJECT_ID: "octogee",
      GATEWAY_COMPUTER_INSTANCE_ID: "",
    });
    expect(gateway.env).toMatchObject({ GATEWAY_RUNTIME_KIND: "gce-vm", GATEWAY_COMPUTER_DESKTOP: "omarchy" });
    expect(gateway.env).not.toHaveProperty("GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL");
    expect(gateway.env).not.toHaveProperty("GATEWAY_COMPUTER_CONTROL_URL");
    expect(gateway.env).not.toHaveProperty("GATEWAY_COMPUTER_VNC_URL");
    expect(bundle.init?.env).not.toHaveProperty("GATEWAY_RUNTIME_KIND");
  });

  it("runs an X11 VM's desktop in its gateway container with no host desktop node", async () => {
    const omarchy = await render();
    const bundle = await render({ desktop: "x11" });
    expect(omarchy.desktop).toBe("omarchy");
    expect(bundle.desktop).toBe("x11");
    expect(isGatewayVmRuntimeBundle(bundle)).toBe(true);
    expect(bundle.containers.map((container) => container.name)).toEqual(["gateway", "gateway-edge"]);
    const [gateway, edge] = bundle.containers;
    expect(gateway.env).toMatchObject({ GATEWAY_RUNTIME_KIND: "gce-vm", GATEWAY_COMPUTER_DESKTOP: "x11" });
    expect(edge.env).toMatchObject({ GATEWAY_RUNTIME_KIND: "gce-vm", GATEWAY_COMPUTER_DESKTOP: "x11", GATEWAY_COMPUTER_CONTROL_URL: "http://127.0.0.1:7777" });
    expect(edge.mounts).toEqual(omarchy.containers[1].mounts.filter((mount) => mount.volume !== "desktop-node-identity"));
    expect(bundle.volumes.map((volume) => volume.name)).not.toContain("desktop-node-state");
  });

  it("runs the desktop node from the gateway image with the gateway's own credential", async () => {
    const bundle = await render();
    const gateway = bundle.containers[0];
    const node = bundle.containers.at(-1)!;
    expect(node.name).toBe("desktop-node");
    expect(node.image).toBe(gateway.image);
    expect(node.command).toEqual(["/usr/local/bin/octogee-desktop-node"]);
    expect(node.env).toMatchObject({
      OCTOGEE_DESKTOP_NODE_NAME: "octogee-desktop",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(node.mounts).toEqual([
      { volume: "desktop-node-state", mountPath: "/home/node/.openclaw", readOnly: false, subPath: null },
      { volume: "desktop-node-identity", mountPath: "/run/octogee/desktop-node-identity", readOnly: false, subPath: null },
    ]);
    expect(bundle.volumes).toContainEqual({ name: "desktop-node-state", kind: "emptyDir" });
    expect(node.env.OPENCLAW_GATEWAY_PASSWORD).toBe(gateway.env.OPENCLAW_GATEWAY_TOKEN);
    expect(node.env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
  });

  it("shares only the native public desktop identity with the edge", async () => {
    const bundle = await render();
    const gateway = bundle.containers.find(container => container.name === 'gateway')!;
    const edge = bundle.containers.find(container => container.name === 'gateway-edge')!;
    const desktop = bundle.containers.find(container => container.name === 'desktop-node')!;
    const identity = { volume: 'desktop-node-identity', mountPath: '/run/octogee/desktop-node-identity', subPath: null };
    expect(bundle.volumes).toContainEqual({ name: identity.volume, kind: 'emptyDir' });
    expect(desktop.mounts).toContainEqual({ ...identity, readOnly: false });
    expect(edge.mounts).toContainEqual({ ...identity, readOnly: true });
    expect(gateway.mounts.some(mount => mount.volume === identity.volume)).toBe(false);
    expect(edge.mounts.some(mount => mount.volume === 'desktop-node-state')).toBe(false);
    expect(desktop.env.OCTOGEE_DESKTOP_NODE_IDENTITY_PATH).toBe(`${identity.mountPath}/identity.json`);
    expect(edge.env.OCTOGEE_DESKTOP_NODE_IDENTITY_PATH).toBe(desktop.env.OCTOGEE_DESKTOP_NODE_IDENTITY_PATH);
  });

  it("refuses to render a desktop node without the gateway secret", () => {
    const gateway = { name: "gateway", image: "img", env: {}, command: null, args: null, mounts: [] };
    expect(() => renderDesktopNode(gateway)).toThrow("OPENCLAW_GATEWAY_TOKEN");
  });

  it("versions the bundle by content, not by render time", async () => {
    const a = await render({ now: () => 1 });
    const b = await render({ now: () => 2 });
    const c = await render({ imageTag: "main.def456" });
    expect(a.version).toBe(b.version);
    expect(c.version).not.toBe(a.version);
  });

  it("fails loudly on a missing secret or an unrenderable chart", async () => {
    await expect(render({ readSecret: async () => { throw new Error("missing secret x"); } })).rejects.toThrow(/missing secret x/);
    await expect(render({ manifests: manifests.filter((m) => (m as { kind: string }).kind !== "Deployment") })).rejects.toThrow(/exactly one Deployment/);
    const readSecret = vi.fn(async () => "v");
    await render({ readSecret });
    expect(readSecret).toHaveBeenCalledWith("gateway-auth-token-b-x", "token");
  });
});

it("gives a native Gateway only its own PostgreSQL credential", async () => {
  const withStore = structuredClone(manifests) as any[];
  const deployment = withStore.find(item => item.kind === "Deployment");
  const gateway = deployment.spec.template.spec.containers.find((item: any) => item.name === "gateway");
  gateway.env.push({ name: "OPENCLAW_AGENT_STORE_DSN", valueFrom: { secretKeyRef: { name: "gateway-auth-token-b-x", key: "agent-store-dsn" } } });
  const bundle = await render({ manifests: withStore, readSecret: async (name, key) => key === "agent-store-dsn" ? "postgresql://scoped-fixture" : secrets[`${name}/${key}`]! });
  expect(bundle.containers.find(item => item.name === "gateway")?.env.OPENCLAW_AGENT_STORE_DSN).toBe("postgresql://scoped-fixture");
  gateway.env.at(-1).valueFrom.secretKeyRef.name = "gateway-auth-token-other-user";
  await expect(render({ manifests: withStore })).rejects.toThrow("not permitted in a tenant VM");
});
