import { createHash } from "node:crypto";
import {
  GATEWAY_DESKTOP_NODE_CONTAINER,
  GATEWAY_DESKTOP_NODE_NAME,
  GATEWAY_DESKTOP_NODE_IDENTITY_VOLUME,
  GATEWAY_DESKTOP_NODE_IDENTITY_DIR,
  GATEWAY_DESKTOP_NODE_IDENTITY_PATH,
  GATEWAY_DESKTOP_NODE_STATE_VOLUME,
  GATEWAY_DESKTOP_RUNTIME_DIR,
  type GatewayVmDesktop,
  type GatewayVmRuntimeBundle,
  type GatewayVmRuntimeContainer,
  type GatewayVmRuntimeMount,
  type GatewayVmRuntimeVolume,
  type RuntimeUserIdentity,
} from "@octogee/shared/types/glm";

interface JsonScan {
  depth: number;
  start: number;
  inString: boolean;
  escaped: boolean;
}

function scanStringChar(scan: JsonScan, ch: string): void {
  if (scan.escaped) scan.escaped = false;
  else if (ch === "\\") scan.escaped = true;
  else if (ch === '"') scan.inString = false;
}

function scanStructuralChar(scan: JsonScan, ch: string, index: number, text: string, items: unknown[]): void {
  if (ch === '"') {
    scan.inString = true;
  } else if (ch === "{" || ch === "[") {
    if (scan.depth === 0) scan.start = index;
    scan.depth += 1;
  } else if (ch === "}" || ch === "]") {
    scan.depth -= 1;
    if (scan.depth === 0 && scan.start >= 0) {
      items.push(JSON.parse(text.slice(scan.start, index + 1)));
      scan.start = -1;
    }
  }
}

export function parseConcatenatedJson(text: string): unknown[] {
  const items: unknown[] = [];
  const scan: JsonScan = { depth: 0, start: -1, inString: false, escaped: false };
  for (let i = 0; i < text.length; i += 1) {
    if (scan.inString) scanStringChar(scan, text[i]);
    else scanStructuralChar(scan, text[i], i, text, items);
  }
  if (scan.depth !== 0) throw new Error("concatenated JSON ended inside a value");
  return items;
}

export function helmTemplateArgsFromUpgradeArgs(upgradeArgs: readonly string[]): string[] {
  if (upgradeArgs[0] !== "upgrade" || upgradeArgs[1] !== "--install") {
    throw new Error("expected helm upgrade --install argv");
  }
  const dropped = new Set(["--server-side=true", "--force-conflicts", "--take-ownership", "--wait"]);
  const rest = upgradeArgs.slice(2).filter((arg) => !dropped.has(arg) && !arg.startsWith("--timeout="));
  return ["template", ...rest];
}

interface K8sEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
    fieldRef?: { fieldPath: string };
  };
}

interface K8sVolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
}

interface K8sContainer {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: K8sEnvVar[];
  volumeMounts?: K8sVolumeMount[];
}

interface K8sVolume {
  name: string;
  emptyDir?: Record<string, unknown>;
  projected?: {
    sources?: Array<{
      serviceAccountToken?: { audience?: string; path?: string };
      configMap?: { name: string };
    }>;
  };
}

interface K8sDeployment {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: {
      spec?: {
        initContainers?: K8sContainer[];
        containers?: K8sContainer[];
        volumes?: K8sVolume[];
      };
    };
  };
}

export interface GatewayVmIdentity {
  serviceAccountEmail: string;
  projectId: string;
}

export interface RenderVmRuntimeBundleInput {
  gatewayId: string;
  builderIdentity?: RuntimeUserIdentity;
  homeStorageId?: string;
  namespace: string;
  imageRepository: string;
  imageTag: string;
  desktop: GatewayVmDesktop;
  computer: GatewayVmIdentity;
  manifests: unknown[];
  readSecret: (name: string, key: string) => Promise<string>;
  hostAliases: Record<string, string>;
  kubernetes: { apiHost: string; apiPort: string; caCert: string };
  now: () => number;
}

export const VM_POD_UID_PLACEHOLDER = "";
export const VM_INSTANCE_ID_PLACEHOLDER = "";

function findDeployment(manifests: unknown[]): K8sDeployment {
  const deployments = manifests.filter(
    (item): item is K8sDeployment => !!item && typeof item === "object" && (item as K8sDeployment).kind === "Deployment",
  );
  if (deployments.length !== 1) {
    throw new Error(`expected exactly one Deployment in the rendered chart, found ${deployments.length}`);
  }
  return deployments[0];
}

