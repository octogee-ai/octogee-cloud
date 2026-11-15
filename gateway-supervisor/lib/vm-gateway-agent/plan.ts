import { scratchVolumeName } from "./scratch.js";
import { createHash } from "node:crypto";
import {
  GATEWAY_DESKTOP_NODE_CONTAINER,
  GATEWAY_DESKTOP_RUNTIME_DIR,
  gatewayVmPodName,
  type GatewayVmRuntimeBundle,
  type GatewayVmRuntimeContainer,
  type GatewayVmRuntimeVolume,
  type RuntimeUserIdentity,
} from "@octogee/shared/types/glm";
import { GATEWAY_HOST_DESKTOP_AUTH_DIR } from "../openclaw-computer-browser.js";

export const BUNDLE_VERSION_LABEL = "ai.octogee.bundle-version";
export const CONTAINER_SPEC_LABEL = "ai.octogee.container-spec";
export const INIT_SPEC_LABEL = "ai.octogee.init-spec";
export const NO_INIT_SPEC = "none";
export const GATEWAY_ID_LABEL = "ai.octogee.gateway-id";
export const NAMESPACE_LABEL = "ai.octogee.namespace";
export const CONTAINER_NAME_LABEL = "ai.octogee.container";
export const CONTAINER_ROLE_LABEL = "ai.octogee.role";
export const USER_SLUG_LABEL = "ai.octogee.builder-slug";
export const LOGGED_LABELS = [GATEWAY_ID_LABEL, NAMESPACE_LABEL, CONTAINER_NAME_LABEL, CONTAINER_ROLE_LABEL] as const;

function homeRestoreVersion(bundle: GatewayVmRuntimeBundle): string | null {
  return bundle.homeRestoreCheckpoint ? createHash("sha256").update(JSON.stringify(bundle.homeRestoreCheckpoint)).digest("hex") : null;
}

const OLDER_PLATFORM_SLUG_ENV = "GATEWAY_BUILDER_SLUG";
const OLDER_PLATFORM_OWNER_ENV = "GATEWAY_OWNER_UID";

type IdentityBundle = Pick<GatewayVmRuntimeBundle, "containers" | "init" | "builderIdentity">;

function renderedEnvValue(bundle: IdentityBundle, name: string): string | undefined {
  const values = new Set([bundle.init, ...bundle.containers].flatMap(container => container?.env[name] ? [container.env[name]] : []));
  if (values.size > 1) throw new Error(`VM bundle contains conflicting user identities in ${name}`);
  return [...values][0];
}

export function bundleUserIdentity(bundle: IdentityBundle): RuntimeUserIdentity | null {
  if (bundle.builderIdentity) return bundle.builderIdentity;
  const builderSlug = renderedEnvValue(bundle, OLDER_PLATFORM_SLUG_ENV);
  const ownerUid = renderedEnvValue(bundle, OLDER_PLATFORM_OWNER_ENV);
  return builderSlug && ownerUid ? { ownerUid, builderSlug } : null;
}

function bundleUserSlug(bundle: IdentityBundle): string | undefined {
  return bundleUserIdentity(bundle)?.builderSlug;
}

export function loggedLabelsFor(bundle: Pick<GatewayVmRuntimeBundle, "namespace" | "containers" | "init" | "builderIdentity">): string[] {
  return [
    ...LOGGED_LABELS.filter(label => label !== NAMESPACE_LABEL || Boolean(bundle.namespace)),
    ...(bundleUserSlug(bundle) ? [USER_SLUG_LABEL] : []),
  ];
}
export const RUNTIME_UID = "1000:1000";
export const SERVICE_RESTART_POLICY = "on-failure";
export const TOKEN_FILE = "token";
export const CA_FILE = "ca.crt";

export interface PlanContext {
  stateRoot: string;
  instanceId: string;
  desktopAuth: boolean;
}

export interface DockerContainerSpec {
  name: string;
  config: Record<string, unknown>;
}

export interface BundlePlan {
  init: DockerContainerSpec | null;
  services: DockerContainerSpec[];
}

export function containerName(container: Pick<GatewayVmRuntimeContainer, "name">): string {
  return `octogee-${container.name}`;
}

export function volumeHostPath(stateRoot: string, volume: GatewayVmRuntimeVolume): string {
  if (volume.kind === "ephemeral") throw new Error("Docker scratch volumes have no agent-local host path");
  return volume.kind === "emptyDir" ? `${stateRoot}/volumes/${volume.name}` : `${stateRoot}/tokens/${volume.name}`;
}

export function volumeByName(bundle: GatewayVmRuntimeBundle, name: string): GatewayVmRuntimeVolume {
  const volume = bundle.volumes.find((candidate) => candidate.name === name);
  if (!volume) throw new Error(`bundle ${bundle.version}: mount references unknown volume ${name}`);
  return volume;
}