async function renderEnv(
  env: K8sEnvVar[] | undefined,
  input: Pick<RenderVmRuntimeBundleInput, "gatewayId" | "namespace" | "readSecret">,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of env ?? []) {
    if (entry.value !== undefined) {
      out[entry.name] = entry.value;
      continue;
    }
    const secret = entry.valueFrom?.secretKeyRef;
    if (secret) {
      const allowed = secret.name === `gateway-auth-token-${input.gatewayId}` && ["token", "agent-store-dsn"].includes(secret.key)
        || ["octogee-fleet-controller", "agent-control-router", "byot-sync-internal"].includes(secret.name) && secret.key === "public-key";
      if (!allowed) throw new Error(`env ${entry.name}: secret ${secret.name}/${secret.key} is not permitted in a tenant VM`);
      out[entry.name] = await input.readSecret(secret.name, secret.key);
      continue;
    }
    const fieldPath = entry.valueFrom?.fieldRef?.fieldPath;
    if (fieldPath === "metadata.namespace") {
      out[entry.name] = input.namespace;
      continue;
    }
    if (fieldPath === "metadata.uid") {
      out[entry.name] = VM_POD_UID_PLACEHOLDER;
      continue;
    }
    throw new Error(`env ${entry.name}: unsupported valueFrom ${JSON.stringify(entry.valueFrom ?? {})}`);
  }
  return out;
}

function renderMounts(mounts: K8sVolumeMount[] | undefined, volumes: Set<string>): GatewayVmRuntimeMount[] {
  return (mounts ?? []).map((mount) => {
    if (!volumes.has(mount.name)) throw new Error(`volumeMount ${mount.name} has no volume`);
    return {
      volume: mount.name,
      mountPath: mount.mountPath,
      readOnly: mount.readOnly === true,
      subPath: mount.subPath ?? null,
    };
  });
}

function renderVolume(volume: K8sVolume): GatewayVmRuntimeVolume {
  if (volume.emptyDir) return { name: volume.name, kind: ["builder-cache", "project-materializations"].includes(volume.name) ? "ephemeral" : "emptyDir" };
  const sources = volume.projected?.sources ?? [];
  const token = sources.find((source) => source.serviceAccountToken)?.serviceAccountToken;
  if (!token) throw new Error(`volume ${volume.name}: only emptyDir and projected service-account-token volumes are supported`);
  if (typeof token.audience === "string" && token.audience.length > 0) {
    return { name: volume.name, kind: "identityToken", audience: token.audience };
  }
  return { name: volume.name, kind: "kubernetesApi" };
}

export const GATEWAY_CONTAINER_NAME = "gateway";
export const GATEWAY_EDGE_CONTAINER_NAME = "gateway-edge";
export const GATEWAY_DESKTOP_NODE_COMMAND = "/usr/local/bin/octogee-desktop-node";
export const GATEWAY_COMPUTER_ENV = {
  GATEWAY_COMPUTER_CONTROL_URL: "http://127.0.0.1:7777",
  GATEWAY_COMPUTER_VNC_URL: "ws://127.0.0.1:6080",
} as const;

async function renderContainer(
  container: K8sContainer,
  input: RenderVmRuntimeBundleInput,
  volumes: Set<string>,
): Promise<GatewayVmRuntimeContainer> {
  let env = await renderEnv(container.env, input);
  if (container.name === GATEWAY_EDGE_CONTAINER_NAME) {
    env = {
      ...env,
      ...GATEWAY_COMPUTER_ENV,
      GATEWAY_RUNTIME_KIND: "gce-vm",
      GATEWAY_COMPUTER_DESKTOP: input.desktop,
      OCTOGEE_DESKTOP_NODE_IDENTITY_PATH: GATEWAY_DESKTOP_NODE_IDENTITY_PATH,
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: input.computer.serviceAccountEmail,
      GATEWAY_COMPUTER_PROJECT_ID: input.computer.projectId,
      GATEWAY_COMPUTER_INSTANCE_ID: VM_INSTANCE_ID_PLACEHOLDER,
    };
  }
  else if (container.name === GATEWAY_CONTAINER_NAME) env = { ...env, GATEWAY_RUNTIME_KIND: "gce-vm", GATEWAY_COMPUTER_DESKTOP: input.desktop };
  const hostDesktopNode = input.desktop === "omarchy" && container.name === GATEWAY_EDGE_CONTAINER_NAME;
  return {
    name: container.name,
    image: container.image,
    env,
    command: container.command ?? null,
    args: container.args ?? null,
    mounts: [
      ...renderMounts(container.volumeMounts, volumes),
      ...(hostDesktopNode ? [{ volume: GATEWAY_DESKTOP_NODE_IDENTITY_VOLUME, mountPath: GATEWAY_DESKTOP_NODE_IDENTITY_DIR, readOnly: true, subPath: null }] : []),
    ],
  };
}