export function scratchOwner(bundle: GatewayVmRuntimeBundle, instanceId: string, volume: string): string {
  if (volume !== "project-materializations") return instanceId;
  const ids = new Set([bundle.init, ...bundle.containers].flatMap(container => container?.env.OCTOGEE_HOME_STORAGE_ID ? [container.env.OCTOGEE_HOME_STORAGE_ID] : []));
  if (ids.size > 1) throw new Error("conflicting home storage identities");
  const id = [...ids][0];
  if (id && !/^\d+$/u.test(id)) throw new Error("invalid home storage identity");
  return id ? `${instanceId}-home-${id}` : instanceId;
}

function bindsFor(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer, ctx: PlanContext): string[] {
  return container.mounts.flatMap((mount) => {
    const volume = volumeByName(bundle, mount.volume);
    if (volume.kind === "ephemeral") {
      if (mount.subPath) return [];
      return `${scratchVolumeName(scratchOwner(bundle, ctx.instanceId, volume.name), volume.name)}:${mount.mountPath}${mount.readOnly ? ":ro" : ""}`;
    }
    const host = mount.subPath ? `${volumeHostPath(ctx.stateRoot, volume)}/${mount.subPath}` : volumeHostPath(ctx.stateRoot, volume);
    return `${host}:${mount.mountPath}${mount.readOnly ? ":ro" : ""}`;
  });
}

function volumeSubpathMounts(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer, ctx: PlanContext): Record<string, unknown>[] {
  return container.mounts.flatMap(mount => {
    const volume = volumeByName(bundle, mount.volume);
    if (volume.kind !== "ephemeral" || !mount.subPath) return [];
    if (volume.name !== "project-materializations" || mount.subPath !== "projects") throw new Error("unsupported Docker volume subPath");
    return [{ Type: "volume", Source: scratchVolumeName(scratchOwner(bundle, ctx.instanceId, volume.name), volume.name), Target: mount.mountPath,
      ReadOnly: mount.readOnly, VolumeOptions: { Subpath: mount.subPath, NoCopy: true } }];
  });
}

function mountsKubernetesApi(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer): boolean {
  return container.mounts.some((mount) => volumeByName(bundle, mount.volume).kind === "kubernetesApi");
}