export function renderDesktopNode(gateway: GatewayVmRuntimeContainer): GatewayVmRuntimeContainer {
  const secret = gateway.env.OPENCLAW_GATEWAY_TOKEN;
  if (!secret) throw new Error("desktop node requires the gateway container's OPENCLAW_GATEWAY_TOKEN");
  return {
    name: GATEWAY_DESKTOP_NODE_CONTAINER,
    image: gateway.image,
    env: {
      OPENCLAW_GATEWAY_PASSWORD: secret,
      OCTOGEE_DESKTOP_NODE_NAME: GATEWAY_DESKTOP_NODE_NAME,
      OCTOGEE_DESKTOP_NODE_IDENTITY_PATH: GATEWAY_DESKTOP_NODE_IDENTITY_PATH,
      XDG_RUNTIME_DIR: GATEWAY_DESKTOP_RUNTIME_DIR,
    },
    command: [GATEWAY_DESKTOP_NODE_COMMAND],
    args: null,
    mounts: [
      { volume: GATEWAY_DESKTOP_NODE_STATE_VOLUME, mountPath: "/home/node/.openclaw", readOnly: false, subPath: null },
      { volume: GATEWAY_DESKTOP_NODE_IDENTITY_VOLUME, mountPath: GATEWAY_DESKTOP_NODE_IDENTITY_DIR, readOnly: false, subPath: null },
    ],
  };
}

export function bundleVersion(bundle: Omit<GatewayVmRuntimeBundle, "version" | "renderedAt">): string {
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex").slice(0, 16);
}

export async function renderVmRuntimeBundle(input: RenderVmRuntimeBundleInput): Promise<GatewayVmRuntimeBundle> {
  const deployment = findDeployment(input.manifests);
  const podSpec = deployment.spec?.template?.spec;
  if (!podSpec?.containers?.length) throw new Error("rendered Deployment has no containers");
  const volumes = (podSpec.volumes ?? []).map(renderVolume);
  const volumeNames = new Set(volumes.map((volume) => volume.name));
  const init = podSpec.initContainers?.[0]
    ? await renderContainer(podSpec.initContainers[0], input, volumeNames)
    : null;
  if ((podSpec.initContainers?.length ?? 0) > 1) throw new Error("rendered Deployment has more than one init container");
  const containers: GatewayVmRuntimeContainer[] = [];
  for (const container of podSpec.containers) containers.push(await renderContainer(container, input, volumeNames));
  const gateway = containers.find((container) => container.name === GATEWAY_CONTAINER_NAME);
  if (!gateway) throw new Error("rendered Deployment has no gateway container");
  if (input.desktop === "omarchy") {
    containers.push(renderDesktopNode(gateway));
    volumes.push({ name: GATEWAY_DESKTOP_NODE_STATE_VOLUME, kind: "emptyDir" }, { name: GATEWAY_DESKTOP_NODE_IDENTITY_VOLUME, kind: "emptyDir" });
  }
  configureHomeIdentity(input.homeStorageId, init, containers);
  const builderIdentity = bindUserIdentity(input.builderIdentity, containers);
  const unversioned = {
    gatewayId: input.gatewayId,
    ...builderIdentity,
    namespace: input.namespace,
    imageRepository: input.imageRepository,
    imageTag: input.imageTag,
    desktop: input.desktop,
    init,
    containers,
    volumes,
    hostAliases: input.hostAliases,
    kubernetes: input.kubernetes,
  };
  return { version: bundleVersion(unversioned), ...unversioned, renderedAt: input.now() };
}

const PROJECT_MATERIALIZATIONS_VOLUME = "project-materializations";
const PROJECT_MATERIALIZATIONS_MOUNT = "/work/materialized";

function bindUserIdentity(
  identity: RuntimeUserIdentity | undefined,
  containers: GatewayVmRuntimeContainer[],
): { builderIdentity?: RuntimeUserIdentity } {
  if (!identity) return {};
  mountUserProjects(identity, containers);
  return { builderIdentity: { ...identity } };
}

function mountUserProjects(identity: RuntimeUserIdentity, containers: GatewayVmRuntimeContainer[]): void {
  for (const container of containers) {
    const materialized = container.mounts.find((mount) =>
      mount.volume === PROJECT_MATERIALIZATIONS_VOLUME && mount.mountPath === PROJECT_MATERIALIZATIONS_MOUNT && mount.subPath === "projects");
    if (!materialized) continue;
    container.mounts.push({
      volume: PROJECT_MATERIALIZATIONS_VOLUME,
      mountPath: `/home/node/.openclaw/customers/${identity.builderSlug}/projects`,
      readOnly: materialized.readOnly,
      subPath: "projects",
    });
  }
}

function configureHomeIdentity(homeStorageId: string | undefined, init: GatewayVmRuntimeContainer | null, containers: GatewayVmRuntimeContainer[]): void {
  if (homeStorageId !== undefined) {
    if (!/^\d+$/u.test(homeStorageId)) throw new Error("invalid home storage identity");
    for (const container of [...(init ? [init] : []), ...containers]) container.env.OCTOGEE_HOME_STORAGE_ID = homeStorageId;
  }
}