export function envFor(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer, ctx: PlanContext): string[] {
  const env: Record<string, string> = { ...container.env };
  if ("POD_UID" in env) env.POD_UID = gatewayVmPodName(bundle.gatewayId, ctx.instanceId);
  if ("GATEWAY_COMPUTER_INSTANCE_ID" in env) env.GATEWAY_COMPUTER_INSTANCE_ID = ctx.instanceId;
  if (mountsKubernetesApi(bundle, container)) {
    env.KUBERNETES_SERVICE_HOST = bundle.kubernetes.apiHost;
    env.KUBERNETES_SERVICE_PORT = bundle.kubernetes.apiPort;
    env.KUBERNETES_SERVICE_PORT_HTTPS = bundle.kubernetes.apiPort;
  }
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

export function containerSpecVersion(config: Record<string, unknown>): string {
  const { Labels, ...spec } = config;
  const labels = Labels as Record<string, string> | undefined;
  const builderSlug = labels?.[USER_SLUG_LABEL];
  const homeRestore = labels?.["ai.octogee.home-restore"];
  return createHash("sha256").update(JSON.stringify({ ...spec, ...(builderSlug ? { builderSlug } : {}), ...(homeRestore ? { homeRestore } : {}) })).digest("hex").slice(0, 16);
}

const X11_SHM_BYTES = 256 * 1024 * 1024;
const SHM_MOUNT_PATH = "/dev/shm";

function gatewayHomeBind(x11Gateway: boolean, stateRoot: string): string {
  return x11Gateway ? `${stateRoot}/desktop-home:/home/octo` : "/home/octo/Documents:/home/octo/Documents";
}

function x11GatewayHostConfig(x11Gateway: boolean): Record<string, unknown> {
  return x11Gateway ? { ShmSize: X11_SHM_BYTES, SecurityOpt: ["seccomp=unconfined"] } : {};
}

function withoutShmMount(container: GatewayVmRuntimeContainer): GatewayVmRuntimeContainer {
  return { ...container, mounts: container.mounts.filter((mount) => mount.mountPath !== SHM_MOUNT_PATH) };
}

export function planContainer(
  bundle: GatewayVmRuntimeBundle,
  container: GatewayVmRuntimeContainer,
  ctx: PlanContext,
  role: "init" | "service",
): DockerContainerSpec {
  const desktopService = role === "service" && container.name === GATEWAY_DESKTOP_NODE_CONTAINER;
  const gatewayService = role === "service" && container.name === "gateway";
  const x11Gateway = gatewayService && bundle.desktop === "x11";
  const bound = x11Gateway ? withoutShmMount(container) : container;
  const mounts = volumeSubpathMounts(bundle, bound, ctx);
  if (gatewayService && ctx.desktopAuth && !x11Gateway) {
    mounts.push({ Type: "bind", Source: `${GATEWAY_DESKTOP_RUNTIME_DIR}/octogee-openclaw-vnc`, Target: GATEWAY_HOST_DESKTOP_AUTH_DIR, ReadOnly: true });
  }
  const config: Record<string, unknown> = {
    Image: container.image,
    User: RUNTIME_UID,
    Env: envFor(bundle, container, ctx),
    ...(container.command ? { Entrypoint: container.command } : {}),
    ...(container.args ? { Cmd: container.args } : {}),
    HostConfig: {
      NetworkMode: "host",
      ...(desktopService ? { PidMode: "host" } : {}),
      Binds: [
        ...bindsFor(bundle, bound, ctx),
        ...(gatewayService ? [gatewayHomeBind(x11Gateway, ctx.stateRoot)] : []),
        ...(desktopService
          // eslint-disable-next-line sonarjs/publicly-writable-directories -- XWayland requires its standard socket directory; the mount is read-only.
          ? [`${GATEWAY_DESKTOP_RUNTIME_DIR}:${GATEWAY_DESKTOP_RUNTIME_DIR}`, "/tmp/.X11-unix:/tmp/.X11-unix:ro"]
          : []),
      ],
      ...(mounts.length ? { Mounts: mounts } : {}),
      ...x11GatewayHostConfig(x11Gateway),
      ExtraHosts: Object.entries(bundle.hostAliases).map(([host, ip]) => `${host}:${ip}`),
      RestartPolicy: { Name: role === "service" ? SERVICE_RESTART_POLICY : "no" },
      LogConfig: { Type: "gcplogs", Config: { labels: loggedLabelsFor(bundle).join(",") } },
    },
  };
  config.Labels = containerLabels(bundle, container, role);
  (config.Labels as Record<string, string>)[CONTAINER_SPEC_LABEL] = containerSpecVersion(config);
  return { name: containerName(container), config };
}

function containerLabels(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer, role: "init" | "service"): Record<string, string> {
  const homeRestore = homeRestoreVersion(bundle);
  return {
    [BUNDLE_VERSION_LABEL]: bundle.version,
    [GATEWAY_ID_LABEL]: bundle.gatewayId,
    ...(homeRestore ? { "ai.octogee.home-restore": homeRestore } : {}),
    ...(bundleUserSlug(bundle) ? { [USER_SLUG_LABEL]: bundleUserSlug(bundle) } : {}),
    ...(bundle.namespace ? { [NAMESPACE_LABEL]: bundle.namespace } : {}),
    [CONTAINER_NAME_LABEL]: container.name,
    [CONTAINER_ROLE_LABEL]: role,
  };
}

export function specVersion(spec: DockerContainerSpec): string {
  return (spec.config.Labels as Record<string, string>)[CONTAINER_SPEC_LABEL];
}

export function planBundle(bundle: GatewayVmRuntimeBundle, ctx: PlanContext): BundlePlan {
  const init = bundle.init ? planContainer(bundle, bundle.init, ctx, "init") : null;
  const initSpec = init ? specVersion(init) : homeRestoreVersion(bundle) ?? NO_INIT_SPEC;
  const services = bundle.containers.map((container) => {
    const service = planContainer(bundle, container, ctx, "service");
    (service.config.Labels as Record<string, string>)[INIT_SPEC_LABEL] = initSpec;
    return service;
  });
  return { init, services };
}

export function planInitSpec(plan: BundlePlan): string {
  return (plan.services[0]?.config.Labels as Record<string, string> | undefined)?.[INIT_SPEC_LABEL] ?? NO_INIT_SPEC;
}

export function imagesToPull(bundle: GatewayVmRuntimeBundle): string[] {
  const refs = new Set<string>();
  if (bundle.init) refs.add(bundle.init.image);
  for (const container of bundle.containers) refs.add(container.image);
  return [...refs];
}

type Inspection = { Config?: { Labels?: Record<string, string> } } | null;

export function runningVersion(inspection: Inspection): string | null {
  return inspection?.Config?.Labels?.[BUNDLE_VERSION_LABEL] ?? null;
}

export function runningSpec(inspection: Inspection): string | null {
  return inspection?.Config?.Labels?.[CONTAINER_SPEC_LABEL] ?? null;
}

export function runningInitSpec(inspection: Inspection): string | null {
  return inspection?.Config?.Labels?.[INIT_SPEC_LABEL] ?? null;
}
